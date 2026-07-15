/**
 * Session Lifecycle Manager for oh-my-codex
 *
 * Tracks session start/end, detects stale sessions from crashed launches,
 * and provides structured logging for session events.
 */

import { constants, existsSync, readFileSync, readdirSync } from 'fs';
import { lstat, open, stat, unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  appendStateAuthorityEvidence,
  atomicWriteAuthorityFile,
  captureRootFilesystemIdentity,
  ensureAuthorityDirectory,
  initializeStateAuthority,
  stateAuthorityTransportCapabilityForChild,
  isObservedCwdCompatibleWithStateAuthority,
  readWorkspaceAuthorityAnchor,
  resolveOrdinaryStateRoot,
  resolveStateAuthorityForGuard,
  resolveWorkspaceIdentity,
  sameRootFilesystemIdentity,
  stateAuthorityFilesystemPrimitiveForPlatform,
  validateStateAuthorityTransportCapability,
  withStateAuthorityTransaction,
  type ResolvedStateAuthorityContext,
  type RootFilesystemIdentity,
  type SessionAliasSet,
} from '../state/authority.js';

export interface SessionState {
  session_id: string;
  native_session_id?: string;
  // Native session replacement metadata used when Codex /new swaps the native
  // session while the original OMX launch wrapper is still responsible for
  // archiving/cleanup.
  previous_native_session_id?: string;
  native_session_switched_at?: string;
  owner_omx_session_id?: string;
  owner_codex_session_id?: string;
  started_at: string;
  cwd: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
  tmux_session_name?: string;
  tmux_pane_id?: string;
}

const SESSION_FILE = 'session.json';
const HISTORY_FILE = 'session-history.jsonl';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function requireSessionId(value: unknown, label = 'sessionId'): string {
  const sessionId = normalizeSessionId(value);
  if (!sessionId) throw new Error(`${label} must match ^[A-Za-z0-9_-]{1,64}$`);
  return sessionId;
}

function validatePersistedSessionState(value: unknown, path: string): SessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      `session lifecycle state must be a JSON object and requires explicit recovery: ${path}`,
    );
  }
  const state = value as SessionState;
  const sessionId = normalizeSessionId(state.session_id);
  if (!sessionId) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      `session lifecycle state contains an invalid session_id and requires explicit recovery: ${path}`,
    );
  }
  const normalizeOptionalId = (field: 'native_session_id' | 'previous_native_session_id' | 'owner_omx_session_id' | 'owner_codex_session_id'): string | undefined => {
    const value = state[field];
    if (value === undefined) return undefined;
    const sessionId = normalizeSessionId(value);
    if (!sessionId) {
      sessionIoError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
        `session lifecycle state contains an invalid ${field} and requires explicit recovery: ${path}`,
      );
    }
    return sessionId;
  };
  const nativeSessionId = normalizeOptionalId('native_session_id');
  const previousNativeSessionId = normalizeOptionalId('previous_native_session_id');
  const ownerOmxSessionId = normalizeOptionalId('owner_omx_session_id');
  const ownerCodexSessionId = normalizeOptionalId('owner_codex_session_id');
  return {
    ...state,
    session_id: sessionId,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    ...(previousNativeSessionId ? { previous_native_session_id: previousNativeSessionId } : {}),
    ...(ownerOmxSessionId ? { owner_omx_session_id: ownerOmxSessionId } : {}),
    ...(ownerCodexSessionId ? { owner_codex_session_id: ownerCodexSessionId } : {}),
  };
}
// No age-based threshold: staleness is determined by PID liveness/identity.
// Long-running sessions (>2h) are legitimate and should not be reaped.

const SESSION_IO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

type SessionIoFileHandle = Awaited<ReturnType<typeof open>>;

interface OpenedSessionIoDirectory {
  /** Present only when Linux descriptor-relative mutation is available. */
  handle?: SessionIoFileHandle;
  /** Descriptor-relative on Linux; canonical path elsewhere. */
  operationPath: string;
  path: string;
  device: number;
  inode: number;
}

/**
 * Session lifecycle I/O follows the authoritative state-root platform model:
 * Linux uses descriptor-relative no-follow paths, while macOS and Windows
 * use canonical paths with identity revalidation.
 */
export const sessionLifecycleFilesystemPrimitiveForPlatform = stateAuthorityFilesystemPrimitiveForPlatform;

/** Windows requires open target handles to be closed before rename or unlink. */
export function sessionLifecycleFileHandleMustCloseBeforeEffect(
  effect: 'rename' | 'unlink',
  platform: NodeJS.Platform = process.platform,
): boolean {
  switch (effect) {
    case 'rename':
    case 'unlink':
      return platform === 'win32';
    default:
      return false;
  }
}

interface SessionIoScope {
  root: OpenedSessionIoDirectory;
  parent: OpenedSessionIoDirectory;
  rootPath: string;
  rootIdentity: RootFilesystemIdentity;
}

/** Test-only lifecycle-I/O fault boundaries. They are never persisted. */
export interface SessionFilesystemTestHooks {
  beforeCaptureParentOmxIdentity?: (omxRoot: string) => void | Promise<void>;
  beforeAtomicWriteRename?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  beforeDelete?: (targetPath: string) => void | Promise<void>;
}

let sessionFilesystemTestHooks: SessionFilesystemTestHooks | undefined;

export function setSessionFilesystemTestHooksForTests(hooks?: SessionFilesystemTestHooks): void {
  sessionFilesystemTestHooks = hooks;
}

function sessionIoError(code: typeof AUTHORITY_DIAGNOSTIC_CODES[keyof typeof AUTHORITY_DIAGNOSTIC_CODES], message: string): never {
  throw new StateAuthorityError(code, message);
}

function sameSessionIoStat(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSessionIoTargetWithinRoot(root: string, target: string): void {
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === ''
    || relativeTarget === '..'
    || relativeTarget.startsWith('../')
    || relativeTarget.startsWith('..\\')
    || isAbsolute(relativeTarget)
  ) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      `session lifecycle target escapes its committed authority root: ${target}`,
    );
  }
}

function noFollowSessionIoDirectoryFlags(): number {
  const flags = sessionLifecycleFilesystemPrimitiveForPlatform().directory_open_flags;
  if (flags === null) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
      'the Linux runtime does not expose no-follow directory opens for descriptor-relative session lifecycle I/O',
    );
  }
  return flags;
}

function noFollowSessionIoFileFlags(): number {
  const primitive = sessionLifecycleFilesystemPrimitiveForPlatform();
  if (primitive.file_open_flags !== null) return primitive.file_open_flags;
  if (primitive.descriptor_relative) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
      'the Linux runtime does not expose no-follow final-file opens for session lifecycle I/O',
    );
  }
  return 0;
}

async function descriptorRelativeSessionIoDirectoryPath(handle: SessionIoFileHandle): Promise<string | null> {
  if (!sessionLifecycleFilesystemPrimitiveForPlatform().descriptor_relative) return null;
  const held = await handle.stat();
  for (const candidate of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      const details = await stat(candidate);
      if (details.isDirectory() && sameSessionIoStat(details, held)) return candidate;
    } catch {
      // Try the next Linux descriptor namespace.
    }
  }
  return null;
}

async function openSessionIoDirectory(
  path: string,
  label: string,
  expected?: { dev: number; ino: number },
): Promise<OpenedSessionIoDirectory> {
  const primitive = sessionLifecycleFilesystemPrimitiveForPlatform();
  const initial = await lstat(path);
  if (initial.isSymbolicLink()) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!initial.isDirectory()) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a directory: ${path}`);
  }
  if (expected && !sameSessionIoStat(initial, expected)) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed before opening`);
  }
  if (!primitive.descriptor_relative) {
    const current = await lstat(path);
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameSessionIoStat(initial, current)
      || (expected !== undefined && !sameSessionIoStat(current, expected))
    ) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while opening`);
    }
    return {
      operationPath: path,
      path,
      device: current.dev,
      inode: current.ino,
    };
  }

  let handle: SessionIoFileHandle | undefined;
  try {
    handle = await open(path, noFollowSessionIoDirectoryFlags());
    const held = await handle.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameSessionIoStat(initial, held)
      || !sameSessionIoStat(current, held)
      || (expected !== undefined && !sameSessionIoStat(held, expected))
    ) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while opening`);
    }
    const operationPath = await descriptorRelativeSessionIoDirectoryPath(handle);
    if (!operationPath) {
      sessionIoError(
        AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
        'the Linux runtime cannot address an opened session lifecycle directory descriptor',
      );
    }
    return {
      handle,
      operationPath,
      path,
      device: held.dev,
      inode: held.ino,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function assertOpenedSessionIoDirectoryCurrent(
  directory: OpenedSessionIoDirectory,
  label: string,
): Promise<void> {
  const current = await lstat(directory.path);
  const expected = { dev: directory.device, ino: directory.inode };
  const held = directory.handle ? await directory.handle.stat() : undefined;
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameSessionIoStat(current, expected)
    || (held !== undefined && !sameSessionIoStat(held, expected))
  ) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} was replaced during session lifecycle I/O`);
  }
}

async function assertSessionIoScopeCurrent(scope: SessionIoScope): Promise<void> {
  await assertOpenedSessionIoDirectoryCurrent(scope.root, 'session lifecycle authority root');
  const actualRootIdentity = await captureRootFilesystemIdentity(scope.rootPath);
  if (!sameRootFilesystemIdentity(scope.rootIdentity, actualRootIdentity)) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'session lifecycle authority root fingerprint changed');
  }
  if (scope.parent !== scope.root) {
    await assertOpenedSessionIoDirectoryCurrent(scope.parent, 'session lifecycle parent directory');
  }
}

async function openSessionIoScope(
  root: string,
  expectedRootIdentity: RootFilesystemIdentity,
  target: string,
  ensureParent: boolean,
): Promise<SessionIoScope> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  assertSessionIoTargetWithinRoot(rootPath, targetPath);
  const parentPath = dirname(targetPath);
  if (ensureParent) await ensureAuthorityDirectory(rootPath, parentPath);
  const actualRootIdentity = await captureRootFilesystemIdentity(rootPath);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'session lifecycle authority root does not match its committed filesystem identity');
  }

  let openedRoot: OpenedSessionIoDirectory | undefined;
  let current: OpenedSessionIoDirectory | undefined;
  try {
    openedRoot = await openSessionIoDirectory(rootPath, 'session lifecycle authority root', {
      dev: Number(expectedRootIdentity.device),
      ino: Number(expectedRootIdentity.inode),
    });
    current = openedRoot;
    const relativeParent = relative(rootPath, parentPath);
    const segments = relativeParent === '' ? [] : relativeParent.split(/[\\/]+/);
    let canonicalCurrentPath = rootPath;
    for (const segment of segments) {
      if (!SESSION_IO_SEGMENT_PATTERN.test(segment)) {
        sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `unsafe session lifecycle parent segment: ${segment}`);
      }
      const childPath = join(current.operationPath, segment);
      canonicalCurrentPath = join(canonicalCurrentPath, segment);
      const child = await openSessionIoDirectory(childPath, 'session lifecycle parent directory');
      child.path = canonicalCurrentPath;
      if (current !== openedRoot) await current.handle?.close();
      current = child;
    }
    const scope = {
      root: openedRoot,
      parent: current,
      rootPath,
      rootIdentity: expectedRootIdentity,
    };
    await assertSessionIoScopeCurrent(scope);
    return scope;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await current?.handle?.close();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (openedRoot && openedRoot !== current) {
      try {
        await openedRoot.handle?.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'session lifecycle scope setup failed and cleanup was incomplete');
    }
    throw error;
  }
}

async function closeSessionIoScope(scope: SessionIoScope): Promise<void> {
  const cleanupFailures: unknown[] = [];
  if (scope.parent !== scope.root) {
    try {
      await scope.parent.handle?.close();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
  }
  try {
    await scope.root.handle?.close();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'session lifecycle scope cleanup was incomplete');
  }
}

async function closeSessionIoResources(
  scope: SessionIoScope,
  handle: SessionIoFileHandle | undefined,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try {
    await handle?.close();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  try {
    await closeSessionIoScope(scope);
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'session lifecycle file cleanup was incomplete');
  }
}

async function readSessionIoFile(
  root: string,
  expectedRootIdentity: RootFilesystemIdentity,
  target: string,
): Promise<string | null> {
  const scope = await openSessionIoScope(root, expectedRootIdentity, target, true);
  const targetPath = join(scope.parent.operationPath, basename(target));
  let handle: SessionIoFileHandle | undefined;
  try {
    await assertSessionIoScopeCurrent(scope);
    let initial: Awaited<ReturnType<typeof lstat>>;
    try {
      initial = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (initial.isSymbolicLink()) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `session lifecycle file must not be a symbolic link: ${target}`);
    }
    if (!initial.isFile()) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `session lifecycle file must be regular: ${target}`);
    }
    try {
      handle = await open(targetPath, constants.O_RDONLY | noFollowSessionIoFileFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `session lifecycle file must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const held = await handle.stat();
    const afterOpen = await lstat(targetPath);
    if (
      afterOpen.isSymbolicLink()
      || !afterOpen.isFile()
      || !sameSessionIoStat(initial, held)
      || !sameSessionIoStat(afterOpen, held)
    ) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `session lifecycle file changed while opening: ${target}`);
    }
    await assertSessionIoScopeCurrent(scope);
    const content = await handle.readFile('utf-8');
    const afterRead = await lstat(targetPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameSessionIoStat(afterRead, held)) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `session lifecycle file changed while reading: ${target}`);
    }
    await assertSessionIoScopeCurrent(scope);
    return content;
  } finally {
    await closeSessionIoResources(scope, handle);
  }
}

async function writeSessionIoFile(
  root: string,
  expectedRootIdentity: RootFilesystemIdentity,
  target: string,
  content: string,
): Promise<void> {
  const scope = await openSessionIoScope(root, expectedRootIdentity, target, true);
  await closeSessionIoScope(scope);
  await atomicWriteAuthorityFile(target, content, {
    authority_root: root,
    expected_root_identity: expectedRootIdentity,
    test_only_before_rename: async (temporaryPath) => {
      await sessionFilesystemTestHooks?.beforeAtomicWriteRename?.(target, temporaryPath);
    },
  });
}

async function appendSessionIoFile(
  root: string,
  expectedRootIdentity: RootFilesystemIdentity,
  target: string,
  content: string,
): Promise<void> {
  const existing = await readSessionIoFile(root, expectedRootIdentity, target);
  await writeSessionIoFile(root, expectedRootIdentity, target, `${existing ?? ''}${content}`);
}

async function deleteSessionIoFile(
  root: string,
  expectedRootIdentity: RootFilesystemIdentity,
  target: string,
): Promise<boolean> {
  const actualRootIdentity = await captureRootFilesystemIdentity(resolve(root));
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'session lifecycle authority root does not match its committed filesystem identity');
  }
  let scope: SessionIoScope;
  try {
    scope = await openSessionIoScope(root, expectedRootIdentity, target, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const targetPath = join(scope.parent.operationPath, basename(target));
  let handle: SessionIoFileHandle | undefined;
  try {
    await assertSessionIoScopeCurrent(scope);
    let initial: Awaited<ReturnType<typeof lstat>>;
    try {
      initial = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (initial.isSymbolicLink()) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `session lifecycle delete target must not be a symbolic link: ${target}`);
    }
    if (!initial.isFile()) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `session lifecycle delete target must be regular: ${target}`);
    }
    try {
      handle = await open(targetPath, constants.O_RDONLY | noFollowSessionIoFileFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `session lifecycle delete target must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const held = await handle.stat();
    const afterOpen = await lstat(targetPath);
    if (
      afterOpen.isSymbolicLink()
      || !afterOpen.isFile()
      || !sameSessionIoStat(initial, held)
      || !sameSessionIoStat(afterOpen, held)
    ) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `session lifecycle delete target changed while opening: ${target}`);
    }
    await assertSessionIoScopeCurrent(scope);
    if (sessionLifecycleFileHandleMustCloseBeforeEffect('unlink')) {
      await handle.close();
      handle = undefined;
    }
    await sessionFilesystemTestHooks?.beforeDelete?.(target);
    await assertSessionIoScopeCurrent(scope);
    const beforeDelete = await lstat(targetPath);
    if (
      beforeDelete.isSymbolicLink()
      || !beforeDelete.isFile()
      || !sameSessionIoStat(beforeDelete, held)
    ) {
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `session lifecycle delete target changed before deletion: ${target}`);
    }
    await assertSessionIoScopeCurrent(scope);
    await unlink(targetPath);
    try {
      await lstat(targetPath);
      sessionIoError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `session lifecycle delete target was recreated during deletion: ${target}`);
    } catch (error) {
      if (error instanceof StateAuthorityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await scope.parent.handle?.sync();
    await assertSessionIoScopeCurrent(scope);
    return true;
  } finally {
    await closeSessionIoResources(scope, handle);
  }
}

function inheritedAuthorityTransport(env: NodeJS.ProcessEnv): {
  authorityPath: string;
  authorityId: string;
  generationId: string;
  workspaceDigest: string;
  capability: string;
  present: boolean;
} {
  const authorityPath = env.OMX_STATE_AUTHORITY_PATH?.trim() ?? '';
  const authorityId = env.OMX_STATE_AUTHORITY_ID?.trim() ?? '';
  const generationId = env.OMX_STATE_AUTHORITY_GENERATION_ID?.trim() ?? '';
  const workspaceDigest = env.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST?.trim() ?? '';
  const capability = env.OMX_STATE_AUTHORITY_CAPABILITY?.trim() ?? '';
  return {
    authorityPath,
    authorityId,
    generationId,
    workspaceDigest,
    capability,
    present: Boolean(authorityPath || authorityId || generationId || workspaceDigest || capability),
  };
}

function deriveWorkspaceFromAuthorityLocator(locator: string): string | null {
  const authorityPath = resolve(locator);
  if (basename(authorityPath) !== 'state-authority.json') return null;
  const generationDirectory = dirname(authorityPath);
  const generationsDirectory = dirname(generationDirectory);
  const authorityDirectory = dirname(generationsDirectory);
  const stateRoot = dirname(authorityDirectory);
  const omxRoot = dirname(stateRoot);
  if (
    basename(generationsDirectory) !== 'generations'
    || basename(authorityDirectory) !== 'authority'
    || basename(stateRoot) !== 'state'
    || basename(omxRoot) !== '.omx'
  ) return null;
  return dirname(omxRoot);
}

function inheritedAuthoritySessionId(env: NodeJS.ProcessEnv): string | undefined {
  const sessionId = env.OMX_SESSION_ID?.trim() || env.CODEX_SESSION_ID?.trim();
  return sessionId ? requireSessionId(sessionId, 'inherited session ID') : undefined;
}

async function assertActiveAuthorityTransport(
  authority: ResolvedStateAuthorityContext,
  transport: ReturnType<typeof inheritedAuthorityTransport>,
): Promise<void> {
  const binding = authority.session_binding;
  const anchor = await readWorkspaceAuthorityAnchor(authority.workspace_identity);
  const expectedBindingPath = binding
    ? join(
      authority.canonical_state_root,
      'authority',
      'generations',
      authority.generation.generation_id,
      'bindings',
      `${binding.binding_id}.json`,
    )
    : '';
  if (
    !anchor
    || !binding
    || binding.lifecycle !== 'active'
    || resolve(transport.authorityPath) !== resolve(authority.authority_path)
    || authority.generation.authority_id !== transport.authorityId
    || authority.generation.generation_id !== transport.generationId
    || authority.workspace_identity.digest !== transport.workspaceDigest
    || anchor.active_generation_id !== authority.generation.generation_id
    || !anchor.active_generation_locator
    || resolve(anchor.active_generation_locator) !== resolve(authority.authority_path)
    || !anchor.active_binding_locator
    || resolve(anchor.active_binding_locator) !== resolve(expectedBindingPath)
    || !anchor.active_lease
    || anchor.active_lease.generation_id !== authority.generation.generation_id
    || anchor.active_lease.binding_id !== binding.binding_id
    || anchor.active_lease.fencing_token !== anchor.fencing_token
    || authority.generation.creation_fence > anchor.fencing_token
    || binding.authority_id !== authority.generation.authority_id
    || binding.generation_id !== authority.generation.generation_id
    || binding.creation_fence !== authority.generation.creation_fence
  ) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      'inherited state-authority transport does not match the active anchor, generation, binding, fence, and filesystem-validated authority context',
    );
  }
}

/**
 * Resolves only a complete inherited authority transport against the currently
 * active workspace anchor. A locator is evidence, not a root selector: any
 * incomplete, stale, or unauthenticated locator is fatal to the caller.
 */
export async function resolveAuthenticatedTransportAuthority(
  observedCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedStateAuthorityContext | null> {
  const transport = inheritedAuthorityTransport(env);
  if (!transport.present) return null;
  if (!transport.authorityPath || !transport.authorityId || !transport.generationId || !transport.workspaceDigest || !transport.capability) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
      'inherited state-authority transport is incomplete',
    );
  }
  // A locator is not an authority selector. It is used only to find the
  // persisted anchor whose opaque bearer is validated below.
  const startupCwd = env.OMX_STARTUP_CWD?.trim() || deriveWorkspaceFromAuthorityLocator(transport.authorityPath);
  if (!startupCwd) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      'inherited state-authority locator does not identify a workspace root',
    );
  }
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: startupCwd,
    observed_cwd: observedCwd,
    session_id: inheritedAuthoritySessionId(env),
  });
  await assertActiveAuthorityTransport(authority, transport);
  await validateStateAuthorityTransportCapability(authority, transport.capability);
  if (!isObservedCwdCompatibleWithStateAuthority(authority, observedCwd)) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.observedCwdOutsideWorkspace,
      'inherited state-authority transport cannot be used from an unrelated workspace cwd',
    );
  }
  return authority;
}

/**
 * A transported startup workspace is usable only after the inherited locator
 * authenticates the active anchor. An unverified persisted startup workspace
 * must agree with the observed workspace; otherwise callers must restart or
 * rebind with a complete authenticated authority transport.
 */
export async function resolveAuthenticatedStateAuthorityStartupCwd(
  observedCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const authority = await resolveAuthenticatedTransportAuthority(observedCwd, env);
  if (authority) return authority.workspace_identity.canonical_path;
  const startupCwd = env.OMX_STARTUP_CWD?.trim();
  if (!startupCwd) return observedCwd;

  let startupWorkspace: ReturnType<typeof resolveWorkspaceIdentity>;
  let observedWorkspace: ReturnType<typeof resolveWorkspaceIdentity>;
  try {
    startupWorkspace = resolveWorkspaceIdentity(startupCwd);
    observedWorkspace = resolveWorkspaceIdentity(observedCwd);
  } catch {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
      `persisted startup authority cannot be reconciled with the observed workspace: startup_candidate_root=${resolve(startupCwd, '.omx', 'state')} observed_candidate_root=${resolve(observedCwd, '.omx', 'state')}; restart from the intended workspace or rebind with a complete authenticated state-authority transport`,
    );
  }
  if (startupWorkspace.digest !== observedWorkspace.digest) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
      `persisted startup authority conflicts with the observed workspace: startup_candidate_root=${resolveOrdinaryStateRoot(startupWorkspace)} observed_candidate_root=${resolveOrdinaryStateRoot(observedWorkspace)}; restart from the intended workspace or rebind with a complete authenticated state-authority transport`,
    );
  }
  return startupWorkspace.canonical_path;
}

async function stateAuthorityStartupCwd(observedCwd: string): Promise<string> {
  return resolveAuthenticatedStateAuthorityStartupCwd(observedCwd);
}

async function resolveSessionAuthorityForGuard(cwd: string): Promise<ResolvedStateAuthorityContext> {
  const transported = await resolveAuthenticatedTransportAuthority(cwd);
  if (transported) return transported;
  return resolveStateAuthorityForGuard({
    startup_cwd: await stateAuthorityStartupCwd(cwd),
    observed_cwd: cwd,
  });
}

function sessionPath(stateDir: string): string {
  return join(stateDir, SESSION_FILE);
}

function historyPath(omxRoot: string): string {
  return join(omxRoot, 'logs', HISTORY_FILE);
}

async function hasLegacyStateArtifacts(cwd: string): Promise<boolean> {
  const stateRoot = resolveOrdinaryStateRoot(resolveWorkspaceIdentity(await stateAuthorityStartupCwd(cwd)));
  if (!existsSync(stateRoot)) return false;
  try {
    return readdirSync(stateRoot).length > 0;
  } catch {
    return true;
  }
}

async function resolveExistingSessionAuthority(cwd: string): Promise<ResolvedStateAuthorityContext | null> {
  try {
    return await resolveSessionAuthorityForGuard(cwd);
  } catch (error) {
    if (
      error instanceof StateAuthorityError
      && error.code === AUTHORITY_DIAGNOSTIC_CODES.anchorMissing
      && !await hasLegacyStateArtifacts(cwd)
    ) {
      return null;
    }
    throw error;
  }
}

function sessionAliases(
  options: Pick<SessionStartOptions, 'nativeSessionId' | 'previousNativeSessionId' | 'ownerOmxSessionId'>,
): Partial<SessionAliasSet> {
  const native = options.nativeSessionId === undefined
    ? undefined
    : requireSessionId(options.nativeSessionId, 'nativeSessionId');
  const previous = options.previousNativeSessionId === undefined
    ? undefined
    : requireSessionId(options.previousNativeSessionId, 'previousNativeSessionId');
  const owner = options.ownerOmxSessionId === undefined
    ? undefined
    : requireSessionId(options.ownerOmxSessionId, 'ownerOmxSessionId');
  return {
    ...(native ? { native_session_id: native, current_session_aliases: [native] } : {}),
    ...(previous ? { previous_session_aliases: [previous] } : {}),
    ...(owner ? { owner_session_aliases: [owner] } : {}),
  };
}
function sessionIdMatchesAuthority(state: SessionState, authority: ResolvedStateAuthorityContext): boolean {
  const binding = authority.session_binding;
  if (!binding) return false;
  const accepted = new Set([
    binding.canonical_session_id,
    binding.aliases.native_session_id,
    ...binding.aliases.current_session_aliases,
    ...binding.aliases.previous_session_aliases,
    ...binding.aliases.owner_session_aliases,
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== ''));
  return accepted.has(state.session_id)
    || (typeof state.native_session_id === 'string' && accepted.has(state.native_session_id))
    || (typeof state.owner_omx_session_id === 'string' && accepted.has(state.owner_omx_session_id));
}


async function readSessionStateAt(
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<SessionState | null> {
  const path = sessionPath(stateDir);
  const content = await readSessionIoFile(stateDir, rootIdentity, path);
  if (content === null) return null;
  try {
    return validatePersistedSessionState(JSON.parse(content), path);
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
      `session lifecycle state is malformed and requires explicit recovery: ${path}`,
    );
  }
}

async function assertCommittedSessionStateRoot(
  stateDir: string,
  expectedRootIdentity: RootFilesystemIdentity,
): Promise<void> {
  const actualRootIdentity = await captureRootFilesystemIdentity(stateDir);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'session lifecycle state root does not match its committed filesystem identity',
    );
  }
}

/**
 * The OMX parent is not persisted authority. Pin it only while the committed
 * state child remains in place on both sides of the parent identity capture.
 */
async function capturePinnedParentOmxRootIdentity(
  context: Pick<ResolvedStateAuthorityContext, 'canonical_state_root' | 'generation'>,
): Promise<RootFilesystemIdentity> {
  await assertCommittedSessionStateRoot(context.canonical_state_root, context.generation.root_identity);
  await sessionFilesystemTestHooks?.beforeCaptureParentOmxIdentity?.(context.generation.canonical_omx_root);
  const omxRootIdentity = await captureRootFilesystemIdentity(context.generation.canonical_omx_root);
  await assertCommittedSessionStateRoot(context.canonical_state_root, context.generation.root_identity);
  return omxRootIdentity;
}

async function appendToLogAt(
  omxRoot: string,
  omxRootIdentity: RootFilesystemIdentity,
  entry: Record<string, unknown>,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(omxRoot, 'logs', `omx-${date}.jsonl`);
  const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() }) + '\n';
  await appendSessionIoFile(omxRoot, omxRootIdentity, logFile, line);
}

async function removeDeadSessionHudState(
  baseStateDir: string,
  rootIdentity: RootFilesystemIdentity,
  sessionIds: Array<string | undefined>,
  removeRootHudState: boolean,
): Promise<void> {
  const uniqueSessionIds = [...new Set(
    sessionIds
      .filter((value): value is string => value !== undefined)
      .map((value) => requireSessionId(value, 'session cleanup ID')),
  )];
  const candidatePaths = [
    ...(removeRootHudState ? [join(baseStateDir, 'hud-state.json')] : []),
    ...uniqueSessionIds.map((sessionId) => join(baseStateDir, 'sessions', sessionId, 'hud-state.json')),
  ];
  await Promise.all(candidatePaths.map(async (path) => {
    await deleteSessionIoFile(baseStateDir, rootIdentity, path);
  }));
}
async function initializeSessionAuthority(
  cwd: string,
  requestedSessionId: string,
  aliases?: Partial<SessionAliasSet>,
): Promise<ResolvedStateAuthorityContext> {
  const canonicalSessionId = requireSessionId(requestedSessionId);
  let existing: ResolvedStateAuthorityContext | null = null;
  try {
    existing = await resolveExistingSessionAuthority(cwd);
  } catch (error) {
    if (!(error instanceof StateAuthorityError) || error.code !== AUTHORITY_DIAGNOSTIC_CODES.anchorMissing) {
      throw error;
    }
  }
  const requestedOwnerAliases = aliases?.owner_session_aliases ?? [];
  const hasOwnerContinuity = existing !== null && requestedOwnerAliases.some((alias) =>
    alias === existing.session_binding?.canonical_session_id
    || existing.session_binding?.aliases.owner_session_aliases.includes(alias),
  );
  const effectiveAliases = existing && aliases ? {
    ...aliases,
    previous_session_aliases: [...new Set([
      ...(hasOwnerContinuity ? [existing.session_binding?.aliases.native_session_id] : []),
      ...(aliases.previous_session_aliases ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.trim() !== ''))],
  } : aliases;
  const authority = await initializeStateAuthority({
    startup_cwd: existing?.workspace_identity.canonical_path ?? cwd,
    observed_cwd: cwd,
    launch_id: `session-${canonicalSessionId}`,
    session_binding: {
      canonical_session_id: canonicalSessionId,
      ...(effectiveAliases ? { aliases: effectiveAliases } : {}),
    },
  });
  return authority;
}

function hasCompleteProcessAuthorityTransport(): boolean {
  return [
    'OMX_STATE_AUTHORITY_PATH',
    'OMX_STATE_AUTHORITY_ID',
    'OMX_STATE_AUTHORITY_GENERATION_ID',
    'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
    'OMX_STATE_AUTHORITY_CAPABILITY',
    'OMX_STARTUP_CWD',
  ].every((key) => Boolean(process.env[key]?.trim()));
}

async function withSessionAuthorityTransaction<T>(
  authority: ResolvedStateAuthorityContext,
  callback: (context: ResolvedStateAuthorityContext) => Promise<T>,
): Promise<T> {
  const refreshProcessTransport = hasCompleteProcessAuthorityTransport();
  const result = await withStateAuthorityTransaction(authority, callback);
  if (refreshProcessTransport) {
    process.env.OMX_STATE_AUTHORITY_CAPABILITY = stateAuthorityTransportCapabilityForChild(authority);
  }
  return result;
}

/**
 * Reset session-scoped HUD/metrics files at launch so stale values do not leak
 * into a new Codex session.
 */
export async function resetSessionMetrics(cwd: string, sessionId?: string): Promise<void> {
  const requestedSessionId = sessionId === undefined
    ? undefined
    : requireSessionId(sessionId);
  const canonicalSessionId = requestedSessionId ?? 'session-metrics';
  const authority = await initializeSessionAuthority(cwd, canonicalSessionId);
  await withSessionAuthorityTransaction(authority, async (context) => {
    const omxDir = context.generation.canonical_omx_root;
    const stateDir = context.canonical_state_root;
    const omxRootIdentity = await capturePinnedParentOmxRootIdentity(context);
    const now = new Date().toISOString();
    await writeSessionIoFile(omxDir, omxRootIdentity, join(omxDir, 'metrics.json'), JSON.stringify({
      total_turns: 0,
      session_turns: 0,
      last_activity: now,
      session_input_tokens: 0,
      session_output_tokens: 0,
      session_total_tokens: 0,
      five_hour_limit_pct: 0,
      weekly_limit_pct: 0,
    }, null, 2));

    const hudStatePath = requestedSessionId
      ? join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json')
      : join(stateDir, 'hud-state.json');
    await writeSessionIoFile(stateDir, context.generation.root_identity, hudStatePath, JSON.stringify({
      last_turn_at: now,
      last_progress_at: now,
      turn_count: 0,
      last_agent_output: '',
    }, null, 2));
  });
}

/**
 * Read current session state. Returns null if no authority or session file exists.
 */
export async function readCommittedSessionState(authority: ResolvedStateAuthorityContext): Promise<SessionState | null> {
  const state = await readSessionStateAt(authority.canonical_state_root, authority.generation.root_identity);
  if (!state) return null;
  if (!sessionIdMatchesAuthority(state, authority)) {
    sessionIoError(
      AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
      'session lifecycle state does not match the committed authority binding and requires explicit recovery',
    );
  }
  return state;
}

export async function readSessionState(cwd: string): Promise<SessionState | null> {
  const authority = await resolveExistingSessionAuthority(cwd);
  if (!authority) return null;
  return readCommittedSessionState(authority);
}

export function isSessionStateAuthoritativeForCwd(state: SessionState, _cwd: string): boolean {
  return SESSION_ID_PATTERN.test(state.session_id);
}

export function isSessionStateUsable(
  state: SessionState,
  cwd: string,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!isSessionStateAuthoritativeForCwd(state, cwd)) return false;

  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasLinuxIdentityMetadata = typeof state.pid_start_ticks === 'number'
    || typeof state.pid_cmdline === 'string';
  if (hasPidMetadata || hasLinuxIdentityMetadata) {
    return !isSessionStale(state, options);
  }

  return true;
}

export async function readUsableSessionState(
  cwd: string,
  options: SessionStaleCheckOptions = {},
): Promise<SessionState | null> {
  const state = await readSessionState(cwd);
  if (!state) return null;
  return isSessionStateUsable(state, cwd, options) ? state : null;
}

interface LinuxProcessIdentity {
  startTicks: number;
  cmdline: string | null;
}

interface SessionStaleCheckOptions {
  platform?: NodeJS.Platform;
  isPidAlive?: (pid: number) => boolean | undefined;
  readLinuxIdentity?: (pid: number) => LinuxProcessIdentity | null;
}

interface SessionStartOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  nativeSessionId?: string;
  previousNativeSessionId?: string;
  nativeSessionSwitchedAt?: string;
  ownerOmxSessionId?: string;
  tmuxSessionName?: string;
  tmuxPaneId?: string;
}

function defaultIsPidAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
  }
}

function parseLinuxProcStartTicks(statContent: string): number | null {
  const commandEnd = statContent.lastIndexOf(')');
  if (commandEnd === -1) return null;

  const remainder = statContent.slice(commandEnd + 1).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length <= 19) return null;

  const startTicks = Number(fields[19]);
  return Number.isFinite(startTicks) ? startTicks : null;
}

function normalizeCmdline(cmdline: string | null | undefined): string | null {
  if (!cmdline) return null;
  const normalized = cmdline.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const startTicks = parseLinuxProcStartTicks(stat);
    if (startTicks == null) return null;

    let cmdline: string | null = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
        .replace(/\u0000+/g, ' ')
        .trim();
    } catch {
      cmdline = null;
    }

    return {
      startTicks,
      cmdline: normalizeCmdline(cmdline),
    };
  } catch {
    return null;
  }
}

function createSessionState(
  cwd: string,
  sessionId: string,
  pid: number,
  platform: NodeJS.Platform,
  linuxIdentity: LinuxProcessIdentity | null,
  options: {
    nowIso?: string;
    nativeSessionId?: string;
    previousNativeSessionId?: string;
    nativeSessionSwitchedAt?: string;
    ownerOmxSessionId?: string;
    startedAt?: string;
    tmuxSessionName?: string;
    tmuxPaneId?: string;
  } = {},
): SessionState {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nativeSessionId = typeof options.nativeSessionId === 'string' && options.nativeSessionId.trim()
    ? options.nativeSessionId.trim()
    : undefined;
  const tmuxSessionName = typeof options.tmuxSessionName === 'string' && options.tmuxSessionName.trim()
    ? options.tmuxSessionName.trim()
    : undefined;
  const tmuxPaneId = typeof options.tmuxPaneId === 'string' && options.tmuxPaneId.trim()
    ? options.tmuxPaneId.trim()
    : undefined;
  const previousNativeSessionId =
    typeof options.previousNativeSessionId === 'string' && options.previousNativeSessionId.trim()
      ? options.previousNativeSessionId.trim()
      : undefined;
  const nativeSessionSwitchedAt =
    typeof options.nativeSessionSwitchedAt === 'string' && options.nativeSessionSwitchedAt.trim()
      ? options.nativeSessionSwitchedAt.trim()
      : undefined;
  const ownerOmxSessionId =
    typeof options.ownerOmxSessionId === 'string' && options.ownerOmxSessionId.trim()
      ? options.ownerOmxSessionId.trim()
      : undefined;

  return {
    session_id: sessionId,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    ...(previousNativeSessionId ? { previous_native_session_id: previousNativeSessionId } : {}),
    ...(nativeSessionSwitchedAt ? { native_session_switched_at: nativeSessionSwitchedAt } : {}),
    ...(ownerOmxSessionId ? { owner_omx_session_id: ownerOmxSessionId } : {}),
    started_at: options.startedAt ?? nowIso,
    cwd,
    pid,
    platform,
    pid_start_ticks: linuxIdentity?.startTicks,
    pid_cmdline: linuxIdentity?.cmdline ?? undefined,
    ...(tmuxSessionName ? { tmux_session_name: tmuxSessionName } : {}),
    ...(tmuxPaneId ? { tmux_pane_id: tmuxPaneId } : {}),
  };
}

/**
 * Check if a session is stale.
 * - If the owning PID is dead, it is stale.
 * - On Linux, require process identity validation (start ticks, optional cmdline).
 *   If identity cannot be validated, treat the session as stale.
 */
export function isSessionStale(
  state: SessionState,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0) return true;

  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pidAlive = isPidAlive(state.pid);
  if (pidAlive === false) return true;
  if (pidAlive === undefined) return false;

  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;

  const readIdentity = options.readLinuxIdentity ?? readLinuxProcessIdentity;
  const liveIdentity = readIdentity(state.pid);
  if (!liveIdentity) return true;

  if (typeof state.pid_start_ticks !== 'number') return true;
  if (state.pid_start_ticks !== liveIdentity.startTicks) return true;

  const expectedCmdline = normalizeCmdline(state.pid_cmdline);
  if (expectedCmdline) {
    const liveCmdline = normalizeCmdline(liveIdentity.cmdline);
    if (!liveCmdline || liveCmdline !== expectedCmdline) return true;
  }

  return false;
}

/**
 * Write session start state after the workspace authority is committed and
 * validated. The recorded cwd is diagnostic metadata; it never selects roots.
 */
export async function writeSessionStart(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const canonicalSessionId = requireSessionId(sessionId);
  const authority = await initializeSessionAuthority(cwd, canonicalSessionId, sessionAliases(options));

  return await withSessionAuthorityTransaction(authority, async (context) => {
    const stateDir = context.canonical_state_root;
    const existing = await readSessionStateAt(stateDir, context.generation.root_identity);
    const sameSession = existing?.session_id === canonicalSessionId;
    const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
      ? options.pid
      : process.pid;
    const platform = options.platform ?? process.platform;
    const linuxIdentity = platform === 'linux'
      ? readLinuxProcessIdentity(pid)
      : null;
    const state = createSessionState(cwd, canonicalSessionId, pid, platform, linuxIdentity, {
      nativeSessionId: options.nativeSessionId ?? (sameSession ? existing?.native_session_id : undefined),
      previousNativeSessionId: options.previousNativeSessionId ?? (sameSession ? existing?.previous_native_session_id : undefined),
      nativeSessionSwitchedAt: options.nativeSessionSwitchedAt ?? (sameSession ? existing?.native_session_switched_at : undefined),
      ownerOmxSessionId: options.ownerOmxSessionId ?? (sameSession ? existing?.owner_omx_session_id : undefined),
      tmuxSessionName: options.tmuxSessionName ?? (sameSession ? existing?.tmux_session_name : undefined),
      tmuxPaneId: options.tmuxPaneId ?? (sameSession ? existing?.tmux_pane_id : undefined),
    });

    await writeSessionIoFile(
      stateDir,
      context.generation.root_identity,
      sessionPath(stateDir),
      JSON.stringify(state, null, 2),
    );
    const omxRootIdentity = await capturePinnedParentOmxRootIdentity(context);
    await appendToLogAt(context.generation.canonical_omx_root, omxRootIdentity, {
      event: 'session_start',
      session_id: canonicalSessionId,
      ...(state.native_session_id ? { native_session_id: state.native_session_id } : {}),
      pid,
      timestamp: state.started_at,
    });
    return state;
  });
}

function getOmxLaunchSessionId(state: SessionState): string | undefined {
  if (state.session_id.startsWith('omx-')) return state.session_id;
  if (typeof state.owner_omx_session_id === 'string' && state.owner_omx_session_id.startsWith('omx-')) {
    return state.owner_omx_session_id;
  }
  return undefined;
}

/**
 * Reconcile a native/Codex SessionStart with the canonical OMX launch session.
 * Same-native restarts preserve the current logical session and refresh
 * PID/native metadata. Native-session replacements start a fresh native-scoped
 * session to avoid inheriting stale task-scoped state; when the replaced session
 * belongs to an OMX launch wrapper, retain that wrapper as owner for later
 * archive/cleanup and log the replacement chain.
 */
export async function reconcileNativeSessionStart(
  cwd: string,
  nativeSessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const canonicalNativeSessionId = requireSessionId(nativeSessionId, 'nativeSessionId');
  const existing = await readUsableSessionState(cwd, {
    ...(options.platform ? { platform: options.platform } : {}),
  });
  if (!existing) {
    const previousAuthoritySessionId = (await resolveExistingSessionAuthority(cwd))?.session_binding?.canonical_session_id;
    return await writeSessionStart(cwd, previousAuthoritySessionId ?? canonicalNativeSessionId, {
      ...options,
      nativeSessionId: canonicalNativeSessionId,
      ...(previousAuthoritySessionId ? { ownerOmxSessionId: previousAuthoritySessionId } : {}),
    });
  }

  const existingNativeSessionId = existing.native_session_id ?? '';
  if (existingNativeSessionId && existingNativeSessionId !== canonicalNativeSessionId) {
    const ownerOmxSessionId = getOmxLaunchSessionId(existing);
    if (ownerOmxSessionId) {
      const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
        ? options.pid
        : process.pid;
      const nowIso = new Date().toISOString();
      await appendToLog(cwd, {
        event: 'native_session_replaced',
        session_id: ownerOmxSessionId,
        ...(existing.session_id !== ownerOmxSessionId ? { active_session_id: existing.session_id } : {}),
        previous_native_session_id: existingNativeSessionId,
        replaced_by_native_session_id: canonicalNativeSessionId,
        pid,
        timestamp: nowIso,
      });

      return await writeSessionStart(cwd, canonicalNativeSessionId, {
        ...options,
        nativeSessionId: canonicalNativeSessionId,
        previousNativeSessionId: existingNativeSessionId,
        nativeSessionSwitchedAt: nowIso,
        ownerOmxSessionId,
      });
    }

    return await writeSessionStart(cwd, canonicalNativeSessionId, {
      ...options,
      nativeSessionId: canonicalNativeSessionId,
    });
  }

  const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
    ? options.pid
    : process.pid;
  const platform = options.platform ?? process.platform;
  const linuxIdentity = platform === 'linux'
    ? readLinuxProcessIdentity(pid)
    : null;
  const nowIso = new Date().toISOString();
  const authority = await initializeSessionAuthority(
    cwd,
    existing.session_id,
    sessionAliases({
      nativeSessionId: canonicalNativeSessionId,
      previousNativeSessionId: options.previousNativeSessionId ?? existing.previous_native_session_id,
      ownerOmxSessionId: options.ownerOmxSessionId ?? existing.owner_omx_session_id,
    }),
  );
  return await withSessionAuthorityTransaction(authority, async (context) => {
    const state = createSessionState(cwd, existing.session_id, pid, platform, linuxIdentity, {
      nowIso,
      nativeSessionId: canonicalNativeSessionId,
      previousNativeSessionId: existing.previous_native_session_id,
      nativeSessionSwitchedAt: existing.native_session_switched_at,
      ownerOmxSessionId: options.ownerOmxSessionId ?? existing.owner_omx_session_id,
      startedAt: existing.started_at,
      tmuxSessionName: existing.tmux_session_name,
      tmuxPaneId: existing.tmux_pane_id,
    });
    await writeSessionIoFile(
      context.canonical_state_root,
      context.generation.root_identity,
      sessionPath(context.canonical_state_root),
      JSON.stringify(state, null, 2),
    );
    const omxRootIdentity = await capturePinnedParentOmxRootIdentity(context);
    await appendToLogAt(context.generation.canonical_omx_root, omxRootIdentity, {
      event: 'session_start_reconciled',
      session_id: state.session_id,
      native_session_id: canonicalNativeSessionId,
      pid,
      timestamp: nowIso,
    });
    return state;
  });
}

/**
 * Write session end: record durable authority evidence, archive history, then
 * remove only the owned session pointer.
 */
export async function writeSessionEnd(cwd: string, sessionId: string): Promise<void> {
  const canonicalSessionId = requireSessionId(sessionId);
  const authority = await resolveSessionAuthorityForGuard(cwd);
  await withSessionAuthorityTransaction(authority, async (context) => {
    const state = await readSessionStateAt(context.canonical_state_root, context.generation.root_identity);
    const endTime = new Date().toISOString();
    const ownsCurrentSessionFile = state == null
      || state.session_id === canonicalSessionId
      || state.native_session_id === canonicalSessionId
      || state.owner_omx_session_id === canonicalSessionId;
    const recordedSessionId = ownsCurrentSessionFile
      ? (state?.owner_omx_session_id === canonicalSessionId ? canonicalSessionId : state?.session_id || canonicalSessionId)
      : canonicalSessionId;
    const preservedActiveSessionId = !ownsCurrentSessionFile && state?.session_id
      ? state.session_id
      : undefined;

    await appendStateAuthorityEvidence(context.generation, {
      kind: 'session_end',
      session_id: recordedSessionId,
      requested_session_id: canonicalSessionId,
      owns_current_session_file: ownsCurrentSessionFile,
      timestamp: endTime,
    });

    const historyEntry = {
      session_id: recordedSessionId,
      ...(ownsCurrentSessionFile && state?.native_session_id ? { native_session_id: state.native_session_id } : {}),
      started_at: ownsCurrentSessionFile ? state?.started_at || 'unknown' : 'unknown',
      ended_at: endTime,
      cwd,
      pid: ownsCurrentSessionFile ? state?.pid || process.pid : process.pid,
      ...(ownsCurrentSessionFile && state?.owner_omx_session_id === canonicalSessionId && state?.session_id
        ? { active_session_id: state.session_id }
        : {}),
      ...(preservedActiveSessionId ? { preserved_active_session_id: preservedActiveSessionId } : {}),
    };
    const omxRootIdentity = await capturePinnedParentOmxRootIdentity(context);
    const history = historyPath(context.generation.canonical_omx_root);
    await appendSessionIoFile(
      context.generation.canonical_omx_root,
      omxRootIdentity,
      history,
      `${JSON.stringify(historyEntry)}\n`,
    );

    await removeDeadSessionHudState(
      context.canonical_state_root,
      context.generation.root_identity,
      [
        ...(ownsCurrentSessionFile ? [state?.session_id, state?.native_session_id] : []),
        canonicalSessionId,
      ],
      ownsCurrentSessionFile && state !== null,
    );
    if (ownsCurrentSessionFile) {
      await deleteSessionIoFile(
        context.canonical_state_root,
        context.generation.root_identity,
        sessionPath(context.canonical_state_root),
      );
    }

    await appendToLogAt(context.generation.canonical_omx_root, omxRootIdentity, {
      event: 'session_end',
      session_id: recordedSessionId,
      ...(ownsCurrentSessionFile && state?.native_session_id ? { native_session_id: state.native_session_id } : {}),
      ...(ownsCurrentSessionFile && state?.owner_omx_session_id === canonicalSessionId && state?.session_id
        ? { active_session_id: state.session_id }
        : {}),
      ...(preservedActiveSessionId ? { preserved_active_session_id: preservedActiveSessionId } : {}),
      timestamp: endTime,
    });
  });
}

/**
 * Append a structured JSONL entry using the committed authority's OMX root.
 */
export async function appendToLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const authority = await resolveSessionAuthorityForGuard(cwd);
  await withSessionAuthorityTransaction(authority, async (context) => {
    const omxRootIdentity = await capturePinnedParentOmxRootIdentity(context);
    await appendToLogAt(context.generation.canonical_omx_root, omxRootIdentity, entry);
  });
}
