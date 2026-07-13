# OMX State Model

This document explains how OMX tracks workflow/skill state, how transition rules are evaluated, and which transitions are commonly allowed or blocked.

## Goals

- make mode state predictable across CLI, MCP, hooks, and HUD
- show which files are authoritative vs compatibility-only
- explain how allowlisted handoffs and overlap rules work
- document common workflow transitions in one place

## State authorities

### 1. Per-mode state files — authoritative

Authoritative workflow state lives in per-mode files under `.omx/state/`:

- root scope: `.omx/state/<mode>-state.json`
- session scope: `.omx/state/sessions/<session_id>/<mode>-state.json`

Examples:

- `.omx/state/ralplan-state.json`
- `.omx/state/sessions/<session_id>/ralph-state.json`
- `.omx/state/team-state.json`

These files determine whether a workflow mode is active, completed, cancelled, or failed. Those mode phases are not always identical to the user-facing terminal lifecycle vocabulary; see the explicit terminal lifecycle section below for that compatibility boundary.

### 2. `skill-active-state.json` — compatibility / visibility layer

`skill-active-state.json` is still used as a compatibility surface for hooks/HUD/native messaging, but transition reconciliation should be driven from the shared transition/reconciliation helpers rather than re-deriving semantics ad hoc.

Locations:

- `.omx/state/skill-active-state.json`
- `.omx/state/sessions/<session_id>/skill-active-state.json`

### 3. Session scope and compatibility reads

Compatibility display/list reads may use this ordered lookup when there is no explicit session requirement:

1. current session scope
2. root scope fallback

An explicit-session read never falls back to current-session or root scope. Mutations, clears, active-mode guards, continuation/resume decisions, and authority-bound native/HUD/team/doctor paths also never use root fallback to recover or resurrect a session. They require the explicit or committed session binding and fail closed when it is missing, stale, foreign, or malformed.

When root and session artifacts disagree, the session artifact may be displayed only through the compatibility read surface; authoritative active decisions use `getAuthoritativeActiveStateDirs()` and must not let a root survivor revive state. Reconciliation terminalizes stale root survivors when appropriate.

## Terminal lifecycle outcome compatibility

For the explicit terminal stop model, treat workflow `current_phase` and user-facing terminal lifecycle outcome as related but separate concepts.

Canonical user-facing lifecycle outcomes are:

- `finished`
- `blocked`
- `failed`
- `userinterlude`
- `askuserQuestion`

Compatibility rules:

- Prefer a dedicated canonical lifecycle field over legacy `run_outcome` when both exist.
- Treat legacy `run_outcome` as a compatibility layer during migration.
- Infer from `current_phase` only when neither canonical lifecycle metadata nor legacy `run_outcome` is available.
- Keep `cancelled` as an internal legacy/admin phase, not as the canonical public lifecycle vocabulary.

Recommended read precedence for terminal lifecycle interpretation:

1. canonical lifecycle metadata (for example `lifecycle_outcome`)
2. legacy `run_outcome`
3. compatibility inference from `current_phase`, question metadata, and persisted error/completion fields

`blocked_on_user` is also compatibility-only. When surrounding question metadata proves OMX asked a blocking question, classify it as `askuserQuestion`; otherwise treat it as a user-wait compatibility signal instead of exposing it as the canonical vocabulary directly.

## Core files

- `src/state/workflow-transition.ts` — transition policy and decision model
- `src/state/workflow-transition-reconcile.ts` — shared transition reconciliation helper
- `src/modes/base.ts` — mode start/update lifecycle
- `src/mcp/state-server.ts` — MCP state writes/reads/clears
- `src/hooks/keyword-detector.ts` — prompt keyword activation + state seeding
- `src/scripts/codex-native-hook.ts` — native hook routing and prompt-submit output

## Transition flow

```mermaid
flowchart TD
  A[Prompt / CLI / MCP request] --> B[Detect requested workflow skill(s)]
  B --> C[Evaluate transition policy]
  C -->|deny| D[Return denial message]
  C -->|allow overlap| E[Keep current active modes + add destination]
  C -->|allow auto-complete| F[Complete source mode(s)]
  F --> G[Sync compatibility skill-active state]
  G --> H[Activate destination mode(s)]
  E --> G
  H --> I[Emit routing / transition message]
```

## Reconciliation sequence

The shared reconciliation helper should follow this sequence:

1. decide outcome
2. complete source mode(s) with audit metadata
3. sync compatibility `skill-active` state
4. activate destination mode(s)
5. return transition message for rendering

This ordering matters because syncing too early can resurrect a mode that was just auto-completed.

## Prompt-submit flow

```mermaid
flowchart TD
  A[UserPromptSubmit] --> B[detectKeywords()]
  B --> C[ordered explicit skill list]
  C --> D[recordSkillActivation()]
  D --> E[shared reconciliation helper]
  E --> F[final active skills]
  F --> G[buildAdditionalContextMessage()]
  G --> H[native hook output]
```

## Transition rule categories

### A. Allow with no change

The requested mode is already active.

### B. Allow as overlap

The requested mode is added without completing the source mode.

Examples:

- `team + ralph`
- `ultrawork + <any tracked mode>`

### C. Allow with source auto-complete

The source mode is terminalized and the destination becomes active.

Current allowlisted forward handoffs:

- `deep-interview -> ralplan` (evidence-gated)
- `ralplan -> team`
- `ralplan -> ralph`
- `ralplan -> autopilot`

### D. Deny

The requested transition is not allowed and no state is changed.

## Common transition rules

| From | To | Result |
|---|---|---|
| `deep-interview` | `ralplan` | evidence-gated auto-complete: requires a durable deep-interview completion gate or explicit user-authorized skip; a satisfied/cleared question obligation alone is not enough |
| `ralplan` | `team` | auto-complete `ralplan`, start `team` |
| `ralplan` | `ralph` | auto-complete `ralplan`, start `ralph` |
| `ralplan` | `autopilot` | auto-complete `ralplan`, start `autopilot` |
| `autopilot` | `ralplan` | denied as a peer transition; represent supervised ralplan by updating `autopilot.current_phase` |
| `team` | `ralph` | allowed overlap |
| `ralph` | `team` | allowed overlap |
| `<any tracked mode>` | `ultrawork` | allowed overlap |
| `ultrawork` | `<any tracked mode>` | allowed overlap |
| execution-like mode | planning-like mode | denied rollback auto-complete |
| anything else non-allowlisted | new conflicting mode | denied |

Autopilot is a supervisor over child stages, not a peer that is completed by
entering its `ralplan` child stage. Review/QA loopbacks should keep
`autopilot-state.json` active and set `current_phase: "ralplan"` rather than
starting standalone `ralplan` over Autopilot.

Inside Autopilot, `ralplan` consensus also requires tracker-backed native
subagent lane evidence for the Architect and Critic approvals. `codex_exec`
outputs and authored planning artifacts remain trace evidence, but they do not
prove that visible native subagent lanes ran.

## Planning-like vs execution-like

### Planning-like

- `deep-interview`
- `ralplan`
- `autoresearch`

### Execution-like

- `team`
- `ralph`
- `autopilot`
- `ultrawork`
- `ultraqa`

Execution-like -> planning-like rollback auto-complete is forbidden. The denial should tell the user, in substance:

> first clear current state first and retry if this action is intended

## Multi-skill prompt-submit behavior

A single prompt can explicitly invoke multiple contiguous `$skill` tokens.

Example:

```text
$ralplan $team $ralph ship this fix
```

Expected result:

1. `ralplan` is recognized as the planning source
2. simultaneous execution follow-ups are deferred instead of auto-starting
3. final active skill remains `ralplan`
4. deferred execution skills are surfaced in native-hook output for traceability
5. native hook output should describe all explicit skills, not only the primary one

Recommended message shape:

- detected keywords summary
- deferred-skill summary, e.g. `planning preserved over simultaneous execution follow-up; deferred skills: team, ralph`
- final active skill / initialized state summary
- team runtime hint only when `team` is actually among the final active skills

## Audit fields for auto-complete

When a source mode is auto-completed during transition, the source state should record:

- `active: false`
- `current_phase: completed`
- `completed_at`
- `auto_completed_reason` or equivalent
- `completion_note` or equivalent
- destination metadata when useful (`transition_target_mode`, source path, etc.)

## Invariants

These rules should remain true unless intentionally changed:

- rollback to planning never auto-completes
- non-allowlisted transitions remain blocked
- `ultrawork` overlap-any must not weaken `ralplan-first` gating
- native-hook output is a presentation layer over shared transition results, not a separate decision engine
- compatibility sync must not resurrect completed source modes

## Practical guidance

### If you are changing transition rules

Update together:

- `src/state/workflow-transition.ts`
- `src/state/workflow-transition-reconcile.ts`
- lifecycle / MCP callers
- prompt-submit/native-hook rendering
- regression tests

### If you are debugging stale state

Check these in order:

1. session-scoped `<mode>-state.json`
2. root `<mode>-state.json`
3. session/root `skill-active-state.json`
4. whether a previous auto-complete wrote audit metadata but compatibility sync reintroduced the mode

### If you are adding a new allowlisted handoff

Define:

- source mode
- destination mode(s)
- whether source auto-completes or destination overlaps
- rollback behavior
- expected native-hook / CLI / MCP transition output
- regression tests for both session and root scope

## Authoritative state root

Each OMX native/session run has exactly one durable state authority. The authority is established **before** a workflow mode is activated and binds the run to:

- a canonical realpath state root;
- a canonical workspace identity — the Git worktree root when available, otherwise the canonical startup cwd;
- a generation record and filesystem identity/capability evidence;
- a session binding containing canonical session identity and separate native/owner/previous aliases.

The root authority and session aliases are different identities. An alias may identify the same session, but it cannot select a different root. Git common-directory data is lineage evidence only; different worktrees remain distinct authorities.

### Resolution and diagnostics

After an authority commits, its persisted anchor/generation/binding is the only root for state reads, writes, clears, active-mode guards, native hooks, HUD, doctor, tmux/team workers, and resume/restart. `cwd`, hook payload cwd, `OMX_ROOT`, `OMX_STATE_ROOT`, `OMX_TEAM_STATE_ROOT`, and nested `.omx` discovery are diagnostics/candidate inputs only. They cannot silently retarget an active run.

When the observed cwd resolves to another `.omx` tree, OMX retains the committed authority and reports an actionable root/cwd mismatch. Mutating operations and continuation guards fail closed on missing, deleted, replaced, foreign, colliding, weak-capability, or conflicting authority evidence. Symlink aliases to the same canonical root are acceptable; an escaping symlink or replaced target is not.

There is no public or hidden caller-selected state-root override. In particular, `omx state ... --root` is not a recovery mechanism. A future root-recovery surface requires explicit owner confirmation and an identity-bound, journaled design.

### Commit and launch ordering

Authority establishment is journal-first and fenced by the workspace anchor lock:

1. resolve canonical workspace identity and acquire the fenced anchor lock;
2. create durable `prepared` then `applying` journal custody for every internal participant effect;
3. create/validate immutable generation and session binding, then atomically publish the active anchor;
4. verify all recorded effects and mark the journal `committed`;
5. only then construct child environments, tmux/HUD/worker metadata, shell exports, spawn specifications, or child processes.

Before journal commit, the authority context is immutable in-process data held by the first-party launcher/recovery owner. It must not be serialized to a child-visible environment file, detached server/tmux environment, registry active locator, HUD/worker startup artifact, shell export, runtime shim, or spawnable child specification. Persistent launch transport is a separately journaled postcommit operation and must be verified before spawning.

Postcommit child transport includes an opaque bearer in `OMX_STATE_AUTHORITY_CAPABILITY`. The raw bearer remains process-local or child-environment-only; persisted anchors contain only its SHA-256 digest and binding metadata. Validation requires the active workspace, generation, binding ID, lease launch, root identity, and observed-cwd relationship. Proven native/owner alias revisions may advance the binding revision without invalidating the parent bearer, while a new generation, binding, lease launch, explicit supersession/revocation, malformed tuple, copied workspace, or expiry fails closed. The default capability lifetime is thirty days so ordinary long-lived sessions and `/new` alias continuity do not fail solely because a short wall-clock timer elapsed; active persisted authority and lease identity remain mandatory throughout that interval.

Alternate roots require a first-party, single-use, fenced bootstrap intent plus the same journal/anchor validation. `OMX_RUNS_DIR` is bootstrap-only candidate/diagnostic evidence: it is never an authority selector, authenticator, migration witness, or active transport. Registry/history records are candidates until they match the committed anchor, consumed intent, generation, root fingerprint, protocol, and session binding. Registry writes, cleanup, terminalization, and active visibility are journaled; no caller-provided runs directory becomes authoritative merely because it was recorded.

### Inventory and drift gate

`src/state/authority-callsite-inventory.ts` is the machine-readable authority-surface ledger. Each exact path/symbol row declares its classification, owner, rationale, and migration phase:

- `authority-context`: consumes committed authority or performs a fenced/postcommit effect derived from it;
- `bootstrap-only`: reads ambient root/run evidence only as a bounded candidate or diagnostic, then crosses validation before active use;
- `intentionally-cwd-local`: workspace content that is explicitly not an authority locator;
- `out-of-scope`: a separately owned non-state-root surface.

`src/state/__tests__/authority-callsite-inventory.test.ts` uses the TypeScript compiler API to resolve definitions, imports/re-exports/aliases, member calls, direct ambient readers, direct `.omx/state` builders, and bounded transitive callers. Every classified `authority-context` and `bootstrap-only` helper seeds the caller graph; an unclassified direct or transitive consumer fails the gate. Every direct read of `OMX_ROOT`, `OMX_STATE_ROOT`, `OMX_TEAM_STATE_ROOT`, or `OMX_RUNS_DIR` must have an exact `bootstrap-only` row, regardless of any surrounding authority work. `.omx/state` construction also requires an exact row.

Dynamic authority dispatch is denied by default. A waiver must resolve to one live call inside its declared symbol and exact source range, match that row's classification/owner/migration phase, name a non-empty rationale and removal condition, enumerate unique bounded receiver targets including the actual receiver, and be used exactly once; stale or broad waivers fail. Secondary text scans retain coverage of run-root and helper inventory. The inventory is a scope ledger, not a claim that every compatibility helper may select authority.

### Recovery and rollback

Recovery reads durable anchor and journal evidence first. It may replay or abort a known fenced operation, but it must not infer an authority from the nearest parent, current cwd, ambient environment, or an ambiguous legacy pointer. Legacy pointers without a root are repairable only from uniquely corroborated authority evidence; zero or multiple candidates are a diagnostic with no mutation. Rollback is forward-fix/quiesce only: do not restore a mixed-version process to a prior root contract while active children can still observe it.
