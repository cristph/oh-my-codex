/**
 * Base mode lifecycle management for oh-my-codex
 * All execution modes (autopilot, autoresearch, deep-interview, ralph, ultrawork, team, ultraqa, ralplan) share this base.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'node:path';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import {
  assertWorkflowTransitionAllowed,
  isTrackedWorkflowMode,
  TRACKED_WORKFLOW_MODES,
  type TrackedWorkflowMode,
} from '../state/workflow-transition.js';
import { reconcileWorkflowTransition } from '../state/workflow-transition-reconcile.js';
import { resolveStateAuthorityForGuard } from '../state/authority.js';
import { syncCanonicalSkillStateForMode } from '../state/skill-active.js';
import { validateAndNormalizeRalphState } from '../ralph/contract.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { validateAutopilotCompletionTransition } from '../autopilot/completion-gate.js';
import { canAdvanceAutopilotDeepInterviewToRalplan, buildAutopilotDeepInterviewRalplanGateError } from '../autopilot/deep-interview-gate.js';
import { canAdvanceAutopilotRalplanToUltragoal, buildAutopilotRalplanUltragoalGateError } from '../autopilot/ralplan-gate.js';
import { deriveAutopilotChildPhase, type AutopilotChildPhase } from '../autopilot/fsm.js';
import { syncRunStateFromModeState } from '../runtime/run-state.js';
import {
  getStatePath,
  resolveWritableStateScope,
} from '../mcp/state-paths.js';
import { completeRalplanSession, validateRalplanTerminalConsensus } from '../state/operations.js';


export interface ModeState {
  active: boolean;
  mode: string;
  iteration: number;
  max_iterations: number;
  current_phase: string;
  run_outcome?: string;
  task_description?: string;
  started_at: string;
  completed_at?: string;
  last_turn_at?: string;
  error?: string;
  [key: string]: unknown;
}

export type ModeName = 'autopilot' | 'autoresearch' | 'deep-interview' | 'ralph' | 'ultrawork' | 'team' | 'ultraqa' | 'ultragoal' | 'ralplan';

/** @deprecated These mode names were removed in v4.6. Use the canonical modes instead. */
export type DeprecatedModeName = 'ultrapilot' | 'pipeline' | 'ecomode';

export interface UpdateModeStateOptions {
  trustedPipelineProgress?: boolean;
}

const DEPRECATED_MODES: Record<DeprecatedModeName, string> = {
  ultrapilot: 'Use "team" instead. ultrapilot has been merged into team mode.',
  pipeline: 'Use "team" instead. pipeline has been merged into team mode.',
  ecomode: 'Use "ultrawork" instead. ecomode has been merged into ultrawork mode.',
};

const AUTOPILOT_CHILD_PHASE_ORDER: AutopilotChildPhase[] = [
  'deep-interview',
  'ralplan',
  'ultragoal',
  'rework',
  'team',
  'ralph',
  'code-review',
  'ultraqa',
];

function autopilotPhaseOrder(phase: AutopilotChildPhase | null): number {
  return phase ? AUTOPILOT_CHILD_PHASE_ORDER.indexOf(phase) : -1;
}

function isForwardAutopilotPhase(
  currentPhase: AutopilotChildPhase | null,
  nextPhase: AutopilotChildPhase | null,
): boolean {
  const currentOrder = autopilotPhaseOrder(currentPhase);
  const nextOrder = autopilotPhaseOrder(nextPhase);
  return currentOrder >= 0 && nextOrder > currentOrder;
}

function isNextAutopilotPhase(
  currentPhase: AutopilotChildPhase | null,
  nextPhase: AutopilotChildPhase | null,
): boolean {
  const currentOrder = autopilotPhaseOrder(currentPhase);
  const nextOrder = autopilotPhaseOrder(nextPhase);
  return currentOrder >= 0 && nextOrder === currentOrder + 1;
}

/**
 * Check if a mode name is deprecated and return a warning message if so.
 * Returns null if the mode is not deprecated.
 */
export function getDeprecationWarning(mode: string): string | null {
  const warning = DEPRECATED_MODES[mode as DeprecatedModeName];
  if (!warning) return null;
  return `[DEPRECATED] Mode "${mode}" is deprecated. ${warning}`;
}

function normalizeRalphModeStateOrThrow(state: ModeState): ModeState {
  const originalPhase = state.current_phase;
  const validation = validateAndNormalizeRalphState(state as Record<string, unknown>);
  if (!validation.ok || !validation.state) {
    throw new Error(validation.error || 'Invalid ralph mode state');
  }
  const normalized = validation.state as ModeState;
  if (
    typeof originalPhase === 'string'
    && typeof normalized.current_phase === 'string'
    && normalized.current_phase !== originalPhase
  ) {
    normalized.ralph_phase_normalized_from = originalPhase;
  }
  return normalized;
}

function applySharedRunOutcomeContractOrThrow(state: ModeState): ModeState {
  const validation = applyRunOutcomeContract(state as Record<string, unknown>);
  if (!validation.ok || !validation.state) {
    throw new Error(validation.error || 'Invalid run outcome state');
  }
  return validation.state as ModeState;
}

function normalizeModeStateOrThrow(mode: string, state: ModeState): ModeState {
  const normalized = mode === 'ralph'
    ? normalizeRalphModeStateOrThrow(state)
    : state;
  return applySharedRunOutcomeContractOrThrow(normalized);
}

async function readActiveWorkflowModesFromStateDir(stateDir: string): Promise<TrackedWorkflowMode[]> {
  const activeModes: TrackedWorkflowMode[] = [];
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const state = await readModeStateFromPaths([join(stateDir, basename(getStatePath(mode)))]);
    if (state?.active) activeModes.push(mode);
  }
  return activeModes;
}

export async function assertModeStartAllowed(
  mode: ModeName,
  projectRoot?: string,
): Promise<void> {
  if (!isTrackedWorkflowMode(mode)) return;
  const scope = await resolveWritableStateScope(projectRoot);

  const activeModes = await readActiveWorkflowModesFromStateDir(scope.stateDir);
  assertWorkflowTransitionAllowed(activeModes, mode, 'start');
}

/**
 * Start a mode. Checks for exclusive mode conflicts.
 */
export async function startMode(
  mode: ModeName,
  taskDescription: string,
  maxIterations: number = 50,
  projectRoot?: string
): Promise<ModeState> {
  const scope = await resolveWritableStateScope(projectRoot);
  const modeStatePath = join(scope.stateDir, basename(getStatePath(mode)));
  const baseStateDir = dirname(dirname(scope.stateDir));
  let transitionMessage: string | undefined;
  if (isTrackedWorkflowMode(mode)) {
    const authority = await resolveStateAuthorityForGuard({
      startup_cwd: projectRoot ?? process.cwd(),
      observed_cwd: projectRoot ?? process.cwd(),
      session_id: scope.sessionId,
    });
    const transition = await reconcileWorkflowTransition(projectRoot ?? process.cwd(), mode, {
      action: 'start',
      sessionId: scope.sessionId,
      source: 'startMode',
      baseStateDir,
      expectedRootIdentity: authority.generation.root_identity,
    });
    transitionMessage = transition.transitionMessage;
  }
  await mkdir(scope.stateDir, { recursive: true });

  const stateBase: ModeState = {
    active: true,
    mode,
    iteration: 0,
    max_iterations: maxIterations,
    current_phase: 'starting',
    task_description: taskDescription,
    started_at: new Date().toISOString(),
    ...(transitionMessage ? { transition_message: transitionMessage } : {}),
    ...(mode === 'ralph' && scope.sessionId ? { owner_omx_session_id: scope.sessionId } : {}),
  };

  const withContext = withModeRuntimeContext({}, stateBase) as ModeState;
  const state = normalizeModeStateOrThrow(mode, withContext);
  await writeFile(modeStatePath, JSON.stringify(state, null, 2));
  await syncRunStateFromModeState(state, projectRoot, scope.sessionId);
  if (isTrackedWorkflowMode(mode)) {
    const authority = await resolveStateAuthorityForGuard({
      startup_cwd: projectRoot ?? process.cwd(),
      observed_cwd: projectRoot ?? process.cwd(),
      session_id: scope.sessionId,
    });
    await syncCanonicalSkillStateForMode({
      cwd: projectRoot ?? process.cwd(),
      baseStateDir,
      mode,
      active: true,
      currentPhase: typeof state.current_phase === 'string' ? state.current_phase : undefined,
      sessionId: scope.sessionId,
      source: 'startMode',
      expectedRootIdentity: authority.generation.root_identity,
    });
  }
  return state;
}

/**
 * Read current mode state
 */
export async function readModeState(mode: string, projectRoot?: string): Promise<ModeState | null> {
  const scope = await resolveWritableStateScope(projectRoot);
  return readModeStateFromPaths([join(scope.stateDir, basename(getStatePath(mode)))]);
}

async function readModeStateFromPaths(paths: string[]): Promise<ModeState | null> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(await readFile(path, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

export async function readModeStateForSession(
  mode: string,
  sessionId: string | undefined,
  projectRoot?: string,
): Promise<ModeState | null> {
  try {
    const scope = await resolveWritableStateScope(projectRoot, sessionId);
    return readModeStateFromPaths([join(scope.stateDir, basename(getStatePath(mode)))]);
  } catch {
    return null;
  }
}

export async function readModeStateForActiveDecision(
  mode: string,
  sessionId: string | undefined,
  projectRoot?: string,
): Promise<ModeState | null> {
  try {
    const scope = await resolveWritableStateScope(projectRoot, sessionId);
    return readModeStateFromPaths([join(scope.stateDir, basename(getStatePath(mode)))]);
  } catch {
    return null;
  }
}

function assertRalphUpdateMatchesSession(state: ModeState, sessionId?: string): void {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return;

  const ownerOmxSessionId = typeof state.owner_omx_session_id === 'string'
    ? state.owner_omx_session_id.trim()
    : '';
  if (ownerOmxSessionId && ownerOmxSessionId !== normalizedSessionId) {
    throw new Error(`Mode ralph state belongs to another session (${ownerOmxSessionId})`);
  }

  const stateSessionId = typeof state.session_id === 'string' ? state.session_id.trim() : '';
  if (stateSessionId && stateSessionId !== normalizedSessionId) {
    throw new Error(`Mode ralph state belongs to another session (${stateSessionId})`);
  }
}

/**
 * Update mode state (merge fields)
 */
export async function updateModeState(
  mode: string,
  updates: Partial<ModeState>,
  projectRoot?: string,
  explicitSessionId?: string,
  options: UpdateModeStateOptions = {},
): Promise<ModeState> {
  const scope = await resolveWritableStateScope(projectRoot, explicitSessionId);
  const baseStateDir = dirname(dirname(scope.stateDir));
  const modeStatePath = join(scope.stateDir, basename(getStatePath(mode)));
  const current = await readModeStateFromPaths([modeStatePath]);
  if (!current) throw new Error(`Mode ${mode} not found`);
  await mkdir(scope.stateDir, { recursive: true });

  if (mode === 'ralph') {
    assertRalphUpdateMatchesSession(current, scope.sessionId);
  }

  const updatedBase = { ...current, ...updates };
  delete updatedBase.trustedPipelineProgress;
  if (!Object.prototype.hasOwnProperty.call(updates, 'run_outcome')) {
    delete updatedBase.run_outcome;
  }
  if (mode === 'ralph' && scope.sessionId && typeof updatedBase.owner_omx_session_id !== 'string') {
    updatedBase.owner_omx_session_id = scope.sessionId;
  }
  const normalizedBase = normalizeModeStateOrThrow(mode, updatedBase as ModeState);
  if (mode === 'ralplan') {
    const validationError = validateRalplanTerminalConsensus(
      projectRoot ?? process.cwd(),
      normalizedBase as Record<string, unknown>,
      scope.sessionId,
    );
    if (validationError) throw new Error(validationError);
  }
  if (mode === 'autopilot') {
    const isPipelineOrchestratorProgressWrite = options.trustedPipelineProgress === true;
    const currentAutopilotChildPhase = deriveAutopilotChildPhase({ ...current, mode: 'autopilot' });
    const nextAutopilotChildPhase = deriveAutopilotChildPhase({ ...normalizedBase, mode: 'autopilot' });
    const completionTransitionError = validateAutopilotCompletionTransition(
      current as Record<string, unknown>,
      normalizedBase as Record<string, unknown>,
      { allowUnknownActivePhaseCompletion: options.trustedPipelineProgress === true },
    );
    if (completionTransitionError) throw new Error(completionTransitionError);
    if (!isPipelineOrchestratorProgressWrite) {
      if (
        currentAutopilotChildPhase === 'deep-interview'
        && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
        && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
      ) {
        throw new Error('Cannot skip Autopilot ralplan gate: deep-interview may only advance to ralplan.');
      }
      if (
        currentAutopilotChildPhase === 'deep-interview'
        && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
      ) {
        const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
          cwd: projectRoot ?? process.cwd(),
          sessionId: scope.sessionId,
          baseStateDir,
          currentState: current as Record<string, unknown>,
          nextState: normalizedBase as Record<string, unknown>,
        });
        if (!gate.allowed) throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
      }
      if (
        currentAutopilotChildPhase === 'ralplan'
        && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
        && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
      ) {
        throw new Error('Cannot skip Autopilot ultragoal gate: ralplan may only advance to ultragoal.');
      }
      if (
        currentAutopilotChildPhase === 'ralplan'
        && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
      ) {
        const gate = canAdvanceAutopilotRalplanToUltragoal({
          cwd: projectRoot ?? process.cwd(),
          sessionId: scope.sessionId,
          currentState: current as Record<string, unknown>,
          nextState: normalizedBase as Record<string, unknown>,
        });
        if (!gate.allowed) throw new Error(buildAutopilotRalplanUltragoalGateError(gate));
      }
    }
  }
  const updated = withModeRuntimeContext(current, normalizedBase) as ModeState;
  await writeFile(modeStatePath, JSON.stringify(updated, null, 2));
  await syncRunStateFromModeState(updated, projectRoot, scope.sessionId);
  if (isTrackedWorkflowMode(mode)) {
    const cwd = projectRoot ?? process.cwd();
    const ralplanCompletionHandled = mode === 'ralplan' && await completeRalplanSession({
      cwd,
      baseStateDir,
      state: updated as Record<string, unknown>,
      explicitSessionId: scope.sessionId,
    });
    if (!ralplanCompletionHandled) {
      const authority = await resolveStateAuthorityForGuard({
        startup_cwd: cwd,
        observed_cwd: cwd,
        session_id: scope.sessionId,
      });
      await syncCanonicalSkillStateForMode({
        cwd,
        baseStateDir,
        mode,
        active: updated.active === true,
        currentPhase: typeof updated.current_phase === 'string' ? updated.current_phase : undefined,
        sessionId: scope.sessionId,
        source: 'updateModeState',
        expectedRootIdentity: authority.generation.root_identity,
      });
    }
  }
  return updated;
}

/**
 * Cancel a mode
 */
export async function cancelMode(mode: string, projectRoot?: string): Promise<void> {
  const state = await readModeState(mode, projectRoot);
  if (state && state.active) {
    await updateModeState(mode, {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }, projectRoot);
  }
}

/**
 * Cancel all active modes
 */
export async function cancelAllModes(projectRoot?: string): Promise<string[]> {
  const scope = await resolveWritableStateScope(projectRoot);
  const cancelled: string[] = [];
  if (!existsSync(scope.stateDir)) return cancelled;

  const files = await readdir(scope.stateDir);
  for (const f of files) {
    if (!f.endsWith('-state.json')) continue;
    const mode = f.replace('-state.json', '');
    const state = await readModeStateFromPaths([join(scope.stateDir, f)]);
    if (state?.active) {
      await cancelMode(mode, projectRoot);
      cancelled.push(mode);
    }
  }
  return cancelled;
}

/**
 * List all active modes
 */
export async function listActiveModes(projectRoot?: string): Promise<Array<{ mode: string; state: ModeState }>> {
  const scope = await resolveWritableStateScope(projectRoot);
  const active: Array<{ mode: string; state: ModeState }> = [];
  if (!existsSync(scope.stateDir)) return active;

  const files = await readdir(scope.stateDir);
  for (const f of files) {
    if (!f.endsWith('-state.json')) continue;
    const mode = f.replace('-state.json', '');
    const state = await readModeStateFromPaths([join(scope.stateDir, f)]);
    if (state?.active) active.push({ mode, state });
  }
  return active;
}
