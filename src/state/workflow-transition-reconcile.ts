import { constants } from 'fs';
import { lstat, mkdir, open } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { getBaseStateDir, validateSessionId, validateStateModeSegment } from '../mcp/state-paths.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  atomicWriteAuthorityFile,
  captureRootFilesystemIdentity,
  isTrustedAuthorityPlatformRootAlias,
  sameRootFilesystemIdentity,
  type RootFilesystemIdentity,
} from './authority.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  TRACKED_WORKFLOW_MODES,
  isTrackedWorkflowMode,
  type TrackedWorkflowMode,
  type WorkflowTransitionAction,
  type WorkflowTransitionDecision,
} from './workflow-transition.js';
import {
  listActiveSkills,
  readVisibleSkillActiveStateForStateDir,
  syncCanonicalSkillStateForMode,
} from './skill-active.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { normalizeTerminalWorkflowState } from './terminal-normalization.js';
import { clearDeepInterviewQuestionObligation } from '../question/deep-interview.js';
import {
  buildAutopilotDeepInterviewRalplanGateError,
  canAdvanceAutopilotDeepInterviewToRalplan,
} from '../autopilot/deep-interview-gate.js';

interface TransitionStateLike {
  active?: unknown;
  current_phase?: unknown;
  completed_at?: unknown;
  [key: string]: unknown;
}

export interface ReconciledWorkflowTransition {
  decision: WorkflowTransitionDecision;
  transitionMessage?: string;
  autoCompletedModes: TrackedWorkflowMode[];
  completedPaths: string[];
}

export interface PlannedWorkflowTransition {
  decision: WorkflowTransitionDecision;
  transitionMessage?: string;
  autoCompletedModes: TrackedWorkflowMode[];
  sourceTargets: string[];
  stateRoot: string;
  rootIdentity: RootFilesystemIdentity;
  requestedMode: TrackedWorkflowMode;
  sessionId?: string;
  nowIso: string;
  source: string;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stateReadError(
  code: typeof AUTHORITY_DIAGNOSTIC_CODES[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
  message: string,
): never {
  throw new StateAuthorityError(code, message);
}

async function assertPersistedWorkflowStateRootIdentity(
  stateRoot: string,
  expectedRootIdentity: RootFilesystemIdentity | undefined,
  label: string,
): Promise<void> {
  if (!expectedRootIdentity) return;
  const actualRootIdentity = await captureRootFilesystemIdentity(stateRoot);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      `${label} does not match the persisted active state-root identity`,
    );
  }
}

function isPathWithinStateRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function sameFileIdentity(
  expected: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
  actual: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
  const target = resolve(path);
  const components: string[] = [];
  let cursor = target;
  while (dirname(cursor) !== cursor) {
    components.unshift(cursor.slice(dirname(cursor).length).replace(/^[\\/]+/, ''));
    cursor = dirname(cursor);
  }

  let current = cursor;
  for (const component of ['', ...components]) {
    if (component) current = join(current, component);
    try {
      const details = await lstat(current);
      if (
        details.isSymbolicLink()
        && !await isTrustedAuthorityPlatformRootAlias(current, details)
      ) {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} has a symbolic-link component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertStateDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!details.isDirectory()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a directory: ${path}`);
  }
}

async function assertStateDirectoryIfPresent(path: string, label: string): Promise<boolean> {
  try {
    await assertStateDirectory(path, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureStateDirectory(
  path: string,
  label: string,
  stateRoot: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  await assertPersistedWorkflowStateRootIdentity(stateRoot, expectedRootIdentity, label);
  await assertNoSymlinkComponents(path, label);
  await mkdir(path, { recursive: true });
  await assertPersistedWorkflowStateRootIdentity(stateRoot, expectedRootIdentity, label);
  await assertNoSymlinkComponents(path, label);
  await assertStateDirectory(path, label);
}

async function assertWorkflowStateParent(
  stateRoot: string,
  path: string,
  sessionId?: string,
  options: { create?: boolean; expectedRootIdentity?: RootFilesystemIdentity } = {},
): Promise<void> {
  const root = resolve(stateRoot);
  const target = resolve(path);
  await assertPersistedWorkflowStateRootIdentity(root, options.expectedRootIdentity, 'workflow state root');
  if (!isPathWithinStateRoot(root, target)) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `workflow state escapes the active authority root: ${target}`);
  }
  if (sessionId) validateSessionId(sessionId);

  if (options.create) {
    await ensureStateDirectory(root, 'workflow state root', root, options.expectedRootIdentity);
  } else if (!await assertStateDirectoryIfPresent(root, 'workflow state root')) {
    return;
  }
  await assertNoSymlinkComponents(root, 'workflow state root');
  await assertStateDirectory(root, 'workflow state root');

  if (!sessionId) {
    if (dirname(target) !== root) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `workflow state has an invalid root-scoped parent: ${target}`);
    }
    return;
  }
  if (dirname(target) !== join(root, 'sessions', sessionId)) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `workflow state has an invalid session-scoped parent: ${target}`);
  }
  const sessionsDir = join(root, 'sessions');
  const sessionDir = join(sessionsDir, sessionId);
  if (options.create) {
    await ensureStateDirectory(sessionsDir, 'workflow sessions directory', root, options.expectedRootIdentity);
    await ensureStateDirectory(sessionDir, 'workflow session directory', root, options.expectedRootIdentity);
  } else if (!await assertStateDirectoryIfPresent(sessionsDir, 'workflow sessions directory')
    || !await assertStateDirectoryIfPresent(sessionDir, 'workflow session directory')) {
    return;
  }
  await assertPersistedWorkflowStateRootIdentity(root, options.expectedRootIdentity, 'workflow state root');
  await assertNoSymlinkComponents(sessionDir, 'workflow session directory');
  await assertStateDirectory(sessionsDir, 'workflow sessions directory');
  await assertStateDirectory(sessionDir, 'workflow session directory');
}

async function readWorkflowStateFileIfPresent(
  stateRoot: string,
  path: string,
  sessionId: string | undefined,
  label: string,
): Promise<string | null> {
  const root = resolve(stateRoot);
  const target = resolve(path);
  await assertWorkflowStateParent(root, target, sessionId);
  if (!await assertStateDirectoryIfPresent(root, 'workflow state root')) return null;

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

  let beforeOpen: Awaited<ReturnType<typeof lstat>>;
  try {
    beforeOpen = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (beforeOpen.isSymbolicLink()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${target}`);
  }
  if (!beforeOpen.isFile()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a regular file: ${target}`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(target, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const opened = await handle.stat();
    const afterOpen = await lstat(target);
    if (afterOpen.isSymbolicLink() || !afterOpen.isFile()
      || !sameFileIdentity(beforeOpen, opened)
      || !sameFileIdentity(opened, afterOpen)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} changed while opening: ${target}`);
    }
    await assertWorkflowStateParent(root, target, sessionId);
    const content = await handle.readFile({ encoding: 'utf8' }) as string;
    const afterRead = await lstat(target);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameFileIdentity(opened, afterRead)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} was replaced while reading: ${target}`);
    }
    await assertWorkflowStateParent(root, target, sessionId);
    return content;
  } finally {
    await handle?.close();
  }
}

async function readJsonIfExists(
  stateRoot: string,
  path: string,
  sessionId: string | undefined,
  options?: { mode?: TrackedWorkflowMode; throwOnParseError?: boolean },
): Promise<TransitionStateLike | null> {
  const content = await readWorkflowStateFileIfPresent(stateRoot, path, sessionId, 'workflow state');
  if (content === null) return null;
  try {
    return JSON.parse(content) as TransitionStateLike;
  } catch {
    if (options?.throwOnParseError && options.mode) {
      throw new Error(
        `Cannot read ${options.mode} workflow state at ${path}. Repair or clear that workflow state yourself via \`omx state clear --input '{"mode":"${options.mode}"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
      );
    }
    return null;
  }
}

async function writeWorkflowStateFile(
  stateRoot: string,
  path: string,
  sessionId: string | undefined,
  state: TransitionStateLike,
  expectedRootIdentity: RootFilesystemIdentity,
): Promise<void> {
  const root = resolve(stateRoot);
  const target = resolve(path);
  await assertWorkflowStateParent(root, target, sessionId, { create: true, expectedRootIdentity });
  await atomicWriteAuthorityFile(target, JSON.stringify(state, null, 2), {
    authority_root: root,
    expected_root_identity: expectedRootIdentity,
  });
}

function modeStatePathForRoot(
  mode: TrackedWorkflowMode,
  stateRoot: string,
  sessionId?: string,
): string {
  const fileName = `${validateStateModeSegment(mode)}-state.json`;
  const normalizedSessionId = sessionId ? validateSessionId(sessionId) : undefined;
  return normalizedSessionId
    ? join(stateRoot, 'sessions', normalizedSessionId, fileName)
    : join(stateRoot, fileName);
}

function workflowStateRoot(cwd: string, baseStateDir?: string): string {
  return resolve(baseStateDir ?? getBaseStateDir(cwd));
}

async function assertAuthoritativeWorkflowStateReadable(
  stateRoot: string,
  sessionId?: string,
): Promise<void> {
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePath = modeStatePathForRoot(mode, stateRoot, sessionId);
    await readJsonIfExists(stateRoot, candidatePath, sessionId, { mode, throwOnParseError: true });
  }
}

async function visibleTrackedModes(
  stateRoot: string,
  sessionId?: string,
): Promise<TrackedWorkflowMode[]> {
  const canonical = await readVisibleSkillActiveStateForStateDir(stateRoot, sessionId);
  const canonicalModes = listActiveSkills(canonical ?? {})
    .filter((entry) => sessionId || safeString(entry.session_id).trim().length === 0)
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);

  return [...new Set(canonicalModes)];
}

async function assertSourceModeAdvanceAllowed(
  cwd: string,
  stateRoot: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  sessionId: string | undefined,
): Promise<void> {
  if (sourceMode !== 'deep-interview' || destinationMode !== 'ralplan') return;
  const sourcePath = modeStatePathForRoot(sourceMode, stateRoot, sessionId);
  const existing = await readJsonIfExists(stateRoot, sourcePath, sessionId, {
    mode: sourceMode,
    throwOnParseError: true,
  });
  const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
    cwd,
    sessionId,
    baseStateDir: stateRoot,
    deepInterviewState: existing,
  });
  if (!gate.allowed) throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
}

async function completeSourceModeState(
  cwd: string,
  stateRoot: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  sessionId: string | undefined,
  nowIso: string,
  source: string,
  expectedRootIdentity: RootFilesystemIdentity,
): Promise<string[]> {
  await assertPersistedWorkflowStateRootIdentity(stateRoot, expectedRootIdentity, 'workflow transition root');
  const transitionMessage = `mode transiting: ${sourceMode} -> ${destinationMode}`;
  const candidatePath = modeStatePathForRoot(sourceMode, stateRoot, sessionId);
  const existing = await readJsonIfExists(stateRoot, candidatePath, sessionId, {
    mode: sourceMode,
    throwOnParseError: true,
  });
  const completedPaths: string[] = [];

  if (existing?.active === true) {
    const nextCandidate: TransitionStateLike = {
      ...existing,
      active: false,
      current_phase: 'completed',
      completed_at: safeString(existing.completed_at).trim() || nowIso,
      auto_completed_reason: transitionMessage,
      completion_note: `Auto-completed ${sourceMode} during allowlisted transition to ${destinationMode}.`,
      transition_source: source,
      transition_target_mode: destinationMode,
    };
    if (sourceMode === 'deep-interview') {
      const nextQuestionEnforcement = clearDeepInterviewQuestionObligation(
        existing.question_enforcement as Parameters<typeof clearDeepInterviewQuestionObligation>[0],
        'handoff',
        new Date(nowIso),
      );
      if (nextQuestionEnforcement) {
        nextCandidate.question_enforcement = nextQuestionEnforcement;
      } else {
        delete nextCandidate.question_enforcement;
      }
    }
    delete nextCandidate.run_outcome;
    const runOutcomeState = applyRunOutcomeContract(nextCandidate, { nowIso }).state as TransitionStateLike;
    const nextState = normalizeTerminalWorkflowState(runOutcomeState, { mode: sourceMode, nowIso }).state as TransitionStateLike;

    await writeWorkflowStateFile(stateRoot, candidatePath, sessionId, nextState, expectedRootIdentity);
    completedPaths.push(candidatePath);
  }

  if (sourceMode === 'deep-interview' && destinationMode === 'ralplan' && completedPaths.length === 0) {
    await assertSourceModeAdvanceAllowed(cwd, stateRoot, sourceMode, destinationMode, sessionId);
    throw new Error('deep-interview workflow state changed before its allowlisted transition could be completed');
  }

  await syncCanonicalSkillStateForMode({
    cwd,
    baseStateDir: stateRoot,
    mode: sourceMode,
    active: false,
    currentPhase: 'completed',
    sessionId,
    nowIso,
    source,
    expectedRootIdentity,
  });

  return completedPaths;
}

export async function planWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
    currentModes?: Iterable<string>;
  } = {},
): Promise<PlannedWorkflowTransition> {
  const {
    sessionId,
    nowIso = new Date().toISOString(),
    source = 'workflow-transition',
  } = options;
  const normalizedSessionId = sessionId ? validateSessionId(sessionId) : undefined;
  const stateRoot = workflowStateRoot(cwd, options.baseStateDir);
  const rootIdentity = await captureRootFilesystemIdentity(stateRoot);
  if (!options.currentModes) {
    await assertAuthoritativeWorkflowStateReadable(stateRoot, normalizedSessionId);
  }
  const currentModes = options.currentModes
    ? [...options.currentModes].filter(isTrackedWorkflowMode)
    : await visibleTrackedModes(stateRoot, normalizedSessionId);
  const decision = evaluateWorkflowTransition(currentModes, requestedMode);

  if (decision.allowed) {
    for (const sourceMode of decision.autoCompleteModes) {
      const sourcePath = modeStatePathForRoot(sourceMode, stateRoot, normalizedSessionId);
      await readJsonIfExists(stateRoot, sourcePath, normalizedSessionId, {
        mode: sourceMode,
        throwOnParseError: true,
      });
      await assertSourceModeAdvanceAllowed(cwd, stateRoot, sourceMode, requestedMode, normalizedSessionId);
    }
  }

  return Object.freeze({
    decision,
    transitionMessage: decision.transitionMessage,
    autoCompletedModes: [...decision.autoCompleteModes],
    sourceTargets: decision.allowed
      ? decision.autoCompleteModes.map((sourceMode) => modeStatePathForRoot(sourceMode, stateRoot, normalizedSessionId))
      : [],
    stateRoot,
    rootIdentity,
    requestedMode,
    ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
    nowIso,
    source,
  });
}

export async function applyPlannedWorkflowTransition(
  cwd: string,
  plan: PlannedWorkflowTransition,
  options: {
    action?: WorkflowTransitionAction;
    expectedRootIdentity?: RootFilesystemIdentity;
  } = {},
): Promise<ReconciledWorkflowTransition> {
  const action = options.action ?? 'activate';
  if (!plan.decision.allowed) {
    throw new Error(buildWorkflowTransitionError(plan.decision.currentModes, plan.requestedMode, action));
  }
  const expectedRootIdentity = options.expectedRootIdentity;
  if (!expectedRootIdentity) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'workflow transition apply requires the persisted active state-root identity',
    );
  }
  const actualRootIdentity = await captureRootFilesystemIdentity(plan.stateRoot);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, plan.rootIdentity)
    || !sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'workflow transition plan no longer matches the persisted active state-root identity',
    );
  }
  await assertAuthoritativeWorkflowStateReadable(plan.stateRoot, plan.sessionId);
  const currentModes = await visibleTrackedModes(plan.stateRoot, plan.sessionId);
  const currentDecision = evaluateWorkflowTransition(currentModes, plan.requestedMode);
  const expectedTargets = currentDecision.allowed
    ? currentDecision.autoCompleteModes.map((sourceMode) => modeStatePathForRoot(sourceMode, plan.stateRoot, plan.sessionId))
    : [];
  if (JSON.stringify(currentDecision) !== JSON.stringify(plan.decision)
    || JSON.stringify(expectedTargets) !== JSON.stringify(plan.sourceTargets)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      'workflow transition source state changed after the plan was created',
    );
  }

  const completedPaths: string[] = [];
  for (const sourceMode of plan.autoCompletedModes) {
    completedPaths.push(...await completeSourceModeState(
      cwd,
      plan.stateRoot,
      sourceMode,
      plan.requestedMode,
      plan.sessionId,
      plan.nowIso,
      plan.source,
      expectedRootIdentity!,
    ));
  }

  return {
    decision: plan.decision,
    transitionMessage: plan.transitionMessage,
    autoCompletedModes: plan.autoCompletedModes,
    completedPaths,
  };
}

export async function completeWorkflowModeState(
  cwd: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  options: {
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
    expectedRootIdentity?: RootFilesystemIdentity;
  } = {},
): Promise<string[]> {
  const stateRoot = workflowStateRoot(cwd, options.baseStateDir);
  const sessionId = options.sessionId ? validateSessionId(options.sessionId) : undefined;
  const expectedRootIdentity = options.expectedRootIdentity;
  if (!expectedRootIdentity) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'workflow mode completion requires the persisted active state-root identity',
    );
  }
  await assertSourceModeAdvanceAllowed(cwd, stateRoot, sourceMode, destinationMode, sessionId);
  return completeSourceModeState(
    cwd,
    stateRoot,
    sourceMode,
    destinationMode,
    sessionId,
    options.nowIso ?? new Date().toISOString(),
    options.source ?? 'workflow-transition',
    expectedRootIdentity,
  );
}

export async function reconcileWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
    currentModes?: Iterable<string>;
    expectedRootIdentity?: RootFilesystemIdentity;
  } = {},
): Promise<ReconciledWorkflowTransition> {
  const plan = await planWorkflowTransition(cwd, requestedMode, options);
  return applyPlannedWorkflowTransition(cwd, plan, {
    action: options.action,
    expectedRootIdentity: options.expectedRootIdentity,
  });
}
