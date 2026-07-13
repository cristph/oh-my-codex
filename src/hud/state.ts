/**
 * OMX HUD - State file readers
 *
 * Reads .omx/state/ files to build HUD render context.
 */

import { readFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, resolve as resolvePath } from 'path';
import { findGitLayout, readGitLayoutFile } from '../utils/git-layout.js';
import { resolveOmxDisplayVersionSync } from '../utils/version.js';
import { getDefaultBridge, isBridgeEnabled } from '../runtime/bridge.js';
import type { RuntimeSnapshot } from '../runtime/bridge.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  resolveStateAuthority,
  validateStateAuthority,
  type ResolvedStateAuthorityContext,
} from '../state/authority.js';
import { resolveAuthenticatedTransportAuthority } from '../hooks/session.js';
import { listActiveSkills, readVisibleSkillActiveStateForStateDir } from '../state/skill-active.js';


import {
  createSubagentTrackingState,
  summarizeSubagentSession,
  type SubagentTrackingState,
} from '../subagents/tracker.js';

import type {
  RalphStateForHud,
  UltragoalStateForHud,
  UltraworkStateForHud,
  AutopilotStateForHud,
  RalplanStateForHud,
  DeepInterviewStateForHud,
  AutoresearchStateForHud,
  CodeReviewStateForHud,
  UltraqaStateForHud,
  TeamStateForHud,
  HudMetrics,
  HudNotifyState,
  HudConfig,
  HudRenderContext,
  SessionStateForHud,
  ResolvedHudConfig,
  HudGitDisplay,
  LateGateHudSource,
} from './types.js';
import { DEFAULT_HUD_CONFIG } from './types.js';

export interface HudAuthorityDiagnostic {
  code: string;
  message: string;
  fatal: boolean;
}

export interface HudAuthorityReadScope {
  workspaceRoot: string;
  stateRoot: string | null;
  sessionId?: string;
  context?: ResolvedStateAuthorityContext;
  diagnostics: HudAuthorityDiagnostic[];
}

function inheritedAuthorityLocatorPresent(env: NodeJS.ProcessEnv): boolean {
  return [
    env.OMX_STATE_AUTHORITY_PATH,
    env.OMX_STATE_AUTHORITY_ID,
    env.OMX_STATE_AUTHORITY_GENERATION_ID,
    env.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST,
  ].some((value) => typeof value === 'string' && value.trim() !== '');
}

function sessionCandidate(env: NodeJS.ProcessEnv): string | undefined {
  const sessionId = env.OMX_SESSION_ID?.trim();
  return sessionId || undefined;
}

async function canonicalPath(path: string): Promise<string> {
  const resolved = resolvePath(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function authorityDiagnostic(code: string, message: string, fatal = true): HudAuthorityDiagnostic {
  return { code, message, fatal };
}

async function authorityLocatorDiagnostics(
  context: ResolvedStateAuthorityContext,
  env: NodeJS.ProcessEnv,
): Promise<HudAuthorityDiagnostic[]> {
  const diagnostics: HudAuthorityDiagnostic[] = [];
  const locator = env.OMX_STATE_AUTHORITY_PATH?.trim();
  if (locator) {
    const [received, expected] = await Promise.all([
      canonicalPath(locator),
      canonicalPath(context.authority_path),
    ]);
    if (received !== expected) {
      diagnostics.push(authorityDiagnostic(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        'inherited authority locator does not match the validated generation',
      ));
    }
  }
  if (env.OMX_STATE_AUTHORITY_ID?.trim() && env.OMX_STATE_AUTHORITY_ID.trim() !== context.generation.authority_id) {
    diagnostics.push(authorityDiagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
      'inherited authority ID does not match the validated generation',
    ));
  }
  if (env.OMX_STATE_AUTHORITY_GENERATION_ID?.trim() && env.OMX_STATE_AUTHORITY_GENERATION_ID.trim() !== context.generation.generation_id) {
    diagnostics.push(authorityDiagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
      'inherited authority generation ID does not match the active generation',
    ));
  }
  if (env.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST?.trim() && env.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST.trim() !== context.workspace_identity.digest) {
    diagnostics.push(authorityDiagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
      'inherited authority workspace digest does not match the active workspace',
    ));
  }
  const rootEvidence: Array<{ name: string; value?: string; stateRoot: string }> = [
    {
      name: 'OMX_TEAM_STATE_ROOT',
      value: env.OMX_TEAM_STATE_ROOT?.trim(),
      stateRoot: env.OMX_TEAM_STATE_ROOT?.trim() ?? '',
    },
    {
      name: 'OMX_ROOT',
      value: env.OMX_ROOT?.trim(),
      stateRoot: env.OMX_ROOT?.trim() ? join(env.OMX_ROOT.trim(), '.omx', 'state') : '',
    },
    {
      name: 'OMX_STATE_ROOT',
      value: env.OMX_STATE_ROOT?.trim(),
      stateRoot: env.OMX_STATE_ROOT?.trim() ? join(env.OMX_STATE_ROOT.trim(), '.omx', 'state') : '',
    },
  ];
  for (const evidence of rootEvidence) {
    if (!evidence.value) continue;
    const [received, expected] = await Promise.all([
      canonicalPath(evidence.stateRoot),
      canonicalPath(context.canonical_state_root),
    ]);
    if (received !== expected) {
      diagnostics.push(authorityDiagnostic(
        AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
        `${evidence.name} conflicts with the persisted authority state root; remove the override and relaunch from the authority workspace`,
      ));
    }
  }
  return diagnostics;
}

function legacyHudScope(cwd: string, env: NodeJS.ProcessEnv): { workspaceRoot: string; stateRoot: string } {
  const teamStateRoot = env.OMX_TEAM_STATE_ROOT?.trim();
  if (teamStateRoot) {
    return { workspaceRoot: resolvePath(cwd), stateRoot: resolvePath(cwd, teamStateRoot) };
  }
  const omxRoot = env.OMX_ROOT?.trim();
  if (omxRoot) {
    const workspaceRoot = resolvePath(cwd, omxRoot);
    return { workspaceRoot, stateRoot: join(workspaceRoot, '.omx', 'state') };
  }
  const omxStateRoot = env.OMX_STATE_ROOT?.trim();
  if (omxStateRoot) {
    const workspaceRoot = resolvePath(cwd, omxStateRoot);
    return { workspaceRoot, stateRoot: join(workspaceRoot, '.omx', 'state') };
  }
  const workspaceRoot = resolvePath(cwd);
  return { workspaceRoot, stateRoot: join(workspaceRoot, '.omx', 'state') };
}

async function readLegacySessionId(stateRoot: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fromEnv = sessionCandidate(env);
  if (fromEnv) return fromEnv;
  const session = await readJsonFile<{ session_id?: unknown; cwd?: unknown }>(join(stateRoot, 'session.json'));
  if (typeof session?.cwd === 'string') {
    const [recordedCwd, observedCwd] = await Promise.all([canonicalPath(session.cwd), canonicalPath(cwd)]);
    if (recordedCwd !== observedCwd) return undefined;
  }
  return typeof session?.session_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(session.session_id)
    ? session.session_id
    : undefined;
}

/**
 * Resolve a validated authority context before reading runtime state. HUD
 * configuration remains deliberately cwd-local; this scope is only for state
 * and durable workspace artifacts.
 */
export async function resolveHudAuthorityReadScope(
  cwd: string,
  context?: ResolvedStateAuthorityContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HudAuthorityReadScope> {
  const locatorPresent = inheritedAuthorityLocatorPresent(env);
  let resolvedContext = context;
  let diagnostics: HudAuthorityDiagnostic[] = [];
  if (locatorPresent) {
    try {
      const transportedContext = await resolveAuthenticatedTransportAuthority(cwd, env);
      if (!transportedContext) {
        return {
          workspaceRoot: resolvePath(cwd),
          stateRoot: null,
          diagnostics: [authorityDiagnostic(
            AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
            'inherited state authority transport is absent',
          )],
        };
      }
      resolvedContext = transportedContext;
    } catch (error) {
      return {
        workspaceRoot: resolvePath(cwd),
        stateRoot: null,
        diagnostics: [authorityDiagnostic(
          error instanceof StateAuthorityError
            ? error.code
            : AUTHORITY_DIAGNOSTIC_CODES.rootMissing,
          `unable to resolve inherited state authority: ${error instanceof Error ? error.message : String(error)}`,
        )],
      };
    }
  }
  if (!resolvedContext) {
    try {
      const resolution = await resolveStateAuthority({
        startup_cwd: cwd,
        observed_cwd: cwd,
        session_id: sessionCandidate(env),
      });
      if (resolution.context && resolution.can_mutate) {
        resolvedContext = resolution.context;
        diagnostics = resolution.diagnostics;
      } else if (
        !locatorPresent
        && resolution.diagnostics.length === 1
        && resolution.diagnostics[0]?.code === AUTHORITY_DIAGNOSTIC_CODES.anchorMissing
      ) {
        const legacy = legacyHudScope(cwd, env);
        return {
          workspaceRoot: legacy.workspaceRoot,
          stateRoot: legacy.stateRoot,
          sessionId: await readLegacySessionId(legacy.stateRoot, cwd, env),
          diagnostics: [],
        };
      } else {
        return {
          workspaceRoot: resolvePath(cwd),
          stateRoot: null,
          diagnostics: resolution.diagnostics,
        };
      }
    } catch (error) {
      if (!locatorPresent) {
        const legacy = legacyHudScope(cwd, env);
        return {
          workspaceRoot: legacy.workspaceRoot,
          stateRoot: legacy.stateRoot,
          sessionId: await readLegacySessionId(legacy.stateRoot, cwd, env),
          diagnostics: [],
        };
      }
      return {
        workspaceRoot: resolvePath(cwd),
        stateRoot: null,
        diagnostics: [authorityDiagnostic(
          AUTHORITY_DIAGNOSTIC_CODES.rootMissing,
          `unable to resolve persisted state authority: ${error instanceof Error ? error.message : String(error)}`,
        )],
      };
    }
  }

  const validation = await validateStateAuthority(resolvedContext.generation, {
    workspace_identity: resolvedContext.workspace_identity,
    session_id: sessionCandidate(env),
  });
  diagnostics = [...diagnostics, ...validation.diagnostics];
  if (resolvedContext.canonical_state_root !== resolvedContext.generation.canonical_state_root) {
    diagnostics.push(authorityDiagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      'validated authority context state root differs from its generation record',
    ));
  }
  diagnostics.push(...await authorityLocatorDiagnostics(resolvedContext, env));
  if (diagnostics.some((diagnostic) => diagnostic.fatal) || !resolvedContext.session_binding) {
    if (!resolvedContext.session_binding) {
      diagnostics.push(authorityDiagnostic(
        AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
        'active authority has no session binding',
      ));
    }
    return {
      workspaceRoot: resolvedContext.workspace_identity.canonical_path,
      stateRoot: null,
      diagnostics,
    };
  }
  return {
    workspaceRoot: resolvedContext.workspace_identity.canonical_path,
    stateRoot: resolvedContext.canonical_state_root,
    sessionId: resolvedContext.session_binding.canonical_session_id,
    context: resolvedContext,
    diagnostics: [],
  };
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function statePath(scope: HudAuthorityReadScope, fileName: string, sessionScoped = false): string | null {
  if (!scope.stateRoot) return null;
  return sessionScoped && scope.sessionId
    ? join(scope.stateRoot, 'sessions', scope.sessionId, fileName)
    : join(scope.stateRoot, fileName);
}

async function readAuthoritativeModeState<T>(cwd: string, mode: string, scope?: HudAuthorityReadScope): Promise<T | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  const path = statePath(resolvedScope, `${mode}-state.json`, Boolean(resolvedScope.sessionId));
  return path ? readJsonFile<T>(path) : null;
}

async function readCurrentAutopilotState(cwd: string, scope?: HudAuthorityReadScope): Promise<AutopilotStateForHud | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  const path = statePath(resolvedScope, 'current-autopilot.json');
  return path ? readJsonFile<AutopilotStateForHud>(path) : null;
}

function isValidPreset(value: unknown): value is ResolvedHudConfig['preset'] {
  return value === 'minimal' || value === 'focused' || value === 'full';
}

function isValidGitDisplay(value: unknown): value is HudGitDisplay {
  return value === 'branch' || value === 'repo-branch';
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeHudConfig(raw: HudConfig | null | undefined): ResolvedHudConfig {
  const normalized: ResolvedHudConfig = {
    preset: DEFAULT_HUD_CONFIG.preset,
    git: {
      ...DEFAULT_HUD_CONFIG.git,
    },
    statusLine: {
      preset: DEFAULT_HUD_CONFIG.statusLine.preset,
    },
  };

  if (!raw || typeof raw !== 'object') return normalized;

  if (isValidPreset(raw.preset)) {
    normalized.preset = raw.preset;
  }

  if (raw.git && typeof raw.git === 'object') {
    if (isValidGitDisplay(raw.git.display)) {
      normalized.git.display = raw.git.display;
    }

    const remoteName = sanitizeOptionalString(raw.git.remoteName);
    if (remoteName) normalized.git.remoteName = remoteName;

    const repoLabel = sanitizeOptionalString(raw.git.repoLabel);
    if (repoLabel) normalized.git.repoLabel = repoLabel;
  }

  if (raw.statusLine && typeof raw.statusLine === 'object') {
    if (isValidPreset(raw.statusLine.preset)) {
      normalized.statusLine.preset = raw.statusLine.preset;
    }
  }

  return normalized;
}

interface RawUltragoalGoal {
  id?: unknown;
  title?: unknown;
  objective?: unknown;
  status?: unknown;
  steeringStatus?: unknown;
  supersededBy?: unknown;
}

interface RawUltragoalPlan {
  activeGoalId?: unknown;
  aggregateCompletion?: unknown;
  goals?: unknown;
}

const ULTRAGOAL_ACTIVE_STATUSES = new Set(['in_progress', 'review_blocked', 'needs_user_decision']);
const ULTRAGOAL_UNRESOLVED_STATUSES = new Set(['pending', 'in_progress', 'failed', 'review_blocked', 'needs_user_decision']);

type NormalizedUltragoalGoal = {
  id: string;
  title: string;
  objective: string;
  status: string;
  steeringStatus?: string;
  supersededBy: string[];
};

function normalizeUltragoalGoal(raw: unknown): NormalizedUltragoalGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const goal = raw as RawUltragoalGoal;
  const id = sanitizeOptionalString(goal.id);
  const title = sanitizeOptionalString(goal.title);
  const objective = sanitizeOptionalString(goal.objective);
  const status = sanitizeOptionalString(goal.status);
  const steeringStatus = sanitizeOptionalString(goal.steeringStatus);
  if (!id || !title || !objective || !status) return null;
  return { id, title, objective, status, steeringStatus, supersededBy: Array.isArray(goal.supersededBy) ? goal.supersededBy.map(sanitizeOptionalString).filter((id): id is string => id !== undefined) : [] };
}

function isResolvedUltragoalStatus(status: string): boolean {
  return status === 'complete';
}

function isSupersededUltragoalGoalResolved(goal: NormalizedUltragoalGoal, goals: NormalizedUltragoalGoal[]): boolean {
  if (goal.steeringStatus !== 'superseded') return false;
  if (goal.supersededBy.length === 0) return false;
  return goal.supersededBy.every((id) => {
    const replacement = goals.find((candidate) => candidate.id === id);
    return replacement !== undefined && isResolvedUltragoalStatus(replacement.status);
  });
}

function isNonBlockingSupersededUltragoalGoal(goal: NormalizedUltragoalGoal, goals: NormalizedUltragoalGoal[]): boolean {
  return isSupersededUltragoalGoalResolved(goal, goals);
}
function isHudCompletionBlockingUltragoalGoal(goal: NormalizedUltragoalGoal, goals: NormalizedUltragoalGoal[]): boolean {
  if (goal.steeringStatus === 'superseded') return !isSupersededUltragoalGoalResolved(goal, goals);
  if (goal.steeringStatus === 'blocked') return true;
  return !isResolvedUltragoalStatus(goal.status);
}

function isHudUnresolvedUltragoalGoal(goal: NormalizedUltragoalGoal, goals: NormalizedUltragoalGoal[]): boolean {
  return isHudCompletionBlockingUltragoalGoal(goal, goals);
}

export async function readUltragoalState(
  cwd: string,
  scope?: HudAuthorityReadScope,
): Promise<UltragoalStateForHud | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  if (!resolvedScope.stateRoot) return null;
  const plan = await readJsonFile<RawUltragoalPlan>(join(resolvedScope.workspaceRoot, '.omx', 'ultragoal', 'goals.json'));
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.goals)) return null;

  const goals = plan.goals.map(normalizeUltragoalGoal).filter((goal): goal is NormalizedUltragoalGoal => goal !== null);
  if (goals.length === 0) return null;

  const completed_goals = goals.filter((goal) => goal.status === 'complete').length;
  const pending_goals = goals.filter((goal) => goal.status === 'pending' && !isNonBlockingSupersededUltragoalGoal(goal, goals)).length;
  const in_progress_goals = goals.filter((goal) => goal.status === 'in_progress' && !isNonBlockingSupersededUltragoalGoal(goal, goals)).length;
  const failed_goals = goals.filter((goal) => goal.status === 'failed' && !isNonBlockingSupersededUltragoalGoal(goal, goals)).length;
  const review_blocked_goals = goals.filter((goal) => goal.status === 'review_blocked' && !isNonBlockingSupersededUltragoalGoal(goal, goals)).length;
  const needs_user_decision_goals = goals.filter((goal) => goal.status === 'needs_user_decision' && !isNonBlockingSupersededUltragoalGoal(goal, goals)).length;
  const unresolved_goals = goals.filter((goal) => isHudUnresolvedUltragoalGoal(goal, goals)).length;
  const aggregateCompletion = plan.aggregateCompletion && typeof plan.aggregateCompletion === 'object' && !Array.isArray(plan.aggregateCompletion)
    ? plan.aggregateCompletion as { status?: unknown }
    : null;
  const aggregateComplete = aggregateCompletion?.status === 'complete';
  const activeGoalId = sanitizeOptionalString(plan.activeGoalId);
  const activeGoal = (
    (activeGoalId ? goals.find((goal) => goal.id === activeGoalId && isHudUnresolvedUltragoalGoal(goal, goals)) : undefined)
    ?? goals.find((goal) => isHudUnresolvedUltragoalGoal(goal, goals) && ULTRAGOAL_ACTIVE_STATUSES.has(goal.status))
    ?? goals.find((goal) => isHudUnresolvedUltragoalGoal(goal, goals) && ULTRAGOAL_UNRESOLVED_STATUSES.has(goal.status))
  );
  const activeIndex = activeGoal ? goals.findIndex((goal) => goal.id === activeGoal.id) : -1;
  const complete = aggregateComplete || unresolved_goals === 0;
  const toHudGoal = ({ goal, index }: { goal: NormalizedUltragoalGoal; index: number }) => ({
    id: goal.id,
    title: goal.title,
    objective: goal.objective,
    status: goal.status,
    index: index + 1,
  });
  const nextPendingGoals = goals
    .map((goal, index) => ({ goal, index }))
    .filter(({ goal, index }) => index > activeIndex && goal.status === 'pending' && isHudUnresolvedUltragoalGoal(goal, goals) && goal.id !== activeGoal?.id)
    .slice(0, 3)
    .map(toHudGoal);
  const orderedOngoingGoals = complete ? [] : [
    ...(activeGoal && activeIndex >= 0 ? [toHudGoal({ goal: activeGoal, index: activeIndex })] : []),
    ...nextPendingGoals,
  ];

  return {
    active: !complete,
    status: complete ? 'complete' : activeGoal?.status ?? 'active',
    total: goals.length,
    complete: completed_goals,
    pending: pending_goals,
    inProgress: in_progress_goals,
    failed: failed_goals,
    reviewBlocked: review_blocked_goals,
    needsUserDecision: needs_user_decision_goals,
    progressTotal: goals.length,
    activeGoal: !complete && activeGoal && activeIndex >= 0 ? {
      id: activeGoal.id,
      title: activeGoal.title,
      objective: activeGoal.objective,
      status: activeGoal.status,
      index: activeIndex + 1,
    } : undefined,
    ongoingGoals: orderedOngoingGoals,
    nextGoals: nextPendingGoals,
  };
}

export async function readRalphState(cwd: string, scope?: HudAuthorityReadScope): Promise<RalphStateForHud | null> {
  const state = await readAuthoritativeModeState<RalphStateForHud>(cwd, 'ralph', scope);
  return state?.active ? state : null;
}

export async function readUltraworkState(cwd: string, scope?: HudAuthorityReadScope): Promise<UltraworkStateForHud | null> {
  const state = await readAuthoritativeModeState<UltraworkStateForHud>(cwd, 'ultrawork', scope);
  return state?.active ? state : null;
}

export async function readAutopilotState(cwd: string, scope?: HudAuthorityReadScope): Promise<AutopilotStateForHud | null> {
  const state = await readAuthoritativeModeState<AutopilotStateForHud>(cwd, 'autopilot', scope);
  return state?.active ? state : null;
}

export async function readRalplanState(cwd: string, scope?: HudAuthorityReadScope): Promise<RalplanStateForHud | null> {
  const state = await readAuthoritativeModeState<RalplanStateForHud>(cwd, 'ralplan', scope);
  return state?.active ? state : null;
}

interface DeepInterviewRawState extends DeepInterviewStateForHud {
  input_lock?: {
    active?: boolean;
  };
}

export async function readDeepInterviewState(cwd: string, scope?: HudAuthorityReadScope): Promise<DeepInterviewStateForHud | null> {
  const state = await readAuthoritativeModeState<DeepInterviewRawState>(cwd, 'deep-interview', scope);
  if (!state?.active) return null;
  return {
    ...state,
    input_lock_active: state.input_lock_active ?? state.input_lock?.active === true,
  };
}

export async function readAutoresearchState(cwd: string, scope?: HudAuthorityReadScope): Promise<AutoresearchStateForHud | null> {
  const state = await readAuthoritativeModeState<AutoresearchStateForHud>(cwd, 'autoresearch', scope);
  return state?.active ? state : null;
}

export async function readUltraqaState(cwd: string, scope?: HudAuthorityReadScope): Promise<UltraqaStateForHud | null> {
  const state = await readAuthoritativeModeState<UltraqaStateForHud>(cwd, 'ultraqa', scope);
  return state?.active ? state : null;
}

export async function readTeamState(cwd: string, scope?: HudAuthorityReadScope): Promise<TeamStateForHud | null> {
  const state = await readAuthoritativeModeState<TeamStateForHud>(cwd, 'team', scope);
  return state?.active ? state : null;
}

export async function readMetrics(cwd: string, scope?: HudAuthorityReadScope): Promise<HudMetrics | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  if (!resolvedScope.stateRoot) return null;
  const omxRoot = resolvedScope.context?.generation.canonical_omx_root ?? join(resolvedScope.workspaceRoot, '.omx');
  return readJsonFile<HudMetrics>(join(omxRoot, 'metrics.json'));
}

export async function readHudNotifyState(cwd: string, scope?: HudAuthorityReadScope): Promise<HudNotifyState | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  const path = statePath(resolvedScope, 'hud-state.json', Boolean(resolvedScope.sessionId));
  return path ? readJsonFile<HudNotifyState>(path) : null;
}

export async function readSessionState(cwd: string, scope?: HudAuthorityReadScope): Promise<SessionStateForHud | null> {
  const resolvedScope = scope ?? await resolveHudAuthorityReadScope(cwd);
  const path = statePath(resolvedScope, 'session.json');
  const session = path ? await readJsonFile<{ session_id?: unknown; started_at?: unknown }>(path) : null;
  if (typeof session?.session_id !== 'string' || session.session_id !== resolvedScope.sessionId) return null;
  return {
    session_id: session.session_id,
    started_at: typeof session.started_at === 'string' ? session.started_at : '',
  };
}

export async function readHudConfig(cwd: string): Promise<ResolvedHudConfig> {
  const config = await readJsonFile<HudConfig>(join(cwd, '.omx', 'hud-config.json'));
  return normalizeHudConfig(config);
}

export function readVersion(): string | null {
  return resolveOmxDisplayVersionSync();
}

export type GitRunner = (cwd: string, args: string[]) => string | null;

/**
 * On Windows, read common git queries directly from .git/ files to avoid
 * spawning console windows (conhost.exe flicker).  Falls back to execSync
 * for non-Windows platforms or unrecognised arguments.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-codex/issues/1100
 */
function runGit(cwd: string, args: string[]): string | null {
  if (process.platform === 'win32') {
    try {
      const gitLayout = findGitLayout(cwd);
      if (gitLayout) {
        const cmd = args.join(' ');

        if (cmd === 'rev-parse --abbrev-ref HEAD') {
          const head = readGitLayoutFile(gitLayout.gitDir, 'HEAD');
          if (head?.startsWith('ref: refs/heads/'))
            return head.slice('ref: refs/heads/'.length);
          return head; // detached HEAD — raw SHA
        }

        if (cmd.startsWith('remote get-url ')) {
          const remoteName = args[2];
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const escaped = remoteName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const re = new RegExp(
              `\\[remote "${escaped}"\\][\\s\\S]*?url\\s*=\\s*(.+)`,
              'm',
            );
            const m = config.match(re);
            if (m) return m[1].trim();
          }
          return null;
        }

        if (cmd === 'remote') {
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const matches = [...config.matchAll(/\[remote "([^"]+)"\]/g)];
            if (matches.length > 0) return matches.map((m) => m[1]).join('\n');
          }
          return null;
        }

        if (cmd === 'rev-parse --show-toplevel') {
          return gitLayout.worktreeRoot;
        }
      }
    } catch { /* fall through to execSync */ }
  }

  return runGitExec(cwd, args);
}

function runGitExec(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function extractRepoName(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const repoMatch = remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
  return repoMatch?.[1] ?? null;
}

function readGitBranchName(cwd: string, gitRunner: GitRunner): string | null {
  return gitRunner(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function readGitRemoteUrl(cwd: string, remoteName: string, gitRunner: GitRunner): string | null {
  return gitRunner(cwd, ['remote', 'get-url', remoteName]);
}

function readFirstRemoteName(cwd: string, gitRunner: GitRunner): string | null {
  const remotes = gitRunner(cwd, ['remote']);
  if (!remotes) return null;

  for (const remote of remotes.split(/\r?\n/)) {
    const trimmed = remote.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function readRepoBasename(cwd: string, gitRunner: GitRunner): string | null {
  const topLevel = gitRunner(cwd, ['rev-parse', '--show-toplevel']);
  return topLevel ? basename(topLevel) : null;
}

function resolveRepoLabel(cwd: string, config: ResolvedHudConfig, gitRunner: GitRunner): string | null {
  if (config.git.repoLabel) return config.git.repoLabel;

  if (config.git.remoteName) {
    const repoFromConfiguredRemote = extractRepoName(readGitRemoteUrl(cwd, config.git.remoteName, gitRunner));
    if (repoFromConfiguredRemote) return repoFromConfiguredRemote;
  }

  const repoFromOrigin = extractRepoName(readGitRemoteUrl(cwd, 'origin', gitRunner));
  if (repoFromOrigin) return repoFromOrigin;

  const firstRemoteName = readFirstRemoteName(cwd, gitRunner);
  if (firstRemoteName) {
    const repoFromFirstRemote = extractRepoName(readGitRemoteUrl(cwd, firstRemoteName, gitRunner));
    if (repoFromFirstRemote) return repoFromFirstRemote;
  }

  return readRepoBasename(cwd, gitRunner);
}

export function readGitBranch(cwd: string): string | null {
  return readGitBranchName(cwd, runGit);
}

export function buildGitBranchLabel(
  cwd: string,
  config: ResolvedHudConfig = DEFAULT_HUD_CONFIG,
  gitRunner: GitRunner = runGit,
): string | null {
  const branch = readGitBranchName(cwd, gitRunner);
  if (!branch) return null;

  if (config.git.display === 'branch') {
    return branch;
  }

  const repoLabel = resolveRepoLabel(cwd, config, gitRunner);
  return repoLabel ? `${repoLabel}/${branch}` : branch;
}

const TERMINAL_OR_INACTIVE_PHASES = new Set(['complete', 'completed', 'cancelled', 'canceled', 'failed', 'inactive', 'cleared']);
function normalizeCanonicalHudPhase(phase: string | undefined): string | undefined {
  const raw = sanitizeOptionalString(phase);
  if (!raw) return undefined;
  const namespaced = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  const normalized = sanitizeOptionalString(namespaced)?.toLowerCase().replace(/_/g, '-');
  if (!normalized || TERMINAL_OR_INACTIVE_PHASES.has(normalized)) return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) return undefined;
  return normalized;
}


function isMissingTerminalOrInactiveDetail(detail: { active?: boolean; current_phase?: string } | null): boolean {
  if (!detail) return true;
  if (detail.active !== true) return true;
  const phase = sanitizeOptionalString(detail.current_phase)?.toLowerCase();
  return phase ? TERMINAL_OR_INACTIVE_PHASES.has(phase) : false;
}

function shouldSurfaceCanonicalSkill(
  canonicalSkills: Map<string, { phase?: string }>,
  skill: string,
  detail: { active?: boolean; current_phase?: string } | null,
): boolean {
  const canonicalPhase = canonicalPhaseForSkill(canonicalSkills, skill);
  if (canonicalSkills.has(skill) && !detail && canonicalPhase) return true;
  if (!canonicalSkills.has(skill)) return false;
  return !isMissingTerminalOrInactiveDetail(detail);
}

function canonicalPhaseForSkill(
  canonicalSkills: Map<string, { phase?: string }>,
  skill: string,
): string | undefined {
  return canonicalSkills.get(skill)?.phase;
}

function mergePhase<T extends { active?: boolean; current_phase?: string }>(
  detail: T | null,
  canonicalPhase?: string,
): T | null {
  const normalizedCanonicalPhase = normalizeCanonicalHudPhase(canonicalPhase);
  if (detail?.active === true) {
    if (detail.current_phase || !normalizedCanonicalPhase) return detail;
    return { ...detail, current_phase: normalizedCanonicalPhase };
  }
  if (!normalizedCanonicalPhase) return null;
  return { active: true, current_phase: normalizedCanonicalPhase } as T;
}

async function readCanonicalTeamPhase(
  scope: HudAuthorityReadScope,
  teamDetail: TeamStateForHud | null,
): Promise<string | undefined> {
  const teamName = sanitizeOptionalString(teamDetail?.team_name);
  if (!teamName || !scope.stateRoot) return undefined;
  const phaseState = await readJsonFile<{ current_phase?: unknown }>(join(scope.stateRoot, 'team', teamName, 'phase.json'));
  return sanitizeOptionalString(phaseState?.current_phase);
}

function mergeTeamPhase(
  detail: TeamStateForHud | null,
  canonicalSkillPhase?: string,
  canonicalTeamPhase?: string,
): TeamStateForHud | null {
  const canonicalPhase = canonicalTeamPhase || canonicalSkillPhase;
  if (detail?.active === true) {
    return canonicalPhase ? { ...detail, current_phase: canonicalPhase } : detail;
  }
  if (!canonicalPhase) return null;
  return { active: true, current_phase: canonicalPhase };
}

function activeAutopilotPhase(autopilot: AutopilotStateForHud | null): string | undefined {
  if (autopilot?.active !== true) return undefined;
  return sanitizeOptionalString(autopilot.current_phase)?.toLowerCase().replace(/_/g, '-');
}

function isReportableCurrentAutopilotState(autopilot: AutopilotStateForHud | null): boolean {
  if (autopilot?.active !== true) return false;
  return sanitizeOptionalString(autopilot.current_phase) !== undefined
    || sanitizeOptionalString(autopilot.session_id) !== undefined
    || sanitizeOptionalString(autopilot.tmux_pane_id) !== undefined;
}

function buildStaleCurrentAutopilotState(autopilot: AutopilotStateForHud | null): AutopilotStateForHud | null {
  if (!isReportableCurrentAutopilotState(autopilot)) return null;
  const reportable = autopilot as AutopilotStateForHud;
  return {
    ...reportable,
    active: true,
    mode: reportable.mode ?? 'autopilot',
    source: 'current-autopilot-stale',
    stale_reason: 'current-autopilot-not-authoritative',
  };
}


function withLateGateSource<T extends { source?: LateGateHudSource }>(
  state: T | null,
  source: LateGateHudSource,
): T | null {
  return state ? { ...state, source } : null;
}

function supervisedAutopilotStage<T extends { active?: boolean; current_phase?: string; source?: LateGateHudSource }>(
  autopilot: AutopilotStateForHud | null,
  stage: string,
): T | null {
  return activeAutopilotPhase(autopilot) === stage
    ? { active: true, current_phase: 'autopilot', source: 'autopilot' } as T
    : null;
}

function hasLiveCodeReviewSubagentEvidence(
  tracking: SubagentTrackingState,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return false;
  const summary = summarizeSubagentSession(tracking, sessionId);
  if (!summary || summary.activeSubagentThreadIds.length === 0) return false;
  const session = tracking.sessions[sessionId];
  if (!session) return false;
  return summary.activeSubagentThreadIds.some((threadId) => {
    const mode = sanitizeOptionalString(session.threads[threadId]?.mode)?.toLowerCase();
    return mode === 'code-reviewer' || mode === 'code-review';
  });
}

function codeReviewFromSubagentEvidence(
  canonicalSkills: Map<string, { phase?: string }>,
  tracking: SubagentTrackingState,
  sessionId: string | undefined,
  autopilot: AutopilotStateForHud | null,
): CodeReviewStateForHud | null {
  if (autopilot?.active === true) return null;
  if (!hasLiveCodeReviewSubagentEvidence(tracking, sessionId)) return null;
  const phase = normalizeCanonicalHudPhase(canonicalPhaseForSkill(canonicalSkills, 'autopilot'));
  return {
    active: true,
    current_phase: phase === 'reviewing' || phase === 'review' || phase === 'code-review'
      ? phase
      : 'reviewing',
    source: 'subagent-tracking',
  };
}

export interface HudAuthorityStatus {
  status: 'legacy' | 'validated' | 'invalid';
  workspaceRoot: string;
  stateRoot: string | null;
  diagnostics: HudAuthorityDiagnostic[];
}

/** Read all state files and build the full render context. */
export async function readAllState(
  cwd: string,
  config: ResolvedHudConfig = DEFAULT_HUD_CONFIG,
  authorityContext?: ResolvedStateAuthorityContext,
): Promise<HudRenderContext & { authority?: HudAuthorityStatus }> {
  const authorityScope = await resolveHudAuthorityReadScope(cwd, authorityContext);
  const version = readVersion();
  const gitBranch = authorityScope.diagnostics[0]
    ? `authority:${authorityScope.diagnostics[0].code}`
    : buildGitBranchLabel(authorityScope.workspaceRoot, config);
  const [metrics, hudNotify, session, subagentTracking] = await Promise.all([
    readMetrics(cwd, authorityScope),
    readHudNotifyState(cwd, authorityScope),
    readSessionState(cwd, authorityScope),
    authorityScope.stateRoot
      ? readJsonFile<SubagentTrackingState>(join(authorityScope.stateRoot, 'subagent-tracking.json')).then((state) => state ?? createSubagentTrackingState())
      : Promise.resolve(createSubagentTrackingState()),
  ]);
  const canonicalSkillState = authorityScope.stateRoot
    ? await readVisibleSkillActiveStateForStateDir(authorityScope.stateRoot, authorityScope.sessionId)
    : {};
  const canonicalSkills = new Map(
    listActiveSkills(canonicalSkillState).map((entry) => [entry.skill, entry] as const),
  );

  const [
    ralphDetail,
    ultragoalArtifact,
    ultragoalDetail,
    ultraworkDetail,
    autopilotDetail,
    ralplanDetail,
    deepInterviewDetail,
    autoresearchDetail,
    ultraqaDetail,
    teamDetail,
    currentAutopilotDetail,
  ] = await Promise.all([
    readAuthoritativeModeState<RalphStateForHud>(cwd, 'ralph', authorityScope),
    readUltragoalState(cwd, authorityScope),
    readAuthoritativeModeState<UltragoalStateForHud>(cwd, 'ultragoal', authorityScope),
    readAuthoritativeModeState<UltraworkStateForHud>(cwd, 'ultrawork', authorityScope),
    readAuthoritativeModeState<AutopilotStateForHud>(cwd, 'autopilot', authorityScope),
    readAuthoritativeModeState<RalplanStateForHud>(cwd, 'ralplan', authorityScope),
    readAuthoritativeModeState<DeepInterviewRawState>(cwd, 'deep-interview', authorityScope),
    readAuthoritativeModeState<AutoresearchStateForHud>(cwd, 'autoresearch', authorityScope),
    readAuthoritativeModeState<UltraqaStateForHud>(cwd, 'ultraqa', authorityScope),
    readAuthoritativeModeState<TeamStateForHud>(cwd, 'team', authorityScope),
    readCurrentAutopilotState(cwd, authorityScope),
  ]);
  const canonicalSkillStateExists = authorityScope.stateRoot
    ? [
      join(authorityScope.stateRoot, 'skill-active-state.json'),
      ...(authorityScope.sessionId
        ? [join(authorityScope.stateRoot, 'sessions', authorityScope.sessionId, 'skill-active-state.json')]
        : []),
    ].some((path) => existsSync(path))
    : false;
  if (!canonicalSkillStateExists && canonicalSkills.size === 0) {
    for (const [skill, detail] of [
      ['ralph', ralphDetail],
      ['ultrawork', ultraworkDetail],
      ['autopilot', autopilotDetail],
      ['ralplan', ralplanDetail],
      ['deep-interview', deepInterviewDetail],
      ['autoresearch', autoresearchDetail],
      ['ultraqa', ultraqaDetail],
      ['team', teamDetail],
    ] as const) {
      if (detail?.active === true) {
        const phase = 'current_phase' in detail && typeof detail.current_phase === 'string'
          ? detail.current_phase
          : undefined;
        canonicalSkills.set(skill, { skill, phase, active: true });
      }
    }
  }

  const ralph = shouldSurfaceCanonicalSkill(canonicalSkills, 'ralph', ralphDetail)
    ? mergePhase(ralphDetail?.active === true ? ralphDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ralph'))
    : null;
  const ultragoal = ultragoalArtifact
    ?? (shouldSurfaceCanonicalSkill(canonicalSkills, 'ultragoal', ultragoalDetail)
      ? mergePhase(ultragoalDetail?.active === true ? ultragoalDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultragoal'))
      : null);
  const ultrawork = shouldSurfaceCanonicalSkill(canonicalSkills, 'ultrawork', ultraworkDetail)
    ? mergePhase(ultraworkDetail?.active === true ? ultraworkDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultrawork'))
    : null;
  const autopilot = shouldSurfaceCanonicalSkill(canonicalSkills, 'autopilot', autopilotDetail)
    ? mergePhase(autopilotDetail?.active === true ? autopilotDetail : null, canonicalPhaseForSkill(canonicalSkills, 'autopilot'))
    : null;
  const staleAutopilot = autopilot ? null : buildStaleCurrentAutopilotState(currentAutopilotDetail);
  const ralplan = shouldSurfaceCanonicalSkill(canonicalSkills, 'ralplan', ralplanDetail)
    ? mergePhase(ralplanDetail?.active === true ? ralplanDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ralplan'))
    : null;
  const deepInterview = shouldSurfaceCanonicalSkill(canonicalSkills, 'deep-interview', deepInterviewDetail)
    ? (() => {
      const merged = mergePhase(
        deepInterviewDetail?.active === true ? {
          ...deepInterviewDetail,
          input_lock_active: deepInterviewDetail.input_lock_active ?? deepInterviewDetail.input_lock?.active === true,
        } : null,
        canonicalPhaseForSkill(canonicalSkills, 'deep-interview'),
      );
      return merged;
    })()
    : null;
  const codeReview = shouldSurfaceCanonicalSkill(canonicalSkills, 'code-review', null)
    ? withLateGateSource(
      mergePhase<CodeReviewStateForHud>(null, canonicalPhaseForSkill(canonicalSkills, 'code-review')),
      'canonical-skill',
    )
    : supervisedAutopilotStage<CodeReviewStateForHud>(autopilot, 'code-review')
      ?? codeReviewFromSubagentEvidence(canonicalSkills, subagentTracking, authorityScope.sessionId, autopilot);
  const ultraqa = shouldSurfaceCanonicalSkill(canonicalSkills, 'ultraqa', ultraqaDetail)
    ? (() => {
      const detail = ultraqaDetail?.active === true ? ultraqaDetail : null;
      const merged = mergePhase(detail, canonicalPhaseForSkill(canonicalSkills, 'ultraqa'));
      return detail ? merged : withLateGateSource(merged, 'canonical-skill');
    })()
    : supervisedAutopilotStage<UltraqaStateForHud>(autopilot, 'ultraqa');
  const canonicalTeamPhase = await readCanonicalTeamPhase(authorityScope, teamDetail?.active === true ? teamDetail : null);
  const team = shouldSurfaceCanonicalSkill(canonicalSkills, 'team', teamDetail)
    ? mergeTeamPhase(
      teamDetail?.active === true ? teamDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'team'),
      canonicalTeamPhase,
    )
    : null;
  const autoresearch = shouldSurfaceCanonicalSkill(canonicalSkills, 'autoresearch', autoresearchDetail)
    ? mergePhase(
      autoresearchDetail?.active === true ? autoresearchDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'autoresearch'),
    )
    : null;

  let runtimeSnapshot: RuntimeSnapshot | null = null;
  if (isBridgeEnabled() && authorityScope.stateRoot) {
    const bridge = getDefaultBridge(authorityScope.stateRoot);
    runtimeSnapshot = bridge.readCompatFile<RuntimeSnapshot>('snapshot.json');
  }

  return {
    version,
    gitBranch,
    ralph,
    ultragoal,
    ultrawork,
    autopilot,
    ralplan,
    deepInterview,
    autoresearch,
    codeReview,
    ultraqa,
    team,
    metrics,
    hudNotify,
    session,
    runtimeSnapshot,
    staleAutopilot,
    authority: {
      status: authorityScope.stateRoot
        ? (authorityScope.context ? 'validated' : 'legacy')
        : 'invalid',
      workspaceRoot: authorityScope.workspaceRoot,
      stateRoot: authorityScope.stateRoot,
      diagnostics: authorityScope.diagnostics,
    },
  };
}
