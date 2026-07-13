import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'fs';
import { createHash, timingSafeEqual } from 'crypto';
import { readFile, realpath, stat } from 'fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'path';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  authorityBindingPath,
  authorityGenerationPaths,
  resolveWorkspaceIdentity,
  stateAuthorityPaths,
  isObservedCwdCompatibleWithStateAuthority,
  validateSessionAuthorityBinding,
  resolveStateAuthority,
  validateStateAuthority,
  validateStateAuthorityGeneration,
  validateWorkspaceAuthorityAnchor,
  type ResolvedStateAuthorityContext,
  type SessionAuthorityBinding,
  type StateAuthorityGeneration,
  type WorkspaceAuthorityAnchor,
} from '../state/authority.js';
import { resolveAuthenticatedTransportAuthority } from '../hooks/session.js';

function authorityTransportValues(env: NodeJS.ProcessEnv): {
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
  const workspaceDigest =
    env.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST?.trim() ?? '';
  const capability = env.OMX_STATE_AUTHORITY_CAPABILITY?.trim() ?? '';
  return {
    authorityPath,
    authorityId,
    generationId,
    workspaceDigest,
    capability,
    present: Boolean(
      authorityPath ||
        authorityId ||
        generationId ||
        workspaceDigest ||
        capability,
    ),
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
    basename(generationsDirectory) !== 'generations' ||
    basename(authorityDirectory) !== 'authority' ||
    basename(stateRoot) !== 'state' ||
    basename(omxRoot) !== '.omx'
  )
    return null;
  return dirname(omxRoot);
}

function failSynchronousAuthorityTransport(
  code: (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
  message: string,
): never {
  throw new StateAuthorityError(code, message);
}

interface SynchronousAuthorityPathSnapshot {
  path: string;
  componentIdentities: Array<{
    path: string;
    dev: number;
    ino: number;
    mode: number;
  }>;
}

interface SynchronousAuthorityJsonRead {
  path: string;
  parsed: Record<string, unknown>;
  contentDigest: string;
  snapshot: SynchronousAuthorityPathSnapshot;
}

function synchronousPathIdentity(details: {
  dev: number;
  ino: number;
  mode: number;
}): { dev: number; ino: number; mode: number } {
  return { dev: details.dev, ino: details.ino, mode: details.mode };
}

function sameSynchronousPathIdentity(
  left: { dev: number; ino: number; mode: number },
  right: { dev: number; ino: number; mode: number },
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function sameSynchronousAuthorityPathSnapshot(
  left: SynchronousAuthorityPathSnapshot,
  right: SynchronousAuthorityPathSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.componentIdentities.length === right.componentIdentities.length &&
    left.componentIdentities.every((entry, index) => {
      const candidate = right.componentIdentities[index];
      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        sameSynchronousPathIdentity(entry, candidate)
      );
    })
  );
}

function snapshotSynchronousAuthorityPath(
  path: string,
  code: (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
  expectedFinalType: 'file' | 'directory',
): SynchronousAuthorityPathSnapshot {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  const componentIdentities: SynchronousAuthorityPathSnapshot['componentIdentities'] =
    [];
  let current = root;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      const details = lstatSync(current);
      const isFinal = index === segments.length - 1;
      if (
        details.isSymbolicLink() ||
        (isFinal
          ? expectedFinalType === 'file'
            ? !details.isFile()
            : !details.isDirectory()
          : !details.isDirectory())
      ) {
        failSynchronousAuthorityTransport(
          code,
          `authority transport path contains an unsafe component: ${current}`,
        );
      }
      componentIdentities.push({
        path: current,
        ...synchronousPathIdentity(details),
      });
    }
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    failSynchronousAuthorityTransport(
      code,
      `cannot inspect authority transport path: ${absolute}`,
    );
  }
  return { path: absolute, componentIdentities };
}

function assertSynchronousAuthorityPathSnapshotCurrent(
  snapshot: SynchronousAuthorityPathSnapshot,
  code: (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
  expectedFinalType: 'file' | 'directory',
): void {
  const current = snapshotSynchronousAuthorityPath(
    snapshot.path,
    code,
    expectedFinalType,
  );
  if (
    current.componentIdentities.length !==
      snapshot.componentIdentities.length ||
    current.componentIdentities.some((entry, index) => {
      const expected = snapshot.componentIdentities[index];
      return (
        !expected ||
        entry.path !== expected.path ||
        !sameSynchronousPathIdentity(entry, expected)
      );
    })
  ) {
    failSynchronousAuthorityTransport(
      code,
      `authority transport path changed while it was being read: ${snapshot.path}`,
    );
  }
}

function readAuthorityJsonSync(
  path: string,
  code: (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
): SynchronousAuthorityJsonRead {
  const snapshot = snapshotSynchronousAuthorityPath(path, code, 'file');
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(snapshot.path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    const expected = snapshot.componentIdentities.at(-1);
    if (
      !opened.isFile() ||
      !expected ||
      !sameSynchronousPathIdentity(synchronousPathIdentity(opened), expected)
    ) {
      failSynchronousAuthorityTransport(
        code,
        `authority transport file changed while it was being opened: ${snapshot.path}`,
      );
    }
    const raw = readFileSync(fd, 'utf8');
    const afterRead = fstatSync(fd);
    if (
      !afterRead.isFile() ||
      !sameSynchronousPathIdentity(synchronousPathIdentity(afterRead), expected)
    ) {
      failSynchronousAuthorityTransport(
        code,
        `authority transport file changed while it was being read: ${snapshot.path}`,
      );
    }
    assertSynchronousAuthorityPathSnapshotCurrent(snapshot, code, 'file');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      failSynchronousAuthorityTransport(
        code,
        `authority transport file is malformed: ${snapshot.path}`,
      );
    }
    return {
      path: snapshot.path,
      parsed: parsed as Record<string, unknown>,
      contentDigest: createHash('sha256').update(raw, 'utf8').digest('hex'),
      snapshot,
    };
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    failSynchronousAuthorityTransport(
      code,
      `cannot read authority transport file: ${snapshot.path}`,
    );
  } finally {
    if (typeof fd === 'number') closeSync(fd);
  }
  return failSynchronousAuthorityTransport(
    code,
    `cannot complete authority transport read: ${snapshot.path}`,
  );
}

function assertSynchronousAuthorityJsonReadCurrent(
  read: SynchronousAuthorityJsonRead,
  code: (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES],
): void {
  assertSynchronousAuthorityPathSnapshotCurrent(read.snapshot, code, 'file');
  const current = readAuthorityJsonSync(read.path, code);
  if (
    !sameSynchronousAuthorityPathSnapshot(read.snapshot, current.snapshot) ||
    current.contentDigest !== read.contentDigest
  ) {
    failSynchronousAuthorityTransport(
      code,
      `authority transport file changed while it was being validated: ${read.path}`,
    );
  }
}

function hasCurrentRootFilesystemIdentity(
  generation: StateAuthorityGeneration,
): boolean {
  try {
    const root = resolve(generation.canonical_state_root);
    const snapshot = snapshotSynchronousAuthorityPath(
      root,
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'directory',
    );
    const details = lstatSync(root);
    if (details.isSymbolicLink() || !details.isDirectory()) return false;
    const actual = statSync(root, { bigint: true });
    const birthtimeNs = (
      actual as unknown as { birthtimeNs: bigint }
    ).birthtimeNs.toString();
    assertSynchronousAuthorityPathSnapshotCurrent(
      snapshot,
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'directory',
    );
    return (
      generation.root_capability.strong_root_identity === 'verified' &&
      generation.root_identity.strong_identity === true &&
      generation.root_identity.canonical_path === root &&
      generation.root_identity.platform === process.platform &&
      generation.root_identity.device === actual.dev.toString() &&
      generation.root_identity.inode === actual.ino.toString() &&
      generation.root_identity.mode === actual.mode.toString() &&
      generation.root_identity.birthtime_ns === birthtimeNs
    );
  } catch {
    return false;
  }
}

function transportCapabilityDigestMatches(
  capability: string,
  expectedDigest: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedDigest)) return false;
  const actual = Buffer.from(
    createHash('sha256').update(capability, 'utf8').digest('hex'),
    'hex',
  );
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateSynchronousTransportCapability(
  capability: string,
  anchor: WorkspaceAuthorityAnchor,
  generation: StateAuthorityGeneration,
  binding: SessionAuthorityBinding,
): void {
  if (capability.length < 32) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      'inherited state-authority transport capability is missing or malformed',
    );
  }
  const metadata = anchor.transport_capability;
  if (!metadata || metadata.status !== 'active') {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      'inherited state-authority transport capability is absent or revoked in the active anchor',
    );
  }
  const expiresAt = new Date(metadata.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      'inherited state-authority transport capability has an invalid expiry',
    );
  }
  if (expiresAt.getTime() <= Date.now()) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityExpired,
      'inherited state-authority transport capability has expired',
    );
  }
  const lease = anchor.active_lease;
  if (
    !lease ||
    metadata.workspace_identity_digest !== anchor.workspace_identity_digest ||
    metadata.authority_id !== generation.authority_id ||
    metadata.generation_id !== generation.generation_id ||
    metadata.binding_id !== binding.binding_id ||
    metadata.binding_revision > binding.binding_revision ||
    metadata.lease_launch_id !== lease.launch_id
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      'inherited state-authority transport capability does not match the active authority tuple',
    );
  }
  if (
    !transportCapabilityDigestMatches(capability, metadata.capability_digest)
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      'inherited state-authority transport capability digest does not match the active anchor',
    );
  }
}

function assertObservedCwdCompatible(
  workspaceIdentity: StateAuthorityGeneration['workspace_identity'],
  observedCwd: string,
): void {
  if (
    !isObservedCwdCompatibleWithStateAuthority(
      { workspace_identity: workspaceIdentity },
      observedCwd,
    )
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.observedCwdOutsideWorkspace,
      'inherited state-authority transport cannot be used from an unrelated workspace cwd',
    );
  }
}

function resolveSynchronousTransportStateRoot(
  observedCwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const transport = authorityTransportValues(env);
  if (!transport.present) return null;
  if (
    !transport.authorityPath ||
    !transport.authorityId ||
    !transport.generationId ||
    !transport.workspaceDigest ||
    !transport.capability
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
      'inherited state-authority transport is incomplete; the opaque capability and all persisted tuple fields are required',
    );
  }
  const startupCwd =
    env.OMX_STARTUP_CWD?.trim() ||
    deriveWorkspaceFromAuthorityLocator(transport.authorityPath);
  if (!startupCwd) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot,
      'inherited state-authority locator does not identify a workspace root',
    );
  }
  const workspace = resolveWorkspaceIdentity(startupCwd);
  const anchorPath = stateAuthorityPaths(workspace).anchor_path;
  const anchorRead = readAuthorityJsonSync(
    anchorPath,
    AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed,
  );
  const anchor = anchorRead.parsed as unknown as WorkspaceAuthorityAnchor;
  validateWorkspaceAuthorityAnchor(anchor, workspace);
  if (
    workspace.digest !== transport.workspaceDigest ||
    anchor.active_generation_id !== transport.generationId ||
    !anchor.active_generation_locator ||
    !anchor.active_binding_locator ||
    !anchor.active_lease ||
    resolve(anchor.active_generation_locator) !==
      resolve(transport.authorityPath)
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      'inherited state-authority transport does not match the active workspace anchor',
    );
  }
  const generationRead = readAuthorityJsonSync(
    anchor.active_generation_locator,
    AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
  );
  const generation =
    generationRead.parsed as unknown as StateAuthorityGeneration;
  validateStateAuthorityGeneration(generation);
  const expectedAuthorityPath = authorityGenerationPaths(
    generation.canonical_state_root,
    generation.generation_id,
  ).authority_path;
  if (
    generation.authority_id !== transport.authorityId ||
    generation.generation_id !== transport.generationId ||
    generation.workspace_identity.digest !== workspace.digest ||
    generation.workspace_identity_digest !== workspace.digest ||
    resolve(anchor.active_generation_locator) !==
      resolve(expectedAuthorityPath) ||
    resolve(transport.authorityPath) !== resolve(expectedAuthorityPath) ||
    !hasCurrentRootFilesystemIdentity(generation)
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'inherited state-authority transport generation is stale, foreign, or has changed filesystem identity',
    );
  }
  const bindingRead = readAuthorityJsonSync(
    anchor.active_binding_locator,
    AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
  );
  const binding = bindingRead.parsed as unknown as SessionAuthorityBinding;
  validateSessionAuthorityBinding(binding);
  const expectedBindingPath = authorityBindingPath(
    generation.canonical_state_root,
    generation.generation_id,
    binding.binding_id,
  );
  if (
    binding.lifecycle !== 'active' ||
    binding.authority_id !== generation.authority_id ||
    binding.generation_id !== generation.generation_id ||
    binding.creation_fence !== generation.creation_fence ||
    resolve(anchor.active_binding_locator) !== resolve(expectedBindingPath) ||
    anchor.active_lease.generation_id !== generation.generation_id ||
    anchor.active_lease.binding_id !== binding.binding_id ||
    anchor.active_lease.fencing_token !== anchor.fencing_token ||
    generation.creation_fence > anchor.fencing_token
  ) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
      'inherited state-authority transport does not match the active binding and fence',
    );
  }
  validateSynchronousTransportCapability(
    transport.capability,
    anchor,
    generation,
    binding,
  );
  assertObservedCwdCompatible(generation.workspace_identity, observedCwd);
  if (!hasCurrentRootFilesystemIdentity(generation)) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'inherited state-authority root changed while its transport was being validated',
    );
  }
  assertSynchronousAuthorityJsonReadCurrent(
    bindingRead,
    AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
  );
  assertSynchronousAuthorityJsonReadCurrent(
    generationRead,
    AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
  );
  assertSynchronousAuthorityJsonReadCurrent(
    anchorRead,
    AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed,
  );
  if (!hasCurrentRootFilesystemIdentity(generation)) {
    failSynchronousAuthorityTransport(
      AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      'inherited state-authority root changed after its transport was validated',
    );
  }
  return generation.canonical_state_root;
}

function assertNoAmbientAuthorityAliasConflict(
  cwd: string,
  env: NodeJS.ProcessEnv,
  stateRoot: string,
): void {
  const expected = resolve(stateRoot);
  for (const [name, value] of [
    ['OMX_TEAM_STATE_ROOT', env.OMX_TEAM_STATE_ROOT?.trim() ?? ''],
    ['OMX_ROOT', env.OMX_ROOT?.trim() ?? ''],
    ['OMX_STATE_ROOT', env.OMX_STATE_ROOT?.trim() ?? ''],
  ] as const) {
    if (!value) continue;
    const candidate =
      name === 'OMX_TEAM_STATE_ROOT'
      ? resolve(cwd, value)
      : join(resolve(cwd, value), '.omx', 'state');
    if (resolve(candidate) !== expected) {
    failSynchronousAuthorityTransport(
        AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch,
        `${name} conflicts with the inherited state authority`,
    );
  }
  }
}

/**
 * Resolves the canonical team state root synchronously. Locator evidence is
 * authenticated against the active anchor before it can select a source or
 * alternate root; otherwise resolution fails closed rather than using cwd.
 */
export function resolveCanonicalTeamStateRoot(
  leaderCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const transportedStateRoot = resolveSynchronousTransportStateRoot(
    leaderCwd,
    env,
  );
  if (transportedStateRoot) {
    assertNoAmbientAuthorityAliasConflict(leaderCwd, env, transportedStateRoot);
    return transportedStateRoot;
  }
  return join(resolve(leaderCwd), '.omx', 'state');
}

export interface TeamWorkerIdentityRef {
  teamName: string;
  workerName: string;
}

export type WorkerTeamStateRootSource =
  | 'authority'
  | 'env'
  | 'leader_cwd'
  | 'cwd'
  | 'identity_metadata';

interface WorkerTeamStateRootResolveOptions {
  /**
   * Allow probing cwd/.omx/state as a last-resort candidate. This is only
   * available for legacy worker sessions without committed authority evidence.
   */
  allowCwdFallback: boolean;
}

export interface WorkerTeamStateRootResolution {
  ok: boolean;
  stateRoot: string | null;
  source: WorkerTeamStateRootSource | null;
  reason?: string;
  identityPath?: string;
  worktreePath?: string;
}

type JsonRecord = Record<string, unknown>;

async function readJsonIfExists(path: string): Promise<JsonRecord | null> {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function metadataStateRoot(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function normalizePath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function pathIsSameOrInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const rel = relative(parent, candidate);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`)
  );
}

async function cwdMatchesIdentityWorktree(
  cwd: string,
  identity: JsonRecord,
): Promise<{ matches: boolean; worktreePath?: string }> {
  const worktreePath = metadataStateRoot(identity.worktree_path);
  if (!worktreePath) return { matches: true };

  const [normalizedCwd, normalizedWorktree] = await Promise.all([
    normalizePath(cwd),
    normalizePath(worktreePath),
  ]);

  return pathIsSameOrInside(normalizedCwd, normalizedWorktree)
    ? { matches: true, worktreePath: normalizedWorktree }
    : { matches: false, worktreePath: normalizedWorktree };
}

async function validateWorkerStateRoot(
  stateRoot: string,
  cwd: string,
  worker: TeamWorkerIdentityRef,
  authority?: ResolvedStateAuthorityContext,
): Promise<WorkerTeamStateRootResolution> {
  const resolvedStateRoot = resolve(cwd, stateRoot);
  if (authority) {
    const [normalizedCandidate, normalizedAuthorityRoot] = await Promise.all([
      normalizePath(resolvedStateRoot),
      normalizePath(authority.canonical_state_root),
    ]);
    if (normalizedCandidate !== normalizedAuthorityRoot) {
      return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: 'authority_workspace_mismatch',
      };
    }
  }
  const identityPath = join(
    resolvedStateRoot,
    'team',
    worker.teamName,
    'workers',
    worker.workerName,
    'identity.json',
  );
  const identity = await readJsonIfExists(identityPath);
  if (!identity) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'missing_or_invalid_identity',
      identityPath,
    };
  }

  const identityName = metadataStateRoot(identity.name);
  if (identityName && identityName !== worker.workerName) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'identity_worker_mismatch',
      identityPath,
    };
  }

  if (authority) {
    const metadataRoot = metadataStateRoot(identity.team_state_root);
    if (metadataRoot) {
      const [normalizedMetadataRoot, normalizedAuthorityRoot] =
        await Promise.all([
        normalizePath(resolve(cwd, metadataRoot)),
        normalizePath(authority.canonical_state_root),
      ]);
      if (normalizedMetadataRoot !== normalizedAuthorityRoot) {
        return {
          ok: false,
          stateRoot: null,
          source: null,
          reason: 'authority_team_metadata_conflict',
          identityPath,
        };
      }
    }
  }

  const worktreeMatch = await cwdMatchesIdentityWorktree(cwd, identity);
  if (!worktreeMatch.matches) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'identity_worktree_mismatch',
      identityPath,
      worktreePath: worktreeMatch.worktreePath,
    };
  }

  return {
    ok: true,
    stateRoot: resolvedStateRoot,
    source: null,
    identityPath,
    worktreePath: worktreeMatch.worktreePath,
  };
}

async function validateWithSource(
  stateRoot: string,
  source: WorkerTeamStateRootSource,
  cwd: string,
  worker: TeamWorkerIdentityRef,
  authority?: ResolvedStateAuthorityContext,
): Promise<WorkerTeamStateRootResolution> {
  const validated = await validateWorkerStateRoot(
    stateRoot,
    cwd,
    worker,
    authority,
  );
  return validated.ok ? { ...validated, source } : validated;
}

async function readMetadataRootFromValidatedCandidate(
  candidateStateRoot: string,
  filename: 'identity.json' | 'manifest.v2.json' | 'config.json',
  cwd: string,
  worker: TeamWorkerIdentityRef,
): Promise<string | null> {
  const validated = await validateWorkerStateRoot(
    candidateStateRoot,
    cwd,
    worker,
  );
  if (!validated.ok) return null;

  const metadataPath =
    filename === 'identity.json'
      ? join(
          candidateStateRoot,
          'team',
          worker.teamName,
          'workers',
          worker.workerName,
          filename,
        )
      : join(candidateStateRoot, 'team', worker.teamName, filename);
  const parsed = await readJsonIfExists(metadataPath);
  return metadataStateRoot(parsed?.team_state_root);
}

async function hasStateAuthorityProtocolEvidence(
  stateRoot: string,
): Promise<boolean> {
  const resolvedStateRoot = resolve(stateRoot);
  const authorityDirectory = join(resolvedStateRoot, 'authority');
  const protocolPaths = [
    join(authorityDirectory, 'generations'),
    join(authorityDirectory, 'journals'),
    join(authorityDirectory, 'state-authority.json'),
    join(authorityDirectory, 'state-authority-anchor.json'),
    join(authorityDirectory, 'state-authority-tombstones.jsonl'),
    join(authorityDirectory, '.state-authority-lock-tombstones.jsonl'),
    join(authorityDirectory, '.state-authority.lock'),
    join(authorityDirectory, '.state-authority.lock.fence-counter.json'),
  ];
  const omxRoot = dirname(resolvedStateRoot);
  if (basename(resolvedStateRoot) === 'state' && basename(omxRoot) === '.omx') {
    protocolPaths.push(
      join(omxRoot, 'bootstrap', 'state-authority-anchor.json'),
      join(omxRoot, 'bootstrap', '.state-authority.lock'),
      join(omxRoot, 'bootstrap', '.state-authority-lock-tombstones.jsonl'),
    );
  }
  for (const protocolPath of protocolPaths) {
    try {
      await stat(protocolPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
    }
  }
  return false;
}

function explicitStateRootCandidates(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];
  const teamStateRoot = env.OMX_TEAM_STATE_ROOT?.trim();
  if (teamStateRoot) candidates.push(resolve(cwd, teamStateRoot));
  const omxRoot = env.OMX_ROOT?.trim();
  if (omxRoot) candidates.push(join(resolve(cwd, omxRoot), '.omx', 'state'));
  const omxStateRoot = env.OMX_STATE_ROOT?.trim();
  if (omxStateRoot)
    candidates.push(join(resolve(cwd, omxStateRoot), '.omx', 'state'));
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

async function explicitRootContainsAuthorityProtocolEvidence(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  for (const stateRoot of explicitStateRootCandidates(cwd, env)) {
    if (await hasStateAuthorityProtocolEvidence(stateRoot)) return true;
  }
  return false;
}

function inheritedAuthorityLocatorPresent(env: NodeJS.ProcessEnv): boolean {
  return authorityTransportValues(env).present;
}

function authoritySessionCandidate(env: NodeJS.ProcessEnv): string | undefined {
  const candidate = env.OMX_SESSION_ID?.trim();
  return candidate || undefined;
}

async function committedLeaderAuthorityWithoutTransport(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exists: boolean; reason?: string }> {
  const leaderCwd = env.OMX_TEAM_LEADER_CWD?.trim() || cwd;
  try {
    const resolution = await resolveStateAuthority({
      startup_cwd: leaderCwd,
      observed_cwd: leaderCwd,
      session_id: authoritySessionCandidate(env),
    });
    if (resolution.context && resolution.can_mutate) return { exists: true };
    const blockingDiagnostic = resolution.diagnostics.find(
      (diagnostic) =>
        diagnostic.code !== AUTHORITY_DIAGNOSTIC_CODES.anchorMissing,
    );
    return blockingDiagnostic
      ? { exists: false, reason: blockingDiagnostic.code }
      : { exists: false };
  } catch (error) {
    return {
      exists: false,
      reason:
        error instanceof StateAuthorityError
          ? error.code
          : AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
    };
  }
}

async function resolveAuthoritativeWorkerContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ context?: ResolvedStateAuthorityContext; reason?: string }> {
  const locatorPresent = inheritedAuthorityLocatorPresent(env);
  let context: ResolvedStateAuthorityContext | undefined;
  if (locatorPresent) {
    try {
      const transported = await resolveAuthenticatedTransportAuthority(
        cwd,
        env,
      );
      if (!transported) return { reason: 'authority_generation_missing' };
      context = transported;
    } catch (error) {
      return {
        reason:
          error instanceof StateAuthorityError
          ? error.code
          : 'authority_generation_malformed',
      };
    }
  }
  if (!context) {
    const committedLeader = await committedLeaderAuthorityWithoutTransport(
      cwd,
      env,
    );
    if (committedLeader.reason) return { reason: committedLeader.reason };
    if (committedLeader.exists)
      return { reason: AUTHORITY_DIAGNOSTIC_CODES.authorityMissing };
    return {};
  }

  const validation = await validateStateAuthority(context.generation, {
    workspace_identity: context.workspace_identity,
    session_id: authoritySessionCandidate(env),
  });
  if (!validation.valid)
    return {
      reason:
        validation.diagnostics[0]?.code ?? 'authority_generation_malformed',
    };
  if (
    context.canonical_state_root !== context.generation.canonical_state_root ||
    !context.session_binding ||
    context.session_binding.lifecycle !== 'active'
  )
    return { reason: 'authority_generation_malformed' };
  return { context };
}

async function explicitRootConflictsWithAuthority(
  cwd: string,
  env: NodeJS.ProcessEnv,
  authority: ResolvedStateAuthorityContext,
): Promise<boolean> {
  const canonical = await normalizePath(authority.canonical_state_root);
  for (const candidate of explicitStateRootCandidates(cwd, env)) {
    if ((await normalizePath(candidate)) !== canonical) return true;
  }
  return false;
}

async function resolveWorkerTeamStateRootWithOptions(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv,
  options: WorkerTeamStateRootResolveOptions,
): Promise<WorkerTeamStateRootResolution> {
  const authority = await resolveAuthoritativeWorkerContext(cwd, env);
  if (authority.context) {
    if (await explicitRootConflictsWithAuthority(cwd, env, authority.context)) {
      return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: 'authority_env_root_conflict',
      };
    }
    const resolved = await validateWithSource(
      authority.context.canonical_state_root,
      'authority',
      cwd,
      worker,
      authority.context,
    );
    return resolved.ok ? resolved : { ...resolved, source: 'authority' };
  }
  if (authority.reason)
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: authority.reason,
    };
  if (await explicitRootContainsAuthorityProtocolEvidence(cwd, env)) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
    };
  }

  const explicit =
    typeof env.OMX_TEAM_STATE_ROOT === 'string'
      ? env.OMX_TEAM_STATE_ROOT.trim()
      : '';
  if (explicit) {
    const resolved = await validateWithSource(
      resolve(cwd, explicit),
      'env',
      cwd,
      worker,
    );
    if (resolved.ok) return resolved;
    return { ...resolved, source: 'env' };
  }

  const leaderCwd =
    typeof env.OMX_TEAM_LEADER_CWD === 'string'
      ? env.OMX_TEAM_LEADER_CWD.trim()
      : '';
  const leaderStateRoot = leaderCwd
    ? join(resolve(cwd, leaderCwd), '.omx', 'state')
    : '';
  const cwdStateRoot = join(cwd, '.omx', 'state');
  const hintedCandidates: Array<{
    stateRoot: string;
    source: WorkerTeamStateRootSource;
  }> = [
    ...(leaderStateRoot
      ? [{ stateRoot: leaderStateRoot, source: 'leader_cwd' as const }]
      : []),
    ...(options.allowCwdFallback
      ? [{ stateRoot: cwdStateRoot, source: 'cwd' as const }]
      : []),
  ];

  for (const candidate of hintedCandidates) {
    const direct = await validateWithSource(
      candidate.stateRoot,
      candidate.source,
      cwd,
      worker,
    );
    if (!direct.ok) continue;
    return direct;
  }

  const diagnosticStateRoot =
    leaderStateRoot || (options.allowCwdFallback ? cwdStateRoot : '');
  const diagnostic = diagnosticStateRoot
    ? await validateWithSource(
        diagnosticStateRoot,
        leaderStateRoot ? 'leader_cwd' : 'cwd',
        cwd,
        worker,
      )
    : null;
  return {
    ok: false,
    stateRoot: null,
    source: null,
    reason: diagnostic?.reason || 'no_valid_worker_state_root',
    identityPath: diagnostic?.identityPath,
  };
}

/**
 * Resolve the canonical team state root for an OMX team worker PostToolUse/git hook.
 *
 * Inherited authenticated authority transport selects the root and disables all
 * worker-cwd fallback. Legacy sessions retain the validated local fallback.
 */
export async function resolveWorkerTeamStateRoot(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerTeamStateRootResolution> {
  return resolveWorkerTeamStateRootWithOptions(cwd, worker, env, {
    allowCwdFallback: !inheritedAuthorityLocatorPresent(env),
  });
}

/**
 * Resolve the team state root for non-git worker notify hooks. Inherited
 * authority selects the root; otherwise this remains a strict no-cwd-fallback
 * resolver for legacy notify invocations.
 */
export async function resolveWorkerNotifyTeamStateRoot(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerTeamStateRootResolution> {
  const resolvedAuthority = await resolveAuthoritativeWorkerContext(cwd, env);
  if (resolvedAuthority.context) {
    if (
      await explicitRootConflictsWithAuthority(
        cwd,
        env,
        resolvedAuthority.context,
      )
    ) {
      return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: 'authority_env_root_conflict',
      };
    }
    const direct = await validateWithSource(
      resolvedAuthority.context.canonical_state_root,
      'authority',
      cwd,
      worker,
      resolvedAuthority.context,
    );
    return direct.ok ? direct : { ...direct, source: 'authority' };
  }
  if (resolvedAuthority.reason)
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: resolvedAuthority.reason,
    };
  if (await explicitRootContainsAuthorityProtocolEvidence(cwd, env)) {
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
    };
  }

  const explicit =
    typeof env.OMX_TEAM_STATE_ROOT === 'string'
      ? env.OMX_TEAM_STATE_ROOT.trim()
      : '';
  if (explicit) {
    const resolved = await validateWithSource(
      resolve(cwd, explicit),
      'env',
      cwd,
      worker,
    );
    if (resolved.ok) return resolved;
    return { ...resolved, source: 'env' };
  }
  const leaderCwd =
    typeof env.OMX_TEAM_LEADER_CWD === 'string'
      ? env.OMX_TEAM_LEADER_CWD.trim()
      : '';
  const leaderStateRoot = leaderCwd
    ? join(resolve(cwd, leaderCwd), '.omx', 'state')
    : '';
  if (!leaderStateRoot)
    return {
      ok: false,
      stateRoot: null,
      source: null,
      reason: 'no_valid_worker_state_root',
    };

  const direct = await validateWithSource(
    leaderStateRoot,
    'leader_cwd',
    cwd,
    worker,
  );
  if (!direct.ok) return direct;
  const metadataRoot = await readMetadataRootFromValidatedCandidate(
    leaderStateRoot,
    'identity.json',
    cwd,
    worker,
  );
  if (metadataRoot) {
    const resolved = await validateWithSource(
      resolve(cwd, metadataRoot),
      'identity_metadata',
      cwd,
      worker,
    );
    if (resolved.ok) return resolved;
  }
  return direct;
}

export async function resolveWorkerTeamStateRootPath(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const resolved = await resolveWorkerTeamStateRoot(cwd, worker, env);
  return resolved.ok ? resolved.stateRoot : null;
}

export async function resolveWorkerNotifyTeamStateRootPath(
  cwd: string,
  worker: TeamWorkerIdentityRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const resolved = await resolveWorkerNotifyTeamStateRoot(cwd, worker, env);
  return resolved.ok ? resolved.stateRoot : null;
}
