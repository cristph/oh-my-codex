import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';

import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';


import { withModeRuntimeContext } from './mode-state-context.js';
import {
  resolveAuthorityRuntimeStateScope,
  resolveRuntimeStateScope,
  resolveWorkingDirectoryForState,
  validateSessionId,
  validateStateModeSegment,
  type ResolvedAuthorityRuntimeStateScope,
  type ResolvedRuntimeStateScope,
} from '../mcp/state-paths.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  STATE_AUTHORITY_TOMBSTONE_FILE,
  StateAuthorityError,
  appendStateAuthorityEvidence,
  atomicWriteAuthorityFile,
  authorityGenerationPaths,
  captureRootFilesystemIdentity,
  fsyncAuthorityDirectory,
  isTrustedAuthorityPlatformRootAlias,
  resolveWorkspaceIdentity,
  resolveStateAuthorityForGuard,
  readStateAuthorityEvidence,
  readWorkspaceAuthorityAnchor,
  sameRootFilesystemIdentity,
  stateAuthorityFilesystemPrimitiveForPlatform,
  validateStateAuthority,
  validateStateAuthorityGeneration,
  withStateAuthorityTransaction,
  type AcquiredStateAuthorityLock,
  type ResolvedStateAuthorityContext,
  type StateAuthorityGeneration,
  type RootFilesystemIdentity,
} from './authority.js';
import { evaluateRalphCompletionAuditEvidence } from '../ralph/completion-audit.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import { RALPH_PHASES, validateAndNormalizeRalphState } from '../ralph/contract.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { normalizeTerminalWorkflowState } from './terminal-normalization.js';
import {
  hasCleanAutopilotReviewAndQaEvidence,
  isAutopilotSuccessfulTerminalState,
  validateAutopilotCompletionTransition,
} from '../autopilot/completion-gate.js';
import { readUltragoalState } from '../hud/state.js';
import {
  SKILL_ACTIVE_STATE_FILE,
  SKILL_ACTIVE_STATE_MODE,
  clearTerminalSkillActiveMarkers,
  getSkillActiveStatePathsForStateDir,
  isTerminalSkillActiveState,
  listActiveSkills,
  syncCanonicalSkillStateForMode,
  type SkillActiveEntry,
  type SkillActiveStateLike,
  writeSkillActiveStateCopiesForStateDir,
} from './skill-active.js';
import {
  buildWorkflowTransitionError,
  TRACKED_WORKFLOW_MODES,
  isTrackedWorkflowMode,
  type TrackedWorkflowMode,
} from './workflow-transition.js';
import {
  applyPlannedWorkflowTransition,
  planWorkflowTransition,
  type PlannedWorkflowTransition,
} from './workflow-transition-reconcile.js';
import {
  buildAutopilotDeepInterviewRalplanGateError,
  canAdvanceAutopilotDeepInterviewToRalplan,
} from '../autopilot/deep-interview-gate.js';
import {
  type AutopilotChildPhase,
  deriveAutopilotChildPhase,
} from '../autopilot/fsm.js';
import {
  buildAutopilotRalplanUltragoalGateError,
  canAdvanceAutopilotRalplanToUltragoal,
} from '../autopilot/ralplan-gate.js';
import {
  isUnsupportedNativeSubagentEvidenceForScope,
} from '../leader/contract.js';
import {
  buildRalplanConsensusGateFromSources,
} from '../ralplan/consensus-gate.js';


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

export const SUPPORTED_STATE_READ_MODES = [
  'autopilot',
  'autoresearch',
  'team',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
  'skill-active',
] as const;

export type SupportedStateReadMode = (typeof SUPPORTED_STATE_READ_MODES)[number];
export type StateOperationName =
  | 'state_read'
  | 'state_write'
  | 'state_clear'
  | 'state_list_active'
  | 'state_get_status';

export interface StateOperationResponse {
  payload: unknown;
  isError?: boolean;
}

const stateWriteQueues = new Map<string, Promise<void>>();
const stateMutationAdmissionQueues = new Map<string, Promise<void>>();

async function withStateMutationAdmission<T>(workspaceKey: string, fn: () => Promise<T>): Promise<T> {
  const tail = stateMutationAdmissionQueues.get(workspaceKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = tail.finally(() => gate);
  stateMutationAdmissionQueues.set(workspaceKey, queued);

  await tail.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateMutationAdmissionQueues.get(workspaceKey) === queued) {
      stateMutationAdmissionQueues.delete(workspaceKey);
    }
  }
}


async function withStateWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = stateWriteQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = tail.finally(() => gate);
  stateWriteQueues.set(path, queued);

  await tail.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateWriteQueues.get(path) === queued) {
      stateWriteQueues.delete(path);
    }
  }
}

async function assertExpectedStateRootIdentity(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  label: string,
): Promise<void> {
  const actualRootIdentity = await captureRootFilesystemIdentity(baseStateDir);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      `${label} does not match the persisted active state-root identity`,
    );
  }
}

async function writeAtomicFile(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  path: string,
  data: string,
): Promise<void> {
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state write root');
  await awaitStateOperationTestBarrier('before_state_write');
  await atomicWriteAuthorityFile(path, data, {
    authority_root: baseStateDir,
    expected_root_identity: expectedRootIdentity,
  });
}

type OpenedStateClearDirectory = {
  handle?: Awaited<ReturnType<typeof open>>;
  operationPath: string;
  path: string;
  identity: StateReadDirectoryIdentity;
};

async function closeStateClearResources(
  targetHandle: Awaited<ReturnType<typeof open>> | undefined,
  directory: OpenedStateClearDirectory | undefined,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try {
    await targetHandle?.close();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  try {
    await directory?.handle?.close();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'state clear cleanup was incomplete');
  }
}

async function descriptorRelativeStateClearDirectoryPath(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string | null> {
  const held = await handle.stat();
  for (const candidate of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      const details = await stat(candidate);
      if (details.isDirectory() && sameStateReadFileIdentity(details, held)) return candidate;
    } catch {
      // Try the next Linux descriptor namespace.
    }
  }
  return null;
}

async function openStateClearDirectory(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  directory: string,
  label: string,
): Promise<OpenedStateClearDirectory> {
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
  const identity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label);
  const primitive = stateAuthorityFilesystemPrimitiveForPlatform();
  if (process.platform !== 'linux') {
    return { operationPath: directory, path: directory, identity };
  }
  if (!primitive.descriptor_relative || primitive.directory_open_flags === null || primitive.file_open_flags === null) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
      'the Linux runtime does not expose descriptor-relative no-follow state deletion',
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, primitive.directory_open_flags);
    const held = await handle.stat();
    const current = await lstat(directory);
    const expectedDirectory = resolve(directory) === resolve(baseStateDir)
      ? identity.stateRoot
      : identity.sessionDir;
    if (
      !expectedDirectory
      || current.isSymbolicLink()
      || !current.isDirectory()
      || !sameStateReadFileIdentity(expectedDirectory, held)
      || !sameStateReadFileIdentity(current, held)
    ) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory changed while opening for deletion: ${directory}`);
    }
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
    const operationPath = await descriptorRelativeStateClearDirectoryPath(handle);
    if (!operationPath) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
        'the Linux runtime cannot address an opened state deletion directory descriptor',
      );
    }
    return { handle, operationPath, path: directory, identity };
  } catch (error) {
    try {
      await handle?.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'state clear directory setup failed and cleanup was incomplete');
    }
    throw error;
  }
}

async function unlinkDurably(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  path: string,
  label = 'state clear target',
): Promise<boolean> {
  const target = resolve(path);
  const directory = dirname(target);
  const primitive = stateAuthorityFilesystemPrimitiveForPlatform();
  if (process.platform === 'linux' && (!primitive.descriptor_relative || primitive.file_open_flags === null)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
      'the Linux runtime does not expose descriptor-relative no-follow state deletion',
    );
  }
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  let openedDirectory: OpenedStateClearDirectory | undefined;
  try {
    openedDirectory = await openStateClearDirectory(baseStateDir, expectedRootIdentity, directory, label);
    const operationTarget = join(openedDirectory.operationPath, basename(target));
    const beforeOpen = await lstat(operationTarget);
    assertRegularStateReadFile(beforeOpen, target, label);
    const noFollow = primitive.file_open_flags ?? 0;
    try {
      targetHandle = await open(operationTarget, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const opened = await targetHandle.stat();
    const afterOpen = await lstat(operationTarget);
    if (afterOpen.isSymbolicLink() || !afterOpen.isFile()
      || !sameStateReadFileIdentity(beforeOpen, opened)
      || !sameStateReadFileIdentity(opened, afterOpen)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} changed while opening for deletion: ${target}`);
    }
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
    const afterOpenDirectoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label);
    if (!sameStateReadDirectoryIdentity(openedDirectory.identity, afterOpenDirectoryIdentity)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory was replaced while opening for deletion: ${target}`);
    }
    await awaitStateOperationTestBarrier('before_state_unlink');
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
    const atUnlinkBoundary = await lstat(operationTarget);
    if (atUnlinkBoundary.isSymbolicLink() || !atUnlinkBoundary.isFile()
      || !sameStateReadFileIdentity(opened, atUnlinkBoundary)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} was replaced before deletion: ${target}`);
    }
    const atUnlinkDirectoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label);
    if (!sameStateReadDirectoryIdentity(openedDirectory.identity, atUnlinkDirectoryIdentity)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory was replaced before deletion: ${target}`);
    }
    if (process.platform === 'win32') {
      await targetHandle.close();
      targetHandle = undefined;
      await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
      const afterClose = await lstat(operationTarget);
      if (afterClose.isSymbolicLink() || !afterClose.isFile()
        || !sameStateReadFileIdentity(opened, afterClose)) {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} was replaced before deletion: ${target}`);
      }
      const afterCloseDirectoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label);
      if (!sameStateReadDirectoryIdentity(openedDirectory.identity, afterCloseDirectoryIdentity)) {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory was replaced before deletion: ${target}`);
      }
    }
    await unlink(operationTarget);
    if (process.platform === 'linux') {
      await openedDirectory.handle?.sync();
    } else {
      await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
      await fsyncAuthorityDirectory(directory);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await closeStateClearResources(targetHandle, openedDirectory);
  }
}


type StateOperationJournalStage = 'prepared' | 'committed' | 'aborted';
type DurableStateOperationName = 'state_write' | 'state_clear';

interface DurableStateOperation {
  operation_id: string;
  name: DurableStateOperationName;
  mode: string;
  session_id?: string;
  all_sessions?: boolean;
  targets: string[];
  recovery_args: Record<string, unknown>;
}

interface StateOperationExecutionOptions {
  skipPreparedOperationRecovery?: boolean;
  authorityTransaction?: {
    authority: ResolvedStateAuthorityContext;
    lock: AcquiredStateAuthorityLock;
  };
  recoveryOperation?: DurableStateOperation;
}

interface DurableStateOperationEvidence {
  schema_version?: unknown;
  authority_id?: unknown;
  generation_id?: unknown;
  event?: {
    kind?: unknown;
    stage?: unknown;
    operation_id?: unknown;
    mode?: unknown;
    session_id?: unknown;
    all_sessions?: unknown;
    targets?: unknown;
    recovery_args?: unknown;
    fencing_token?: unknown;
    anchor_revision?: unknown;
  };
}

type ParsedDurableStateOperationEvidence = {
  operation: DurableStateOperation;
  stage: StateOperationJournalStage;
};

const stateOperationRecoveryQueues = new Map<string, Promise<void>>();

type StateOperationFaultInjectionPoint =
  | 'after_effects_before_committed_evidence'
  | 'after_first_state_clear_effect';
type StateOperationTestBarrierPoint =
  | 'before_mutation_transaction'
  | 'before_state_evidence_read'
  | 'before_state_evidence_append'
  | 'before_state_read'
  | 'before_state_unlink'
  | 'before_state_write';

export interface StateOperationTestHooks {
  faultInjectionPoint?: StateOperationFaultInjectionPoint;
  barrier?: (point: StateOperationTestBarrierPoint) => void | Promise<void>;
}

let stateOperationTestHooks: StateOperationTestHooks = {};

export function setStateOperationTestHooksForTests(hooks: StateOperationTestHooks = {}): void {
  stateOperationTestHooks = hooks;
}

function injectStateOperationFault(point: StateOperationFaultInjectionPoint): void {
  if (stateOperationTestHooks.faultInjectionPoint === point) {
    throw new Error(`injected state operation crash at ${point}`);
  }
}

async function awaitStateOperationTestBarrier(point: StateOperationTestBarrierPoint): Promise<void> {
  await stateOperationTestHooks.barrier?.(point);
}

function createRecoveryArguments(
  rawArgs: Record<string, unknown>,
  effectiveSessionId: string | undefined,
): Record<string, unknown> {
  const { workingDirectory: _workingDirectory, ...request } = rawArgs;
  const recoveryArgs = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  if (effectiveSessionId) recoveryArgs.session_id = effectiveSessionId;
  return recoveryArgs;
}

function createDurableStateOperation(input: Omit<DurableStateOperation, 'operation_id'>): DurableStateOperation {
  return {
    operation_id: `state-operation-${randomUUID()}`,
    ...input,
  };
}

async function appendDurableStateOperationEvidence(
  authority: ResolvedStateAuthorityContext,
  lock: AcquiredStateAuthorityLock,
  operation: DurableStateOperation,
  stage: StateOperationJournalStage,
  error?: unknown,
): Promise<void> {
  await awaitStateOperationTestBarrier('before_state_evidence_append');
  await appendStateAuthorityEvidence(authority.generation, {

    kind: operation.name === 'state_clear' ? 'state_clear_tombstone' : 'state_write_transaction',
    stage,
    operation_id: operation.operation_id,
    mode: operation.mode,
    ...(operation.session_id ? { session_id: operation.session_id } : {}),
    ...(operation.all_sessions ? { all_sessions: true } : {}),
    targets: operation.targets,
    recovery_args: operation.recovery_args,
    fencing_token: lock.record.fencing_token,
    anchor_revision: lock.record.anchor_revision,
    ...(stage === 'aborted' ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });
}

function malformedDurableStateOperationEvidence(message: string): never {
  throw new StateAuthorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, message);
}

function validateDurableStateOperationEvidence(evidence: unknown): DurableStateOperationEvidence {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid record');
  }
  const record = evidence as DurableStateOperationEvidence;
  if (
    record.schema_version !== 1
    || typeof record.authority_id !== 'string'
    || record.authority_id.length === 0
    || typeof record.generation_id !== 'string'
    || record.generation_id.length === 0
    || !record.event
    || typeof record.event !== 'object'
    || Array.isArray(record.event)
  ) {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid envelope');
  }
  return record;
}

type HistoricalGenerationDirectoryIdentity = Array<Awaited<ReturnType<typeof lstat>>>;

async function captureHistoricalGenerationDirectoryIdentity(
  stateRoot: string,
  generationId: string,
): Promise<HistoricalGenerationDirectoryIdentity> {
  const generationDirectory = authorityGenerationPaths(stateRoot, generationId).generation_directory;
  const directories = [
    stateRoot,
    join(stateRoot, 'authority'),
    join(stateRoot, 'authority', 'generations'),
    generationDirectory,
  ];
  const identity = await Promise.all(directories.map((directory) => lstat(directory)));
  for (let index = 0; index < identity.length; index += 1) {
    const details = identity[index]!;
    if (details.isSymbolicLink()) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
        `historical authority generation directory must not be a symbolic link: ${directories[index]}`,
      );
    }
    if (!details.isDirectory()) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `historical authority generation directory is not a directory: ${directories[index]}`,
      );
    }
  }
  return identity;
}

function sameHistoricalGenerationDirectoryIdentity(
  expected: HistoricalGenerationDirectoryIdentity,
  actual: HistoricalGenerationDirectoryIdentity,
): boolean {
  return expected.length === actual.length
    && expected.every((details, index) => sameStateReadFileIdentity(details, actual[index]!));
}

async function readLocallyRootedHistoricalGeneration(
  authority: ResolvedStateAuthorityContext,
  generationId: string,
): Promise<StateAuthorityGeneration> {
  const stateRoot = authority.generation.canonical_state_root;
  const authorityPath = authorityGenerationPaths(stateRoot, generationId).authority_path;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

  const rootBefore = await captureRootFilesystemIdentity(stateRoot);
  if (!sameRootFilesystemIdentity(authority.generation.root_identity, rootBefore)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'the active state root changed before historical generation validation',
    );
  }
  await assertStatePathHasNoSymlinkComponents(authorityPath, 'historical authority generation');
  const directoriesBefore = await captureHistoricalGenerationDirectoryIdentity(stateRoot, generationId);
  const beforeOpen = await lstat(authorityPath);
  assertRegularStateReadFile(beforeOpen, authorityPath, 'historical authority generation');

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(authorityPath, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `historical authority generation must not be a symbolic link: ${authorityPath}`);
      }
      throw error;
    }
    const opened = await handle.stat();
    assertRegularStateReadFile(opened, authorityPath, 'historical authority generation');
    const afterOpen = await lstat(authorityPath);
    assertRegularStateReadFile(afterOpen, authorityPath, 'historical authority generation');
    if (!sameStateReadFileIdentity(beforeOpen, opened) || !sameStateReadFileIdentity(opened, afterOpen)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `historical authority generation changed while opening: ${authorityPath}`,
      );
    }
    const directoriesAfterOpen = await captureHistoricalGenerationDirectoryIdentity(stateRoot, generationId);
    if (!sameHistoricalGenerationDirectoryIdentity(directoriesBefore, directoriesAfterOpen)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `historical authority generation directory changed while opening: ${authorityPath}`,
      );
    }

    const content = await handle.readFile({ encoding: 'utf8' }) as string;
    const afterRead = await lstat(authorityPath);
    assertRegularStateReadFile(afterRead, authorityPath, 'historical authority generation');
    if (!sameStateReadFileIdentity(opened, afterRead)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `historical authority generation changed while reading: ${authorityPath}`,
      );
    }
    const directoriesAfterRead = await captureHistoricalGenerationDirectoryIdentity(stateRoot, generationId);
    if (!sameHistoricalGenerationDirectoryIdentity(directoriesBefore, directoriesAfterRead)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `historical authority generation directory changed while reading: ${authorityPath}`,
      );
    }
    const rootAfter = await captureRootFilesystemIdentity(stateRoot);
    if (!sameRootFilesystemIdentity(rootBefore, rootAfter)
      || !sameRootFilesystemIdentity(authority.generation.root_identity, rootAfter)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
        'the active state root changed while validating a historical generation',
      );
    }
    try {
      const generation = JSON.parse(content) as StateAuthorityGeneration;
      validateStateAuthorityGeneration(generation);
      return generation;
    } catch (error) {
      if (error instanceof StateAuthorityError) throw error;
      malformedDurableStateOperationEvidence(`historical authority generation contains invalid JSON: ${authorityPath}`);
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveLocallyProvenDurableStateOperationGeneration(
  evidence: DurableStateOperationEvidence,
  authority: ResolvedStateAuthorityContext,
): Promise<StateAuthorityGeneration> {
  if (evidence.authority_id === authority.generation.authority_id
    && evidence.generation_id === authority.generation.generation_id) {
    return authority.generation;
  }

  const anchor = await readWorkspaceAuthorityAnchor(authority.workspace_identity);
  if (!anchor || anchor.active_generation_id !== authority.generation.generation_id) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      'state authority changed while validating historical state operation evidence',
    );
  }

  const stateRoot = authority.generation.canonical_state_root;
  let descendant = authority.generation;
  const seenGenerationIds = new Set([descendant.generation_id]);
  let isImmediatePredecessor = true;
  while (descendant.prior_generation_id) {
    const historicalGenerationId = descendant.prior_generation_id;
    if (seenGenerationIds.has(historicalGenerationId)) {
      malformedDurableStateOperationEvidence('state operation evidence historical generation lineage contains a cycle');
    }
    seenGenerationIds.add(historicalGenerationId);

    let historical: StateAuthorityGeneration;
    try {
      historical = await readLocallyRootedHistoricalGeneration(authority, historicalGenerationId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        malformedDurableStateOperationEvidence('state operation evidence does not belong to the active state root lineage');
      }
      throw error;
    }
    const expectedAuthorityPath = authorityGenerationPaths(stateRoot, historicalGenerationId).authority_path;
    if (historical.generation_id !== historicalGenerationId
      || historical.canonical_state_root !== stateRoot
      || !sameRootFilesystemIdentity(historical.root_identity, authority.generation.root_identity)) {
      malformedDurableStateOperationEvidence('state operation evidence references a generation outside the active state root lineage');
    }
    const terminal = anchor.last_terminal;
    if (isImmediatePredecessor && (
      !terminal
      || terminal.status !== 'terminal'
      || terminal.generation_id !== historicalGenerationId
      || terminal.generation_locator !== expectedAuthorityPath
    )) {
      malformedDurableStateOperationEvidence('state operation evidence immediate predecessor is not terminalized in the active authority lineage');
    }
    const validation = await validateStateAuthority(historical, {
      workspace_identity: authority.workspace_identity,
    });
    if (!validation.valid) {
      malformedDurableStateOperationEvidence(
        `state operation evidence references an invalid historical generation: ${validation.diagnostics[0]?.message ?? 'unknown validation failure'}`,
      );
    }
    if (historical.authority_id === evidence.authority_id
      && historical.generation_id === evidence.generation_id) {
      return historical;
    }

    descendant = historical;
    isImmediatePredecessor = false;
  }

  malformedDurableStateOperationEvidence('state operation evidence does not belong to the active state root lineage');
}

function parseDurableStateOperation(
  evidence: DurableStateOperationEvidence,
  evidenceGeneration: StateAuthorityGeneration,
  lock: AcquiredStateAuthorityLock,
): ParsedDurableStateOperationEvidence | null {
  const event = evidence.event!;
  if (event.kind !== 'state_write_transaction' && event.kind !== 'state_clear_tombstone') return null;
  if (
    event.stage !== 'prepared'
    && event.stage !== 'committed'
    && event.stage !== 'aborted'
  ) {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid journal stage');
  }
  if (typeof event.operation_id !== 'string' || event.operation_id.length === 0 || typeof event.mode !== 'string') {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid operation identity');
  }
  if (!Array.isArray(event.targets) || !event.targets.every((target) => typeof target === 'string')) {
    malformedDurableStateOperationEvidence('state operation evidence has invalid targets');
  }
  if (!event.recovery_args || typeof event.recovery_args !== 'object' || Array.isArray(event.recovery_args)) {
    malformedDurableStateOperationEvidence('state operation evidence has invalid recovery arguments');
  }
  if (event.session_id !== undefined && typeof event.session_id !== 'string') {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid session ID');
  }
  if (event.all_sessions !== undefined && event.all_sessions !== true) {
    malformedDurableStateOperationEvidence('state operation evidence has an invalid all-sessions flag');
  }
  if (
    typeof event.fencing_token !== 'number'
    || !Number.isSafeInteger(event.fencing_token)
    || event.fencing_token < evidenceGeneration.creation_fence
    || event.fencing_token > lock.record.fencing_token
  ) {
    malformedDurableStateOperationEvidence('state operation evidence has a fence outside its referenced authority generation');
  }
  if (
    typeof event.anchor_revision !== 'number'
    || !Number.isSafeInteger(event.anchor_revision)
    || event.anchor_revision < 0
    || event.anchor_revision > lock.record.anchor_revision
  ) {
    malformedDurableStateOperationEvidence('state operation evidence has an anchor revision outside the current authority generation');
  }
  return {
    operation: {
      operation_id: event.operation_id,
      name: event.kind === 'state_clear_tombstone' ? 'state_clear' : 'state_write',
      mode: event.mode,
      ...(typeof event.session_id === 'string' ? { session_id: event.session_id } : {}),
      ...(event.all_sessions === true ? { all_sessions: true } : {}),
      targets: event.targets,
      recovery_args: event.recovery_args as Record<string, unknown>,
    },
    stage: event.stage,
  };
}

async function repairTornDurableStateOperationEvidence(
  authority: ResolvedStateAuthorityContext,
  completeContent: string,
): Promise<void> {
  const evidencePath = join(
    authority.generation.canonical_state_root,
    'authority',
    STATE_AUTHORITY_TOMBSTONE_FILE,
  );
  await writeAtomicFile(authority.generation.canonical_state_root, authority.generation.root_identity, evidencePath, completeContent);
  await fsyncAuthorityDirectory(dirname(evidencePath));
}

async function readPreparedDurableStateOperations(
  authority: ResolvedStateAuthorityContext,
  lock: AcquiredStateAuthorityLock,
): Promise<DurableStateOperation[]> {
  let content: string;
  await awaitStateOperationTestBarrier('before_state_evidence_read');
  try {
    content = await readStateAuthorityEvidence(authority.generation) ?? '';
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const hasTornTail = content.length > 0 && !content.endsWith('\n');
  const completeContent = hasTornTail ? content.slice(0, content.lastIndexOf('\n') + 1) : content;
  const lines = completeContent.length > 0 ? completeContent.slice(0, -1).split('\n') : [];
  const prepared = new Map<string, DurableStateOperation>();
  for (const line of lines) {
    if (!line.trim()) {
      malformedDurableStateOperationEvidence('state operation evidence contains an empty complete record');
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(line);
    } catch {
      malformedDurableStateOperationEvidence('state operation evidence contains invalid JSON');
    }
    const durableEvidence = validateDurableStateOperationEvidence(evidence);
    const evidenceGeneration = await resolveLocallyProvenDurableStateOperationGeneration(durableEvidence, authority);
    const parsed = parseDurableStateOperation(durableEvidence, evidenceGeneration, lock);
    if (!parsed) continue;
    if (parsed.stage === 'prepared') {
      prepared.set(parsed.operation.operation_id, parsed.operation);
    } else {
      prepared.delete(parsed.operation.operation_id);
    }
  }
  if (hasTornTail) {
    await repairTornDurableStateOperationEvidence(authority, completeContent);
  }
  return [...prepared.values()];
}

async function isDurableStateOperationTerminal(
  authority: ResolvedStateAuthorityContext,
  lock: AcquiredStateAuthorityLock,
  operationId: string,
): Promise<boolean> {
  const prepared = await readPreparedDurableStateOperations(authority, lock);
  return !prepared.some((operation) => operation.operation_id === operationId);
}

function stateOperationRecoveryKey(authority: ResolvedStateAuthorityContext): string {
  return `${authority.workspace_identity.canonical_path}:${authority.generation.generation_id}`;
}

async function recoverPreparedDurableStateOperations(authority: ResolvedStateAuthorityContext): Promise<void> {
  const key = stateOperationRecoveryKey(authority);
  const queued = stateOperationRecoveryQueues.get(key);
  if (queued) {
    await queued;
    return;
  }

  const recovery = replayPreparedDurableStateOperations(authority);
  stateOperationRecoveryQueues.set(key, recovery);
  try {
    await recovery;
  } finally {
    if (stateOperationRecoveryQueues.get(key) === recovery) {
      stateOperationRecoveryQueues.delete(key);
    }
  }
}

async function replayPreparedDurableStateOperationsUnderTransaction(
  authority: ResolvedStateAuthorityContext,
  lock: AcquiredStateAuthorityLock,
): Promise<void> {
  const prepared = await readPreparedDurableStateOperations(authority, lock);
  for (const operation of prepared) {
    if (await isDurableStateOperationTerminal(authority, lock, operation.operation_id)) continue;
    const response = await executeStateOperationInternal(
      operation.name,
      {
        ...operation.recovery_args,
        workingDirectory: authority.workspace_identity.canonical_path,
      },
      {
        skipPreparedOperationRecovery: true,
        authorityTransaction: { authority, lock },
        recoveryOperation: operation,
      },
    );
    if (response.isError) {
      throw new Error(`prepared ${operation.name} recovery failed: ${(response.payload as { error?: unknown }).error ?? 'unknown error'}`);
    }
  }
}

async function replayPreparedDurableStateOperations(authority: ResolvedStateAuthorityContext): Promise<void> {
  await withStateAuthorityTransaction(authority, replayPreparedDurableStateOperationsUnderTransaction);
}

/**
 * The authority evidence log is the durable state-operation journal. A caller
 * observes success only after every effect and its fenced committed record sync.
 * Failed effects stay prepared: a prepared record is replayed from its persisted
 * request rather than being misclassified as aborted after a partial mutation.
 */
async function withDurableStateOperation<T>(
  authority: ResolvedStateAuthorityContext,
  lock: AcquiredStateAuthorityLock,
  operation: DurableStateOperation,
  effect: (markEffectsStarted: () => void) => Promise<T>,
  options: { preparedAlreadyRecorded?: boolean } = {},
): Promise<T> {
  if (!options.preparedAlreadyRecorded) {
    await appendDurableStateOperationEvidence(authority, lock, operation, 'prepared');
  }
  let effectsStarted = false;
  try {
    const result = await effect(() => {
      effectsStarted = true;
    });
    injectStateOperationFault('after_effects_before_committed_evidence');
    await appendDurableStateOperationEvidence(authority, lock, operation, 'committed');
    return result;
  } catch (error) {
    if (!effectsStarted) {
      await appendDurableStateOperationEvidence(authority, lock, operation, 'aborted', error);
    }
    throw error;
  }
}

async function assertStateDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      `${label} must not be a symbolic link: ${path}`,
    );
  }
  if (!details.isDirectory()) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      `${label} must be a directory: ${path}`,
    );
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

async function ensureStateChildDirectory(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  parent: string,
  child: string,
  label: string,
): Promise<string> {
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, `${label} root`);
  await assertStateDirectory(parent, `${label} parent`);
  const path = join(parent, child);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, `${label} root`);
  await assertStateDirectory(parent, `${label} parent`);
  await assertStateDirectory(path, label);
  return path;
}

async function assertSessionStateDirectoryForRead(
  baseStateDir: string,
  sessionId?: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state session read root');
  }
  if (!sessionId) return;
  if (!await assertStateDirectoryIfPresent(baseStateDir, 'state root')) return;
  const sessionsDir = join(baseStateDir, 'sessions');
  if (!await assertStateDirectoryIfPresent(sessionsDir, 'state sessions directory')) return;
  await assertStateDirectory(sessionsDir, 'state sessions directory');
  const sessionDir = join(sessionsDir, sessionId);
  if (!await assertStateDirectoryIfPresent(sessionDir, 'state session directory')) return;
  await assertStateDirectory(sessionsDir, 'state sessions directory');
  await assertStateDirectory(sessionDir, 'state session directory');
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state session read root');
  }
}

function isPathWithinStateRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function stateReadError(code: typeof AUTHORITY_DIAGNOSTIC_CODES[keyof typeof AUTHORITY_DIAGNOSTIC_CODES], message: string): never {

  throw new StateAuthorityError(code, message);
}

async function assertStatePathHasNoSymlinkComponents(path: string, label: string): Promise<void> {
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


async function assertStateReadDirectory(
  baseStateDir: string,
  directory: string,
  label: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
  }
  const stateRoot = resolve(baseStateDir);
  const stateDirectory = resolve(directory);
  if (!isPathWithinStateRoot(stateRoot, stateDirectory)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      `${label} escapes the active authority state root: ${stateDirectory}`,
    );
  }

  await assertStatePathHasNoSymlinkComponents(stateRoot, label);
  await assertStateDirectory(stateRoot, 'state root');

  if (stateDirectory !== stateRoot) {
    const segments = relative(stateRoot, stateDirectory).split(/[\\/]+/);
    if (segments.length !== 2 || segments[0] !== 'sessions' || !/^[A-Za-z0-9_-]{1,64}$/.test(segments[1])) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `${label} is outside the active authority session schema: ${stateDirectory}`,
      );
    }

    const sessionsDir = join(stateRoot, 'sessions');
    await assertStateDirectory(sessionsDir, 'state sessions directory');
    await assertStateDirectory(stateDirectory, 'state session directory');
    await assertStateDirectory(sessionsDir, 'state sessions directory');
    await assertStatePathHasNoSymlinkComponents(stateRoot, label);
    await assertStateDirectory(stateRoot, 'state root');
  }
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, label);
  }
}

async function assertStateReadDirectoryIfPresent(
  baseStateDir: string,
  directory: string,
  label: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<boolean> {
  try {
    await assertStateReadDirectory(baseStateDir, directory, label, expectedRootIdentity);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertRegularStateReadFile(
  details: Awaited<ReturnType<typeof lstat>>,
  path: string,
  label: string,
): void {
  if (details.isSymbolicLink()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!details.isFile()) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a regular file: ${path}`);
  }
}

function sameStateReadFileIdentity(
  expected: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
  actual: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

type StateReadDirectoryIdentity = {
  stateRoot: Awaited<ReturnType<typeof lstat>>;
  sessionsDir?: Awaited<ReturnType<typeof lstat>>;
  sessionDir?: Awaited<ReturnType<typeof lstat>>;
};

async function captureStateReadDirectoryIdentity(
  baseStateDir: string,
  directory: string,
  label: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<StateReadDirectoryIdentity> {
  await assertStateReadDirectory(baseStateDir, directory, label, expectedRootIdentity);
  const stateRoot = resolve(baseStateDir);
  const stateDirectory = resolve(directory);
  const identity: StateReadDirectoryIdentity = { stateRoot: await lstat(stateRoot) };
  if (stateDirectory !== stateRoot) {
    const sessionsDir = join(stateRoot, 'sessions');
    identity.sessionsDir = await lstat(sessionsDir);
    identity.sessionDir = await lstat(stateDirectory);
  }
  return identity;
}

function sameStateReadDirectoryIdentity(
  expected: StateReadDirectoryIdentity,
  actual: StateReadDirectoryIdentity,
): boolean {
  return sameStateReadFileIdentity(expected.stateRoot, actual.stateRoot)
    && (!expected.sessionsDir || (actual.sessionsDir !== undefined && sameStateReadFileIdentity(expected.sessionsDir, actual.sessionsDir)))
    && (!expected.sessionDir || (actual.sessionDir !== undefined && sameStateReadFileIdentity(expected.sessionDir, actual.sessionDir)));
}


async function readRegularStateFile(
  baseStateDir: string,
  path: string,
  label: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<string> {
  const target = resolve(path);
  const directory = dirname(target);
  const directoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label, expectedRootIdentity);

  const beforeOpen = await lstat(target);
  assertRegularStateReadFile(beforeOpen, target, label);

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
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
    assertRegularStateReadFile(opened, target, label);
    if (!sameStateReadFileIdentity(beforeOpen, opened)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} changed while opening: ${target}`);
    }

    const afterOpen = await lstat(target);
    assertRegularStateReadFile(afterOpen, target, label);
    if (!sameStateReadFileIdentity(opened, afterOpen)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} was replaced while opening: ${target}`);
    }
    const afterOpenDirectoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label, expectedRootIdentity);
    if (!sameStateReadDirectoryIdentity(directoryIdentity, afterOpenDirectoryIdentity)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory was replaced while opening: ${target}`);
    }

    const content = await handle.readFile({ encoding: 'utf8' }) as string;
    const afterRead = await lstat(target);
    assertRegularStateReadFile(afterRead, target, label);
    if (!sameStateReadFileIdentity(opened, afterRead)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} was replaced while reading: ${target}`);
    }
    const afterReadDirectoryIdentity = await captureStateReadDirectoryIdentity(baseStateDir, directory, label, expectedRootIdentity);
    if (!sameStateReadDirectoryIdentity(directoryIdentity, afterReadDirectoryIdentity)) {
      stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} directory was replaced while reading: ${target}`);
    }
    return content;
  } finally {
    await handle?.close();
  }
}

async function readRegularStateFileIfPresent(
  baseStateDir: string,
  path: string,
  label: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<string | null> {
  try {
    return await readRegularStateFile(baseStateDir, path, label, expectedRootIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseCanonicalStateRecord(content: string, path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, `${label} contains malformed JSON: ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    stateReadError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, `${label} must be a JSON object: ${path}`);
  }
  return value as Record<string, unknown>;
}

async function readSafeSkillActiveState(
  baseStateDir: string,
  path: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<SkillActiveStateLike | null> {
  const content = await readRegularStateFileIfPresent(baseStateDir, path, 'canonical skill state', expectedRootIdentity);
  if (content === null) return null;
  return parseCanonicalStateRecord(content, path, 'canonical skill state') as SkillActiveStateLike;
}

async function readVisibleSafeSkillActiveState(
  baseStateDir: string,
  sessionId?: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<SkillActiveStateLike | null> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(baseStateDir, sessionId);
  return sessionPath
    ? readSafeSkillActiveState(baseStateDir, sessionPath, expectedRootIdentity)
    : readSafeSkillActiveState(baseStateDir, rootPath, expectedRootIdentity);
}

async function listStateSessionDirectories(
  baseStateDir: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<string[]> {
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state session inventory root');
  }
  await assertStatePathHasNoSymlinkComponents(baseStateDir, 'state root');
  await assertStateDirectory(baseStateDir, 'state root');
  const sessionsDir = join(baseStateDir, 'sessions');
  if (!await assertStateDirectoryIfPresent(sessionsDir, 'state sessions directory')) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  await assertStateDirectory(sessionsDir, 'state sessions directory');
  await assertStatePathHasNoSymlinkComponents(baseStateDir, 'state root');
  await assertStateDirectory(baseStateDir, 'state root');

  const directories: string[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) continue;
    await assertStateDirectory(sessionsDir, 'state sessions directory');
    const sessionDir = join(sessionsDir, entry.name);
    await assertStateDirectory(sessionDir, 'state session directory');
    directories.push(sessionDir);
  }
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state session inventory root');
  }
  return directories;
}

async function finalizeCanonicalSkillStateDurability(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  options: { sessionId?: string; allSessions?: boolean; sessionIds?: readonly string[] } = {},
): Promise<void> {
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state durability root');
  const directories = new Set<string>([baseStateDir]);
  if (options.sessionId) {
    const sessionsDir = join(baseStateDir, 'sessions');
    await assertStateDirectory(sessionsDir, 'state sessions directory');
    const sessionDir = join(sessionsDir, options.sessionId);
    await assertStateDirectory(sessionsDir, 'state sessions directory');
    await assertStateDirectory(sessionDir, 'state session directory');
    directories.add(sessionDir);
  } else if (options.allSessions) {
    if (options.sessionIds) {
      const sessionsDir = join(baseStateDir, 'sessions');
      const seenSessionIds = new Set<string>();
      for (const candidate of options.sessionIds) {
        const sessionId = validateSessionId(candidate)!;
        if (seenSessionIds.has(sessionId)) {
          throw new Error(`canonical skill-state durability session inventory contains duplicate session ID: ${sessionId}`);
        }
        seenSessionIds.add(sessionId);
        await assertStateDirectory(sessionsDir, 'state sessions directory');
        const sessionDir = join(sessionsDir, sessionId);
        await assertStateDirectory(sessionDir, 'state session directory');
        directories.add(sessionDir);
      }
    } else {
      for (const sessionDir of await listStateSessionDirectories(baseStateDir, expectedRootIdentity)) {
        directories.add(sessionDir);
      }
    }
  }

  for (const directory of directories) {
    const path = join(directory, SKILL_ACTIVE_STATE_FILE);
    const content = await readRegularStateFileIfPresent(baseStateDir, path, 'canonical skill state', expectedRootIdentity);
    if (content !== null) {
      parseCanonicalStateRecord(content, path, 'canonical skill state');
      await writeAtomicFile(baseStateDir, expectedRootIdentity, path, content);
    }
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state durability root');
    await fsyncAuthorityDirectory(directory);
  }
}

async function writeClearedSessionScopedModeState(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  path: string,
  mode: string,
  sessionId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const clearedState = withModeRuntimeContext({}, {
    mode,
    active: false,
    current_phase: 'cleared',
    updated_at: nowIso,
    completed_at: nowIso,
    session_id: sessionId,
  });
  await writeAtomicFile(baseStateDir, expectedRootIdentity, path, JSON.stringify(clearedState, null, 2));
}

async function clearSessionNativeStopState(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  sessionId: string,
): Promise<string[]> {
  const paths = [
    join(baseStateDir, 'native-stop-state.json'),
    join(baseStateDir, 'sessions', sessionId, 'native-stop-state.json'),
  ];
  const pending = [] as Array<{
    path: string;
    state: Record<string, unknown>;
    sessions: Record<string, unknown>;
  }>;
  for (const path of paths) {
    const content = await readRegularStateFileIfPresent(baseStateDir, path, 'native Stop state', expectedRootIdentity);
    if (content === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error(`native Stop state contains malformed JSON: ${path}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`native Stop state has a malformed root container: ${path}`);
    }
    const state = value as Record<string, unknown>;
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
      throw new Error(`native Stop state has a malformed sessions container: ${path}`);
    }
    pending.push({
      path,
      state,
      sessions: { ...(state.sessions as Record<string, unknown>) },
    });
  }

  const changed: string[] = [];
  for (const entry of pending) {
    if (!Object.prototype.hasOwnProperty.call(entry.sessions, sessionId)) continue;
    delete entry.sessions[sessionId];
    entry.state.sessions = entry.sessions;
    await writeAtomicFile(baseStateDir, expectedRootIdentity, entry.path, JSON.stringify(entry.state, null, 2));
    changed.push(entry.path);
  }
  return changed;
}

function readModeSupportsStrictValidation(mode: string): mode is SupportedStateReadMode {
  return SUPPORTED_STATE_READ_MODES.includes(mode as SupportedStateReadMode);
}

function validateStrictReadableMode(mode: unknown): string {
  const normalized = validateStateModeSegment(mode);
  if (!readModeSupportsStrictValidation(normalized)) {
    throw new Error(`mode must be one of: ${SUPPORTED_STATE_READ_MODES.join(', ')}`);
  }
  return normalized;
}

function modeStatePath(baseStateDir: string, mode: string, sessionId?: string): string {
  const fileName = `${validateStateModeSegment(mode)}-state.json`;
  return sessionId ? join(baseStateDir, 'sessions', sessionId, fileName) : join(baseStateDir, fileName);
}


async function initializeStateEnvironment(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  workspaceRoot: string,
  effectiveSessionId?: string,
  authoritativeOmxRoot?: string,
): Promise<void> {
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state environment root');
  await assertStateDirectory(baseStateDir, 'state root');
  await fsyncAuthorityDirectory(baseStateDir);
  if (effectiveSessionId) {
    const sessionsDir = await ensureStateChildDirectory(
      baseStateDir,
      expectedRootIdentity,
      baseStateDir,
      'sessions',
      'state sessions directory',
    );
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state environment root');
    await fsyncAuthorityDirectory(baseStateDir);
    await ensureStateChildDirectory(
      baseStateDir,
      expectedRootIdentity,
      sessionsDir,
      effectiveSessionId,
      'state session directory',
    );
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state environment root');
    await fsyncAuthorityDirectory(sessionsDir);
  }
  const { ensureTmuxHookInitialized } = await import('../cli/tmux-hook.js');
  await ensureTmuxHookInitialized(workspaceRoot, authoritativeOmxRoot);
  await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'state environment root');
}

function uniqueStatePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))];
}

type PersistedWriteTargetInventory = {
  modeStatePath: string;
  skillStatePaths: string[];
  transitionSourcePaths: string[];
};

function validatePreparedWriteTargetInventory(
  authority: ResolvedStateAuthorityContext,
  baseStateDir: string,
  operation: DurableStateOperation,
  expectedModePath: string,
  sessionId?: string,
): PersistedWriteTargetInventory {
  const stateRoot = resolve(authority.canonical_state_root);
  if (resolve(baseStateDir) !== stateRoot || resolve(authority.generation.canonical_state_root) !== stateRoot) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      'prepared state write recovery does not use the active authority state root',
    );
  }
  if (operation.targets.length === 0 || new Set(operation.targets).size !== operation.targets.length) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      'prepared state write target inventory is empty or contains duplicates',
    );
  }

  const modePath = resolve(expectedModePath);
  const expectedSkillPaths = uniqueStatePaths([
    join(stateRoot, SKILL_ACTIVE_STATE_FILE),
    sessionId ? join(stateRoot, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE) : undefined,
  ]).map((target) => resolve(target));
  const allowedTransitionFiles = new Set(TRACKED_WORKFLOW_MODES.map((mode) => `${mode}-state.json`));
  const modeFile = `${validateStateModeSegment(operation.mode)}-state.json`;
  const inventory: PersistedWriteTargetInventory = {
    modeStatePath: modePath,
    skillStatePaths: [],
    transitionSourcePaths: [],
  };

  for (const target of operation.targets) {
    const resolvedTarget = resolve(target);
    if (target !== resolvedTarget || !isPathWithinStateRoot(stateRoot, resolvedTarget)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `prepared state write target escapes the active authority state root: ${target}`,
      );
    }
    const segments = relative(stateRoot, resolvedTarget).split(/[\\/]+/);
    const rootScoped = segments.length === 1;
    const sessionScoped = segments.length === 3
      && segments[0] === 'sessions'
      && /^[A-Za-z0-9_-]{1,64}$/.test(segments[1]);
    if (!rootScoped && !sessionScoped) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `prepared state write target is outside the authority state schema: ${target}`,
      );
    }
    const fileName = segments.at(-1)!;
    if (resolvedTarget === modePath) continue;
    if (expectedSkillPaths.includes(resolvedTarget)) {
      inventory.skillStatePaths.push(resolvedTarget);
      continue;
    }
    if (allowedTransitionFiles.has(fileName) && fileName !== modeFile) {
      const expectedScope = sessionId ? ['sessions', sessionId] : [];
      if (segments.slice(0, -1).join('/') !== expectedScope.join('/')) {
        stateReadError(
          AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
          `prepared transition source target is outside the requested state scope: ${target}`,
        );
      }
      inventory.transitionSourcePaths.push(resolvedTarget);
      continue;
    }
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      `prepared state write target is not an allowed state file: ${target}`,
    );
  }

  if (!operation.targets.includes(modePath)
    || inventory.skillStatePaths.length !== expectedSkillPaths.length
    || !expectedSkillPaths.every((path) => inventory.skillStatePaths.includes(path))) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      'prepared state write target inventory does not include its exact mode and canonical skill-state targets',
    );
  }
  return inventory;
}

type PersistedClearTargetInventory = {
  modeStatePaths: string[];
  skillStatePaths: string[];
  nativeStopPaths: string[];
};

function validatePreparedClearTargetInventory(
  authority: ResolvedStateAuthorityContext,
  baseStateDir: string,
  operation: DurableStateOperation,
): PersistedClearTargetInventory {
  const stateRoot = resolve(authority.canonical_state_root);
  if (resolve(baseStateDir) !== stateRoot || resolve(authority.generation.canonical_state_root) !== stateRoot) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      'prepared state clear recovery does not use the active authority state root',
    );
  }
  if (operation.targets.length === 0 || new Set(operation.targets).size !== operation.targets.length) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      'prepared state clear target inventory is empty or contains duplicates',
    );
  }

  const modeFile = `${validateStateModeSegment(operation.mode)}-state.json`;
  const inventory: PersistedClearTargetInventory = {
    modeStatePaths: [],
    skillStatePaths: [],
    nativeStopPaths: [],
  };
  for (const target of operation.targets) {
    const resolvedTarget = resolve(target);
    if (target !== resolvedTarget || !isPathWithinStateRoot(stateRoot, resolvedTarget)) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `prepared state clear target escapes the active authority state root: ${target}`,
      );
    }
    const segments = relative(stateRoot, resolvedTarget).split(/[\\/]+/);
    const rootScoped = segments.length === 1;
    const sessionScoped = segments.length === 3
      && segments[0] === 'sessions'
      && /^[A-Za-z0-9_-]{1,64}$/.test(segments[1]);
    if (!rootScoped && !sessionScoped) {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `prepared state clear target is outside the authority state schema: ${target}`,
      );
    }
    const fileName = segments.at(-1)!;
    if (fileName === modeFile) {
      inventory.modeStatePaths.push(resolvedTarget);
    } else if (fileName === SKILL_ACTIVE_STATE_FILE) {
      inventory.skillStatePaths.push(resolvedTarget);
    } else if (fileName === 'native-stop-state.json' && !operation.all_sessions) {
      inventory.nativeStopPaths.push(resolvedTarget);
    } else {
      stateReadError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
        `prepared state clear target is not an allowed state file: ${target}`,
      );
    }
  }

  if (inventory.modeStatePaths.length === 0 || (operation.all_sessions && !inventory.modeStatePaths.includes(join(stateRoot, modeFile)))) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      'prepared all-session clear target inventory does not include the canonical root mode state',
    );
  }
  return inventory;
}

async function clearPersistedAllSessionSkillStateTargets(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  skillStatePaths: string[],
  mode: string,
): Promise<void> {
  const now = new Date().toISOString();
  for (const path of skillStatePaths) {
    const content = await readRegularStateFileIfPresent(baseStateDir, path, 'prepared canonical skill state', expectedRootIdentity);
    if (content === null) continue;
    const state = parseCanonicalStateRecord(content, path, 'prepared canonical skill state') as SkillActiveStateLike;
    const entries = listActiveSkills(state).filter((entry) => entry.skill !== mode);
    const primary = entries.find((entry) => entry.skill === stringValue(state.skill).trim()) ?? entries[0];
    const next: SkillActiveStateLike = {
      ...state,
      active: entries.length > 0,
      skill: primary?.skill ?? (stringValue(state.skill).trim() || mode),
      phase: primary?.phase ?? (stringValue(state.phase).trim() || undefined),
      updated_at: now,
      active_skills: entries,
    };
    await writeAtomicFile(baseStateDir, expectedRootIdentity, path, JSON.stringify(next, null, 2));
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'prepared canonical skill-state root');
    await fsyncAuthorityDirectory(dirname(path));
  }
}

function hasExplicitStateField(
  fields: Record<string, unknown>,
  customState: unknown,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key)
    || (
      customState != null
      && Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, key)
    );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalSessionId(value: unknown): string | undefined {
  try {
    return validateSessionId(stringValue(value).trim());
  } catch {
    return undefined;
  }
}

function normalizeCurrentPhaseAliasForWrite(
  state: Record<string, unknown>,
  fields: Record<string, unknown>,
  customState: unknown,
): void {
  const hasCanonicalPhase = hasExplicitStateField(fields, customState, 'current_phase');
  const hasAliasPhase = hasExplicitStateField(fields, customState, 'currentPhase');
  if (!hasCanonicalPhase && hasAliasPhase) {
    state.current_phase = state.currentPhase;
  }
  if (hasCanonicalPhase || hasAliasPhase) {
    delete state.currentPhase;
  }
}

function normalizeCleanAutopilotCompletionEvidence(state: Record<string, unknown>): void {
  if (!isAutopilotSuccessfulTerminalState(state) || !hasCleanAutopilotReviewAndQaEvidence(state)) return;

  const reviewVerdict = state.review_verdict;
  const qaVerdict = state.qa_verdict;
  const nestedState = { ...objectRecord(state.state) };
  const handoffArtifacts = { ...objectRecord(nestedState.handoff_artifacts ?? state.handoff_artifacts) };

  handoffArtifacts.code_review = reviewVerdict;
  handoffArtifacts.ultraqa = qaVerdict;
  state.handoff_artifacts = handoffArtifacts;
  state.return_to_ralplan_reason = null;
  nestedState.handoff_artifacts = handoffArtifacts;
  nestedState.review_verdict = reviewVerdict;
  nestedState.qa_verdict = qaVerdict;
  nestedState.return_to_ralplan_reason = null;
  state.state = nestedState;
}

function isCompleteRalplanTerminalState(state: Record<string, unknown>): boolean {
  const currentPhase = stringValue(state.current_phase).trim().toLowerCase();
  const gate = objectRecord(state.ralplan_consensus_gate);
  return state.active === false
    && currentPhase === 'complete'
    && gate.complete === true;
}

function isRalplanCompleteCloseoutAttempt(state: Record<string, unknown>): boolean {
  return state.active === false && hasCleanTerminalValue(state);
}
function stateContainsUnsupportedNativeSubagentEvidence(
  state: Record<string, unknown>,
  input: { cwd?: string; sessionId?: string } = {},
): boolean {
  const nestedState = objectRecord(state.state);
  const handoffArtifacts = objectRecord(state.handoff_artifacts);
  const nestedHandoffArtifacts = objectRecord(nestedState.handoff_artifacts);
  const ralplanHandoff = objectRecord(handoffArtifacts.ralplan);
  const nestedRalplanHandoff = objectRecord(nestedHandoffArtifacts.ralplan);
  return isUnsupportedNativeSubagentEvidenceForScope(state.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedState.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(handoffArtifacts.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedHandoffArtifacts.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(ralplanHandoff.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedRalplanHandoff.native_subagent_support, input);
}

function hasNonCleanTerminalValue(state: Record<string, unknown>): boolean {
  const terminalValues = new Set(['blocked', 'cancelled', 'failed']);
  return terminalValues.has(stringValue(state.current_phase).trim().toLowerCase())
    || terminalValues.has(stringValue(state.status).trim().toLowerCase())
    || terminalValues.has(stringValue(state.outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.terminal_outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.lifecycle_outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.run_outcome).trim().toLowerCase());
}

function hasCleanTerminalValue(state: Record<string, unknown>): boolean {
  const terminalValues = [
    state.current_phase,
    state.status,
    state.outcome,
    state.terminal_outcome,
    state.lifecycle_outcome,
    state.run_outcome,
  ];
  return terminalValues.some((value) => stringValue(value).trim().toLowerCase() === 'complete');
}

function hasCompleteRalplanConsensusGate(state: Record<string, unknown>): boolean {
  const nestedState = objectRecord(state.state);
  return objectRecord(state.ralplan_consensus_gate).complete === true
    || objectRecord(nestedState.ralplan_consensus_gate).complete === true;
}

function isApprovedUnsupportedNativeNonCleanRecoveryState(
  state: Record<string, unknown>,
  input: { cwd?: string; sessionId?: string } = {},
): boolean {
  if (state.active !== false) return false;
  if (hasCleanTerminalValue(state)) return false;
  if (hasCompleteRalplanConsensusGate(state)) return false;
  return stateContainsUnsupportedNativeSubagentEvidence(state, input) && hasNonCleanTerminalValue(state);
}

export function validateRalplanTerminalConsensus(
  cwd: string,
  state: Record<string, unknown>,
  sessionId: string | undefined,
  options: { requireNativeSubagents?: boolean } = {},
): string | null {
  if (!isRalplanCompleteCloseoutAttempt(state)) return null;
  if (stateContainsUnsupportedNativeSubagentEvidence(state, { cwd, sessionId })) {
    return 'Cannot complete ralplan cleanly while native subagent support is unavailable; terminalize the workflow as blocked/cancelled/failed or restart in a runtime with working native subagents.';
  }
  const stateSessionId = sessionId ?? optionalSessionId(state.session_id);
  const gate = buildRalplanConsensusGateFromSources([
    { source: 'state-write-ralplan-terminal', value: state, sessionId: stateSessionId },
  ], {
    cwd,
    sessionId: stateSessionId,
    requireNativeSubagents: options.requireNativeSubagents === true,
  });
  if (gate.complete === true) {
    if (options.requireNativeSubagents === true) {
      state.ralplan_consensus_gate = {
        ...objectRecord(state.ralplan_consensus_gate),
        ...gate,
      };
    }
    return null;
  }
  const details = gate.blockedDetails?.length ? ` Details: ${gate.blockedDetails.join('; ')}.` : '';
  const evidenceDescription = options.requireNativeSubagents === true
    ? 'tracker-backed native architect and critic consensus evidence'
    : 'architect and critic consensus evidence';
  return `ralplan complete state requires ${evidenceDescription} (${gate.blockedReason ?? 'missing_consensus'}).${details}`;
}

function buildRalplanTerminalState(
  state: Record<string, unknown>,
  sessionId: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  const completedAt = stringValue(state.completed_at).trim() || nowIso;
  const terminalReason = stringValue(state.terminal_reason).trim() || 'ralplan consensus complete';
  return withModeRuntimeContext(state, {
    ...state,
    mode: 'ralplan',
    active: false,
    current_phase: 'complete',
    status: 'complete',
    updated_at: nowIso,
    completed_at: completedAt,
    terminal_reason: terminalReason,
    session_id: sessionId,
    ralplan_consensus_gate: {
      ...objectRecord(state.ralplan_consensus_gate),
      complete: true,
    },
  });
}

function buildRalplanTerminalSkillState(
  base: SkillActiveStateLike | null,
  terminalState: Record<string, unknown>,
  sessionId: string | undefined,
  nowIso: string,
): SkillActiveStateLike {
  const completedAt = stringValue(terminalState.completed_at).trim() || nowIso;
  const terminalReason = stringValue(terminalState.terminal_reason).trim() || 'ralplan consensus complete';
  return {
    ...(base ?? {}),
    version: 1,
    active: false,
    skill: 'ralplan',
    keyword: stringValue(base?.keyword).trim() || 'ralplan',
    phase: 'complete',
    activated_at: stringValue(base?.activated_at).trim() || stringValue(terminalState.started_at).trim() || nowIso,
    updated_at: nowIso,
    completed_at: completedAt,
    source: stringValue(base?.source).trim() || 'state-operations',
    ...(sessionId ? { session_id: sessionId } : {}),
    terminal_reason: terminalReason,
    active_skills: [],
  };
}

function buildRalplanSkillStateFromEntries(
  base: SkillActiveStateLike | null,
  terminalState: Record<string, unknown>,
  entries: SkillActiveEntry[],
  sessionId: string | undefined,
  nowIso: string,
): SkillActiveStateLike {
  if (entries.length === 0) {
    return buildRalplanTerminalSkillState(base, terminalState, sessionId, nowIso);
  }

  const primary = entries[0] as SkillActiveEntry;
  const activeBase = clearTerminalSkillActiveMarkers(base ?? {});
  return {
    ...activeBase,
    version: 1,
    active: true,
    skill: primary.skill,
    keyword: stringValue(activeBase.keyword).trim(),
    phase: primary.phase || stringValue(activeBase.phase).trim(),
    activated_at: primary.activated_at || stringValue(base?.activated_at).trim() || nowIso,
    updated_at: nowIso,
    source: stringValue(activeBase.source).trim() || 'state-operations',
    session_id: primary.session_id || undefined,
    thread_id: primary.thread_id || stringValue(activeBase.thread_id).trim() || undefined,
    turn_id: primary.turn_id || stringValue(activeBase.turn_id).trim() || undefined,
    active_skills: entries,
  };
}

function isTerminalSkillActiveTombstone(state: SkillActiveStateLike | null): boolean {
  return state !== null && isTerminalSkillActiveState(state);
}

function filterCompletedRalplanRootEntries(
  entries: SkillActiveEntry[],
  completedSessionId: string | undefined,
  rootScopeCompletion: boolean,
): SkillActiveEntry[] {
  return entries.filter((entry) => {
    const entrySessionId = stringValue(entry.session_id).trim();
    if (entry.skill !== 'ralplan') return true;
    if (completedSessionId && entrySessionId === completedSessionId) return false;
    if (rootScopeCompletion && entrySessionId.length === 0) return false;
    return true;
  });
}

function filterCompletedRalplanSessionEntries(entries: SkillActiveEntry[], sessionId: string): SkillActiveEntry[] {
  return entries.filter((entry) => {
    const entrySessionId = stringValue(entry.session_id).trim();
    return entrySessionId === sessionId && entry.skill !== 'ralplan';
  });
}

function skillActiveEntryKey(entry: Pick<SkillActiveEntry, 'skill' | 'session_id'>): string {
  return `${entry.skill}::${stringValue(entry.session_id).trim()}`;
}

function collectCompletedRalplanSessionEntries(
  sessionState: SkillActiveStateLike | null,
  rootState: SkillActiveStateLike | null,
  sessionId: string,
): SkillActiveEntry[] {
  const entries = new Map<string, SkillActiveEntry>();
  for (const entry of filterCompletedRalplanSessionEntries(listActiveSkills(rootState ?? {}), sessionId)) {
    entries.set(skillActiveEntryKey(entry), entry);
  }
  for (const entry of filterCompletedRalplanSessionEntries(listActiveSkills(sessionState ?? {}), sessionId)) {
    entries.set(skillActiveEntryKey(entry), entry);
  }
  return [...entries.values()];
}

async function writeAtomicJson(
  baseStateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
  path: string,
  value: unknown,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  JSON.parse(serialized);
  await writeAtomicFile(baseStateDir, expectedRootIdentity, path, serialized);
}

async function resolvePersistedStateRootIdentity(
  cwd: string,
  baseStateDir: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<RootFilesystemIdentity> {
  if (expectedRootIdentity) {
    await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'ralplan completion root');
    return expectedRootIdentity;
  }
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
  });
  if (resolve(authority.canonical_state_root) !== resolve(baseStateDir)) {
    stateReadError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      'ralplan completion does not use the committed active authority state root',
    );
  }
  await assertExpectedStateRootIdentity(baseStateDir, authority.generation.root_identity, 'ralplan completion root');
  return authority.generation.root_identity;
}


async function readJsonRecordIfExists(
  baseStateDir: string,
  path: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<Record<string, unknown> | null> {
  const content = await readRegularStateFileIfPresent(baseStateDir, path, 'workflow state', expectedRootIdentity);
  if (content === null) return null;
  return parseCanonicalStateRecord(content, path, 'workflow state');
}


function shouldWriteRootRalplanTerminalState(rootState: Record<string, unknown> | null, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return optionalSessionId(rootState?.session_id) === sessionId;
}

export async function completeRalplanSession(options: {
  cwd: string;
  baseStateDir: string;
  state: Record<string, unknown>;
  explicitSessionId?: string;
  requireNativeSubagents?: boolean;
  expectedRootIdentity?: RootFilesystemIdentity;
}): Promise<boolean> {
  if (!isCompleteRalplanTerminalState(options.state)) return false;
  const sessionId = options.explicitSessionId === undefined ? undefined : validateSessionId(options.explicitSessionId);
  const validationError = validateRalplanTerminalConsensus(options.cwd, options.state, sessionId, {
    requireNativeSubagents: options.requireNativeSubagents === true,
  });
  if (validationError) throw new Error(validationError);
  const expectedRootIdentity = await resolvePersistedStateRootIdentity(
    options.cwd,
    options.baseStateDir,
    options.expectedRootIdentity,
  );

  const completedSessionId = sessionId ?? optionalSessionId(options.state.session_id);
  const rootScopeCompletion = !sessionId;

  const nowIso = new Date().toISOString();
  const rootState = buildRalplanTerminalState(options.state, sessionId, nowIso);
  const rootStatePath = modeStatePath(options.baseStateDir, 'ralplan');
  const existingRootState = await readJsonRecordIfExists(options.baseStateDir, rootStatePath, expectedRootIdentity);

  const shouldWriteRootState = shouldWriteRootRalplanTerminalState(existingRootState, sessionId);

  if (shouldWriteRootState) {
    await writeAtomicJson(options.baseStateDir, expectedRootIdentity, rootStatePath, rootState);

  }
  if (sessionId) {
    await writeAtomicJson(
      options.baseStateDir,
      expectedRootIdentity,
      modeStatePath(options.baseStateDir, 'ralplan', sessionId),
      buildRalplanTerminalState(options.state, sessionId, nowIso),
    );
  }

  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(options.baseStateDir, sessionId);
  const rootSkillState = await readSafeSkillActiveState(options.baseStateDir, rootPath, expectedRootIdentity);

  const rootEntries = filterCompletedRalplanRootEntries(
    listActiveSkills(rootSkillState ?? {}),
    completedSessionId,
    rootScopeCompletion,
  );
  if (rootEntries.length > 0 || (shouldWriteRootState && rootSkillState !== null)) {
    await writeAtomicJson(options.baseStateDir, expectedRootIdentity, rootPath, buildRalplanSkillStateFromEntries(rootSkillState, rootState, rootEntries, undefined, nowIso));

  } else if (rootSkillState !== null && !isTerminalSkillActiveTombstone(rootSkillState)) {
    await unlinkDurably(options.baseStateDir, expectedRootIdentity, rootPath, 'ralplan canonical skill state');

  }
  if (sessionPath && sessionId) {
    const sessionSkillState = await readSafeSkillActiveState(options.baseStateDir, sessionPath, expectedRootIdentity);

    const sessionEntries = collectCompletedRalplanSessionEntries(sessionSkillState, rootSkillState, sessionId);
    if (sessionEntries.length > 0 || sessionSkillState !== null) {
      await writeAtomicJson(
        options.baseStateDir,
        expectedRootIdentity,
        sessionPath,
        sessionEntries.length > 0
          ? buildRalplanSkillStateFromEntries(sessionSkillState ?? rootSkillState, rootState, sessionEntries, sessionId, nowIso)
          : buildRalplanTerminalSkillState(sessionSkillState, rootState, sessionId, nowIso),
      );
    }
  }
  return true;
}

type OperationRuntimeScope = ResolvedRuntimeStateScope & {
  authority?: ResolvedAuthorityRuntimeStateScope['authority'];
};

export async function listStateStatuses(
  scope: OperationRuntimeScope,
  mode?: string,
  options: { authoritativeActiveDecision?: boolean } = {},
): Promise<Record<string, unknown>> {
  const expectedRootIdentity = scope.authority?.generation.root_identity;
  const stateDirs = options.authoritativeActiveDecision || scope.authority
    ? scope.authoritativeActiveDirs
    : scope.compatibilityReadDirs;
  const statuses: Record<string, unknown> = {};
  const seenModes = new Set<string>();

  for (const stateDir of stateDirs) {
    if (!await assertStateReadDirectoryIfPresent(scope.baseStateDir, stateDir, 'state status directory', expectedRootIdentity)) continue;
    const files = await readdir(stateDir);
    await assertStateReadDirectory(scope.baseStateDir, stateDir, 'state status directory', expectedRootIdentity);
    for (const file of files) {
      if (!file.endsWith('-state.json')) continue;
      const currentMode = file.replace('-state.json', '');
      if (!mode && currentMode === SKILL_ACTIVE_STATE_MODE) continue;
      if (mode && currentMode !== mode) continue;
      if (seenModes.has(currentMode)) continue;
      const path = join(stateDir, file);
      const content = await readRegularStateFileIfPresent(scope.baseStateDir, path, 'state status file', expectedRootIdentity);
      if (content === null) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
          `state status file disappeared during enumeration: ${path}`,
        );
      }
      seenModes.add(currentMode);
      try {
        const data = scope.authority
          ? parseCanonicalStateRecord(content, path, 'authoritative state status file')
          : JSON.parse(content) as Record<string, unknown>;
        statuses[currentMode] = {
          active: data.active,
          phase: data.current_phase,
          path,
          data,
        };
      } catch (error) {
        if (scope.authority) throw error;
        statuses[currentMode] = { error: 'malformed state file' };
      }
    }
  }
  if (!scope.authority && (!mode || mode === 'autopilot')) {
    const existingAutopilot = statuses.autopilot as { active?: unknown } | undefined;
    if (existingAutopilot?.active !== true) {
      const currentAutopilotPath = join(scope.baseStateDir, 'current-autopilot.json');
      const content = await readRegularStateFileIfPresent(
        scope.baseStateDir,
        currentAutopilotPath,
        'current autopilot status file',
      );
      if (content !== null) {
        try {
          const data = JSON.parse(content) as { active?: unknown; current_phase?: unknown };
          const phase = typeof data.current_phase === 'string' ? data.current_phase.trim() : '';
          if (data.active === true && phase) {
            statuses.autopilot = {
              active: false,
              phase,
              displayState: 'STALE',
              path: currentAutopilotPath,
              data,
              source: 'current-autopilot',
            };
          }
        } catch {
          // Malformed compatibility status is not reportable authority evidence.
        }
      }
    }
  }



  if (!scope.authority && (!mode || mode === 'ultragoal')) {
    const workspaceRoot = scope.cwd;
    const ultragoal = await readUltragoalState(workspaceRoot).catch(() => null);
    const existingUltragoal = statuses.ultragoal as { active?: unknown } | undefined;
    if (
      ultragoal
      && existingUltragoal?.active !== true
      && (ultragoal.active || (mode === 'ultragoal' && !seenModes.has('ultragoal')))
    ) {
      const failed = ultragoal.status === 'failed';
      statuses.ultragoal = {
        active: failed ? false : ultragoal.active,
        phase: ultragoal.status,
        ...(failed ? { displayState: 'FAILED' } : {}),
        path: join(workspaceRoot, '.omx', 'ultragoal', 'goals.json'),
        data: ultragoal,
        source: 'ultragoal-artifacts',
      };
    }
  }

  return statuses;
}

export async function listActiveStateModes(scope: OperationRuntimeScope): Promise<string[]> {
  const sessionId = scope.sessionId;
  const statuses = await listStateStatuses(scope, undefined, { authoritativeActiveDecision: true });
  const canonicalState = await readVisibleSafeSkillActiveState(scope.baseStateDir, sessionId, scope.authority?.generation.root_identity);

  const canonicalActiveModes = new Set(
    listActiveSkills(canonicalState ?? {})
      .filter((entry) => {
        const entrySessionId = typeof entry.session_id === 'string' ? entry.session_id.trim() : '';
        return sessionId ? entrySessionId === sessionId : entrySessionId.length === 0;
      })
      .map((entry) => entry.skill),
  );
  const hasCanonicalVisibility = canonicalState !== null;

  return Object.entries(statuses)
    .filter(([mode, status]) => {
      if (!Boolean((status as { active?: unknown }).active)) return false;
      if (hasCanonicalVisibility && isTrackedWorkflowMode(mode)) {
        return canonicalActiveModes.has(mode);
      }
      return true;
    })
    .map(([mode]) => mode);
}

async function readCanonicalActiveWorkflowModes(
  baseStateDir: string,
  sessionId: string | undefined,
  expectedRootIdentity: RootFilesystemIdentity,
): Promise<TrackedWorkflowMode[]> {
  const normalizedSessionId = sessionId ?? '';
  const canonicalState = await readVisibleSafeSkillActiveState(baseStateDir, sessionId, expectedRootIdentity);

  const activeModes = listActiveSkills(canonicalState ?? {})
    .filter((entry) => {
      const entrySessionId = typeof entry.session_id === 'string' ? entry.session_id.trim() : '';
      return normalizedSessionId ? entrySessionId === normalizedSessionId : entrySessionId.length === 0;
    })
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);
  return [...new Set(activeModes)];
}

function isActiveDetailWorkflowState(state: Record<string, unknown>): boolean {
  if (state.active !== true) return false;
  const phase = typeof state.current_phase === 'string' ? state.current_phase.trim().toLowerCase() : '';
  return !['complete', 'completed', 'cancelled', 'canceled', 'failed', 'cleared'].includes(phase);
}

async function readSessionDetailTransitionModes(
  baseStateDir: string,
  sessionId: string | undefined,
  requestedMode: TrackedWorkflowMode,
  expectedRootIdentity: RootFilesystemIdentity,
): Promise<TrackedWorkflowMode[] | undefined> {
  if (!sessionId || requestedMode !== 'ralplan') return undefined;
  const autopilotPath = modeStatePath(baseStateDir, 'autopilot', sessionId);
  const autopilotContent = await readRegularStateFileIfPresent(baseStateDir, autopilotPath, 'workflow transition state', expectedRootIdentity);
  if (autopilotContent !== null) {
    const state = parseCanonicalStateRecord(autopilotContent, autopilotPath, 'workflow transition state');
    if (isActiveDetailWorkflowState(state)) return ['autopilot'];
  }

  const deepInterviewPath = modeStatePath(baseStateDir, 'deep-interview', sessionId);
  const deepInterviewContent = await readRegularStateFileIfPresent(baseStateDir, deepInterviewPath, 'workflow transition state', expectedRootIdentity);
  if (deepInterviewContent === null) return undefined;
  const state = parseCanonicalStateRecord(deepInterviewContent, deepInterviewPath, 'workflow transition state');
  return isActiveDetailWorkflowState(state) ? ['deep-interview'] : undefined;
}

export async function executeStateOperation(
  name: StateOperationName,
  rawArgs: Record<string, unknown> = {},
): Promise<StateOperationResponse> {
  if (name !== 'state_write' && name !== 'state_clear') {
    return executeStateOperationInternal(name, rawArgs);
  }

  try {
    const cwd = resolveWorkingDirectoryForState(rawArgs.workingDirectory as string | undefined);
    const workspaceKey = resolveWorkspaceIdentity(cwd).canonical_path;
    return await withStateMutationAdmission(workspaceKey, () => executeStateOperationInternal(name, rawArgs));
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }
}

async function executeStateOperationInternal(
  name: StateOperationName,
  rawArgs: Record<string, unknown> = {},
  options: StateOperationExecutionOptions = {},
): Promise<StateOperationResponse> {
  let cwd: string;
  let explicitSessionId: string | undefined;
  let scope: OperationRuntimeScope;

  try {
    cwd = resolveWorkingDirectoryForState(rawArgs.workingDirectory as string | undefined);
    explicitSessionId = validateSessionId(rawArgs.session_id);
    try {
      scope = await resolveAuthorityRuntimeStateScope(cwd, explicitSessionId);
    } catch (error) {
      if (!(error instanceof StateAuthorityError) || error.code !== AUTHORITY_DIAGNOSTIC_CODES.anchorMissing) {
        throw error;
      }
      if (name !== 'state_write' && name !== 'state_clear') {
        scope = await resolveRuntimeStateScope(cwd, explicitSessionId);
      } else {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.anchorMissing,
          'state write/clear requires a committed active authority',
        );
      }
    }
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }

  try {
    const needsStandaloneRecovery = scope.authority
      && !options.skipPreparedOperationRecovery
      && (name !== 'state_write' && name !== 'state_clear');
    if (needsStandaloneRecovery) {
      await recoverPreparedDurableStateOperations(scope.authority!);
    }
    await awaitStateOperationTestBarrier('before_state_read');
    await assertSessionStateDirectoryForRead(
      scope.baseStateDir,
      scope.sessionId,
      scope.authority?.generation.root_identity,
    );
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }

  try {
    const execute = async (
      operationScope: OperationRuntimeScope = scope,
      transactionLock?: AcquiredStateAuthorityLock,
    ): Promise<StateOperationResponse> => {
      const scope = operationScope;
    switch (name) {
      case 'state_read': {
        const mode = validateStrictReadableMode(rawArgs.mode);
        const stateDirs = scope.authority ? scope.authoritativeActiveDirs : scope.compatibilityReadDirs;
        const paths = stateDirs.map((dir) => join(dir, `${mode}-state.json`));
        for (const path of paths) {
          const content = await readRegularStateFileIfPresent(
            scope.baseStateDir,
            path,
            'state read file',
            scope.authority?.generation.root_identity,
          );
          if (content === null) continue;
          return { payload: JSON.parse(content) };
        }
        return { payload: { exists: false, mode } };

      }

      case 'state_write': {
        const authority = scope.authority;
        if (!authority) throw new Error('state_write requires a committed state authority');
        const effectiveSessionId = scope.sessionId;
        const baseStateDir = scope.baseStateDir;
        const expectedRootIdentity = authority.generation.root_identity;
        await initializeStateEnvironment(
          baseStateDir,
          expectedRootIdentity,
          authority.workspace_identity.canonical_path,
          effectiveSessionId,
          authority.generation.canonical_omx_root,
        );

        const mode = validateStateModeSegment(rawArgs.mode);
        const path = modeStatePath(baseStateDir, mode, effectiveSessionId);
        const {
          mode: _mode,
          workingDirectory: _workingDirectory,
          session_id: _sessionId,
          state: customState,
          ...fields
        } = rawArgs;
        let validationError: string | null = null;
        let transitionMessage: string | undefined;
        let ensureRalphArtifacts = false;

        const lock = transactionLock;
        if (!lock) throw new Error('state_write requires a fenced authority transaction lock');
        const skillStatePaths = getSkillActiveStatePathsForStateDir(baseStateDir, effectiveSessionId);
        const canonicalSkillStatePaths = uniqueStatePaths([skillStatePaths.rootPath, skillStatePaths.sessionPath]);
        const preflightContent = await readRegularStateFileIfPresent(
          baseStateDir,
          path,
          'state write preflight',
          expectedRootIdentity,
        );
        const preflightExisting = preflightContent === null
          ? {}
          : parseCanonicalStateRecord(preflightContent, path, 'state write preflight');
        for (const skillStatePath of canonicalSkillStatePaths) {
          await readSafeSkillActiveState(baseStateDir, skillStatePath, expectedRootIdentity);
        }
        let plannedTransition: PlannedWorkflowTransition | undefined;
        if (!options.recoveryOperation && isTrackedWorkflowMode(mode)) {
          const preflightState = {
            ...preflightExisting,
            ...fields,
            ...((customState as Record<string, unknown>) || {}),
          } as Record<string, unknown>;
          normalizeCurrentPhaseAliasForWrite(preflightState, fields, customState);
          if (preflightState.active === true) {
            const activeCanonicalModes = await readCanonicalActiveWorkflowModes(
              baseStateDir,
              effectiveSessionId,
              expectedRootIdentity,
            );
            const transitionCurrentModes = mode === 'ralplan'
              ? (
                activeCanonicalModes.length > 0
                  ? activeCanonicalModes
                  : await readSessionDetailTransitionModes(
                    baseStateDir,
                    effectiveSessionId,
                    mode,
                    expectedRootIdentity,
                  )
              )
              : undefined;
            plannedTransition = await planWorkflowTransition(cwd, mode, {
              action: 'write',
              sessionId: effectiveSessionId,
              source: 'state-operations',
              baseStateDir,
              ...(transitionCurrentModes ? { currentModes: transitionCurrentModes } : {}),
            });
          }
        }
        const expectedTargets = uniqueStatePaths([
          path,
          skillStatePaths.rootPath,
          skillStatePaths.sessionPath,
          ...(plannedTransition?.sourceTargets ?? []),
        ]);
        const operation = options.recoveryOperation ?? createDurableStateOperation({
          name: 'state_write',
          mode,
          ...(effectiveSessionId ? { session_id: effectiveSessionId } : {}),
          targets: expectedTargets,
          recovery_args: createRecoveryArguments(rawArgs, effectiveSessionId),
        });
        if (operation.name !== 'state_write' || operation.mode !== mode || operation.session_id !== effectiveSessionId) {
          throw new Error('prepared state write recovery does not match the requested operation');
        }
        if (options.recoveryOperation) {
          validatePreparedWriteTargetInventory(authority, baseStateDir, operation, path, effectiveSessionId);
        } else if (
          operation.targets.length !== expectedTargets.length
          || operation.targets.some((target, index) => target !== expectedTargets[index])
        ) {
          throw new Error('prepared state write recovery does not match the requested operation targets');
        }
        await withDurableStateOperation(authority, lock, operation, async (markEffectsStarted) => {
        await withStateWriteLock(path, async () => {
          const existingContent = await readRegularStateFileIfPresent(
            baseStateDir,
            path,
            'state write existing file',
            expectedRootIdentity,
          );
          const existing = existingContent === null
            ? {}
            : parseCanonicalStateRecord(existingContent, path, 'state write existing file');


          const mergedRaw = {
            ...existing,
            ...fields,
            ...((customState as Record<string, unknown>) || {}),
          } as Record<string, unknown>;
          normalizeCurrentPhaseAliasForWrite(mergedRaw, fields, customState);
          delete mergedRaw.trustedPipelineProgress;
          if (!hasExplicitStateField(fields, customState, 'run_outcome')) {
            delete mergedRaw.run_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'lifecycle_outcome')) {
            delete mergedRaw.lifecycle_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'terminal_outcome')) {
            delete mergedRaw.terminal_outcome;
          }

          if (
            mode === 'ralph' &&
            effectiveSessionId &&
            typeof mergedRaw.owner_omx_session_id !== 'string'
          ) {
            mergedRaw.owner_omx_session_id = effectiveSessionId;
          }

          if (mode === 'ralph') {
            const originalPhase = mergedRaw.current_phase;
            const validation = validateAndNormalizeRalphState(mergedRaw);
            if (!validation.ok || !validation.state) {
              validationError = validation.error || `ralph.current_phase must be one of: ${RALPH_PHASES.join(', ')}`;
              return;
            }
            if (
              typeof originalPhase === 'string' &&
              typeof validation.state.current_phase === 'string' &&
              validation.state.current_phase !== originalPhase
            ) {
              validation.state.ralph_phase_normalized_from = originalPhase;
            }
            Object.assign(mergedRaw, validation.state);
            if (mergedRaw.current_phase === 'complete') {
              const completionAudit = evaluateRalphCompletionAuditEvidence(mergedRaw, cwd);
              if (!completionAudit.complete) {
                validationError = `ralph complete state requires passing completion_audit or repo-relative completion_audit_path (${completionAudit.reason})`;
                return;
              }
              delete mergedRaw.completion_audit_gate;
              delete mergedRaw.completion_audit_missing_reason;
              delete mergedRaw.completion_audit_blocked_at;
            }
            ensureRalphArtifacts = true;
          }

          if (mode !== SKILL_ACTIVE_STATE_MODE) {
            const runOutcomeValidation = applyRunOutcomeContract(mergedRaw);
            if (!runOutcomeValidation.ok || !runOutcomeValidation.state) {
              validationError = runOutcomeValidation.error || 'Invalid run outcome state';
              return;
            }
            Object.assign(mergedRaw, runOutcomeValidation.state);
            const terminalNormalization = normalizeTerminalWorkflowState(mergedRaw, { mode });
            Object.assign(mergedRaw, terminalNormalization.state);
          }

          if (mode === 'autopilot') {
            normalizeCleanAutopilotCompletionEvidence(mergedRaw);
          }

          const unsupportedNativeNonCleanRecovery = isApprovedUnsupportedNativeNonCleanRecoveryState(mergedRaw, { cwd, sessionId: effectiveSessionId });
          if (mode === 'ralplan' && !unsupportedNativeNonCleanRecovery) {
            validationError = validateRalplanTerminalConsensus(cwd, mergedRaw, effectiveSessionId, {
              requireNativeSubagents: true,
            });
            if (validationError) return;
          }

          const currentAutopilotChildPhase = mode === 'autopilot'
            ? deriveAutopilotChildPhase({ mode: 'autopilot', ...existing })
            : null;
          let nextAutopilotChildPhase = mode === 'autopilot'
            ? deriveAutopilotChildPhase({ mode: 'autopilot', ...mergedRaw })
            : null;

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isAutopilotSuccessfulTerminalState(mergedRaw)
          ) {
            validationError = 'Cannot complete Autopilot before ralplan gate: deep-interview may only advance to ralplan.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isAutopilotSuccessfulTerminalState(mergedRaw)
          ) {
            validationError = 'Cannot complete Autopilot before ultragoal gate: ralplan may only advance to ultragoal.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && unsupportedNativeNonCleanRecovery
          ) {
            nextAutopilotChildPhase = currentAutopilotChildPhase;
          }

          if (mode === 'autopilot') {
            const completionTransitionError = validateAutopilotCompletionTransition(
              existing as Record<string, unknown>,
              mergedRaw,
            );
            if (completionTransitionError) {
              validationError = completionTransitionError;
              return;
            }
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
            && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            validationError = 'Cannot skip Autopilot ralplan gate: deep-interview may only advance to ralplan.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
              cwd,
              sessionId: effectiveSessionId,
              baseStateDir,
              currentState: existing as Record<string, unknown>,
              nextState: mergedRaw,
            });
            if (!gate.allowed) {
              validationError = buildAutopilotDeepInterviewRalplanGateError(gate);
              return;
            }
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
            && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            validationError = 'Cannot skip Autopilot ultragoal gate: ralplan may only advance to ultragoal.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            const gate = canAdvanceAutopilotRalplanToUltragoal({
              cwd,
              sessionId: effectiveSessionId,
              currentState: existing as Record<string, unknown>,
              nextState: mergedRaw,
            });
            if (!gate.allowed) {
              validationError = buildAutopilotRalplanUltragoalGateError(gate);
              return;
            }
          }

          if (isTrackedWorkflowMode(mode) && mergedRaw.active === true) {
            let transitionPlan = plannedTransition;
            try {
              if (options.recoveryOperation) markEffectsStarted();

              if (!transitionPlan) {
                const activeCanonicalModes = await readCanonicalActiveWorkflowModes(baseStateDir, effectiveSessionId, expectedRootIdentity);
                const transitionCurrentModes = mode === 'ralplan'
                  ? (
                    activeCanonicalModes.length > 0
                      ? activeCanonicalModes
                      : await readSessionDetailTransitionModes(baseStateDir, effectiveSessionId, mode, expectedRootIdentity)
                  )
                  : undefined;
                transitionPlan = await planWorkflowTransition(cwd, mode, {
                  action: 'write',
                  sessionId: effectiveSessionId,
                  source: 'state-operations',
                  baseStateDir,
                  ...(transitionCurrentModes ? { currentModes: transitionCurrentModes } : {}),
                });
              }
              if (!transitionPlan.decision.allowed) {
                validationError = buildWorkflowTransitionError(transitionPlan.decision.currentModes, mode, 'write');
                return;
              }
              if (options.recoveryOperation && !transitionPlan.sourceTargets.every((target) => operation.targets.includes(target))) {
                throw new Error('prepared state write recovery transition targets do not match the accepted transition plan');
              }
              if (transitionPlan.autoCompletedModes.length > 0) {
                markEffectsStarted();
              }
              const transition = await applyPlannedWorkflowTransition(cwd, transitionPlan, {
                action: 'write',
                expectedRootIdentity,
              });
              transitionMessage ??= transition.transitionMessage;
            } catch (error) {
              validationError = (error as Error).message;
              return;
            }
          }
          markEffectsStarted();

          const merged = withModeRuntimeContext(existing, mergedRaw);
          await assertSessionStateDirectoryForRead(baseStateDir, effectiveSessionId, expectedRootIdentity);
          await writeAtomicFile(baseStateDir, expectedRootIdentity, path, JSON.stringify(merged, null, 2));

        });

        if (validationError) throw new Error(validationError);

        if (mode === SKILL_ACTIVE_STATE_MODE) {
          const state = await readSafeSkillActiveState(baseStateDir, path, expectedRootIdentity);
          if (state) {
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state write root');
            await writeSkillActiveStateCopiesForStateDir(baseStateDir, state, effectiveSessionId, undefined, expectedRootIdentity);
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state write root');
            await finalizeCanonicalSkillStateDurability(baseStateDir, expectedRootIdentity, { sessionId: effectiveSessionId });
          }
        } else {

          if (mode === 'ralph' && ensureRalphArtifacts) {
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'ralph artifact write root');
            await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId, baseStateDir, expectedRootIdentity);
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'ralph artifact write root');
          }
          await assertSessionStateDirectoryForRead(baseStateDir, effectiveSessionId, expectedRootIdentity);
          const data = parseCanonicalStateRecord(
            await readRegularStateFile(baseStateDir, path, 'written workflow state', expectedRootIdentity),
            path,
            'written workflow state',
          );

          const ralplanCompletionHandled = mode === 'ralplan'
            && !isApprovedUnsupportedNativeNonCleanRecoveryState(data, { cwd, sessionId: effectiveSessionId })
            && await completeRalplanSession({
              cwd,
              baseStateDir,
              state: data,
              explicitSessionId: effectiveSessionId,
              requireNativeSubagents: true,
              expectedRootIdentity,
            });

          if (!ralplanCompletionHandled) {
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state write root');
            await syncCanonicalSkillStateForMode({
              cwd,
              baseStateDir,
              mode,
              active: data.active === true,
              currentPhase: typeof data.current_phase === 'string' ? data.current_phase : undefined,
              sessionId: effectiveSessionId,
              source: 'state-operations',
              expectedRootIdentity,
            });
            await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state write root');
            await finalizeCanonicalSkillStateDurability(baseStateDir, expectedRootIdentity, { sessionId: effectiveSessionId });
          }
        }
        }, { preparedAlreadyRecorded: options.recoveryOperation !== undefined });

        return {
          payload: {
            success: true,
            mode,
            path,
            ...(transitionMessage ? { transition: transitionMessage } : {}),
          },
        };
      }

      case 'state_clear': {
        const authority = scope.authority;
        if (!authority) throw new Error('state_clear requires a committed state authority');
        const lock = transactionLock;
        if (!lock) throw new Error('state_clear requires a fenced authority transaction lock');
        const effectiveSessionId = scope.sessionId;
        const baseStateDir = scope.baseStateDir;
        const expectedRootIdentity = authority.generation.root_identity;
        await initializeStateEnvironment(
          baseStateDir,
          expectedRootIdentity,
          authority.workspace_identity.canonical_path,
          effectiveSessionId,
          authority.generation.canonical_omx_root,
        );

        const mode = validateStateModeSegment(rawArgs.mode);
        const allSessions = rawArgs.all_sessions === true;
        const path = modeStatePath(baseStateDir, mode, effectiveSessionId);
        const allSessionDirectories = options.recoveryOperation || !allSessions
          ? []
          : await listStateSessionDirectories(baseStateDir, expectedRootIdentity);
        const allSessionIds = allSessionDirectories.map((directory) => basename(directory));
        const discoveredPaths = options.recoveryOperation
          ? []
          : (allSessions
            ? [
              join(baseStateDir, `${mode}-state.json`),
              ...allSessionDirectories.map((directory) => join(directory, `${mode}-state.json`)),
            ]
            : [path]);
        const skillStatePaths = getSkillActiveStatePathsForStateDir(baseStateDir, effectiveSessionId);
        const operation = options.recoveryOperation ?? createDurableStateOperation({
          name: 'state_clear',
          mode,
          ...(!allSessions && effectiveSessionId ? { session_id: effectiveSessionId } : {}),
          ...(allSessions ? { all_sessions: true } : {}),
          targets: uniqueStatePaths([
            ...discoveredPaths,
            ...discoveredPaths.map((statePath) => join(dirname(statePath), SKILL_ACTIVE_STATE_FILE)),
            ...allSessionDirectories.map((directory) => join(directory, SKILL_ACTIVE_STATE_FILE)),
            ...(!allSessions && mode !== SKILL_ACTIVE_STATE_MODE ? [skillStatePaths.rootPath, skillStatePaths.sessionPath] : []),
            ...(!allSessions && effectiveSessionId
              ? [
                join(baseStateDir, 'native-stop-state.json'),
                join(baseStateDir, 'sessions', effectiveSessionId, 'native-stop-state.json'),
              ]
              : []),
          ]),
          recovery_args: createRecoveryArguments(rawArgs, allSessions ? undefined : effectiveSessionId),
        });
        if (
          operation.name !== 'state_clear'
          || operation.mode !== mode
          || Boolean(operation.all_sessions) !== allSessions
          || (!allSessions && operation.session_id !== effectiveSessionId)
        ) {
          throw new Error('prepared state clear recovery does not match the requested operation');
        }
        const targetInventory = validatePreparedClearTargetInventory(authority, baseStateDir, operation);
        const paths = targetInventory.modeStatePaths;
        const expectedPath = resolve(path);
        if (!allSessions && (paths.length !== 1 || paths[0] !== expectedPath)) {
          throw new Error(`prepared state clear recovery target does not match the active session scope: expected=${expectedPath} actual=${paths.join(',')}`);
        }
        for (const statePath of targetInventory.modeStatePaths) {
          const content = await readRegularStateFileIfPresent(
            baseStateDir,
            statePath,
            'state clear preflight',
            expectedRootIdentity,
          );
          if (content !== null) parseCanonicalStateRecord(content, statePath, 'state clear preflight');
        }
        for (const skillStatePath of targetInventory.skillStatePaths) {
          await readSafeSkillActiveState(baseStateDir, skillStatePath, expectedRootIdentity);
        }
        const rootWorkflowStatePath = !allSessions && mode !== SKILL_ACTIVE_STATE_MODE && effectiveSessionId
          ? modeStatePath(baseStateDir, mode)
          : undefined;
        const rootWorkflowContent = rootWorkflowStatePath
          ? await readRegularStateFileIfPresent(
            baseStateDir,
            rootWorkflowStatePath,
            'root workflow state clear preflight',
            expectedRootIdentity,
          )
          : null;
        if (rootWorkflowContent !== null && rootWorkflowStatePath) {
          parseCanonicalStateRecord(rootWorkflowContent, rootWorkflowStatePath, 'root workflow state clear preflight');
        }


        return await withDurableStateOperation(authority, lock, operation, async (markEffectsStarted) => {
          await assertSessionStateDirectoryForRead(baseStateDir, effectiveSessionId, expectedRootIdentity);
          markEffectsStarted();
          if (!allSessions) {
            if (
              mode !== SKILL_ACTIVE_STATE_MODE
              && effectiveSessionId
              && rootWorkflowContent !== null
            ) {
              await writeClearedSessionScopedModeState(baseStateDir, expectedRootIdentity, path, mode, effectiveSessionId);

            } else {
              await unlinkDurably(baseStateDir, expectedRootIdentity, path, 'session state clear target');

            }
            const nativeStopCleared = effectiveSessionId
              ? await clearSessionNativeStopState(baseStateDir, expectedRootIdentity, effectiveSessionId)
              : [];
            if (mode !== SKILL_ACTIVE_STATE_MODE) {
              await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state clear root');
              await syncCanonicalSkillStateForMode({
                cwd,
                baseStateDir,
                mode,
                active: false,
                sessionId: effectiveSessionId,
                source: 'state-operations',
                expectedRootIdentity,
              });
              await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical skill-state clear root');
              await finalizeCanonicalSkillStateDurability(baseStateDir, expectedRootIdentity, { sessionId: effectiveSessionId });
            }
            return { payload: { cleared: true, mode, path, ...(nativeStopCleared.length > 0 ? { native_stop_cleared: nativeStopCleared } : {}) } };
          }

          const removedPaths: string[] = [];
          for (const statePath of paths) {
            if (await unlinkDurably(baseStateDir, expectedRootIdentity, statePath, 'all-session state clear target')) {
              removedPaths.push(statePath);
              if (removedPaths.length === 1) {
                injectStateOperationFault('after_first_state_clear_effect');
              }
            }
          }
          if (mode !== SKILL_ACTIVE_STATE_MODE) {
            if (options.recoveryOperation) {
              await clearPersistedAllSessionSkillStateTargets(baseStateDir, expectedRootIdentity, targetInventory.skillStatePaths, mode);
            } else {
              await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical all-session skill-state clear root');
              await syncCanonicalSkillStateForMode({
                cwd,
                baseStateDir,
                mode,
                active: false,
                source: 'state-operations',
                allSessions: true,
                allSessionIds,
                expectedRootIdentity,
              });
              await assertExpectedStateRootIdentity(baseStateDir, expectedRootIdentity, 'canonical all-session skill-state clear root');
              await finalizeCanonicalSkillStateDurability(baseStateDir, expectedRootIdentity, { allSessions: true, sessionIds: allSessionIds });
            }
          }

          return {
            payload: {
              cleared: true,
              mode,
              all_sessions: true,
              removed: removedPaths.length,
              paths: removedPaths,
              warning: 'all_sessions clears global and session-scoped state files',
            },
          };
        }, { preparedAlreadyRecorded: options.recoveryOperation !== undefined });
      }

      case 'state_list_active': {
        const activeModes = await listActiveStateModes(scope);
        return { payload: { active_modes: activeModes } };
      }

      case 'state_get_status': {
        const mode = typeof rawArgs.mode === 'string' ? rawArgs.mode.trim() : undefined;
        const statuses = await listStateStatuses(scope, mode || undefined);
        return { payload: { statuses } };
      }
    }
    };
    const executeWithAuthorityTransaction = async (
      refreshedAuthority: ResolvedStateAuthorityContext,
      lock: AcquiredStateAuthorityLock,
    ): Promise<StateOperationResponse> => {
      const refreshedScope = await resolveAuthorityRuntimeStateScope(cwd, explicitSessionId);
      if (refreshedScope.authority.generation.generation_id !== refreshedAuthority.generation.generation_id) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
          'state authority changed while refreshing the operation transaction context',
        );
      }
      return execute({ ...refreshedScope, authority: refreshedAuthority }, lock);
    };
    if (options.authorityTransaction) {
      return await executeWithAuthorityTransaction(
        options.authorityTransaction.authority,
        options.authorityTransaction.lock,
      );
    }
    if (scope.authority && !options.skipPreparedOperationRecovery && (name === 'state_write' || name === 'state_clear')) {
      await awaitStateOperationTestBarrier('before_mutation_transaction');
      return await withStateAuthorityTransaction(scope.authority, async (refreshedAuthority, lock) => {
        await replayPreparedDurableStateOperationsUnderTransaction(refreshedAuthority, lock);
        return executeWithAuthorityTransaction(refreshedAuthority, lock);
      });
    }
    return scope.authority
      ? await withStateAuthorityTransaction(scope.authority, executeWithAuthorityTransaction)
      : await execute();
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }
}
