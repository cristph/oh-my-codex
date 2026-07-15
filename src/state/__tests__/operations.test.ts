import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const ORIGINAL_TEST_UMASK = process.umask(0o077);
after(() => process.umask(ORIGINAL_TEST_UMASK));

import {
  executeStateOperation as executeStateOperationRaw,
  setStateOperationTestHooksForTests,
  type StateOperationName,
  type StateOperationResponse,
} from '../operations.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  canonicalizeAuthorityPathForCreation,
  initializeStateAuthority,
  resolveStateAuthorityForGuard,
  rolloverStateAuthorityToAlternateRoot,
} from '../authority.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { updateModeState } from '../../modes/base.js';

const operationAuthorityInitByWorkspace = new Map<string, Promise<void>>();

async function ensureTestOperationAuthority(
  workingDirectory: string,
  sessionId: string | undefined,
): Promise<void> {
  const existing = operationAuthorityInitByWorkspace.get(workingDirectory);
  if (existing) return existing;
  const initializing = (async () => {
    try {
      await resolveStateAuthorityForGuard({
        startup_cwd: workingDirectory,
        observed_cwd: workingDirectory,
      });
      return;
    } catch (error) {
      if (
        !(error instanceof StateAuthorityError)
        || error.code !== AUTHORITY_DIAGNOSTIC_CODES.anchorMissing
      ) {
        throw error;
      }
    }
    if (existsSync(join(workingDirectory, '.omx', 'state', 'authority'))) return;

    const stateRoot = join(workingDirectory, '.omx', 'state');
    const stagedStateRoot = join(
      workingDirectory,
      '.omx',
      `.state-before-test-authority-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const staged = existsSync(stateRoot);
    if (staged) await rename(stateRoot, stagedStateRoot);
    try {
      const requestedSessionId = sessionId?.trim()
        || `operations-test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await initializeStateAuthority({
        startup_cwd: workingDirectory,
        launch_id: `operations-test-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        session_binding: { canonical_session_id: requestedSessionId },
      });
      if (staged) {
        for (const entry of await readdir(stagedStateRoot)) {
          await rename(join(stagedStateRoot, entry), join(stateRoot, entry));
        }
        await rm(stagedStateRoot, { recursive: true, force: true });
      }
    } catch (error) {
      if (staged && existsSync(stagedStateRoot) && !existsSync(stateRoot)) {
        await rename(stagedStateRoot, stateRoot);
      }
      throw error;
    }
  })();
  operationAuthorityInitByWorkspace.set(workingDirectory, initializing);
  try {
    await initializing;
  } catch (error) {
    operationAuthorityInitByWorkspace.delete(workingDirectory);
    throw error;
  }
}
async function executeStateOperation(
  name: StateOperationName,
  rawArgs: Record<string, unknown> = {},
): Promise<StateOperationResponse> {
  if (name === 'state_write' || name === 'state_clear') {
    const workingDirectory = typeof rawArgs.workingDirectory === 'string'
      ? rawArgs.workingDirectory
      : process.cwd();
    const requestedSessionId = typeof rawArgs.session_id === 'string'
      ? rawArgs.session_id
      : undefined;
    await ensureTestOperationAuthority(workingDirectory, requestedSessionId);
  }
  return executeStateOperationRaw(name, rawArgs);
}

async function committedSessionStatePath(
  workingDirectory: string,
  filename: string,
  sessionId?: string,
): Promise<string> {
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: workingDirectory,
    observed_cwd: workingDirectory,
  });
  const scopedSessionId = sessionId?.trim() || authority.session_binding?.canonical_session_id;
  assert.ok(scopedSessionId, 'state operation authority must have a committed session binding');
  return join(authority.canonical_state_root, 'sessions', scopedSessionId, filename);
}
async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;

  if (typeof env.TMUX === 'string') process.env.TMUX = env.TMUX;
  else delete process.env.TMUX;
  if (typeof env.TMUX_PANE === 'string') process.env.TMUX_PANE = env.TMUX_PANE;
  else delete process.env.TMUX_PANE;
  if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
  else if ('PATH' in env) delete process.env.PATH;

  try {
    return await run();
  } finally {
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function withOmxRootEnv<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  process.env.OMX_ROOT = root;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  try {
    return await run();
  } finally {
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
  }
}
async function withStateRootEnv<T>(env: Partial<Record<'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT', string>>, run: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  if (typeof env.OMX_ROOT === 'string') process.env.OMX_ROOT = env.OMX_ROOT;
  else delete process.env.OMX_ROOT;
  if (typeof env.OMX_STATE_ROOT === 'string') process.env.OMX_STATE_ROOT = env.OMX_STATE_ROOT;
  else delete process.env.OMX_STATE_ROOT;
  if (typeof env.OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = env.OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
  try {
    return await run();
  } finally {
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
  }
}

async function withStateOperationFault<T>(
  point: 'after_effects_before_committed_evidence' | 'after_first_state_clear_effect',
  run: () => Promise<T>,
): Promise<T> {
  setStateOperationTestHooksForTests({ faultInjectionPoint: point });
  try {
    return await run();
  } finally {
    setStateOperationTestHooksForTests();
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function executeStateOperationInChild(
  operationsModuleUrl: string,
  name: 'state_write' | 'state_clear',
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): Promise<{ payload: unknown; isError?: boolean }> {
  const childProgram = `
    const { writeFile, access } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { executeStateOperation, setStateOperationTestHooksForTests } = await import(process.env.OMX_STATE_OPERATION_MODULE_URL);
    const faultInjectionPoint = process.env.OMX_STATE_OPERATION_FAULT_INJECTION;
    const barrierDirectory = process.env.OMX_STATE_OPERATION_TEST_BARRIER_DIR;
    const barrierPoint = process.env.OMX_STATE_OPERATION_TEST_BARRIER_POINT || 'before_mutation_transaction';
    setStateOperationTestHooksForTests({
      ...(faultInjectionPoint ? { faultInjectionPoint } : {}),
      ...(barrierDirectory ? {
        barrier: async (point) => {
          if (point !== barrierPoint) return;
          const reachedPath = join(barrierDirectory, point + '.reached');
          const releasePath = join(barrierDirectory, point + '.release');
          await writeFile(reachedPath, '');
          const deadline = Date.now() + 5000;
          for (;;) {
            try { await access(releasePath); break; } catch {}
            if (Date.now() >= deadline) throw new Error('timed out waiting at state operation test barrier: ' + point);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
      } : {}),
    });
    const response = await executeStateOperation(
      process.env.OMX_STATE_OPERATION_NAME,
      JSON.parse(process.env.OMX_STATE_OPERATION_ARGS),
    );
    process.stdout.write(JSON.stringify(response));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childProgram], {
      env: {
        ...process.env,
        ...env,
        OMX_STATE_OPERATION_MODULE_URL: operationsModuleUrl,
        OMX_STATE_OPERATION_NAME: name,
        OMX_STATE_OPERATION_ARGS: JSON.stringify(args),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!child.stdout || !child.stderr) {
      child.kill();
      reject(new Error('state operation child did not expose output streams'));
      return;
    }
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`state operation child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { payload: unknown; isError?: boolean });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function responsePayload<T extends Record<string, unknown>>(response: { payload: unknown; isError?: boolean }): T {
  assert.equal(response.isError, undefined);
  assert.ok(response.payload && typeof response.payload === 'object' && !Array.isArray(response.payload));
  return response.payload as T;
}

function validExecutionContract(stride: 'task' | 'deliverable' | 'milestone'): Record<string, unknown> {
  const perStride = {
    task: {
      allow_task_shrink: true,
      acceptance_coverage_scope: 'task',
      shrink_policy: 'allowed',
      completion_unit: 'One focused task',
      stop_condition: 'Stop after that task is implemented and verified',
    },
    deliverable: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'deliverable',
      shrink_policy: 'ask_before_shrink',
      completion_unit: 'The named deliverable',
      stop_condition: 'Stop after the deliverable is complete and verified',
    },
    milestone: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'milestone',
      shrink_policy: 'deny_unless_blocked',
      completion_unit: 'The approved milestone',
      stop_condition: 'Stop after the milestone is complete unless blocked',
    },
  } as const;

  return {
    version: 1,
    execution_stride: stride,
    source: 'deep-interview',
    selected_by: 'user',
    ...perStride[stride],
  };
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  const trackingPath = subagentTrackingPath(cwd);
  const architectCompletedAt = '2026-05-28T00:00:00.000Z';
  const criticStartedAt = '2026-05-28T00:01:00.000Z';
  const criticCompletedAt = '2026-05-28T00:02:00.000Z';
  await mkdir(dirname(trackingPath), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: criticCompletedAt,
        threads: {
          'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: architectCompletedAt, last_seen_at: architectCompletedAt, turn_count: 1 },
          'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: architectCompletedAt, last_seen_at: architectCompletedAt, completed_at: architectCompletedAt, turn_count: 1, mode: 'architect' },
          'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: criticStartedAt, last_seen_at: criticCompletedAt, completed_at: criticCompletedAt, turn_count: 1, mode: 'critic' },
        },
      },
    },
  }, null, 2));
}

function ralplanConsensusGate(
  sessionId: string,
  provenanceKind: 'native_subagent' | 'codex_exec',
  threadOverrides: { architect?: string; critic?: string } = {},
): Record<string, unknown> {
  const architectThread = threadOverrides.architect ?? (provenanceKind === 'native_subagent' ? 'thread-architect' : 'exec-architect');
  const criticThread = threadOverrides.critic ?? (provenanceKind === 'native_subagent' ? 'thread-critic' : 'exec-critic');
  return {
    required: true,
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: {
      agent_role: 'architect',
      verdict: 'approve',
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: architectThread,
      artifact_path: '.omx/artifacts/architect.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: 'approve',
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: criticThread,
      artifact_path: '.omx/artifacts/critic.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
  };
}

async function writeNativeRalplanConsensusGate(
  cwd: string,
  sessionId: string,
  threadOverrides: { architect?: string; critic?: string } = {},
): Promise<Record<string, unknown>> {
  await writeNativeSubagentTracking(cwd, sessionId);
  return ralplanConsensusGate(sessionId, 'native_subagent', threadOverrides);
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state operations directory initialization', () => {
  it('keeps state_list_active side-effect-free without setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps state_get_status side-effect-free when session_id is provided', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-status-readonly-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess1');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        session_id: 'sess1',
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { statuses: {} });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not let a populated ambient OMX_TEAM_STATE_ROOT become state mutation authority', async () => {

    const root = await mkdtemp(join(tmpdir(), 'omx-state-ops-team-root-'));
    try {
      const wd = join(root, 'workspace');
      const teamStateRoot = join(root, 'team-state');
      await mkdir(wd, { recursive: true });
      await mkdir(teamStateRoot, { recursive: true });
      await writeFile(join(teamStateRoot, 'session.json'), JSON.stringify({
        session_id: 'sess-team-write',
        cwd: wd,
      }));
      await writeFile(join(teamStateRoot, 'autoresearch-state.json'), JSON.stringify({
        active: true,
        current_phase: 'ambient-forged',
      }));


      await withStateRootEnv({ OMX_TEAM_STATE_ROOT: teamStateRoot }, async () => {
        const writeResponse = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: 'sess-team-write',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const writePayload = responsePayload<{ path: string }>(writeResponse);
        const canonicalPath = canonicalizeAuthorityPathForCreation(
          join(wd, '.omx', 'state', 'sessions', 'sess-team-write', 'autoresearch-state.json'),
        );
        assert.equal(writePayload.path, canonicalPath);
        assert.equal(existsSync(canonicalPath), true);
        assert.equal(existsSync(join(teamStateRoot, 'sessions')), false);
        assert.equal(existsSync(join(teamStateRoot, 'authority')), false);


        const clearResponse = await executeStateOperation('state_clear', {
          workingDirectory: wd,
          session_id: 'sess-team-write',
          mode: 'autoresearch',
        });
        const clearPayload = responsePayload<{ path: string }>(clearResponse);
        assert.equal(clearPayload.path, canonicalPath);
        assert.equal(existsSync(canonicalPath), false);
        assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-team-write', 'skill-active-state.json')), true);
        assert.equal(existsSync(join(teamStateRoot, 'sessions')), false);
        assert.equal(existsSync(join(teamStateRoot, 'authority')), false);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not let populated OMX_ROOT or OMX_STATE_ROOT candidates retarget state mutations', async () => {

    for (const envName of ['OMX_ROOT', 'OMX_STATE_ROOT'] as const) {
      const root = await mkdtemp(join(tmpdir(), `omx-state-ops-${envName.toLowerCase()}-`));
      try {
        const workspace = join(root, 'workspace');
        const ambientRoot = join(root, 'ambient-root');
        await mkdir(workspace, { recursive: true });
        const ambientStateRoot = join(ambientRoot, '.omx', 'state');
        await mkdir(ambientStateRoot, { recursive: true });
        await writeFile(join(ambientStateRoot, 'session.json'), JSON.stringify({
          session_id: `sess-${envName.toLowerCase()}`,
          cwd: workspace,
        }));
        await writeFile(join(ambientStateRoot, 'autoresearch-state.json'), JSON.stringify({
          active: true,
          current_phase: 'ambient-forged',
        }));

        await withStateRootEnv({ [envName]: ambientRoot }, async () => {
          const response = await executeStateOperation('state_write', {
            workingDirectory: workspace,
            session_id: `sess-${envName.toLowerCase()}`,
            mode: 'autoresearch',
            active: true,
            current_phase: 'running',
          });
          const payload = responsePayload<{ path: string }>(response);
          assert.equal(
            payload.path,
            canonicalizeAuthorityPathForCreation(
              join(workspace, '.omx', 'state', 'sessions', `sess-${envName.toLowerCase()}`, 'autoresearch-state.json'),
            ),
          );
          assert.equal(existsSync(join(ambientStateRoot, 'authority')), false, envName);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('surfaces active ultragoal artifacts in list-active without mode state files', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-artifact-'));
    try {
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          activeGoalId: 'G001',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'in_progress',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: ['ultragoal'] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; path?: string; source?: string }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, true);
      assert.equal(statuses.ultragoal?.phase, 'in_progress');
      assert.equal(statuses.ultragoal?.path, join(wd, '.omx', 'ultragoal', 'goals.json'));
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports reconciled task-scoped aggregate ultragoal artifacts as inactive in get-status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-reconciled-'));
    try {
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          aggregateCompletion: {
            status: 'complete',
            completedAt: '2026-06-01T12:00:00.000Z',
            evidence: 'task-scoped Codex aggregate completed and active microgoal row was reconciled',
          },
          activeGoalId: 'G002',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'complete',
            completedAt: '2026-06-01T12:00:00.000Z',
          }, {
            id: 'G002',
            title: 'Still marked running',
            objective: 'Progress-only row left running by the old aggregate path.',
            status: 'in_progress',
          }, {
            id: 'G003',
            title: 'Still marked pending',
            objective: 'Progress-only row left pending by the old aggregate path.',
            status: 'pending',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; path?: string; source?: string; data?: { activeGoal?: unknown; inProgress?: number; pending?: number; complete?: number } }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, false);
      assert.equal(statuses.ultragoal?.phase, 'complete');
      assert.equal(statuses.ultragoal?.path, join(wd, '.omx', 'ultragoal', 'goals.json'));
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
      assert.equal(statuses.ultragoal?.data?.activeGoal, undefined);
      assert.equal(statuses.ultragoal?.data?.complete, 1);
      assert.equal(statuses.ultragoal?.data?.inProgress, 1);
      assert.equal(statuses.ultragoal?.data?.pending, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers active ultragoal artifacts over stale inactive mode state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-stale-state-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'ultragoal-state.json'),
        JSON.stringify({ active: false, current_phase: 'cleared' }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          activeGoalId: 'G001',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'in_progress',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: ['ultragoal'] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; source?: string }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, true);
      assert.equal(statuses.ultragoal?.phase, 'in_progress');
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not let workspace Ultragoal artifacts override a committed authority state decision', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-authoritative-ultragoal-'));
    try {
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ultragoal',
        active: false,
        current_phase: 'cleared',
      });
      assert.equal(established.isError, undefined);
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          activeGoalId: 'G001',
          goals: [{ id: 'G001', title: 'Forged compatibility artifact', status: 'in_progress' }],
        }),
      );

      const active = await executeStateOperation('state_list_active', { workingDirectory: wd });
      const status = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (status.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; source?: string }>;
      }).statuses || {};

      assert.deepEqual(active.payload, { active_modes: [] });
      assert.equal(statuses.ultragoal?.active, false);
      assert.equal(statuses.ultragoal?.phase, 'cleared');
      assert.equal(statuses.ultragoal?.source, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not treat root fallback as active for explicit session list-active decisions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-active-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralph',
          current_phase: 'executing',
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'missing-session',
      });

      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        session_id: 'missing-session',
        mode: 'ralph',
      });
      assert.deepEqual(readResponse.payload, { exists: false, mode: 'ralph' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps missing state_read side-effect-free without setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-readonly-missing-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { exists: false, mode: 'deep-interview' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('requires a committed authority before a raw standalone state mutation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-resolve-only-'));
    try {
      const response = await executeStateOperationRaw('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: true,
      });
      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error), /requires a committed active authority/i);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'authority')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('bootstraps tmux-hook from the current tmux pane for mutating state operations', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-live-'));
    try {
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      const fakeBin = await createFakeTmuxBin(wd);

      await withAmbientTmuxEnv(
        {
          TMUX: '/tmp/maintainer-default,123,0',
          TMUX_PANE: '%777',
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
        },
        async () => {
          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'deep-interview',
          });
          assert.equal(response.isError, undefined);
          assert.equal((response.payload as { success?: boolean }).success, true);
        },
      );

      const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
        target?: { type?: string; value?: string };
      };
      assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads deep-interview state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-readwrite-'));
    try {
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: true,
        current_phase: 'deep-interview',
        state: {
          current_focus: 'intent',
          threshold: 0.2,
        },
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(writeResponse.payload, {
        success: true,
        mode: 'deep-interview',
        path: canonicalizeAuthorityPathForCreation(await committedSessionStatePath(wd, 'deep-interview-state.json')),
      });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'deep-interview');
      assert.equal(readBody.current_focus, 'intent');
      assert.equal(readBody.threshold, 0.2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('normalizes terminal deep-interview snapshots by releasing stale locks', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-di-terminal-normalize-'));
    try {
      const completedAt = '2026-07-09T00:00:00.000Z';
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: false,
        current_phase: 'cancelled',
        completed_at: completedAt,
        input_lock: {
          active: true,
          owner: 'question-round',
        },
        approval_lock: {
          status: 'pending',
          reviewer: 'user',
        },
        question_enforcement: {
          obligation_id: 'obligation-stale',
          source: 'omx-question',
          status: 'pending',
          lifecycle_outcome: 'askuserQuestion',
          requested_at: '2026-07-08T23:59:00.000Z',
        },
      });

      assert.equal(writeResponse.isError, undefined);

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const readBody = readResponse.payload as Record<string, unknown>;
      const inputLock = readBody.input_lock as Record<string, unknown>;
      const approvalLock = readBody.approval_lock as Record<string, unknown>;
      const questionEnforcement = readBody.question_enforcement as Record<string, unknown>;

      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cancelled');
      assert.equal(readBody.completed_at, completedAt);
      assert.equal(readBody.run_outcome, 'cancelled');
      assert.equal(inputLock.active, false);
      assert.equal(inputLock.status, 'released');
      assert.equal(inputLock.released_at, completedAt);
      assert.equal(approvalLock.active, false);
      assert.equal(approvalLock.status, 'released');
      assert.equal(inputLock.release_reason, 'terminal_state_normalization');
      assert.equal(questionEnforcement.status, 'cleared');
      assert.equal(questionEnforcement.clear_reason, 'abort');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads autoresearch state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autoresearch-'));
    try {
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(writeResponse.payload, {
        success: true,
        mode: 'autoresearch',
        path: canonicalizeAuthorityPathForCreation(await committedSessionStatePath(wd, 'autoresearch-state.json')),
      });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'autoresearch',
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'running');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('lists active modes from the explicit session scope without leaking a sibling Ralph session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-foreign-ralph-scope-'));
    try {
      const currentSessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-current');
      const foreignSessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-foreign');
      await mkdir(currentSessionDir, { recursive: true });
      await mkdir(foreignSessionDir, { recursive: true });
      await writeFile(
        join(foreignSessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, current_phase: 'executing' }, null, 2),
      );

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-current',
      });

      assert.deepEqual(response.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('isolates same workflow state across explicit session ids when starting and clearing one session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-same-workflow-isolation-'));
    try {
      const writeA = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-a',
        mode: 'ralph',
        active: true,
        iteration: 1,
        max_iterations: 5,
        current_phase: 'executing',
        state: { task_slug: 'session-a-task' },
      });
      assert.equal(writeA.isError, undefined);

      const sessionAStatePath = join(wd, '.omx', 'state', 'sessions', 'sess-a', 'ralph-state.json');
      const sessionACanonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-a', 'skill-active-state.json');
      const sessionAStateBefore = JSON.parse(await readFile(sessionAStatePath, 'utf-8')) as Record<string, unknown>;
      const sessionACanonicalBefore = JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')) as Record<string, unknown>;

      const writeB = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-b',
        mode: 'ralph',
        active: true,
        iteration: 1,
        max_iterations: 5,
        current_phase: 'executing',
        state: { task_slug: 'session-b-task' },
      });
      assert.equal(writeB.isError, undefined);

      assert.deepEqual(JSON.parse(await readFile(sessionAStatePath, 'utf-8')), sessionAStateBefore);
      assert.deepEqual(JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')), sessionACanonicalBefore);

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        session_id: 'sess-b',
        mode: 'ralph',
      });

      const activeA = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-a',
      });
      assert.deepEqual(activeA.payload, { active_modes: ['ralph'] });

      const activeB = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-b',
      });
      assert.deepEqual(activeB.payload, { active_modes: [] });

      assert.deepEqual(JSON.parse(await readFile(sessionAStatePath, 'utf-8')), sessionAStateBefore);
      assert.deepEqual(JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')), sessionACanonicalBefore);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes independently coordinated concurrent state_write calls per mode file and preserves merged fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-concurrency-'));
    try {
      const writes = Array.from({ length: 16 }, (_, i) =>
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          state: { [`k${i}`]: i },
        }),
      );

      const responses = await Promise.all(writes);
      for (const response of responses) {
        assert.equal(response.isError, undefined);
      }

      const filePath = await committedSessionStatePath(wd, 'team-state.json');
      const state = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      for (let i = 0; i < 16; i++) {
        assert.equal(state[`k${i}`], i);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails reads, list-active, and status closed when a committed authority anchor is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-ops-malformed-authority-'));
    try {
      const wd = join(root, 'workspace');
      const ambientStateRoot = join(root, 'ambient-state');
      await mkdir(wd, { recursive: true });
      await mkdir(ambientStateRoot, { recursive: true });
      await writeFile(
        join(ambientStateRoot, 'deep-interview-state.json'),
        JSON.stringify({ active: true, current_phase: 'legacy-ambient' }),
      );

      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: true,
        current_phase: 'authoritative',
      });
      assert.equal(established.isError, undefined);
      await writeFile(join(wd, '.omx', 'bootstrap', 'state-authority-anchor.json'), '{ malformed');

      await withStateRootEnv({ OMX_TEAM_STATE_ROOT: ambientStateRoot }, async () => {
        const read = await executeStateOperation('state_read', {
          workingDirectory: wd,
          mode: 'deep-interview',
        });
        const active = await executeStateOperation('state_list_active', { workingDirectory: wd });
        const status = await executeStateOperation('state_get_status', { workingDirectory: wd });

        for (const response of [read, active, status]) {
          assert.equal(response.isError, true);
          assert.match((response.payload as { error: string }).error, /authority JSON is invalid/);
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the committed state root is replaced', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-replaced-authority-root-'));
    try {
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: true,
        current_phase: 'authoritative',
      });
      assert.equal(established.isError, undefined);

      const stateRoot = join(wd, '.omx', 'state');
      await rm(stateRoot, { recursive: true, force: true });
      await mkdir(stateRoot, { recursive: true });
      await writeFile(
        join(stateRoot, 'deep-interview-state.json'),
        JSON.stringify({ active: true, current_phase: 'replacement' }),
      );

      const response = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(response.isError, true);
      assert.match((response.payload as { error: string }).error, /fingerprint changed/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails a committed read closed when the state root is replaced after scope resolution', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-read-root-swap-'));
    const stateRoot = join(wd, '.omx', 'state');
    const displacedStateRoot = join(wd, '.omx', 'state-before-read');
    try {
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      setStateOperationTestHooksForTests({
        async barrier(point) {
          if (point !== 'before_state_read') return;
          await rename(stateRoot, displacedStateRoot);
          await mkdir(stateRoot, { recursive: true });
          await writeFile(
            join(stateRoot, 'team-state.json'),
            JSON.stringify({ active: true, current_phase: 'replacement-root' }),
          );
        },
      });

      const response = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error), /persisted active state-root identity|fingerprint/);
    } finally {
      setStateOperationTestHooksForTests();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves malformed canonical workflow and skill state instead of overwriting either during a mutation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-malformed-canonical-preflight-'));
    const stateRoot = join(wd, '.omx', 'state');
    let workflowPath: string;
    let skillStatePath: string;
    try {
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      workflowPath = await committedSessionStatePath(wd, 'team-state.json');
      skillStatePath = await committedSessionStatePath(wd, 'skill-active-state.json');

      await writeFile(workflowPath, '{ malformed workflow state');
      const workflowDenied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'must-not-overwrite',
      });
      assert.equal(workflowDenied.isError, true);
      assert.match(String((workflowDenied.payload as { error?: unknown }).error), /malformed JSON/);
      assert.equal(await readFile(workflowPath, 'utf-8'), '{ malformed workflow state');

      await writeFile(workflowPath, JSON.stringify({ active: true, current_phase: 'baseline' }));
      await writeFile(skillStatePath, '{ malformed canonical skill state');
      const skillDenied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: false,
        current_phase: 'cleared',
      });
      assert.equal(skillDenied.isError, true);
      assert.match(String((skillDenied.payload as { error?: unknown }).error), /canonical skill state contains malformed JSON/);
      assert.equal(await readFile(skillStatePath, 'utf-8'), '{ malformed canonical skill state');
      assert.equal((JSON.parse(await readFile(workflowPath, 'utf-8')) as { current_phase?: string }).current_phase, 'baseline');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not commit a prepared write into a root replaced at the atomic-write boundary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-write-root-swap-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const parkedStateRoot = join(wd, '.omx', 'state-before-write-boundary');
      const statePath = join(stateRoot, 'team-state.json');
      const barrierDir = join(wd, 'barrier');
      const point = 'before_state_write';
      await mkdir(barrierDir, { recursive: true });
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);

      const pending = executeStateOperationInChild(
        new URL('../operations.js', import.meta.url).href,
        'state_write',
        { workingDirectory: wd, mode: 'team', active: true, current_phase: 'must-not-reach-replacement' },
        {
          OMX_STATE_OPERATION_TEST_BARRIER_DIR: barrierDir,
          OMX_STATE_OPERATION_TEST_BARRIER_POINT: point,
        },
      );
      await waitForFile(join(barrierDir, `${point}.reached`));
      await rename(stateRoot, parkedStateRoot);
      await mkdir(stateRoot, { recursive: true });
      await writeFile(statePath, JSON.stringify({ active: true, current_phase: 'replacement-root' }));
      await writeFile(join(barrierDir, `${point}.release`), 'release');

      const response = await pending;
      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error), /persisted active state-root identity|fingerprint/);
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'replacement-root',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('tombstones a clear intent before durable deletion and commits it only after every effect', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-clear-tombstone-'));
    try {
      let statePath: string;
      const written = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(written.isError, undefined);
      statePath = await committedSessionStatePath(wd, 'team-state.json');
      assert.equal(existsSync(statePath), true);

      const cleared = await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'team',
      });
      assert.equal(cleared.isError, undefined);
      assert.equal(existsSync(statePath), false);

      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event: { kind?: string; stage?: string; operation_id?: string; fencing_token?: number; targets?: string[] };
      });
      const committed = evidence.find((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'committed'
      ));
      assert.ok(committed);
      const operationId = committed.event.operation_id;
      const prepared = evidence.find((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'prepared'
        && record.event.operation_id === operationId
      ));
      assert.ok(prepared);
      assert.equal(prepared.event.fencing_token, committed.event.fencing_token);
      assert.ok(prepared.event.targets?.includes(canonicalizeAuthorityPathForCreation(statePath)));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('retains a prepared clear tombstone when a destructive deletion may have started', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-clear-fault-'));
    try {
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'authoritative',
      });
      assert.equal(established.isError, undefined);

      const target = await committedSessionStatePath(wd, 'team-state.json');
      assert.equal(existsSync(target), true);
      const response = await withStateOperationFault(
        'after_first_state_clear_effect',
        () => executeStateOperation('state_clear', {
          workingDirectory: wd,
          mode: 'team',
          all_sessions: true,
        }),
      );
      assert.equal(response.isError, true);
      assert.match((response.payload as { error: string }).error, /injected state operation crash/);
      assert.equal(existsSync(target), false);

      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event: { kind?: string; stage?: string; operation_id?: string; targets?: string[] };
      });
      const prepared = evidence.find((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'prepared'
      ));
      assert.ok(prepared);
      assert.ok(prepared.event.targets?.includes(canonicalizeAuthorityPathForCreation(target)));
      assert.equal(evidence.some((record) => (
        record.event.kind === 'state_clear_tombstone'
        && (record.event.stage === 'committed' || record.event.stage === 'aborted')
        && record.event.operation_id === prepared.event.operation_id
      )), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('aborts a durable write when target validation fails before the atomic file effect', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-write-fault-'));
    try {
      await ensureTestOperationAuthority(wd, undefined);
      const stateRoot = join(wd, '.omx', 'state');
      const statePath = await committedSessionStatePath(wd, 'team-state.json');
      await mkdir(statePath, { recursive: true });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(response.isError, true);
      assert.match((response.payload as { error: string }).error, /regular file|Cannot read team workflow state/);
      assert.equal(existsSync(statePath), true);

      assert.equal(
        existsSync(join(stateRoot, 'authority', 'state-authority-tombstones.jsonl')),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies copied predecessor prepared evidence after an alternate-root authority rollover', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-predecessor-evidence-'));
    const runRoot = await mkdtemp(join(tmpdir(), 'omx-state-ops-successor-root-'));
    try {
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'predecessor-prepared',
        })
      ));
      assert.equal(faulted.isError, true);

      const predecessorEvidencePath = join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl');
      const predecessorPrepared = (await readFile(predecessorEvidencePath, 'utf-8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: { kind?: string; stage?: string } })
        .find((record) => (
          record.event?.kind === 'state_write_transaction'
          && record.event.stage === 'prepared'
        ));
      assert.ok(predecessorPrepared);

      const predecessor = await resolveStateAuthorityForGuard({
        startup_cwd: wd,
        observed_cwd: wd,
      });
      const successor = await rolloverStateAuthorityToAlternateRoot({
        context: predecessor,
        proposed_state_root: join(runRoot, '.omx', 'state'),
        creation_root: runRoot,
        launch_id: 'state-operation-successor-rollover',
        consumer_kind: 'madmax',
        issuer: {
          kind: 'first-party-launcher',
          package_version: 'test',
          package_digest: 'a'.repeat(64),
        },
      });
      assert.notEqual(successor.generation.generation_id, predecessor.generation.generation_id);

      const successorEvidencePath = join(
        successor.canonical_state_root,
        'authority',
        'state-authority-tombstones.jsonl',
      );
      await mkdir(dirname(successorEvidencePath), { recursive: true });
      await writeFile(successorEvidencePath, `${JSON.stringify(predecessorPrepared)}\n`);

      const denied = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(denied.isError, true);
      assert.match(
        String((denied.payload as { error?: unknown }).error),
        /does not belong to the active state root lineage/,
      );
      assert.equal(existsSync(join(successor.canonical_state_root, 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('does not replay a predecessor prepared write into a changed committed session scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-historical-evidence-'));
    try {
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'historical-prepared',
        })
      ));
      assert.equal(faulted.isError, true);

      const predecessor = await resolveStateAuthorityForGuard({
        startup_cwd: wd,
        observed_cwd: wd,
      });
      const predecessorGeneration = JSON.parse(
        await readFile(predecessor.authority_path, 'utf-8'),
      ) as Record<string, unknown>;
      await writeFile(predecessor.authority_path, `${JSON.stringify({
        ...predecessorGeneration,
        created_by_pid: 2147483001,
        created_by_process_started_at: 'linux:1',
        created_by_boot_id: 'retired-owner',
        created_by_command_digest: 'a'.repeat(64),
      })}\n`);

      const successor = await initializeStateAuthority({
        startup_cwd: wd,
        launch_id: 'state-operation-same-root-successor',
        session_binding: { canonical_session_id: 'state-operation-same-root-successor' },
      });
      assert.notEqual(successor.generation.generation_id, predecessor.generation.generation_id);
      assert.equal(successor.canonical_state_root, predecessor.canonical_state_root);

      const statePath = await committedSessionStatePath(
        wd,
        'team-state.json',
        predecessor.session_binding?.canonical_session_id,
      );
      const recovered = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        session_id: 'state-operation-same-root-successor',
      });
      assert.equal(recovered.isError, undefined);
      assert.equal(
        existsSync(await committedSessionStatePath(wd, 'team-state.json', 'state-operation-same-root-successor')),
        false,
      );
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'historical-prepared',
      );
      const evidence = (await readFile(
        join(successor.canonical_state_root, 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').map((line) => JSON.parse(line) as {
        event?: { kind?: string; stage?: string; operation_id?: string; recovery_args?: { current_phase?: unknown } };
      });
      const prepared = evidence.find((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.recovery_args?.current_phase === 'historical-prepared'
      ));
      const preparedOperationId = prepared?.event?.operation_id;
      assert.ok(preparedOperationId);
      assert.equal(evidence.some((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'committed'
        && record.event.operation_id === preparedOperationId
      )), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replays a locally proven same-root predecessor prepared clear through generation rollover', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-historical-clear-'));
    try {
      const statePath = join(wd, '.omx', 'state', 'team-state.json');
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(established.isError, undefined);
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_clear', { workingDirectory: wd, mode: 'team' })
      ));
      assert.equal(faulted.isError, true);
      assert.equal(existsSync(statePath), false);

      const predecessor = await resolveStateAuthorityForGuard({
        startup_cwd: wd,
        observed_cwd: wd,
      });
      const predecessorGeneration = JSON.parse(
        await readFile(predecessor.authority_path, 'utf-8'),
      ) as Record<string, unknown>;
      await writeFile(predecessor.authority_path, `${JSON.stringify({
        ...predecessorGeneration,
        created_by_pid: 2147483001,
        created_by_process_started_at: 'linux:1',
        created_by_boot_id: 'retired-owner',
        created_by_command_digest: 'a'.repeat(64),
      })}\n`);
      const successor = await initializeStateAuthority({
        startup_cwd: wd,
        launch_id: 'state-operation-same-root-clear-successor',
        session_binding: { canonical_session_id: 'state-operation-same-root-clear-session' },
      });

      const recovered = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(recovered.isError, undefined);
      assert.equal(existsSync(statePath), false);
      const evidence = (await readFile(
        join(successor.canonical_state_root, 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').map((line) => JSON.parse(line) as {
        event?: { kind?: string; stage?: string; operation_id?: string };
      });
      const prepared = evidence.find((record) => (
        record.event?.kind === 'state_clear_tombstone'
        && record.event.stage === 'prepared'
      ));
      const preparedOperationId = prepared?.event?.operation_id;
      assert.ok(preparedOperationId);
      assert.equal(evidence.some((record) => (
        record.event?.kind === 'state_clear_tombstone'
        && record.event.stage === 'committed'
        && record.event.operation_id === preparedOperationId
      )), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('repairs one torn evidence tail before replaying and accepting the next mutation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-torn-evidence-tail-'));
    try {
      let statePath: string;
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'prepared-before-torn-tail',
        })
      ));
      assert.equal(faulted.isError, true);
      statePath = await committedSessionStatePath(wd, 'team-state.json');

      const evidencePath = join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl');
      const evidenceBeforeRepair = (await readFile(evidencePath, 'utf-8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: { kind?: string; stage?: string; operation_id?: string } });
      const prepared = evidenceBeforeRepair.find((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
      ));
      const preparedOperationId = prepared?.event?.operation_id;
      assert.ok(preparedOperationId);
      await writeFile(evidencePath, '{"schema_version":', { flag: 'a' });

      const recovered = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(recovered.isError, undefined);
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'prepared-before-torn-tail',
      );

      const repairedContent = await readFile(evidencePath, 'utf-8');
      assert.match(repairedContent, /\n$/);
      const repairedEvidence = repairedContent.trim().split('\n').map((line) => JSON.parse(line) as {
        event?: { kind?: string; stage?: string; operation_id?: string };
      });
      assert.equal(repairedEvidence.some((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'committed'
        && record.event.operation_id === preparedOperationId
      )), true);

      const nextWrite = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'after-torn-tail-repair',
      });
      assert.equal(nextWrite.isError, undefined);
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'after-torn-tail-repair',
      );
      for (const line of (await readFile(evidencePath, 'utf-8')).trim().split('\n')) {
        JSON.parse(line);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies malformed interior evidence instead of treating it as a recoverable tail', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-malformed-interior-evidence-'));
    try {
      const written = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(written.isError, undefined);

      const evidencePath = join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl');
      const firstEvidenceLine = (await readFile(evidencePath, 'utf-8')).split('\n').find(Boolean);
      assert.ok(firstEvidenceLine);
      await writeFile(evidencePath, `{ malformed interior evidence\n${firstEvidenceLine}\n`, { flag: 'a' });

      const denied = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(denied.isError, true);
      assert.match(
        String((denied.payload as { error?: unknown }).error),
        /state operation evidence contains invalid JSON/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies current-generation recovery evidence without a valid historical fence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-invalid-evidence-fence-'));
    try {
      const written = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(written.isError, undefined);

      const statePath = await committedSessionStatePath(wd, 'team-state.json');
      const evidencePath = join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl');
      const firstEvidenceLine = (await readFile(evidencePath, 'utf-8')).split('\n').find(Boolean);
      assert.ok(firstEvidenceLine);
      const malformedEvidence = JSON.parse(firstEvidenceLine) as { event: Record<string, unknown> };
      malformedEvidence.event = {
        kind: 'state_write_transaction',
        stage: 'prepared',
        operation_id: 'state-operation-missing-fence',
        mode: 'team',
        targets: [statePath],
        recovery_args: {
          mode: 'team',
          active: true,
          current_phase: 'must-not-replay',
        },
      };
      await writeFile(evidencePath, `${JSON.stringify(malformedEvidence)}\n`, { flag: 'a' });

      const denied = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(denied.isError, true);
      assert.match(
        String((denied.payload as { error?: unknown }).error),
        /fence outside (?:the current|its referenced) authority generation/,
      );
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'baseline',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies state-write recovery when persisted targets differ from the active authority scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-mismatched-write-targets-'));
    try {
      let statePath: string;
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'prepared-write',
        })
      ));
      assert.equal(faulted.isError, true);
      statePath = await committedSessionStatePath(wd, 'team-state.json');

      const evidencePath = join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl');
      const preparedLine = (await readFile(evidencePath, 'utf-8'))
        .split('\n')
        .find((line) => line.includes('"stage":"prepared"'));
      assert.ok(preparedLine);
      const tamperedEvidence = JSON.parse(preparedLine) as { event: Record<string, unknown> };
      tamperedEvidence.event = {
        ...tamperedEvidence.event,
        targets: [join(wd, '.omx', 'state', 'other-team-state.json')],
      };
      await writeFile(evidencePath, `${JSON.stringify(tamperedEvidence)}\n`, { flag: 'a' });

      const denied = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(denied.isError, true);
      assert.match(
        String((denied.payload as { error?: unknown }).error),
        /prepared state write (?:recovery does not match the requested operation targets|target is not an allowed state file)/,
      );
      assert.equal(existsSync(join(wd, '.omx', 'state', 'other-team-state.json')), false);
      assert.equal(
        (JSON.parse(await readFile(statePath, 'utf-8')) as { current_phase?: string }).current_phase,
        'prepared-write',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies native-stop clears with malformed root or session participant state until recovery can reconcile both', async () => {
    for (const malformedCase of ['root-json', 'session-sessions'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-native-stop-${malformedCase}-`));
      try {
        const sessionId = `sess-native-stop-${malformedCase}`;
        const stateRoot = join(wd, '.omx', 'state');
        const rootNativeStopPath = join(stateRoot, 'native-stop-state.json');
        const sessionNativeStopPath = join(stateRoot, 'sessions', sessionId, 'native-stop-state.json');
        const validNativeStopState = JSON.stringify({
          sessions: {
            [sessionId]: { stopped: true },
          },
        }, null, 2);
        const written = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'team',
          active: true,
          current_phase: 'running',
        });
        assert.equal(written.isError, undefined);
        await writeFile(
          rootNativeStopPath,
          malformedCase === 'root-json' ? '{ malformed native stop' : validNativeStopState,
        );
        await writeFile(
          sessionNativeStopPath,
          malformedCase === 'session-sessions'
            ? JSON.stringify({ sessions: [] }, null, 2)
            : validNativeStopState,
        );
        const rootBeforeClear = await readFile(rootNativeStopPath, 'utf-8');
        const sessionBeforeClear = await readFile(sessionNativeStopPath, 'utf-8');

        const denied = await executeStateOperation('state_clear', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'team',
        });
        assert.equal(denied.isError, true);
        assert.match(
          String((denied.payload as { error?: unknown }).error),
          malformedCase === 'root-json' ? /malformed JSON/ : /malformed sessions container/,
        );
        assert.equal(await readFile(rootNativeStopPath, 'utf-8'), rootBeforeClear);
        assert.equal(await readFile(sessionNativeStopPath, 'utf-8'), sessionBeforeClear);

        const evidencePath = join(stateRoot, 'authority', 'state-authority-tombstones.jsonl');
        const evidence = (await readFile(evidencePath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line) as {
          event?: { kind?: string; stage?: string; operation_id?: string };
        });
        const prepared = evidence.find((record) => (
          record.event?.kind === 'state_clear_tombstone'
          && record.event.stage === 'prepared'
        ));
        const preparedOperationId = prepared?.event?.operation_id;
        assert.ok(preparedOperationId);
        assert.equal(evidence.some((record) => (
          (record.event?.stage === 'committed' || record.event?.stage === 'aborted')
          && record.event.operation_id === preparedOperationId
        )), false);

        await writeFile(rootNativeStopPath, validNativeStopState);
        await writeFile(sessionNativeStopPath, validNativeStopState);
        const recovered = await executeStateOperation('state_get_status', { workingDirectory: wd });
        assert.equal(recovered.isError, undefined);
        for (const path of [rootNativeStopPath, sessionNativeStopPath]) {
          const state = JSON.parse(await readFile(path, 'utf-8')) as { sessions?: Record<string, unknown> };
          assert.equal(Object.prototype.hasOwnProperty.call(state.sessions, sessionId), false);
        }
        const recoveredEvidence = (await readFile(evidencePath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line) as {
          event?: { kind?: string; stage?: string; operation_id?: string };
        });
        assert.equal(recoveredEvidence.some((record) => (
          record.event?.stage === 'committed'
          && record.event.operation_id === preparedOperationId
        )), true);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('commits prepared A before concurrent B writes so stale recovery cannot overwrite B', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-write-evidence-recovery-'));
    try {
      let statePath: string;
      const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'prepared-state',
        })
      ));
      assert.equal(faulted.isError, true);
      statePath = await committedSessionStatePath(wd, 'team-state.json');
      assert.match((faulted.payload as { error: string }).error, /after_effects_before_committed_evidence/);
      assert.equal(existsSync(statePath), true);

      const [status, successfulWrite] = await Promise.all([
        executeStateOperation('state_get_status', { workingDirectory: wd }),
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'caller-state',
        }),
      ]);
      assert.equal(status.isError, undefined, JSON.stringify(status.payload));
      assert.equal(successfulWrite.isError, undefined, JSON.stringify(successfulWrite.payload));
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(state.current_phase, 'caller-state');

      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event: {
          kind?: string;
          stage?: string;
          operation_id?: string;
          targets?: string[];
          recovery_args?: { current_phase?: unknown };
        };
      });
      const originalPreparedIndex = evidence.findIndex((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.recovery_args?.current_phase === 'prepared-state'
        && record.event.targets?.includes(canonicalizeAuthorityPathForCreation(statePath))
      ));
      const callerPreparedIndex = evidence.findIndex((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.recovery_args?.current_phase === 'caller-state'
      ));
      assert.ok(originalPreparedIndex >= 0);
      assert.ok(callerPreparedIndex >= 0);
      const originalPrepared = evidence[originalPreparedIndex];
      const originalCommittedIndex = evidence.findIndex((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'committed'
        && record.event.operation_id === originalPrepared.event.operation_id
      ));
      assert.ok(originalCommittedIndex >= 0);
      assert.ok(originalCommittedIndex < callerPreparedIndex);
      assert.equal(evidence.some((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'aborted'
        && record.event.operation_id === originalPrepared.event.operation_id
      )), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps a cross-process prepared crash inside the newer mutation transaction', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-cross-process-recovery-'));
    try {
      let statePath: string;
      const barrierDir = join(wd, 'barrier');
      const reachedPath = join(barrierDir, 'before_mutation_transaction.reached');
      const releasePath = join(barrierDir, 'before_mutation_transaction.release');
      const operationsModuleUrl = new URL('../operations.js', import.meta.url).href;
      await mkdir(barrierDir, { recursive: true });

      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      statePath = await committedSessionStatePath(wd, 'team-state.json');

      const newerMutation = executeStateOperationInChild(
        operationsModuleUrl,
        'state_write',
        {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'newer-b',
        },
        { OMX_STATE_OPERATION_TEST_BARRIER_DIR: barrierDir },
      );
      await waitForFile(reachedPath);

      const crashedPrepared = await executeStateOperationInChild(
        operationsModuleUrl,
        'state_write',
        {
          workingDirectory: wd,
          mode: 'team',
          active: true,
          current_phase: 'prepared-a',
        },
        { OMX_STATE_OPERATION_FAULT_INJECTION: 'after_effects_before_committed_evidence' },
      );
      assert.equal(crashedPrepared.isError, true);
      assert.equal((await readFile(statePath, 'utf-8')).includes('prepared-a'), true);

      await writeFile(releasePath, 'release');
      const newerResponse = await newerMutation;
      assert.equal(newerResponse.isError, undefined);

      const status = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(status.isError, undefined);
      const finalState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(finalState.current_phase, 'newer-b');

      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event: { kind?: string; stage?: string; operation_id?: string; recovery_args?: { current_phase?: unknown } };
      });
      const preparedA = evidence.find((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.recovery_args?.current_phase === 'prepared-a'
      ));
      assert.ok(preparedA);
      assert.equal(evidence.some((record) => (
        record.event.kind === 'state_write_transaction'
        && record.event.stage === 'committed'
        && record.event.operation_id === preparedA.event.operation_id
      )), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replays prepared operations independently for concurrent workspaces', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'omx-state-ops-recovery-workspace-a-'));
    const workspaceB = await mkdtemp(join(tmpdir(), 'omx-state-ops-recovery-workspace-b-'));
    try {
      for (const workingDirectory of [workspaceA, workspaceB]) {
        const faulted = await withStateOperationFault('after_effects_before_committed_evidence', () => (
          executeStateOperation('state_write', {
            workingDirectory,
            mode: 'team',
            active: true,
            current_phase: 'prepared-state',
          })
        ));
        assert.equal(faulted.isError, true);
      }

      const recovered = await Promise.all([
        executeStateOperation('state_get_status', { workingDirectory: workspaceA }),
        executeStateOperation('state_get_status', { workingDirectory: workspaceB }),
      ]);
      for (const response of recovered) {
        assert.equal(response.isError, undefined);
      }

      for (const workspace of [workspaceA, workspaceB]) {
        const evidence = (await readFile(
          join(workspace, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
          'utf-8',
        )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
          event: { kind?: string; stage?: string; operation_id?: string };
        });
        const preparedIds = evidence
          .filter((record) => record.event.kind === 'state_write_transaction' && record.event.stage === 'prepared')
          .map((record) => record.event.operation_id)
          .filter((operationId): operationId is string => typeof operationId === 'string');
        assert.equal(preparedIds.length, 1);
        for (const operationId of preparedIds) {
          assert.equal(evidence.some((record) => (
            record.event.kind === 'state_write_transaction'
            && record.event.stage === 'committed'
            && record.event.operation_id === operationId
          )), true);
        }
      }
    } finally {
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
    }
  });

  it('replays a partially applied all-sessions clear before admitting the next operation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-clear-recovery-'));
    try {
      const sessionId = 'sess-clear-recovery';
      const lateSessionId = 'sess-created-after-prepare';
      let rootPath: string;
      const sessionPath = join(wd, '.omx', 'state', 'sessions', sessionId, 'team-state.json');
      const latePath = join(wd, '.omx', 'state', 'sessions', lateSessionId, 'team-state.json');

      for (const args of [
        { workingDirectory: wd, mode: 'team', active: true, current_phase: 'running' },
        { workingDirectory: wd, session_id: sessionId, mode: 'team', active: true, current_phase: 'running' },
      ]) {
        const response = await executeStateOperation('state_write', args);
        assert.equal(response.isError, undefined);
      }
      rootPath = await committedSessionStatePath(wd, 'team-state.json');
      assert.equal(existsSync(rootPath), true);
      assert.equal(existsSync(sessionPath), true);

      const faulted = await withStateOperationFault('after_first_state_clear_effect', () => (
        executeStateOperation('state_clear', {
          workingDirectory: wd,
          mode: 'team',
          all_sessions: true,
        })
      ));
      assert.equal(faulted.isError, true);
      assert.equal(existsSync(rootPath), false);
      assert.equal(existsSync(sessionPath), true);
      await mkdir(dirname(latePath), { recursive: true });
      await writeFile(latePath, JSON.stringify({ active: true, current_phase: 'created-after-prepare' }));


      const recovered = await executeStateOperation('state_get_status', { workingDirectory: wd });
      assert.equal(recovered.isError, undefined);
      assert.equal(existsSync(rootPath), false);
      assert.equal(existsSync(sessionPath), false);
      assert.equal(existsSync(latePath), true);
      assert.equal((JSON.parse(await readFile(latePath, 'utf-8')) as { current_phase?: string }).current_phase, 'created-after-prepare');


      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event: { kind?: string; stage?: string; operation_id?: string; all_sessions?: boolean; targets?: string[] };

      });
      const prepared = evidence.find((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'prepared'
        && record.event.all_sessions === true
      ));
      assert.ok(prepared);
      assert.equal(prepared.event.targets?.includes(latePath), false);

      assert.equal(evidence.some((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'committed'
        && record.event.operation_id === prepared.event.operation_id
      )), true);
      assert.equal(evidence.some((record) => (
        record.event.kind === 'state_clear_tombstone'
        && record.event.stage === 'aborted'
        && record.event.operation_id === prepared.event.operation_id
      )), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not read a symlink-replaced operation evidence file after its descriptor-safe read seam', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-evidence-read-race-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const evidencePath = join(stateRoot, 'authority', 'state-authority-tombstones.jsonl');
      const outsideEvidence = join(wd, 'outside-evidence.jsonl');
      const barrierDir = join(wd, 'barrier');
      const point = 'before_state_evidence_read';
      await mkdir(barrierDir, { recursive: true });
      await writeFile(outsideEvidence, 'outside evidence must remain unread\n');
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      const pending = executeStateOperationInChild(
        new URL('../operations.js', import.meta.url).href,
        'state_write',
        { workingDirectory: wd, mode: 'team', active: true, current_phase: 'second' },
        {
          OMX_STATE_OPERATION_TEST_BARRIER_DIR: barrierDir,
          OMX_STATE_OPERATION_TEST_BARRIER_POINT: point,
        },
      );
      await waitForFile(join(barrierDir, `${point}.reached`));
      await rm(evidencePath);
      await symlink(outsideEvidence, evidencePath, 'file');
      await writeFile(join(barrierDir, `${point}.release`), 'release');
      const response = await pending;
      assert.equal(response.isError, true);
      assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside evidence must remain unread\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not append to a symlink-replaced operation evidence file after its descriptor-safe append seam', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-evidence-append-race-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const evidencePath = join(stateRoot, 'authority', 'state-authority-tombstones.jsonl');
      const outsideEvidence = join(wd, 'outside-evidence.jsonl');
      const barrierDir = join(wd, 'barrier');
      const point = 'before_state_evidence_append';
      await mkdir(barrierDir, { recursive: true });
      await writeFile(outsideEvidence, 'outside evidence must remain unwritten\n');
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      const pending = executeStateOperationInChild(
        new URL('../operations.js', import.meta.url).href,
        'state_write',
        { workingDirectory: wd, mode: 'team', active: true, current_phase: 'second' },
        {
          OMX_STATE_OPERATION_TEST_BARRIER_DIR: barrierDir,
          OMX_STATE_OPERATION_TEST_BARRIER_POINT: point,
        },
      );
      await waitForFile(join(barrierDir, `${point}.reached`));
      await rm(evidencePath);
      await symlink(outsideEvidence, evidencePath, 'file');
      await writeFile(join(barrierDir, `${point}.release`), 'release');
      const response = await pending;
      assert.equal(response.isError, true);
      assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside evidence must remain unwritten\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not delete through a symlink-replaced state target after its descriptor-safe unlink seam', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-unlink-race-'));
    try {
      let statePath: string;
      const outsideState = join(wd, 'outside-state.json');
      const barrierDir = join(wd, 'barrier');
      const point = 'before_state_unlink';
      await mkdir(barrierDir, { recursive: true });
      await writeFile(outsideState, 'outside state must remain undeleted\n');
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'baseline',
      });
      assert.equal(established.isError, undefined);
      statePath = await committedSessionStatePath(wd, 'team-state.json');
      const pending = executeStateOperationInChild(
        new URL('../operations.js', import.meta.url).href,
        'state_clear',
        { workingDirectory: wd, mode: 'team' },
        {
          OMX_STATE_OPERATION_TEST_BARRIER_DIR: barrierDir,
          OMX_STATE_OPERATION_TEST_BARRIER_POINT: point,
        },
      );
      await waitForFile(join(barrierDir, `${point}.reached`));
      await rm(statePath);
      await symlink(outsideState, statePath, 'file');
      await writeFile(join(barrierDir, `${point}.release`), 'release');
      const response = await pending;
      assert.equal(response.isError, true);
      assert.equal(await readFile(outsideState, 'utf8'), 'outside state must remain undeleted\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('rejects a sessions symlink for session reads, writes, and all-session enumeration', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-sessions-symlink-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const outside = join(wd, 'outside');
      const sessionId = 'sess-symlink';
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(established.isError, undefined);
      await rm(join(stateRoot, 'sessions'), { recursive: true, force: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(stateRoot, 'sessions'), 'dir');

      const write = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      const read = await executeStateOperation('state_read', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'team',
      });
      const clear = await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'team',
        all_sessions: true,
      });

      for (const response of [write, read, clear]) {
        assert.equal(response.isError, true);
        assert.match((response.payload as { error: string }).error, /symbolic link/);
      }
      assert.equal(existsSync(join(outside, sessionId, 'team-state.json')), false);
      assert.equal(existsSync(await committedSessionStatePath(wd, 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects symlinked mode files for reads, status/list enumeration, and workflow-state inspection', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-mode-file-symlink-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const outside = join(wd, 'outside');
      let teamPath: string;
      const established = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(established.isError, undefined);
      teamPath = await committedSessionStatePath(wd, 'team-state.json');
      await mkdir(outside, { recursive: true });
      const outsideTeamState = join(outside, 'team-state.json');
      await writeFile(outsideTeamState, JSON.stringify({ active: true, current_phase: 'outside-root' }));
      await rm(teamPath);
      await symlink(outsideTeamState, teamPath, 'file');

      const read = await executeStateOperation('state_read', { workingDirectory: wd, mode: 'team' });
      const status = await executeStateOperation('state_get_status', { workingDirectory: wd });
      const list = await executeStateOperation('state_list_active', { workingDirectory: wd });
      for (const response of [read, status, list]) {
        assert.equal(response.isError, true);
        assert.match((response.payload as { error: string }).error, /symbolic link/);
      }
      assert.equal((JSON.parse(await readFile(outsideTeamState, 'utf-8')) as { current_phase?: string }).current_phase, 'outside-root');

      const sessionId = 'sess-workflow-symlink';
      const deepInterview = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'deep-interview',
        active: true,
        current_phase: 'running',
      });
      assert.equal(deepInterview.isError, undefined);
      const sessionDir = join(stateRoot, 'sessions', sessionId);
      const deepInterviewPath = join(sessionDir, 'deep-interview-state.json');
      const outsideDeepInterview = join(outside, 'deep-interview-state.json');
      await writeFile(outsideDeepInterview, JSON.stringify({ active: true, current_phase: 'outside-workflow' }));
      await rm(deepInterviewPath);
      await symlink(outsideDeepInterview, deepInterviewPath, 'file');
      await rm(join(stateRoot, 'skill-active-state.json'), { force: true });
      await rm(join(sessionDir, 'skill-active-state.json'), { force: true });

      const workflow = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      });
      assert.equal(workflow.isError, true);
      assert.match((workflow.payload as { error: string }).error, /symbolic link/);
      assert.equal((JSON.parse(await readFile(outsideDeepInterview, 'utf-8')) as { current_phase?: string }).current_phase, 'outside-workflow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('journals the exact auto-complete source before reconciling a workflow transition', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-transition-targets-'));
    try {
      const sessionId = 'sess-transition-targets';
      const stateRoot = join(wd, '.omx', 'state');
      const deepInterviewPath = join(stateRoot, 'sessions', sessionId, 'deep-interview-state.json');
      const activated = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'deep-interview',
        active: true,
        current_phase: 'interviewing',
        deep_interview_gate: {
          status: 'skipped',
          source: 'test',
          session_id: sessionId,
          skip_authorized_by_user: true,
          reason: 'test transition inventory',
          skipped_at: '2026-07-13T00:00:00.000Z',
        },
      });
      assert.equal(activated.isError, undefined);

      const transitioned = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      });
      assert.equal(transitioned.isError, undefined);
      const evidence = (await readFile(
        join(stateRoot, 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event?: { kind?: string; stage?: string; mode?: string; targets?: string[] };
      });
      const prepared = evidence.find((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.mode === 'ralplan'
      ));
      assert.ok(prepared);
      assert.equal(prepared.event?.targets?.includes(canonicalizeAuthorityPathForCreation(deepInterviewPath)), true);
      const deepInterview = JSON.parse(await readFile(deepInterviewPath, 'utf-8')) as { active?: boolean };
      assert.equal(deepInterview.active, false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects a transition source symlink without touching its external target', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-transition-source-symlink-'));
    try {
      const sessionId = 'sess-transition-source-symlink';
      const stateRoot = join(wd, '.omx', 'state');
      const deepInterviewPath = join(stateRoot, 'sessions', sessionId, 'deep-interview-state.json');
      const outsidePath = join(wd, 'outside-deep-interview.json');
      const activated = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'deep-interview',
        active: true,
        current_phase: 'interviewing',
        deep_interview_gate: {
          status: 'skipped',
          source: 'test',
          session_id: sessionId,
          skip_authorized_by_user: true,
          reason: 'test source symlink',
          skipped_at: '2026-07-13T00:00:00.000Z',
        },
      });
      assert.equal(activated.isError, undefined);
      await writeFile(outsidePath, JSON.stringify({ active: true, current_phase: 'outside' }));
      await rm(deepInterviewPath);
      await symlink(outsidePath, deepInterviewPath, 'file');

      const transition = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      });
      assert.equal(transition.isError, true);
      assert.match(String((transition.payload as { error?: string }).error || ''), /symbolic link/);
      assert.equal((JSON.parse(await readFile(outsidePath, 'utf-8')) as { current_phase?: string }).current_phase, 'outside');
      assert.equal(existsSync(join(stateRoot, 'sessions', sessionId, 'ralplan-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('does not report a legacy root mode active after clearing the current session scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-clear-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-clear';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'legacy-root' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'session-active' }, null, 2),
      );
      await ensureTestOperationAuthority(wd, sessionId);

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(existsSync(join(sessionDir, 'deep-interview-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'deep-interview-state.json')), true);

      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, false);
      assert.equal(sessionState.current_phase, 'cleared');

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string }>;
      }).statuses || {};
      assert.equal(statuses['deep-interview']?.active, false);
      assert.equal(statuses['deep-interview']?.phase, 'cleared');

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cleared');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('all_sessions clear removes session-only canonical workflow state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-all-sessions-session-only-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-only');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralph',
          session_id: 'sess-only',
          active_skills: [{ skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-only' }],
        }, null, 2),
      );

      const cleared = await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'ralph',
        all_sessions: true,
      });
      assert.equal(cleared.isError, undefined);

      assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not list a mode active when terminal canonical visibility contradicts an active detail state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-terminal-canonical-wins-'));
    try {
      const sessionId = 'sess-terminal-visible';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'autopilot',
        phase: 'complete',
        completed_at: '2026-06-09T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });

      assert.deepEqual(response.payload, { active_modes: [] });
      const detailState = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(detailState.active, true);
      assert.equal(detailState.current_phase, 'deep-interview');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses the implicit current session canonical state when filtering list-active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-terminal-canonical-implicit-'));
    try {
      const sessionId = 'sess-terminal-implicit';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'autopilot',
        phase: 'complete',
        completed_at: '2026-06-09T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });

      assert.deepEqual(response.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('syncs canonical skill-active state for tracked mode writes and clears', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-canonical-'));
    try {
      await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-sync',
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      });

      const canonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-sync', 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{
          skill: string;
          phase?: string;
          session_id?: string;
          activated_at?: string;
          updated_at?: string;
        }>;
      };
      assert.deepEqual(canonical.active_skills, [{
        skill: 'autoresearch',
        phase: 'running',
        active: true,
        activated_at: canonical.active_skills?.[0]?.activated_at,
        updated_at: canonical.active_skills?.[0]?.updated_at,
        session_id: 'sess-sync',
      }]);

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        session_id: 'sess-sync',
        mode: 'autoresearch',
      });

      const cleared = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        active_skills?: unknown[];
      };
      assert.equal(cleared.active, false);
      assert.deepEqual(cleared.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes completed ralplan writes across root and current session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-complete-'));
    try {
      const sessionId = 'sess-ralplan-complete';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      const staleSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        updated_at: '2026-06-30T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_architect_review: {
          verdict: 'APPROVE',
          artifact_path: '.omx/plans/architect.md',
        },
        ralplan_critic_review: {
          verdict: 'APPROVE',
          artifact_path: '.omx/plans/critic.md',
        },
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootRalplan, sessionRalplan]) {
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.equal(state.status, 'complete');
        assert.equal(state.terminal_reason, 'consensus approved bounded no-op');
        assert.equal((state.ralplan_consensus_gate as Record<string, unknown>).complete, true);
        assert.equal(state.session_id, sessionId);
      }

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, false);
        assert.equal(state.phase, 'complete');
        assert.equal(state.terminal_reason, 'consensus approved bounded no-op');
        assert.deepEqual(state.active_skills, []);
      }
      assert.equal(sessionSkill.session_id, sessionId);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes ralplan when runtime tracker lags but workspace tracker has completed native reviews', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-runtime-lag-complete-'));
    const stateRoot = wd;
    try {
      await withStateRootEnv({ OMX_STATE_ROOT: stateRoot }, async () => {
        const sessionId = 'sess-ralplan-runtime-lag-complete';
        const runtimeStateDir = join(stateRoot, '.omx', 'state');
        const sessionDir = join(runtimeStateDir, 'sessions', sessionId);
        const workspaceStateDir = join(wd, '.omx', 'state');
        await mkdir(sessionDir, { recursive: true });
        await mkdir(workspaceStateDir, { recursive: true });
        await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
          session_id: sessionId,
          native_session_id: 'thread-leader',
          cwd: wd,
        }, null, 2));
        const consensusGate = ralplanConsensusGate(sessionId, 'native_subagent') as {
          ralplan_architect_review: Record<string, unknown>;
          ralplan_critic_review: Record<string, unknown>;
        };
        consensusGate.ralplan_architect_review.completed_at = '2026-07-07T04:30:00.000Z';
        consensusGate.ralplan_critic_review.completed_at = '2026-07-07T04:31:00.000Z';
        await writeFile(subagentTrackingPath(wd), JSON.stringify({
          schemaVersion: 1,
          sessions: {
            [sessionId]: {
              session_id: sessionId,
              leader_thread_id: 'thread-leader',
              updated_at: '2026-07-07T04:31:00.000Z',
              threads: {
                'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
                'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', turn_count: 1 },
                'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', turn_count: 1 },
              },
            },
          },
        }, null, 2));
        await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify({
          schemaVersion: 1,
          sessions: {
            [sessionId]: {
              session_id: sessionId,
              leader_thread_id: 'thread-leader',
              updated_at: '2026-07-07T04:31:00.000Z',
              threads: {
                'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
                'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', completed_at: '2026-07-07T04:30:00.000Z', turn_count: 1 },
                'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', completed_at: '2026-07-07T04:31:00.000Z', turn_count: 1 },
              },
            },
          },
        }, null, 2));
        await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
          session_id: sessionId,
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: false,
          current_phase: 'complete',
          planning_complete: true,
          latest_plan_path: '.omx/plans/prd-clickstack-otel-consumer-20260707T043000Z.md',
          terminal_reason: 'consensus approved despite runtime tracker lag',
          ralplan_consensus_gate: consensusGate,
        });

        assert.equal(response.isError, undefined, JSON.stringify(response.payload));
        const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(sessionRalplan.active, false);
        assert.equal(sessionRalplan.current_phase, 'complete');
        assert.equal(sessionRalplan.status, 'complete');
        assert.equal(sessionRalplan.terminal_reason, 'consensus approved despite runtime tracker lag');
        assert.equal((sessionRalplan.ralplan_consensus_gate as Record<string, unknown>).complete, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects forged ralplan complete gates before mutating active session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-forged-complete-'));
    try {
      const sessionId = 'sess-ralplan-forged-complete';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: {
          complete: true,
        },
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /tracker-backed native architect and critic consensus evidence/);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ralplan unsupported native non-clean recovery without tracker-backed consensus', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-unsupported-recovery-'));
    try {
      const sessionId = 'sess-ralplan-unsupported-recovery';
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'blocked',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'blocked');
      assert.equal(state.ralplan_consensus_gate, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete without tracker-backed native consensus after unsupported recovery support', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-still-strict-'));
    try {
      const sessionId = 'sess-ralplan-clean-still-strict';
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-unsupported-valid-consensus-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-unsupported-valid-consensus-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with handoff-artifact unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-handoff-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-handoff-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        handoff_artifacts: {
          ralplan: {
            native_subagent_support: {
              status: 'unsupported',
              reason: 'multi_agent_v1_unavailable',
              source: 'post_tool_failure',
            },
          },
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with nested handoff-artifact unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-nested-handoff-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-nested-handoff-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        state: {
          handoff_artifacts: {
            ralplan: {
              native_subagent_support: {
                status: 'unsupported',
                reason: 'multi_agent_v1_unavailable',
                source: 'post_tool_failure',
              },
            },
          },
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with handoff-root unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-handoff-root-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-handoff-root-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        handoff_artifacts: {
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
          ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
        },
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean status alias with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-status-alias-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-status-alias-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        status: 'complete',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('normalizes currentPhase before gating ralplan terminal writes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-current-phase-alias-'));
    try {
      const sessionId = 'sess-ralplan-current-phase-alias';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        currentPhase: 'complete',
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /tracker-backed native architect and critic consensus evidence/);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
      assert.equal(sessionRalplan.currentPhase, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reuses existing tracker-backed ralplan consensus when terminal writes omit gate payload', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-existing-consensus-'));
    try {
      const sessionId = 'sess-ralplan-existing-consensus';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
        ralplan_consensus_gate: consensusGate,
      }, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        terminal_reason: 'existing tracker-backed consensus complete',
      });

      assert.equal(response.isError, undefined);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, false);
      assert.equal(sessionRalplan.current_phase, 'complete');
      const finalGate = sessionRalplan.ralplan_consensus_gate as Record<string, unknown>;
      assert.equal(finalGate.complete, true);
      assert.deepEqual(finalGate.required_review_roles, ['architect', 'critic']);
      assert.equal((finalGate.ralplan_architect_review as Record<string, unknown>).provenance_kind, 'native_subagent');
      assert.equal((finalGate.ralplan_critic_review as Record<string, unknown>).provenance_kind, 'native_subagent');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes completed ralplan updateModeState writes across root and current session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-complete-update-mode-'));
    try {
      const sessionId = 'sess-ralplan-complete-update-mode';
      await initializeStateAuthority({
        startup_cwd: wd,
        observed_cwd: wd,
        launch_id: 'ralplan-update-mode-authority',
        session_binding: { canonical_session_id: sessionId },
      });
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      const staleSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));

      await updateModeState('ralplan', {
        active: false,
        current_phase: 'complete',
        terminal_reason: 'runtime consensus complete',
        ralplan_consensus_gate: consensusGate,
      }, wd);

      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootRalplan, sessionRalplan]) {
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.equal(state.status, 'complete');
        assert.equal(state.terminal_reason, 'runtime consensus complete');
        assert.equal((state.ralplan_consensus_gate as Record<string, unknown>).complete, true);
        assert.equal(state.session_id, sessionId);
      }

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, false);
        assert.equal(state.phase, 'complete');
        assert.equal(state.terminal_reason, 'runtime consensus complete');
        assert.deepEqual(state.active_skills, []);
      }

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects forged ralplan complete gates from updateModeState before mutating active state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-update-mode-forged-complete-'));
    try {
      const sessionId = 'sess-ralplan-update-mode-forged-complete';
      await ensureTestOperationAuthority(wd, sessionId);
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      await assert.rejects(
        updateModeState('ralplan', {
          active: false,
          current_phase: 'complete',
          ralplan_consensus_gate: {
            complete: true,
          },
        }, wd),
        /architect and critic consensus evidence/,
      );

      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when committed authority session metadata belongs to a foreign workspace', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-stale-session-'));
    try {
      const staleSessionId = 'sess-ralplan-stale';
      await ensureTestOperationAuthority(wd, staleSessionId);
      const consensusGate = await writeNativeRalplanConsensusGate(wd, staleSessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', staleSessionId);
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: staleSessionId,
        cwd: `${wd}-different-project`,
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: staleSessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: staleSessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
          },
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: staleSessionId,
          },
        ],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        state: {
          session_id: staleSessionId,
          ralplan_consensus_gate: consensusGate,
        },
      });

      assert.equal(response.isError, true);
      assert.match(
        String((response.payload as { error?: unknown }).error),
        /session metadata belongs to a different workspace/,
      );
      assert.equal(existsSync(`${wd}-different-project`), false);
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootRalplan.active, true);
      assert.equal(rootRalplan.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide unrelated root detail state when ralplan terminalizes without canonical state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-root-detail-only-'));
    try {
      const sessionId = 'sess-ralplan-root-detail-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
      }, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        state: {
          session_id: sessionId,
          ralplan_consensus_gate: consensusGate,
        },
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves an unrelated active root ralplan when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-root-'));
    try {
      const sessionId = 'sess-ralplan-preserve-root';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
          },
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootRalplan.active, true);
      assert.equal(rootRalplan.current_phase, 'planning');
      assert.equal(rootRalplan.session_id, undefined);

      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, false);
      assert.equal(sessionRalplan.current_phase, 'complete');
      assert.equal(sessionRalplan.session_id, sessionId);

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; session_id?: string }>;
      };
      assert.equal(rootSkill.active, true);
      assert.equal(rootSkill.skill, 'ralplan');
      assert.deepEqual(rootSkill.active_skills, [{ skill: 'ralplan', phase: 'planning', active: true }]);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide a legacy active root ralplan detail state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-legacy-root-detail-'));
    try {
      const sessionId = 'sess-ralplan-legacy-root-detail';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes an empty session-only root mirror when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-empty-root-mirror-'));
    try {
      const sessionId = 'sess-ralplan-empty-root-mirror';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves run_outcome-only root canonical tombstones when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-root-tombstone-'));
    try {
      const sessionId = 'sess-ralplan-root-tombstone';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'team',
        run_outcome: 'finish',
        active_skills: [{
          skill: 'team',
          active: true,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(before.payload, { active_modes: [] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        run_outcome?: string;
      };
      assert.equal(rootSkill.active, true);
      assert.equal(rootSkill.run_outcome, 'finish');

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes terminal_reason-only active root canonical state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-terminal-reason-only-'));
    try {
      const sessionId = 'sess-ralplan-terminal-reason-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        terminal_reason: 'stale reason without terminal marker',
        active_skills: [{
          skill: 'ralplan',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(before.payload, { active_modes: ['ralplan'] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes non-terminal lifecycle_outcome root canonical state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-lifecycle-nonterminal-'));
    try {
      const sessionId = 'sess-ralplan-lifecycle-nonterminal';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        lifecycle_outcome: 'progress',
        active_skills: [{
          skill: 'ralplan',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(before.payload, { active_modes: ['ralplan'] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves unrelated active session skills when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-'));
    try {
      const sessionId = 'sess-ralplan-preserve';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      const mixedSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        updated_at: '2026-06-30T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'autoresearch',
            phase: 'running',
            active: true,
            session_id: sessionId,
          },
        ],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(mixedSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(mixedSkillState, null, 2));
      await ensureTestOperationAuthority(wd, sessionId);

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, true);
        assert.equal(state.skill, 'autoresearch');
        assert.equal(state.phase, 'running');
        assert.deepEqual(state.active_skills?.map((entry) => entry.skill), ['autoresearch']);
        assert.deepEqual(state.active_skills?.map((entry) => entry.session_id), [sessionId]);
      }

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: ['autoresearch'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves same-session root mirror skills when session canonical state is partial', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-partial-session-skill-'));
    try {
      const sessionId = 'sess-ralplan-partial-session-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'team',
            phase: 'running',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        session_id?: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      assert.equal(sessionSkill.active, true);
      assert.equal(sessionSkill.skill, 'team');
      assert.equal(sessionSkill.phase, 'running');
      assert.equal(sessionSkill.session_id, sessionId);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.skill), ['team']);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.session_id), [sessionId]);

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('clears stale terminal phase aliases when preserving same-session root mirror skills', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-terminal-session-skill-'));
    try {
      const sessionId = 'sess-ralplan-terminal-session-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'team',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'ralplan',
        phase: 'blocked',
        session_id: sessionId,
        completed_at: '2026-06-30T00:00:00.000Z',
        terminal_reason: 'stale terminal marker',
        active_skills: [],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        completed_at?: string;
        terminal_reason?: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      assert.equal(sessionSkill.active, true);
      assert.equal(sessionSkill.skill, 'team');
      assert.equal(sessionSkill.phase, '');
      assert.equal(sessionSkill.completed_at, undefined);
      assert.equal(sessionSkill.terminal_reason, undefined);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.skill), ['team']);

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide detail-only active session state when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-session-detail-only-'));
    try {
      const sessionId = 'sess-ralplan-session-detail-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(listed.payload, { active_modes: ['autoresearch'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not seed session canonical state from root-only skills when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-root-only-skill-'));
    try {
      const sessionId = 'sess-ralplan-root-only-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autoresearch',
        phase: 'running',
        active_skills: [{
          skill: 'autoresearch',
          phase: 'running',
          active: true,
        }],
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['team'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('aborts unsupported overlaps before effects so clear and retry remain available', async () => {

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-deny-overlap-'));
    try {
      const existing = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(existing.isError, undefined);

      const denied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'autopilot',
        active: true,
        current_phase: 'planning',
      });

      assert.equal(denied.isError, true);
      assert.match(String((denied.payload as { error?: string }).error || ''), /Unsupported workflow overlap: team \+ autopilot\./);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'autopilot-state.json')), false);

      const canonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team']);

      const evidence = (await readFile(
        join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
        'utf-8',
      )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        event?: { kind?: string; stage?: string; mode?: string; operation_id?: string };
      });
      const deniedPrepared = evidence.find((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'prepared'
        && record.event.mode === 'autopilot'
      ));
      assert.ok(deniedPrepared?.event?.operation_id);
      assert.equal(evidence.some((record) => (
        record.event?.kind === 'state_write_transaction'
        && record.event.stage === 'aborted'
        && record.event.operation_id === deniedPrepared.event?.operation_id
      )), true);

      const cleared = await executeStateOperation('state_clear', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'team',
      });
      assert.equal(cleared.isError, undefined);
      const retried = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'autopilot',
        active: true,
        current_phase: 'planning',
      });
      assert.equal(retried.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not reject planning writes from stale detail-only execution state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-stale-detail-rollback-'));
    try {
      const sessionId = 'sess-stale-detail';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
        }, null, 2),
      );

      const written = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      });

      assert.equal(written.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), true);
      const canonical = JSON.parse(
        await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['ralplan']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone ralplan writes while preserving active Autopilot supervisor state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-child-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-child';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'required',
                skip_reason: null,
              },
            },
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            active: true,
            skill: 'autopilot',
            phase: 'deep-interview',
            session_id: sessionId,
          }, null, 2),
        );

        const denied = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });

        assert.equal(denied.isError, true);
        assert.match(String((denied.payload as { error?: string }).error || ''), /Execution-to-planning rollback auto-complete is not allowed\./);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);

        const autopilotState = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(autopilotState.active, true);
        assert.equal(autopilotState.mode, 'autopilot');
        assert.equal(autopilotState.current_phase, 'deep-interview');
        assert.equal(autopilotState.auto_completed_reason, undefined);

        const corrected = await executeStateOperation('state_clear', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
        });
        assert.equal(corrected.isError, undefined);

        const retried = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });
        assert.equal(retried.isError, undefined);

        const evidence = (await readFile(
          join(wd, '.omx', 'state', 'authority', 'state-authority-tombstones.jsonl'),
          'utf-8',
        )).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
          event: { kind?: string; stage?: string; mode?: string; operation_id?: string };
        });
        const rejectedPrepared = evidence.find((record) => (
          record.event.kind === 'state_write_transaction'
          && record.event.stage === 'prepared'
          && record.event.mode === 'ralplan'
        ));
        assert.ok(rejectedPrepared);
        assert.equal(evidence.some((record) => (
          record.event.kind === 'state_write_transaction'
          && record.event.stage === 'aborted'
          && record.event.operation_id === rejectedPrepared.event.operation_id
        )), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone ralplan writes from detail-only active Autopilot supervisor state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-detail-only-ralplan-child-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-detail-only-ralplan-child';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'required',
                skip_reason: null,
              },
            },
          }, null, 2),
        );

        const denied = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });

        assert.equal(denied.isError, true);
        assert.match(String((denied.payload as { error?: string }).error || ''), /Cannot write ralplan: autopilot is already active\./);
        assert.match(String((denied.payload as { error?: string }).error || ''), /Execution-to-planning rollback auto-complete is not allowed\./);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
        assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

        const autopilotState = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(autopilotState.active, true);
        assert.equal(autopilotState.mode, 'autopilot');
        assert.equal(autopilotState.current_phase, 'deep-interview');
        assert.equal(autopilotState.auto_completed_reason, undefined);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('lets canonical ralplan authority override stale detail-only Autopilot state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-canonical-ralplan-stale-autopilot-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-canonical-ralplan-stale-autopilot';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            active: true,
            skill: 'ralplan',
            phase: 'planning',
            session_id: sessionId,
            active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId }],
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            session_id: sessionId,
          }, null, 2),
        );

        const written = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'critic-review',
        });

        assert.equal(written.isError, undefined);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), true);

        const canonical = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active_skills?: Array<{ skill: string }> };
        assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['ralplan']);

        const autopilotState = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(autopilotState.active, true);
        assert.equal(autopilotState.auto_completed_reason, undefined);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot itself to enter the supervised ralplan child phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Requirements clarified and ready for consensus planning.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Autopilot may proceed to ralplan.',
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.mode, 'autopilot');
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot direct deep-interview to ultragoal skip without deep-interview evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-di-skip-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-di-skip-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal|Unsupported|cannot/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview completion before the ralplan gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-di-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-di-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ralplan gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
        assert.equal(state.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot direct deep-interview to ultragoal skip even with deep-interview evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-di-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-di-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Deep-interview is complete, but ralplan consensus is not.',
              },
              handoff_artifacts: {
                deep_interview: { summary: 'Ready for ralplan only.' },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal|Unsupported|cannot/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview to ralplan self-write when only a satisfied question exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            question_enforcement: {
              obligation_id: 'obligation-answered',
              source: 'omx-question',
              status: 'satisfied',
              lifecycle_outcome: 'askuserQuestion',
              requested_at: '2026-05-28T00:00:00.000Z',
              question_id: 'question-answered',
              satisfied_at: '2026-05-28T00:01:00.000Z',
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /missing deep-interview completion\/skip gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot waiting-for-user to ralplan self-write while the deep-interview question is unresolved', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-waiting-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-waiting-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'waiting-for-user',
            run_outcome: 'blocked_on_user',
            lifecycle_outcome: 'askuserQuestion',
            state: {
              deep_interview_question: {
                status: 'waiting_for_user',
                source: 'omx-question',
                obligation_id: 'obligation-waiting',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Stale completion gate must not bypass an unresolved question.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /question obligation is still pending/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'waiting-for-user');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot handoff when the next state omits a still-pending deep-interview question', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-omitted-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-omitted-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'waiting-for-user',
            run_outcome: 'blocked_on_user',
            lifecycle_outcome: 'askuserQuestion',
            state: {
              deep_interview_question: {
                status: 'waiting_for_user',
                source: 'omx-question',
                obligation_id: 'obligation-omitted',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: {
                status: 'required',
                rationale: 'Question still needs an answer.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Replacement state must not erase an unanswered question obligation.',
            },
            handoff_artifacts: {
              deep_interview: { summary: 'Ready for planning.' },
            },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /question obligation is still pending/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'waiting-for-user');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores stale standalone deep-interview question state for Autopilot supervisor handoff', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ignore-standalone-di-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ignore-standalone-di';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'deep-interview-state.json'),
          JSON.stringify({
            active: false,
            mode: 'deep-interview',
            current_phase: 'completed',
            question_enforcement: {
              obligation_id: 'stale-obligation',
              source: 'omx-question',
              status: 'pending',
              lifecycle_outcome: 'askuserQuestion',
              requested_at: '2026-05-28T00:00:00.000Z',
            },
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Autopilot-owned gate is complete.',
              },
              handoff_artifacts: {
                deep_interview: { summary: 'Autopilot-owned handoff is ready.' },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot satisfied nested question handoff without a record-backed question id', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-satisfied-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-satisfied-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_question: {
                status: 'satisfied',
                source: 'omx-question',
                obligation_id: 'obligation-no-record',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
                satisfied_at: '2026-05-28T00:01:00.000Z',
              },
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Question satisfaction must be backed by an answered record.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /lacks same-session answered omx question record/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot handoff when next state satisfies a previously pending question', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-next-question-satisfied-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-next-question-satisfied';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        const questionId = 'question-next-satisfied';
        await mkdir(join(sessionDir, 'questions'), { recursive: true });
        await writeFile(
          join(sessionDir, 'questions', `${questionId}.json`),
          JSON.stringify({
            kind: 'omx.question/v1',
            question_id: questionId,
            session_id: sessionId,
            source: 'deep-interview',
            status: 'answered',
            answer: 'lowercase ascii slug',
            answers: [{ question_id: 'q-1', index: 0, answer: 'lowercase ascii slug' }],
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_question: {
                obligation_id: 'obligation-next-satisfied',
                source: 'omx-question',
                status: 'waiting_for_user',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            deep_interview_question: {
              obligation_id: 'obligation-next-satisfied',
              source: 'omx-question',
              status: 'satisfied',
              requested_at: '2026-05-28T00:00:00.000Z',
              question_id: questionId,
              satisfied_at: '2026-05-28T00:01:00.000Z',
            },
            deep_interview_gate: {
              status: 'complete',
              rationale: 'The answered question resolves the CLI output policy.',
            },
            handoff_artifacts: {
              deep_interview: { summary: 'Ready for ralplan after answered question.' },
            },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot deep-interview to ralplan handoff with required valid execution contract strides', async () => {
    for (const stride of ['task', 'deliverable', 'milestone'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-${stride}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-${stride}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: `The ${stride} stride is explicitly contracted for planning.`,
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: `Ready for ralplan with ${stride} stride.`,
                  execution_contract_required: true,
                  execution_contract: validExecutionContract(stride),
                },
              },
            },
          });

          assert.equal(response.isError, undefined);
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'ralplan');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('allows partial Autopilot ralplan handoff writes when a required execution contract is already persisted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-partial-write-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-partial-write';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'The persisted interview artifact already defines the milestone contract.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Ready for ralplan with a persisted milestone execution contract.',
                  execution_contract_required: true,
                  execution_contract: validExecutionContract('milestone'),
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
        assert.deepEqual(
          ((state.state as Record<string, unknown>).handoff_artifacts as Record<string, unknown>).deep_interview,
          {
            summary: 'Ready for ralplan with a persisted milestone execution contract.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview handoff when execution contract is required but missing or invalid', async () => {
    for (const [caseName, deepInterviewHandoff] of Object.entries({
      missing: {
        summary: 'Execution contract was required but omitted.',
        execution_contract_required: true,
      },
      wrongStrideFields: {
        summary: 'Execution contract mismatches its stride semantics.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('deliverable'),
          allow_task_shrink: true,
        },
      },
      legacyPhaseEnum: {
        summary: 'Legacy phase enum must not be accepted as an execution stride.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('milestone'),
          execution_stride: 'phase',
        },
      },
      invalidSource: {
        summary: 'Contract provenance must be deep-interview.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('task'),
          source: 'ralplan',
        },
      },
      invalidSelection: {
        summary: 'Contract selected_by must be user or default.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('task'),
          selected_by: 'inferred',
        },
      },
    })) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-deny-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-deny-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'The interview is complete but the required contract is not valid.',
              },
              handoff_artifacts: {
                deep_interview: deepInterviewHandoff,
              },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('preserves Autopilot legacy behavior when execution contract is absent or not required', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-not-required-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-not-required';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            deep_interview_gate: {
              status: 'complete',
              rationale: 'No execution contract was required for this legacy handoff.',
            },
            handoff_artifacts: {
              deep_interview: {
                summary: 'Ready for ralplan with legacy behavior.',
                execution_contract_required: false,
                execution_contract: {
                  version: 1,
                  execution_stride: 'phase',
                },
              },
            },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('honors all documented execution contract required marker locations and runtime aliases', async () => {
    const aliasContract = {
      version: 1,
      executionStride: 'deliverable',
      source: 'deep-interview',
      selected_by: 'user',
      allowTaskShrink: false,
      completionUnit: 'The named deliverable',
      stopCondition: 'Stop after the deliverable is complete and verified',
      acceptanceCoverageScope: 'deliverable',
      shrinkPolicy: 'ask_before_shrink',
    };

    for (const [caseName, topLevelPatch, nestedPatch, handoffPatch] of [
      ['gate', {}, { deep_interview_gate: { execution_contract_required: true } }, {}],
      ['top-level', { execution_contract_required: true }, {}, {}],
      ['nested-state', {}, { execution_contract_required: true }, {}],
      ['handoff', {}, {}, { execution_contract_required: true }],
      ['handoff-camel', {}, {}, { executionContractRequired: true }],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-marker-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-marker-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            ...topLevelPatch,
            state: {
              ...nestedPatch,
              deep_interview_gate: {
                status: 'complete',
                rationale: `The ${caseName} marker requires a valid execution contract.`,
                ...((nestedPatch as { deep_interview_gate?: Record<string, unknown> }).deep_interview_gate ?? {}),
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: `Ready for ralplan with ${caseName} required marker.`,
                  execution_contract: aliasContract,
                  ...handoffPatch,
                },
              },
            },
          });

          assert.equal(response.isError, undefined);
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'ralplan');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies stale valid execution contracts from masking an invalid next-state contract', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-precedence-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-precedence';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Stale current-state contract must not rescue nextState.',
                  execution_contract_required: true,
                  execution_contract: validExecutionContract('milestone'),
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            execution_contract: {
              ...validExecutionContract('milestone'),
              shrink_policy: 'allowed',
            },
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Resulting next state carries an invalid higher-priority contract.',
            },
            handoff_artifacts: {
              deep_interview: {
                summary: 'Valid handoff contract must not mask invalid direct/nested contract.',
                execution_contract_required: true,
                execution_contract: validExecutionContract('milestone'),
              },
            },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports direct execution contract compatibility while rejecting invalid handoff contracts', async () => {
    for (const [caseName, handoffPatch, shouldAllow] of [
      ['missing-handoff-contract', {}, true],
      ['invalid-handoff-contract', { execution_contract: { ...validExecutionContract('deliverable'), source: 'ralplan' } }, false],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-${caseName}-handoff-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-contract-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            state: {
              execution_contract: validExecutionContract('deliverable'),
              deep_interview_gate: {
                status: 'complete',
                rationale: 'A compatibility direct contract may satisfy a marker, but invalid handoff data fails first.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Handoff marker requires the handoff contract to be valid too.',
                  execution_contract_required: true,
                  ...handoffPatch,
                },
              },
            },
          });

          assert.equal(response.isError, shouldAllow ? undefined : true);
          if (!shouldAllow) {
            assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          }
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, shouldAllow ? 'ralplan' : 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('applies required execution contract validation to explicit Autopilot deep-interview skip gates', async () => {
    for (const [caseName, deepInterviewHandoff, shouldAllow] of [
      ['missing', { summary: 'Skip is authorized, but contract is missing.', execution_contract_required: true }, false],
      ['valid', {
        summary: 'Skip is authorized and the required contract is present.',
        execution_contract_required: true,
        execution_contract: validExecutionContract('task'),
      }, true],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-skip-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-skip-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
              state: {
                deep_interview_gate: {
                  status: 'skipped',
                  skip_authorized_by_user: true,
                  skip_reason: 'User explicitly authorized skipping deep-interview for this bounded follow-up.',
                  skipped_at: '2026-05-28T00:02:00.000Z',
                  source: 'user',
                  session_id: sessionId,
                },
                handoff_artifacts: {
                  deep_interview: deepInterviewHandoff,
                },
              },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
          });

          assert.equal(response.isError, shouldAllow ? undefined : true);
          if (!shouldAllow) {
            assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          }
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, shouldAllow ? 'ralplan' : 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('allows Autopilot deep-interview to ralplan self-write with explicit user-authorized skip evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-skip-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase-skip';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'skipped',
                skip_authorized_by_user: true,
                skip_reason: 'User explicitly authorized skipping deep-interview for this bounded follow-up.',
                skipped_at: '2026-05-28T00:02:00.000Z',
                source: 'user',
                session_id: sessionId,
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not use OMX_TEAM_STATE_ROOT question/session artifacts as mutation authority', async () => {

    const root = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-team-question-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      const wd = join(root, 'source');
      const teamStateRoot = join(root, 'team-state');
      const sessionId = 'sess-autopilot-team-question';
      const sessionDir = join(teamStateRoot, 'sessions', sessionId);
      const questionId = 'question-team-satisfied';
      await mkdir(wd, { recursive: true });
      await mkdir(join(sessionDir, 'questions'), { recursive: true });
      await writeFile(join(teamStateRoot, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(
        join(sessionDir, 'questions', `${questionId}.json`),
        JSON.stringify({
          kind: 'omx.question/v1',
          question_id: questionId,
          session_id: sessionId,
          source: 'deep-interview',
          status: 'answered',
          answer: 'clarified scope',
          answers: [{ question_id: 'q-1', index: 0, answer: 'clarified scope' }],
        }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'deep-interview',
          question_enforcement: {
            obligation_id: 'obligation-team-question',
            source: 'omx-question',
            status: 'satisfied',
            lifecycle_outcome: 'askuserQuestion',
            requested_at: '2026-05-28T00:00:00.000Z',
            question_id: questionId,
            satisfied_at: '2026-05-28T00:01:00.000Z',
          },
          state: {
            deep_interview_gate: {
              status: 'complete',
              rationale: 'The answered question resolves the execution boundary.',
            },
          },
        }, null, 2),
      );

      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',

      });

      assert.equal(response.isError, undefined, JSON.stringify(response.payload));
      const state = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', sessionId, 'autoresearch-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(state.current_phase, 'running');
      const ambientState = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(ambientState.current_phase, 'deep-interview');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', sessionId, 'questions', `${questionId}.json`)), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });


  it('denies Autopilot direct ralplan to code-review skip without native consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-ralplan-skip-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-ralplan-skip-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'code-review',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot skip Autopilot ultragoal gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan completion before the ultragoal gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ultragoal gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
        assert.equal(state.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot ralplan unsupported native non-clean recovery', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-recovery-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-recovery';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'blocked',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'blocked');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan to ultragoal self-write with codex_exec consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'codex_exec'),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /tracker-backed native architect and critic lanes/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan to ultragoal when unsupported native evidence is present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-ultragoal-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-ultragoal-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'native_subagents_unsupported',
            source: 'post_tool_failure',
          },
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'native_subagents_unsupported',
            source: 'post_tool_failure',
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan to ultragoal with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-valid-consensus-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-valid-consensus-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
          state: {
            handoff_artifacts: {
              ralplan: {
                plan_path: '.omx/plans/prd.md',
                test_spec_path: '.omx/plans/test-spec.md',
              },
              ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
            },
          },
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        const error = String((response.payload as { error?: string }).error || '');
        assert.match(error, /terminalize non-clean/);
        assert.match(error, /blocked\/cancelled\/failed/);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  for (const { lane, architectVerdict, criticVerdict } of [
    { lane: 'architect', architectVerdict: 'iterate', criticVerdict: 'approve' },
    { lane: 'critic', architectVerdict: 'approve', criticVerdict: 'iterate' },
  ] as const) {
    it(`denies Autopilot ralplan to ultragoal self-write when ${lane} verdict is iterate despite complete consensus flag`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-ralplan-${lane}-iterate-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-ralplan-${lane}-iterate-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeNativeSubagentTracking(wd, sessionId);
          const consensusGate = ralplanConsensusGate(sessionId, 'native_subagent');
          (consensusGate.ralplan_architect_review as Record<string, unknown>).verdict = architectVerdict;
          (consensusGate.ralplan_critic_review as Record<string, unknown>).verdict = criticVerdict;
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'ralplan',
              state: {
                handoff_artifacts: {
                  ralplan: {
                    plan_path: '.omx/plans/prd.md',
                    test_spec_path: '.omx/plans/test-spec.md',
                  },
                  ralplan_consensus_gate: consensusGate,
                },
              },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ultragoal',
          });

          assert.equal(response.isError, true);
          const error = String((response.payload as { error?: string }).error || '');
          assert.match(error, new RegExp(`${lane}.*verdict=iterate`, 'i'));
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'ralplan');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }


  it('explains when native ralplan reviews are not present in subagent tracking', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-missing-tracker-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-missing-tracker';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        const error = String((response.payload as { error?: string }).error || '');
        assert.match(error, /subagent-tracking\.json/);
        assert.match(error, /only reviews recorded in OMX subagent-tracking\.json count as native lanes/i);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('denies Autopilot ralplan to ultragoal self-write when native reviews reuse one subagent thread', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-same-thread-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-same-thread-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent', {
                  critic: 'thread-architect',
                }),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /tracker-backed native architect and critic lanes/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies legacy Autopilot planning to ultragoal without ralplan consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-legacy-planning-gate-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-legacy-planning-gate';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'planning',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /ralplan consensus/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'planning');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot implementation-phase completion before the code-review gate', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-complete-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-complete-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: phase,
              state: { handoff_artifacts: { ultragoal: { verification: 'passed' } } },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'complete',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before code-review gate/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot implementation-phase skip directly to ultraqa', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-ultraqa-skip-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-ultraqa-skip-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: phase,
              state: { handoff_artifacts: { ultragoal: { verification: 'passed' } } },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ultraqa',
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot skip Autopilot code-review gate/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot code-review completion before the ultraqa gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-code-review-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-code-review-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'code-review',
            state: {
              handoff_artifacts: { code_review: { source: 'native-subagent' } },
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            qa_verdict: { clean: true, skipped: false },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ultraqa gate/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'code-review');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot code-review REQUEST_CHANGES to enter implementation rework', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-review-rework-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-review-rework';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'code-review', review_cycle: 1 }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'rework',
          review_cycle: 2,
          state: {
            handoff_artifacts: {
              code_review: {
                stage: 'code-review',
                recommendation: 'REQUEST_CHANGES',
                architectural_status: 'CLEAR',
                clean: false,
                artifact_path: '.omx/reviews/code-review-cycle-1.json',
                findings: ['Fix src/implementation.ts'],
              },
            },
            review_verdict: {
              stage: 'code-review',
              recommendation: 'REQUEST_CHANGES',
              architectural_status: 'CLEAR',
              clean: false,
              artifact_path: '.omx/reviews/code-review-cycle-1.json',
              findings: ['Fix src/implementation.ts'],
            },
            return_to_ralplan_reason: null,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'rework');
        assert.equal(state.review_cycle, 2);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replaces stale blocking review state when Autopilot completes with clean latest evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-clean-clears-stale-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-clean-clears-stale';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            return_to_ralplan_reason: 'Earlier code-review BLOCK required fixes.',
            handoff_artifacts: {
              code_review: { stage: 'code-review', recommendation: 'REQUEST_CHANGES', architectural_status: 'BLOCK', clean: false, artifact_path: '.omx/reviews/stale-block.json' },
              ultraqa: null,
            },
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'REQUEST_CHANGES', architectural_status: 'BLOCK', clean: false, artifact_path: '.omx/reviews/stale-block.json' },
              qa_verdict: null,
              return_to_ralplan_reason: 'Earlier code-review BLOCK required fixes.',
            },
          }, null, 2),
        );

        const cleanReview = { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review-cycle-2.json' };
        const cleanQa = { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/2864' };
        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-18T05:00:00.000Z',
          state: {
            review_verdict: cleanReview,
            qa_verdict: cleanQa,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        const nestedState = state.state as Record<string, unknown>;
        const handoffArtifacts = nestedState.handoff_artifacts as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.deepEqual(state.review_verdict, cleanReview);
        assert.deepEqual(state.qa_verdict, cleanQa);
        assert.equal(state.return_to_ralplan_reason, null);
        assert.deepEqual(nestedState.review_verdict, cleanReview);
        assert.deepEqual(nestedState.qa_verdict, cleanQa);
        assert.equal(nestedState.return_to_ralplan_reason, null);
        assert.deepEqual(handoffArtifacts.code_review, cleanReview);
        assert.deepEqual(handoffArtifacts.ultraqa, cleanQa);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ultraqa completion without clean review and QA evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-complete-evidence-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-complete-evidence-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
              qa_verdict: null,
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot implementation and code-review terminalization via inactive ultraqa phase', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph', 'code-review']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-inactive-ultraqa-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-inactive-ultraqa-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({ active: true, mode: 'autopilot', current_phase: phase }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'ultraqa',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/3' },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot (complete|skip) Autopilot/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot ultraqa completion when review and QA provenance are swapped', async () => {
    const cases = [
      {
        name: 'swapped-stage',
        review_verdict: { stage: 'ultraqa', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict' },
        qa_verdict: { stage: 'code-review', clean: true, skipped: false, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.code-review.artifacts.review_verdict' },
      },
      {
        name: 'swapped-artifact-path',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.code-review.artifacts.review_verdict' },
      },
      {
        name: 'review-uses-ultraqa-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/ultraqa/qa-verdict.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/qa/qa-verdict.json' },
      },
      {
        name: 'qa-uses-code-review-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/reviews/code-review.json' },
      },
      {
        name: 'shared-neutral-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/evidence/shared.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/evidence/shared.json' },
      },
    ];

    for (const testCase of cases) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-ultraqa-${testCase.name}-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-ultraqa-${testCase.name}-deny`;
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: testCase.review_verdict,
            qa_verdict: testCase.qa_verdict,
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot ultraqa completion with self-attested clean verdicts but no durable provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-self-attested-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-self-attested-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
              qa_verdict: { clean: true, skipped: false },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            qa_verdict: { clean: true, skipped: false },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ultraqa skipped completion without durable QA provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-skipped-no-provenance-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-skipped-no-provenance-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: true, reason: 'Docs-only change; QA not applicable.' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot completion from an unknown active phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-unknown-phase-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-unknown-phase-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'bogus',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:40:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/5' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /unknown active phase/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'bogus');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot completion from an unknown active phase when persisted state omits mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-unknown-phase-no-mode-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-unknown-phase-no-mode-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            current_phase: 'bogus',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:45:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/6' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /unknown active phase/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'bogus');
        assert.equal(Object.prototype.hasOwnProperty.call(state, 'mode'), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not persist user-supplied trustedPipelineProgress from Autopilot state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-trusted-field-strip-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-trusted-field-strip';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            current_phase: 'ultraqa',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultraqa',
          trustedPipelineProgress: true,
          state: {
            trustedPipelineProgress: true,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(Object.prototype.hasOwnProperty.call(state, 'trustedPipelineProgress'), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot state_write cancellation from gated phases without clean review and QA evidence', async () => {
    for (const phase of ['deep-interview', 'ralplan', 'ultragoal', 'code-review']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-cancel-allow-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-cancel-allow`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              current_phase: phase,
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'cancelled',
            completed_at: '2026-06-09T16:30:00.000Z',
          });

          assert.equal(response.isError, undefined);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, false);
          assert.equal(state.current_phase, 'cancelled');
          assert.equal(state.run_outcome, 'cancelled');
          assert.equal(state.completed_at, '2026-06-09T16:30:00.000Z');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('allows Autopilot ultraqa completion with clean review and QA evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-complete-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-complete-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:30:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot ultraqa skipped completion with reason and durable QA provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-skipped-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-skipped-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:35:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: {
              stage: 'ultraqa',
              clean: true,
              skipped: true,
              reason: 'Docs-only change; QA not applicable.',
              artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict',
            },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot ralplan to ultragoal self-write with tracker-backed native consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ultragoal');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when canonical deep-interview is active but mode state is missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-missing-deep-interview-state-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-missing-deep-interview-state';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            version: 1,
            active: true,
            skill: 'deep-interview',
            session_id: sessionId,
            active_skills: [{
              skill: 'deep-interview',
              active: true,
              phase: 'intent-first',
              session_id: sessionId,
            }],
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /missing deep-interview completion\/skip gate/i);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
        const canonical = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active_skills?: Array<{ skill: string; active?: boolean }> };
        assert.equal(canonical.active_skills?.[0]?.skill, 'deep-interview');
        assert.equal(canonical.active_skills?.[0]?.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete existing workflow state when tracked write validation fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-validate-before-transition-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-invalid');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning' }, null, 2),
      );

      const denied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-invalid',
        mode: 'ralph',
        active: true,
        current_phase: 'definitely-invalid',
      });

      assert.equal(denied.isError, true);
      assert.match(String((denied.payload as { error?: string }).error || ''), /ralph\.current_phase/i);

      const ralplanState = JSON.parse(
        await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ralplanState.active, true);
      assert.equal(ralplanState.current_phase, 'planning');
      assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session-scoped tracked state writable after root-state parse fallback on resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-resume-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-resume-root-fallback';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          owner_omx_session_id: 'stale-root-owner',
        }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          owner_omx_session_id: sessionId,
        }, null, 2),
      );
      await ensureTestOperationAuthority(wd, sessionId);

      const writeResult = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        state: {
          current_phase: 'verify',
        },
      });

      assert.equal(writeResult.isError, undefined);
      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.current_phase, 'verifying');
      assert.equal(sessionState.owner_omx_session_id, sessionId);

      const rootState = JSON.parse(
        await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(rootState.current_phase, 'executing');
      assert.equal(rootState.owner_omx_session_id, 'stale-root-owner');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
