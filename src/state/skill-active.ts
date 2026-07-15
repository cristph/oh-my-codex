import { constants } from 'fs';
import { lstat, mkdir, open, readdir, stat, unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { getBaseStateDir, validateSessionId } from '../mcp/state-paths.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  atomicWriteAuthorityFile,
  captureRootFilesystemIdentity,
  fsyncAuthorityDirectory,
  isTrustedAuthorityPlatformRootAlias,
  sameRootFilesystemIdentity,
  stateAuthorityFilesystemPrimitiveForPlatform,
  type RootFilesystemIdentity,
} from './authority.js';
import { isTerminalRunOutcome, normalizeRunOutcome, normalizeTerminalLifecycleOutcome } from '../runtime/run-outcome.js';
import {
  assertWorkflowTransitionAllowed,
  isTrackedWorkflowMode,
  pickPrimaryWorkflowMode,
} from './workflow-transition.js';

export const SKILL_ACTIVE_STATE_MODE = 'skill-active';
export const SKILL_ACTIVE_STATE_FILE = `${SKILL_ACTIVE_STATE_MODE}-state.json`;

export const CANONICAL_WORKFLOW_SKILLS = [
  'autopilot',
  'autoresearch',
  'team',
  'ultragoal',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
] as const;

export type CanonicalWorkflowSkill = (typeof CANONICAL_WORKFLOW_SKILLS)[number];

export interface SkillActiveEntry {
  skill: string;
  phase?: string;
  active?: boolean;
  activated_at?: string;
  updated_at?: string;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
}

export interface SkillActiveStateLike {
  version?: number;
  active?: boolean;
  skill?: string;
  keyword?: string;
  phase?: string;
  activated_at?: string;
  updated_at?: string;
  source?: string;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  initialized_mode?: string;
  initialized_state_path?: string;
  input_lock?: unknown;
  active_skills?: SkillActiveEntry[];
  [key: string]: unknown;
}

export interface SyncCanonicalSkillStateOptions {
  cwd: string;
  baseStateDir?: string;
  mode: string;
  active: boolean;
  currentPhase?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  nowIso?: string;
  source?: string;
  allSessions?: boolean;
  allSessionIds?: readonly string[];
  expectedRootIdentity?: RootFilesystemIdentity;

}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function entryKey(entry: Pick<SkillActiveEntry, 'skill' | 'session_id'>): string {
  return `${entry.skill}::${safeString(entry.session_id).trim()}`;
}

function rootMirrorEntriesForCanonicalSession(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) return entries;
  return entries.filter((entry) => {
    const entrySessionId = safeString(entry.session_id).trim();
    return entrySessionId.length === 0 || entrySessionId === normalizedSessionId;
  });
}

function filterSessionOnlyEntries(
  sessionState: SkillActiveStateLike | null,
  rootEntries: SkillActiveEntry[],
  sessionId: string,
): SkillActiveEntry[] {
  const inheritedKeys = new Set(rootMirrorEntriesForCanonicalSession(rootEntries, sessionId).map(entryKey));
  return listActiveSkills(sessionState ?? {}).filter((entry) => (
    safeString(entry.session_id).trim() === sessionId
    && !inheritedKeys.has(entryKey(entry))
  ));
}

function normalizeSkillActiveEntry(raw: unknown): SkillActiveEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const skill = safeString((raw as Record<string, unknown>).skill).trim();
  if (!skill) return null;

  return {
    ...raw as Record<string, unknown>,
    skill,
    phase: safeString((raw as Record<string, unknown>).phase).trim() || undefined,
    active: (raw as Record<string, unknown>).active !== false,
    activated_at: safeString((raw as Record<string, unknown>).activated_at).trim() || undefined,
    updated_at: safeString((raw as Record<string, unknown>).updated_at).trim() || undefined,
    session_id: safeString((raw as Record<string, unknown>).session_id).trim() || undefined,
    thread_id: safeString((raw as Record<string, unknown>).thread_id).trim() || undefined,
    turn_id: safeString((raw as Record<string, unknown>).turn_id).trim() || undefined,
  };
}

export function extractSessionIdFromInitializedStatePath(pathValue: unknown): string | undefined {
  const pathText = safeString(pathValue).trim();
  if (!pathText) return undefined;
  const normalized = pathText.replace(/\\/g, '/');
  const match = /(?:^|\/)sessions\/([^/]+)\/[^/]+-state\.json$/.exec(normalized);
  return match?.[1];
}

function baseInitializationMatchesTargetSession(
  base: SkillActiveStateLike | null,
  targetSessionId?: string,
): boolean {
  const normalizedTargetSessionId = safeString(targetSessionId).trim();
  if (!normalizedTargetSessionId) return true;

  const initializedPathSessionId = extractSessionIdFromInitializedStatePath(base?.initialized_state_path);
  if (initializedPathSessionId && initializedPathSessionId !== normalizedTargetSessionId) {
    return false;
  }

  const baseSessionId = safeString(base?.session_id).trim();
  if (baseSessionId && baseSessionId !== normalizedTargetSessionId) {
    return false;
  }

  return true;
}

function sanitizeWriterBaseForSession(
  base: SkillActiveStateLike | null,
  targetSessionId?: string,
): SkillActiveStateLike {
  const inherited = { ...(base ?? {}) };
  if (!baseInitializationMatchesTargetSession(base, targetSessionId)) {
    delete inherited.initialized_mode;
    delete inherited.initialized_state_path;
    delete inherited.input_lock;
    delete inherited.context_snapshot_path;
    delete inherited.prd_path;
    delete inherited.test_spec_path;
    delete inherited.task_slug;
    delete inherited.task_description;
    delete inherited.owner_omx_session_id;
    delete inherited.owner_codex_session_id;
    delete inherited.owner_codex_thread_id;
    delete inherited.tmux_pane_id;
  }
  return inherited;
}

export function isTerminalSkillActivePhase(phase: unknown): boolean {
  const normalized = safeString(phase).trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'cleared') return true;
  const runOutcome = normalizeRunOutcome(normalized).outcome;
  if (isTerminalRunOutcome(runOutcome)) return true;
  return Boolean(normalizeTerminalLifecycleOutcome(normalized).outcome);
}

export function isTerminalSkillActiveState(state: SkillActiveStateLike): boolean {
  if (state.active === false) return true;
  if (isTerminalSkillActivePhase(state.phase)) return true;
  if (safeString(state.completed_at).trim().length > 0) return true;
  const runOutcome = normalizeRunOutcome(state.run_outcome).outcome;
  if (isTerminalRunOutcome(runOutcome)) return true;
  const lifecycleOutcome = normalizeTerminalLifecycleOutcome(state.lifecycle_outcome ?? state.terminal_outcome).outcome;
  return Boolean(lifecycleOutcome);
}

export function clearTerminalSkillActiveMarkers<T extends SkillActiveStateLike>(state: T): T {
  const next = { ...state };
  if (isTerminalSkillActivePhase(next.phase)) delete next.phase;
  delete next.completed_at;
  delete next.cancel_reason;
  delete next.run_outcome;
  delete next.lifecycle_outcome;
  delete next.terminal_outcome;
  delete next.terminal_reason;
  return next;
}

export function listActiveSkills(raw: unknown): SkillActiveEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const state = raw as SkillActiveStateLike;
  if (isTerminalSkillActiveState(state)) return [];
  const deduped = new Map<string, SkillActiveEntry>();

  if (Array.isArray(state.active_skills)) {
    for (const candidate of state.active_skills) {
      const normalized = normalizeSkillActiveEntry(candidate);
      if (!normalized || normalized.active === false) continue;
      deduped.set(entryKey(normalized), normalized);
    }
  }

  const topLevelSkill = safeString(state.skill).trim();
  if (deduped.size === 0 && state.active === true && topLevelSkill) {
    const topLevelEntry = {
      skill: topLevelSkill,
      phase: safeString(state.phase).trim() || undefined,
      active: true,
      activated_at: safeString(state.activated_at).trim() || undefined,
      updated_at: safeString(state.updated_at).trim() || undefined,
      session_id: safeString(state.session_id).trim() || undefined,
      thread_id: safeString(state.thread_id).trim() || undefined,
      turn_id: safeString(state.turn_id).trim() || undefined,
    };
    deduped.set(entryKey(topLevelEntry), topLevelEntry);
  }

  return [...deduped.values()];
}

export function normalizeSkillActiveState(raw: unknown): SkillActiveStateLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as SkillActiveStateLike;
  const activeSkills = listActiveSkills(state);
  const primary = activeSkills.find((entry) => entry.skill === safeString(state.skill).trim()) ?? activeSkills[0];
  const skill = safeString(state.skill).trim() || primary?.skill || '';
  if (!skill && activeSkills.length === 0) return null;

  return {
    ...state,
    version: typeof state.version === 'number' ? state.version : 1,
    active: typeof state.active === 'boolean' ? state.active : activeSkills.length > 0,
    skill,
    keyword: safeString(state.keyword).trim(),
    phase: safeString(state.phase).trim() || primary?.phase || '',
    activated_at: safeString(state.activated_at).trim() || primary?.activated_at || '',
    updated_at: safeString(state.updated_at).trim() || primary?.updated_at || '',
    source: safeString(state.source).trim() || undefined,
    session_id: safeString(state.session_id).trim() || primary?.session_id || undefined,
    thread_id: safeString(state.thread_id).trim() || primary?.thread_id || undefined,
    turn_id: safeString(state.turn_id).trim() || primary?.turn_id || undefined,
    active_skills: activeSkills.length > 0 ? activeSkills : undefined,
  };
}

export function getSkillActiveStatePaths(cwd: string, sessionId?: string): {
  rootPath: string;
  sessionPath?: string;
} {
  return getSkillActiveStatePathsForStateDir(getBaseStateDir(cwd), sessionId);
}

export function getSkillActiveStatePathsForStateDir(stateDir: string, sessionId?: string): {
  rootPath: string;
  sessionPath?: string;
} {
  const rootPath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
  const normalizedSession = safeString(sessionId).trim();
  if (!normalizedSession) return { rootPath };
  const validatedSessionId = validateSessionId(normalizedSession)!;
  return {
    rootPath,
    sessionPath: join(stateDir, 'sessions', validatedSessionId, SKILL_ACTIVE_STATE_FILE),
  };
}

function skillStateError(
  code: typeof AUTHORITY_DIAGNOSTIC_CODES[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
  message: string,
): never {
  throw new StateAuthorityError(code, message);
}

async function assertPersistedSkillStateRootIdentity(
  stateDir: string,
  expectedRootIdentity: RootFilesystemIdentity | undefined,
  label: string,
): Promise<void> {
  if (!expectedRootIdentity) return;
  const actualRootIdentity = await captureRootFilesystemIdentity(stateDir);
  if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
    skillStateError(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      `${label} does not match the persisted active state-root identity`,
    );
  }
}

function isPathWithinStateRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function sameSkillStateIdentity(
  expected: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
  actual: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}


async function assertNoSkillStateSymlinkComponents(path: string, label: string): Promise<void> {
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
      if (details.isSymbolicLink() && !await isTrustedAuthorityPlatformRootAlias(current, details)) {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} has a symbolic-link component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertSkillStateDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!details.isDirectory()) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a directory: ${path}`);
  }
}

async function assertSkillStateDirectoryIfPresent(path: string, label: string): Promise<boolean> {
  try {
    await assertSkillStateDirectory(path, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureSkillStateDirectory(
  path: string,
  label: string,
  stateDir: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  await assertPersistedSkillStateRootIdentity(stateDir, expectedRootIdentity, label);
  await assertNoSkillStateSymlinkComponents(path, label);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPersistedSkillStateRootIdentity(stateDir, expectedRootIdentity, label);
  await assertNoSkillStateSymlinkComponents(path, label);
  await assertSkillStateDirectory(path, label);
}

async function assertCanonicalSkillStatePath(
  stateDir: string,
  path: string,
  sessionId?: string,
  options: { create?: boolean; expectedRootIdentity?: RootFilesystemIdentity } = {},
): Promise<boolean> {
  const root = resolve(stateDir);
  const target = resolve(path);
  await assertPersistedSkillStateRootIdentity(root, options.expectedRootIdentity, 'canonical skill state root');
  if (!isPathWithinStateRoot(root, target)) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state escapes the active authority root: ${target}`);
  }
  const normalizedSessionId = sessionId ? validateSessionId(sessionId) : undefined;
  const expectedPath = normalizedSessionId
    ? join(root, 'sessions', normalizedSessionId, SKILL_ACTIVE_STATE_FILE)
    : join(root, SKILL_ACTIVE_STATE_FILE);
  if (target !== expectedPath) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state has an invalid authority path: ${target}`);
  }

  if (options.create) {
    await ensureSkillStateDirectory(root, 'canonical skill state root', root, options.expectedRootIdentity);
  } else if (!await assertSkillStateDirectoryIfPresent(root, 'canonical skill state root')) {
    return false;
  }
  await assertNoSkillStateSymlinkComponents(root, 'canonical skill state root');
  await assertSkillStateDirectory(root, 'canonical skill state root');

  if (!normalizedSessionId) return true;
  const sessionsDir = join(root, 'sessions');
  const sessionDir = join(sessionsDir, normalizedSessionId);
  if (options.create) {
    await ensureSkillStateDirectory(sessionsDir, 'canonical skill sessions directory', root, options.expectedRootIdentity);
    await ensureSkillStateDirectory(sessionDir, 'canonical skill session directory', root, options.expectedRootIdentity);
  } else if (!await assertSkillStateDirectoryIfPresent(sessionsDir, 'canonical skill sessions directory')
    || !await assertSkillStateDirectoryIfPresent(sessionDir, 'canonical skill session directory')) {
    return false;
  }
  await assertPersistedSkillStateRootIdentity(root, options.expectedRootIdentity, 'canonical skill state root');
  await assertNoSkillStateSymlinkComponents(sessionDir, 'canonical skill session directory');
  await assertSkillStateDirectory(sessionsDir, 'canonical skill sessions directory');
  await assertSkillStateDirectory(sessionDir, 'canonical skill session directory');
  return true;
}

function inferSkillStatePathScope(path: string): { stateDir: string; sessionId?: string } {
  const target = resolve(path);
  if (basename(target) !== SKILL_ACTIVE_STATE_FILE) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state has an invalid filename: ${target}`);
  }
  const parent = dirname(target);
  if (basename(dirname(parent)) === 'sessions') {
    const sessionId = validateSessionId(basename(parent));
    return { stateDir: dirname(dirname(parent)), ...(sessionId ? { sessionId } : {}) };
  }
  return { stateDir: parent };
}

async function readCanonicalSkillStateFile(
  stateDir: string,
  path: string,
  sessionId?: string,
): Promise<SkillActiveStateLike | null> {
  const root = resolve(stateDir);
  const target = resolve(path);
  if (!await assertCanonicalSkillStatePath(root, target, sessionId)) return null;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

  let beforeOpen: Awaited<ReturnType<typeof lstat>>;
  try {
    beforeOpen = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (beforeOpen.isSymbolicLink()) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `canonical skill state must not be a symbolic link: ${target}`);
  }
  if (!beforeOpen.isFile()) {
    skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state must be a regular file: ${target}`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(target, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `canonical skill state must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const opened = await handle.stat();
    const afterOpen = await lstat(target);
    if (afterOpen.isSymbolicLink() || !afterOpen.isFile()
      || !sameSkillStateIdentity(beforeOpen, opened)
      || !sameSkillStateIdentity(opened, afterOpen)) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state changed while opening: ${target}`);
    }
    await assertCanonicalSkillStatePath(root, target, sessionId);
    const content = await handle.readFile({ encoding: 'utf8' }) as string;
    const afterRead = await lstat(target);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameSkillStateIdentity(opened, afterRead)) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state was replaced while reading: ${target}`);
    }
    await assertCanonicalSkillStatePath(root, target, sessionId);
    try {
      return normalizeSkillActiveState(JSON.parse(content));
    } catch (error) {
      return skillStateError(
        AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
        `canonical skill state is malformed: ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await handle?.close();
  }
}

async function writeCanonicalSkillStateFile(
  stateDir: string,
  path: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  const root = resolve(stateDir);
  const target = resolve(path);
  await assertCanonicalSkillStatePath(root, target, sessionId, { create: true, expectedRootIdentity });
  let rootIdentity = expectedRootIdentity;
  if (!rootIdentity) {
    try {
      const authorityDirectory = await lstat(join(root, 'authority'));
      if (authorityDirectory.isDirectory()) {
        skillStateError(
          AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
          'canonical skill-state mutation under committed authority requires the persisted root identity',
        );
      }
    } catch (error) {
      if (error instanceof StateAuthorityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    rootIdentity = await captureRootFilesystemIdentity(root);
  }
  await atomicWriteAuthorityFile(target, JSON.stringify(state, null, 2), {
    authority_root: root,
    expected_root_identity: rootIdentity,
  });
}

async function unlinkCanonicalSkillStateFile(
  stateDir: string,
  path: string,
  sessionId: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<boolean> {
  const root = resolve(stateDir);
  const target = resolve(path);
  if (!await assertCanonicalSkillStatePath(root, target, sessionId, { expectedRootIdentity })) return false;
  const primitive = stateAuthorityFilesystemPrimitiveForPlatform();
  if (process.platform === 'linux' && (
    !primitive.descriptor_relative
    || primitive.directory_open_flags === null
    || primitive.file_open_flags === null
  )) {
    skillStateError(
      AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
      'the Linux runtime does not expose descriptor-relative no-follow canonical skill-state deletion',
    );
  }

  const parent = dirname(target);
  let parentHandle: Awaited<ReturnType<typeof open>> | undefined;
  let operationParent = parent;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (process.platform === 'linux') {
      const beforeParentOpen = await lstat(parent);
      if (beforeParentOpen.isSymbolicLink() || !beforeParentOpen.isDirectory()) {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill-state parent must be a regular directory: ${parent}`);
      }
      parentHandle = await open(parent, primitive.directory_open_flags!);
      const openedParent = await parentHandle.stat();
      const afterParentOpen = await lstat(parent);
      if (
        afterParentOpen.isSymbolicLink()
        || !afterParentOpen.isDirectory()
        || !sameSkillStateIdentity(beforeParentOpen, openedParent)
        || !sameSkillStateIdentity(openedParent, afterParentOpen)
      ) {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill-state parent changed while opening: ${parent}`);
      }
      let descriptorPath: string | null = null;
      for (const candidate of [`/proc/self/fd/${parentHandle.fd}`, `/dev/fd/${parentHandle.fd}`]) {
        try {
          const details = await stat(candidate);
          if (details.isDirectory() && sameSkillStateIdentity(details, openedParent)) {
            descriptorPath = candidate;
            break;
          }
        } catch {
          // Try the next Linux descriptor namespace.
        }
      }
      if (!descriptorPath) {
        skillStateError(
          AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
          'the Linux runtime cannot address an opened canonical skill-state parent descriptor',
        );
      }
      operationParent = descriptorPath;
    }

    const operationTarget = join(operationParent, basename(target));
    let beforeOpen: Awaited<ReturnType<typeof lstat>>;
    try {
      beforeOpen = await lstat(operationTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (beforeOpen.isSymbolicLink()) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `canonical skill state must not be a symbolic link: ${target}`);
    }
    if (!beforeOpen.isFile()) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state must be a regular file: ${target}`);
    }
    try {
      handle = await open(operationTarget, constants.O_RDONLY | (primitive.file_open_flags ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `canonical skill state must not be a symbolic link: ${target}`);
      }
      throw error;
    }
    const opened = await handle.stat();
    const beforeUnlink = await lstat(operationTarget);
    if (beforeUnlink.isSymbolicLink() || !beforeUnlink.isFile()
      || !sameSkillStateIdentity(beforeOpen, opened)
      || !sameSkillStateIdentity(opened, beforeUnlink)) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state was replaced before deletion: ${target}`);
    }
    await assertCanonicalSkillStatePath(root, target, sessionId, { expectedRootIdentity });
    if (process.platform === 'win32') {
      await handle.close();
      handle = undefined;
      await assertCanonicalSkillStatePath(root, target, sessionId, { expectedRootIdentity });
      const afterClose = await lstat(operationTarget);
      if (afterClose.isSymbolicLink() || !afterClose.isFile() || !sameSkillStateIdentity(opened, afterClose)) {
        skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill state was replaced before deletion: ${target}`);
      }
    }
    await unlink(operationTarget);
    if (process.platform === 'linux') {
      await parentHandle?.sync();
    } else {
      await assertCanonicalSkillStatePath(root, target, sessionId, { expectedRootIdentity });
      await fsyncAuthorityDirectory(parent);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

async function listCanonicalSkillSessionIds(stateDir: string): Promise<string[]> {
  const root = resolve(stateDir);
  if (!await assertSkillStateDirectoryIfPresent(root, 'canonical skill state root')) return [];
  await assertNoSkillStateSymlinkComponents(root, 'canonical skill state root');
  const sessionsDir = join(root, 'sessions');
  if (!await assertSkillStateDirectoryIfPresent(sessionsDir, 'canonical skill sessions directory')) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  await assertSkillStateDirectory(sessionsDir, 'canonical skill sessions directory');
  await assertNoSkillStateSymlinkComponents(root, 'canonical skill state root');

  const sessionIds: string[] = [];
  for (const entry of entries) {
    const sessionId = validateSessionId(entry.name);
    const sessionDir = join(sessionsDir, sessionId!);
    const details = await lstat(sessionDir);
    if (details.isSymbolicLink()) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `canonical skill session directory must not be a symbolic link: ${sessionDir}`);
    }
    if (!details.isDirectory()) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill session entry must be a directory: ${sessionDir}`);
    }
    await assertCanonicalSkillStatePath(root, join(sessionDir, SKILL_ACTIVE_STATE_FILE), sessionId);
    sessionIds.push(sessionId!);
  }
  return sessionIds;
}

async function validateCanonicalSkillSessionIds(stateDir: string, candidateSessionIds: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const candidate of candidateSessionIds) {
    const sessionId = validateSessionId(candidate)!;
    if (seen.has(sessionId)) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, `canonical skill session inventory contains a duplicate session ID: ${sessionId}`);
    }
    seen.add(sessionId);
    const sessionPath = join(resolve(stateDir), 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE);
    if (!await assertCanonicalSkillStatePath(stateDir, sessionPath, sessionId)) {
      skillStateError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `canonical skill session inventory disappeared before reconciliation: ${sessionId}`);
    }
    sessionIds.push(sessionId);
  }
  return sessionIds;
}

export async function readSkillActiveState(path: string): Promise<SkillActiveStateLike | null> {
  const { stateDir, sessionId } = inferSkillStatePathScope(path);
  return readCanonicalSkillStateFile(stateDir, path, sessionId);
}

export async function writeSkillActiveStateCopies(
  cwd: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike | null,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  const stateDir = expectedRootIdentity?.canonical_path ?? getBaseStateDir(cwd);
  await writeSkillActiveStateCopiesForStateDir(
    stateDir,
    state,
    sessionId,
    rootState,
    expectedRootIdentity,
  );
}

export async function writeSkillActiveStateCopiesForStateDir(
  stateDir: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike | null,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  const normalized = { version: 1, ...state };
  const normalizedRoot = rootState === null
    ? null
    : { version: 1, ...(rootState ?? normalized) };
  if (normalizedRoot !== null) {
    await writeCanonicalSkillStateFile(stateDir, rootPath, normalizedRoot, undefined, expectedRootIdentity);
  }
  if (sessionPath) {
    await writeCanonicalSkillStateFile(stateDir, sessionPath, normalized, validateSessionId(sessionId), expectedRootIdentity);
  }
}

export async function readVisibleSkillActiveState(cwd: string, sessionId?: string): Promise<SkillActiveStateLike | null> {
  return readVisibleSkillActiveStateForStateDir(getBaseStateDir(cwd), sessionId);
}

export async function readVisibleSkillActiveStateForStateDir(
  stateDir: string,
  sessionId?: string,
): Promise<SkillActiveStateLike | null> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  return sessionPath
    ? readCanonicalSkillStateFile(stateDir, sessionPath, validateSessionId(sessionId))
    : readCanonicalSkillStateFile(stateDir, rootPath);
}

export function tracksCanonicalWorkflowSkill(mode: string): mode is CanonicalWorkflowSkill {
  return (CANONICAL_WORKFLOW_SKILLS as readonly string[]).includes(mode);
}

export async function syncCanonicalSkillStateForMode(options: SyncCanonicalSkillStateOptions): Promise<void> {
  const {
    cwd,
    baseStateDir: requestedBaseStateDir,
    mode,
    active,
    currentPhase,
    sessionId,
    threadId,
    turnId,
    nowIso = new Date().toISOString(),
    source = 'state-server',
    allSessions = false,
    allSessionIds,
    expectedRootIdentity,
  } = options;
  const baseStateDir = requestedBaseStateDir ?? expectedRootIdentity?.canonical_path ?? getBaseStateDir(cwd);
  if (expectedRootIdentity) {
    const actualRootIdentity = await captureRootFilesystemIdentity(baseStateDir);
    if (!sameRootFilesystemIdentity(expectedRootIdentity, actualRootIdentity)) {
      skillStateError(
        AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
        'canonical skill-state root no longer matches the persisted authority identity',
      );
    }
  }

  if (!tracksCanonicalWorkflowSkill(mode)) return;

  const normalizedSessionId = safeString(sessionId).trim();
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(baseStateDir, normalizedSessionId || undefined);
  const existingRoot = await readCanonicalSkillStateFile(baseStateDir, rootPath);
  const existingSession = sessionPath
    ? await readCanonicalSkillStateFile(baseStateDir, sessionPath, validateSessionId(normalizedSessionId))
    : null;
  if (!existingRoot && !existingSession && !active && !options.allSessions) return;
  const allRootEntries = listActiveSkills(existingRoot ?? {});
  const rootEntries = normalizedSessionId
    ? allRootEntries.filter((entry) => safeString(entry.session_id).trim() === normalizedSessionId)
    : allRootEntries;
  const sessionOnlyEntries = normalizedSessionId
    ? listActiveSkills(existingSession ?? {}).filter((entry) => (
      safeString(entry.session_id).trim() === normalizedSessionId
      && !rootEntries.some((rootEntry) => (
        rootEntry.skill === entry.skill
        && safeString(rootEntry.session_id).trim() === safeString(entry.session_id).trim()
      ))
    ))
    : [];
  const visibleEntries = normalizedSessionId
    ? [...rootEntries, ...sessionOnlyEntries]
    : rootEntries.filter((entry) => safeString(entry.session_id).trim().length === 0);

  if (active && isTrackedWorkflowMode(mode)) {
    const currentWorkflowModes = visibleEntries
      .map((entry) => entry.skill)
      .filter(isTrackedWorkflowMode);
    assertWorkflowTransitionAllowed(currentWorkflowModes, mode, 'write');
  }

  const canonicalSessionIds = normalizedSessionId
    ? []
    : allSessionIds
      ? await validateCanonicalSkillSessionIds(baseStateDir, allSessionIds)
      : await listCanonicalSkillSessionIds(baseStateDir);


  const applyEntriesToState = (
    base: SkillActiveStateLike | null,
    entries: SkillActiveEntry[],
    fallbackMode: string,
    targetSessionId?: string,
  ): SkillActiveStateLike => {
    const inheritedBase = entries.length > 0
      ? clearTerminalSkillActiveMarkers(sanitizeWriterBaseForSession(base, targetSessionId))
      : sanitizeWriterBaseForSession(base, targetSessionId);
    const currentPrimary = safeString(inheritedBase.skill).trim();
    const primarySkill = pickPrimaryWorkflowMode(currentPrimary, entries.map((entry) => entry.skill), fallbackMode);
    const primaryEntry = entries.find((entry) => entry.skill === primarySkill) ?? entries[0];
    return {
      ...inheritedBase,
      version: 1,
      active: entries.length > 0,
      skill: primaryEntry?.skill || primarySkill || fallbackMode,
      keyword: safeString(inheritedBase.keyword).trim(),
      phase: primaryEntry?.phase || safeString(inheritedBase.phase).trim(),
      activated_at: primaryEntry?.activated_at || safeString(inheritedBase.activated_at).trim() || nowIso,
      updated_at: nowIso,
      source: safeString(inheritedBase.source).trim() || source,
      session_id: primaryEntry?.session_id || safeString(inheritedBase.session_id).trim() || undefined,
      thread_id: primaryEntry?.thread_id || safeString(inheritedBase.thread_id).trim() || undefined,
      turn_id: primaryEntry?.turn_id || safeString(inheritedBase.turn_id).trim() || undefined,
      active_skills: entries,
    };
  };

  if (normalizedSessionId) {
    const nextSessionEntries = sessionOnlyEntries.filter((entry) => entry.skill !== mode);
    if (active) {
      nextSessionEntries.push({
        skill: mode,
        phase: safeString(currentPhase).trim() || undefined,
        active: true,
        activated_at: sessionOnlyEntries.find((entry) => entry.skill === mode)?.activated_at || nowIso,
        updated_at: nowIso,
        session_id: normalizedSessionId,
        thread_id: safeString(threadId).trim() || undefined,
        turn_id: safeString(turnId).trim() || undefined,
      });
    }

    const nextSessionRootEntries = rootEntries.filter((entry) => !(
      entry.skill === mode
      && safeString(entry.session_id).trim() === normalizedSessionId
    ));
    const nextRootEntries = allRootEntries.filter((entry) => !(
      entry.skill === mode
      && safeString(entry.session_id).trim() === normalizedSessionId
    ));

    const nextSessionState = applyEntriesToState(
      existingSession ?? existingRoot,
      [...nextSessionRootEntries, ...nextSessionEntries],
      mode,
      normalizedSessionId,
    );
    const nextRootState = nextRootEntries.length > 0
      ? applyEntriesToState(existingRoot, nextRootEntries, mode)
      : applyEntriesToState(
        existingSession ?? existingRoot,
        active ? nextSessionEntries : [],
        mode,
        normalizedSessionId,
      );
    await writeSkillActiveStateCopiesForStateDir(baseStateDir, nextSessionState, sessionId, nextRootState, expectedRootIdentity);
    return;
  }

  const rootScopedEntries = rootEntries.filter((entry) => safeString(entry.session_id).trim().length === 0);
  const sessionScopedRootMirrorEntries = allSessions
    ? []
    : rootEntries.filter((entry) => safeString(entry.session_id).trim().length > 0);
  const nextRootScopedEntries = rootScopedEntries.filter((entry) => entry.skill !== mode);
  if (active) {
    nextRootScopedEntries.push({
      skill: mode,
      phase: safeString(currentPhase).trim() || undefined,
      active: true,
      activated_at: rootScopedEntries.find((entry) => entry.skill === mode)?.activated_at || nowIso,
      updated_at: nowIso,
      session_id: undefined,
      thread_id: safeString(threadId).trim() || undefined,
      turn_id: safeString(turnId).trim() || undefined,
    });
  }
  const nextRootEntries = allSessions
    ? rootEntries.filter((entry) => entry.skill !== mode)
    : [...sessionScopedRootMirrorEntries, ...nextRootScopedEntries];

  const nextRootState = applyEntriesToState(existingRoot, nextRootEntries, mode);
  await writeSkillActiveStateCopiesForStateDir(baseStateDir, nextRootState, undefined, nextRootState, expectedRootIdentity);

  for (const candidateSessionId of canonicalSessionIds) {
    const sessionPath = join(baseStateDir, 'sessions', candidateSessionId, SKILL_ACTIVE_STATE_FILE);
    const existingSessionState = await readCanonicalSkillStateFile(baseStateDir, sessionPath, candidateSessionId);
    const sessionOnlyEntries = filterSessionOnlyEntries(existingSessionState, rootEntries, candidateSessionId)
      .filter((entry) => !(allSessions && entry.skill === mode));
    const nextVisibleRootEntries = nextRootEntries
      .filter((entry) => safeString(entry.session_id).trim() === candidateSessionId);
    const nextSessionEntries = [...nextVisibleRootEntries, ...sessionOnlyEntries];

    if (nextSessionEntries.length === 0) {
      await unlinkCanonicalSkillStateFile(baseStateDir, sessionPath, candidateSessionId, expectedRootIdentity);
      continue;
    }

    const nextSessionState = applyEntriesToState(
      existingSessionState ?? existingRoot,
      nextSessionEntries,
      nextSessionEntries[0]?.skill || mode,
      candidateSessionId,
    );
    await writeSkillActiveStateCopiesForStateDir(baseStateDir, nextSessionState, candidateSessionId, nextRootState, expectedRootIdentity);
  }
}
