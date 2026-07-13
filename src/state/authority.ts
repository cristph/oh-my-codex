import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from 'node:fs';

import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  link,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  resolveWorkspaceIdentity,
  type WorkspaceIdentity,
} from '../utils/git-layout.js';

export type { WorkspaceIdentity } from '../utils/git-layout.js';
export { resolveWorkspaceIdentity } from '../utils/git-layout.js';

export const STATE_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const STATE_AUTHORITY_PROTOCOL_VERSION = 1 as const;
export const STATE_AUTHORITY_FILE = 'state-authority.json';
export const STATE_AUTHORITY_ANCHOR_FILE = 'state-authority-anchor.json';
export const STATE_AUTHORITY_LOCK = '.state-authority.lock';
export const STATE_AUTHORITY_TOMBSTONE_FILE = 'state-authority-tombstones.jsonl';
export const STATE_AUTHORITY_LOCK_TOMBSTONE_FILE = '.state-authority-lock-tombstones.jsonl';
const STATE_AUTHORITY_LOCK_ACQUISITION_GUARD = `${STATE_AUTHORITY_LOCK}.acquire`;
const STATE_AUTHORITY_LOCK_ACQUISITION_RECLAIM_CLAIM = `${STATE_AUTHORITY_LOCK_ACQUISITION_GUARD}.reclaim`;
const STATE_AUTHORITY_LOCK_FENCE_COUNTER_FILE = `${STATE_AUTHORITY_LOCK}.fence-counter.json`;


export const STATE_AUTHORITY_JOURNAL_DIRECTORY = 'journals';

export const AUTHORITY_DIAGNOSTIC_CODES = {
  anchorMissing: 'authority_anchor_missing',
  anchorMalformed: 'authority_anchor_malformed',
  anchorRevisionConflict: 'authority_anchor_revision_conflict',
  workspaceMismatch: 'authority_workspace_mismatch',
  observedCwdOutsideWorkspace: 'authority_observed_cwd_outside_workspace',
  authorityMissing: 'authority_generation_missing',
  authorityMalformed: 'authority_generation_malformed',
  authorityPathEscapesRoot: 'authority_path_escapes_root',
  authorityProtocolIncompatible: 'authority_protocol_incompatible',
  rootFingerprintMismatch: 'authority_root_fingerprint_mismatch',
  rootCapabilityWeak: 'authority_root_capability_weak',
  rootMissing: 'authority_root_missing',
  rootSymlink: 'authority_root_symlink',
  sessionBindingConflict: 'authority_session_binding_conflict',
  lockHeld: 'authority_lock_held',
  lockOwnerMismatch: 'authority_lock_owner_mismatch',
  lockTakeoverUnproven: 'authority_lock_takeover_unproven',
  intentExpired: 'authority_bootstrap_intent_expired',
  intentReplay: 'authority_bootstrap_intent_replayed',
  intentConflict: 'authority_bootstrap_intent_conflict',
  intentAmbiguous: 'authority_bootstrap_intent_ambiguous',
  intentIssuerMismatch: 'authority_bootstrap_intent_issuer_mismatch',
  journalMalformed: 'authority_journal_malformed',
  journalTransitionInvalid: 'authority_journal_transition_invalid',
  journalConflict: 'authority_journal_conflict',
  legacyAuthorityUnproven: 'legacy_authority_unproven',
  legacyAuthorityAmbiguous: 'legacy_authority_ambiguous',
  resumeEvidenceMissing: 'authority_resume_evidence_missing',
  ownerConfirmationRequired: 'OWNER_CONFIRMATION_REQUIRED',
  transportCapabilityInvalid: 'authority_transport_capability_invalid',
  transportCapabilityExpired: 'authority_transport_capability_expired',
} as const;

export type AuthorityDiagnosticCode =
  (typeof AUTHORITY_DIAGNOSTIC_CODES)[keyof typeof AUTHORITY_DIAGNOSTIC_CODES];

export interface AuthorityDiagnostic {
  code: AuthorityDiagnosticCode;
  message: string;
  fatal: boolean;
}

export class StateAuthorityError extends Error {
  readonly code: AuthorityDiagnosticCode;

  constructor(code: AuthorityDiagnosticCode, message: string) {
    super(message);
    this.name = 'StateAuthorityError';
    this.code = code;
  }
}

export interface RootFilesystemIdentity {
  schema_version: 1;
  platform: NodeJS.Platform;
  canonical_path: string;
  device: string;
  inode: string;
  mode: string;
  birthtime_ns: string;
  strong_identity: boolean;
}

export type StateAuthorityCapabilityStatus = 'verified' | 'unsupported' | 'unverified';

export interface StateAuthorityFilesystemCapability {
  schema_version: 1;
  platform: NodeJS.Platform;
  canonical_path: string;
  exclusive_create: StateAuthorityCapabilityStatus;
  atomic_rename: StateAuthorityCapabilityStatus;
  file_sync: StateAuthorityCapabilityStatus;
  directory_sync: StateAuthorityCapabilityStatus;
  /**
   * Linux descriptor-relative no-follow operations. Platforms without a stable
   * opened-directory pathname record verified path revalidation instead.
   */
  no_follow_directories: StateAuthorityCapabilityStatus;
  /** Present on path-revalidated mutation platforms. */
  revalidated_path_mutation?: StateAuthorityCapabilityStatus;
  strong_root_identity: StateAuthorityCapabilityStatus;
  probed_at: string;
}

export interface StateAuthorityGeneration {
  schema_version: 1;
  authority_protocol_version: 1;
  authority_id: string;
  generation_id: string;
  status: 'committed';
  canonical_state_root: string;
  canonical_omx_root: string;
  root_identity: RootFilesystemIdentity;
  root_capability: StateAuthorityFilesystemCapability;
  workspace_identity: WorkspaceIdentity;
  workspace_identity_digest: string;
  creation_fence: number;
  prior_generation_id?: string;
  alternate_intent_id?: string;
  created_at: string;
  created_by_pid: number;
  created_by_process_started_at?: string;
  created_by_boot_id?: string;
  created_by_command_digest?: string;

}

export interface SessionAliasSet {
  native_session_id?: string;
  current_session_aliases: string[];
  previous_session_aliases: string[];
  owner_session_aliases: string[];
}

export interface SessionAuthorityBinding {
  schema_version: 1;
  binding_id: string;
  authority_id: string;
  generation_id: string;
  binding_revision: number;
  canonical_session_id: string;
  aliases: SessionAliasSet;
  lifecycle: 'active' | 'terminal';
  created_at: string;
  updated_at: string;
  creation_fence: number;
}

export interface WorkspaceAuthorityLease {
  launch_id: string;
  generation_id: string;
  binding_id: string;
  acquired_at: string;
  owner_nonce: string;
  fencing_token: number;
}

/**
 * The bearer capability itself is never persisted. This record binds its
 * SHA-256 digest to the current active authority tuple and revokes it when
 * that tuple changes.
 */
export interface StateAuthorityTransportCapabilityMetadata {
  schema_version: 1;
  status: 'active' | 'revoked';
  capability_digest: string;
  workspace_identity_digest: string;
  authority_id: string;
  generation_id: string;
  binding_id: string;
  binding_revision: number;
  lease_launch_id: string;
  lease_owner_nonce: string;
  fencing_token: number;
  issued_at: string;
  expires_at: string;
  revoked_at?: string;
}

export interface MintStateAuthorityTransportCapabilityInput {
  now?: Date;
  /** Bounded test hook; production callers use the 30-day maximum lifetime. */
  ttl_ms?: number;
}

export interface MintedStateAuthorityTransportCapability {
  capability: string;
  metadata: StateAuthorityTransportCapabilityMetadata;
}

export interface PendingAuthorityEstablishment {
  operation_id: string;
  launch_id: string;
  proposed_state_root: string;
  expected_anchor_revision: number;
  owner_nonce: string;
  fencing_token: number;
  journal_locator?: string;
  intent_id?: string;
  created_at: string;
}

export interface PendingAuthorityOperation {
  operation_id: string;
  generation_id: string;
  generation_locator: string;
  journal_locator: string;
  expected_anchor_revision: number;
  owner_nonce: string;
  fencing_token: number;
  kind: StateAuthorityOperationKind;
  created_at: string;
  intent_id?: string;
  binding_locator?: string;
  source_generation_id?: string;
  source_authority_locator?: string;
  source_binding_locator?: string;
  target_root_identity?: RootFilesystemIdentity;
}


export interface TerminalAuthorityLineage {
  generation_id: string;
  generation_locator: string;
  binding_revision: number;
  operation_id: string;
  status: 'terminal' | 'aborted';
  terminal_at: string;
}

export interface AbortedAuthorityEstablishment {
  operation_id: string;
  proposed_state_root: string;
  fencing_token: number;
  reason: string;
  aborted_at: string;
}

export type AlternateRootConsumerKind = 'madmax' | 'boxed' | 'team';
export type AlternateRootIntentStatus = 'preparing' | 'prepared' | 'consumed' | 'aborted';


export interface FirstPartyIssuer {
  kind: 'first-party-launcher';
  package_version: string;
  package_digest: string;
}

export interface AlternateRootBootstrapIntent {
  intent_schema_version: 1;
  authority_protocol_version: 1;
  intent_id: string;
  workspace_identity: WorkspaceIdentity;
  workspace_identity_digest: string;
  launch_id: string;
  issuer: FirstPartyIssuer;
  owner_nonce: string;
  expected_anchor_revision: number;
  fencing_token: number;
  proposed_state_root: string;
  /**
   * While status is `preparing`, these fingerprint the existing creation
   * boundary. Once the target exists they fingerprint the target root itself.
   */
  proposed_root_identity: RootFilesystemIdentity;
  proposed_root_capability: StateAuthorityFilesystemCapability;
  creation_boundary?: string;
  creation_root?: string;

  intended_consumer_kind: AlternateRootConsumerKind;
  created_at: string;
  expires_at: string;
  status: AlternateRootIntentStatus;
  consumed_by_generation_id?: string;
  consumed_at_anchor_revision?: number;
  aborted_reason?: string;
  tombstoned_at?: string;
}

export interface WorkspaceAuthorityAnchor {
  schema_version: 1;
  authority_protocol_version: 1;
  workspace_identity: WorkspaceIdentity;
  workspace_identity_digest: string;
  anchor_revision: number;
  fencing_token: number;
  active_generation_id?: string;
  active_generation_locator?: string;
  active_binding_locator?: string;
  active_lease?: WorkspaceAuthorityLease;
  transport_capability?: StateAuthorityTransportCapabilityMetadata;
  pending_establishment?: PendingAuthorityEstablishment;
  pending_operation?: PendingAuthorityOperation;
  last_terminal?: TerminalAuthorityLineage;
  alternate_intents: AlternateRootBootstrapIntent[];
  aborted_establishments: AbortedAuthorityEstablishment[];
  updated_at: string;
}

export type StateAuthorityJournalStatus = 'prepared' | 'applying' | 'committed' | 'aborted';
export type StateAuthorityOperationKind =
  | 'generation_establish'
  | 'generation_terminalize'
  | 'launch_transport_publish'
  | 'alternate_root_rollover';


export interface StateAuthorityOperationJournal {
  schema_version: 1;
  authority_protocol_version: 1;
  operation_id: string;
  kind: StateAuthorityOperationKind;
  status: StateAuthorityJournalStatus;
  authority_id: string;
  generation_id: string;
  binding_revision: number;
  /** Present and required for launch_transport_publish journals. */
  binding_id?: string;

  workspace_identity_digest: string;
  expected_anchor_revision: number;
  fencing_token: number;
  created_at: string;
  updated_at: string;
  effects_digest: string;
  completed_steps: string[];
  blocked_reason?: string;
}

/**
 * A durable post-commit transport publication. The journal is keyed by the
 * active authority generation, binding, and caller-supplied binding key; it
 * contains no bearer material.
 */
export interface StateAuthorityLaunchTransportPublication {
  operation_id: string;
  authority_protocol_version: 1;
  authority_id: string;
  generation_id: string;
  binding_id: string;
  binding_revision: number;
  workspace_identity_digest: string;
  anchor_revision: number;
  fencing_token: number;
  root_identity: RootFilesystemIdentity;
}

export interface PublishStateAuthorityLaunchTransportInput<T> {
  context: ResolvedStateAuthorityContext;
  binding_key: string;
  effects: Record<string, string>;
  /**
   * Applies only non-consumable preparation. It runs after the applying
   * journal is durable and may be retried after interruption.
   */
  prepare?: (
    context: ResolvedStateAuthorityContext,
    publication: StateAuthorityLaunchTransportPublication,
  ) => Promise<void>;
  /**
   * Publishes child-visible persistent transport while the journal is applying.
   * It must be idempotent for applying-state recovery and committed replay.
   */
  publish: (
    context: ResolvedStateAuthorityContext,
    publication: StateAuthorityLaunchTransportPublication,
  ) => Promise<T>;
  /** Verifies the durable transport effect before any caller may spawn. */
  verify: (
    context: ResolvedStateAuthorityContext,
    publication: StateAuthorityLaunchTransportPublication,
  ) => Promise<void>;
  /** Test-only crash barrier. It is never persisted or transported. */
  test_only_fault_injection?: 'after_prepared_journal' | 'after_applying_journal' | 'after_committed_journal' | 'after_persistent_publication';
}

export interface ResolvedStateAuthorityContext {
  observed_cwd: string;
  workspace_identity: WorkspaceIdentity;
  canonical_state_root: string;
  authority_path: string;
  anchor_path: string;
  generation: StateAuthorityGeneration;
  session_binding?: SessionAuthorityBinding;
}

export interface StateAuthorityResolution {
  context?: ResolvedStateAuthorityContext;
  diagnostics: AuthorityDiagnostic[];
  can_mutate: boolean;
}

export interface StateAuthorityPaths {
  workspace_root: string;
  omx_root: string;
  bootstrap_directory: string;
  anchor_path: string;
  lock_path: string;
  lock_fence_path: string;

}

export interface AuthorityGenerationPaths {
  generation_directory: string;
  authority_path: string;
  binding_directory: string;
  journal_directory: string;
}

export interface StateAuthorityLockOwner {
  host: string;
  pid: number;
  process_started_at: string;
  boot_id?: string;
  command_digest?: string;
}

export interface StateAuthorityLockRecord {
  schema_version: 1;
  owner_nonce: string;
  fencing_token: number;
  anchor_revision: number;
  owner: StateAuthorityLockOwner;
  acquired_at: string;
  heartbeat_at: string;
}

export interface AcquiredStateAuthorityLock {
  path: string;
  record: StateAuthorityLockRecord;
}

export interface StateAuthorityLockTakeoverProof {
  kind: 'owner-exited';
  owner_nonce: string;
  fencing_token: number;
  verified_at: string;
}

export interface AlternateRootIntentValidationInput {
  anchor: WorkspaceAuthorityAnchor;
  workspace_identity: WorkspaceIdentity;
  launch_id: string;
  issuer: FirstPartyIssuer;
  owner_nonce: string;
  fencing_token: number;
  expected_consumer_kind: AlternateRootConsumerKind;
  now?: Date;
}


export interface AlternateRootIntentValidation {
  valid: boolean;
  diagnostic?: AuthorityDiagnostic;
}

export interface CreateAlternateRootIntentInput {
  anchor: WorkspaceAuthorityAnchor;
  workspace_identity: WorkspaceIdentity;
  launch_id: string;
  issuer: FirstPartyIssuer;
  owner_nonce: string;
  proposed_state_root: string;
  proposed_root_identity: RootFilesystemIdentity;
  proposed_root_capability: StateAuthorityFilesystemCapability;
  intended_consumer_kind: AlternateRootConsumerKind;
  expires_at: string;
  now?: Date;
  intent_id?: string;
}

export type OrdinaryStateAuthorityRolloverFaultInjectionPoint =
  | 'after_prepared_journal'
  | 'after_pending_anchor'
  | 'after_applying_journal'
  | 'after_target_generation'
  | 'after_target_binding'
  | 'after_switched_anchor'
  | 'after_terminal_binding'
  | 'after_committed_journal';

export interface InitializeStateAuthorityInput {
  startup_cwd: string;
  observed_cwd?: string;
  launch_id: string;
  session_binding: CreateSessionAuthorityBindingInput;
  legacy_state_root_candidate?: string;
  now?: Date;
  /** Test-only crash seam. It is never persisted or transported. */
  test_only_ordinary_rollover_fault_injection?: OrdinaryStateAuthorityRolloverFaultInjectionPoint;
}

export interface CreateSessionAuthorityBindingInput {
  canonical_session_id: string;
  aliases?: Partial<SessionAliasSet>;
}

export interface ResolveStateAuthorityInput {
  startup_cwd: string;
  observed_cwd?: string;
  session_id?: string;
}

export interface StateAuthorityValidationInput {
  workspace_identity: WorkspaceIdentity;
  session_id?: string;
}

export interface StateAuthorityValidation {
  valid: boolean;
  diagnostics: AuthorityDiagnostic[];
}

export interface StateAuthorityBootstrapEvidence {
  has_pending_operation: boolean;
  has_active_generation: boolean;
  has_terminal_lineage: boolean;
  legacy_artifact_paths: string[];
  valid_legacy_candidate_count: number;
  requested_resume: boolean;
  authenticated_prepared_intent_count: number;
}

export type StateAuthorityBootstrapDecision =
  | 'recover-pending'
  | 'resolve-active'
  | 'rollover'
  | 'establish-pristine'
  | 'migrate-legacy'
  | 'deny-resume-missing'
  | 'deny-legacy-unproven'
  | 'deny-ambiguous';

export interface StateAuthorityBootstrapDecisionResult {
  decision: StateAuthorityBootstrapDecision;
  diagnostic?: AuthorityDiagnostic;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function diagnostic(
  code: AuthorityDiagnosticCode,
  message: string,
  fatal = true,
): AuthorityDiagnostic {
  return { code, message, fatal };
}

function authorityError(code: AuthorityDiagnosticCode, message: string): never {
  throw new StateAuthorityError(code, message);
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

const STATE_AUTHORITY_TRANSPORT_CAPABILITY_MAX_TTL_MS = 30 * 24 * 60 * 60_000;
const STATE_AUTHORITY_TRANSPORT_CAPABILITY_DEFAULT_TTL_MS = STATE_AUTHORITY_TRANSPORT_CAPABILITY_MAX_TTL_MS;

interface CachedStateAuthorityTransportCapability {
  capability: string;
  metadata: StateAuthorityTransportCapabilityMetadata;
}

// Process-local only. The raw bearer secret is deliberately absent from every
// authority, binding, journal, and evidence record.
const stateAuthorityTransportCapabilityCache = new Map<string, CachedStateAuthorityTransportCapability>();

function transportCapabilityCacheKey(
  workspaceDigest: string,
  generationId: string,
  bindingId: string,
  bindingRevision: number,
): string {
  return `${workspaceDigest}:${generationId}:${bindingId}:${bindingRevision}`;
}

function transportCapabilityDigest(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

function validateTransportCapabilityMetadata(
  metadata: StateAuthorityTransportCapabilityMetadata,
  anchor: WorkspaceAuthorityAnchor,
): void {
  if (!metadata || typeof metadata !== 'object' || metadata.schema_version !== 1
    || !['active', 'revoked'].includes(metadata.status)
    || !/^[0-9a-f]{64}$/i.test(metadata.capability_digest)
    || metadata.workspace_identity_digest !== anchor.workspace_identity_digest) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'workspace authority transport capability metadata is malformed');
  }
  safeIdentifier(metadata.authority_id, 'transport capability authority ID');
  safeIdentifier(metadata.generation_id, 'transport capability generation ID');
  safeIdentifier(metadata.binding_id, 'transport capability binding ID');
  nonEmptyString(metadata.lease_launch_id, 'transport capability lease launch ID', AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid);
  nonEmptyString(metadata.lease_owner_nonce, 'transport capability lease owner nonce', AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid);
  assertFiniteNonNegativeInteger(metadata.binding_revision, 'transport capability binding revision', AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid);
  assertFiniteNonNegativeInteger(metadata.fencing_token, 'transport capability fence', AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid);
  const issuedAt = new Date(metadata.issued_at);
  const expiresAt = new Date(metadata.expires_at);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())
    || expiresAt <= issuedAt
    || expiresAt.getTime() - issuedAt.getTime() > STATE_AUTHORITY_TRANSPORT_CAPABILITY_MAX_TTL_MS) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'workspace authority transport capability lifetime is invalid');
  }
  if (metadata.status === 'revoked' && Number.isNaN(new Date(metadata.revoked_at ?? '').getTime())) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'revoked workspace authority transport capability lacks a revocation timestamp');
  }
}

/**
 * An inherited authority is scoped to one canonical Git workspace identity. A
 * nested Git repository is distinct even below the authority root, and linked
 * worktrees remain distinct even when Git reports a shared common directory.
 * A startup-cwd authority retains its historical non-Git descendant scope, but
 * still rejects a descendant that establishes a Git workspace identity.
 */
export function isObservedCwdCompatibleWithStateAuthority(
  authority: Pick<ResolvedStateAuthorityContext, 'workspace_identity'>,
  observedCwd: string,
): boolean {
  try {
    const canonicalObservedCwd = canonicalizeExistingAuthorityPath(observedCwd, 'observed cwd');
    if (!isAuthorityPathWithin(authority.workspace_identity.canonical_path, canonicalObservedCwd)) return false;
    const observedWorkspace = resolveWorkspaceIdentity(canonicalObservedCwd);
    if (authority.workspace_identity.kind === 'startup-cwd') {
      return observedWorkspace.kind === 'startup-cwd';
    }
    return sameWorkspaceIdentity(authority.workspace_identity, observedWorkspace);
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown, label: string, code: AuthorityDiagnosticCode): string {
  if (typeof value !== 'string' || value.trim() === '') {
    authorityError(code, `${label} must be a non-empty string`);
  }
  return value;
}

function safeIdentifier(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, `${label} is not a safe identifier`);
  }
  return value;
}

function safeSessionIdentifier(value: string, label: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, `${label} is not a valid session identifier`);
  }
  return value;
}

function assertFiniteNonNegativeInteger(value: unknown, label: string, code: AuthorityDiagnosticCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    authorityError(code, `${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertPathInput(path: string, label: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a non-empty path`);
  }
  if (path.includes('\0')) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must not contain a NUL byte`);
  }
  return resolve(path);
}

function realpathNative(path: string): string {
  return typeof realpathSync.native === 'function' ? realpathSync.native(path) : realpathSync(path);
}

export function canonicalizeExistingAuthorityPath(path: string, label = 'path'): string {
  const resolved = assertPathInput(path, label);
  try {
    return realpathNative(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootMissing, `cannot canonicalize ${label} "${resolved}": ${detail}`);
  }
}

function trustedAuthorityPlatformRootAliasTarget(path: string): string | undefined {
  if (process.platform !== 'darwin' || dirname(path) !== '/') return undefined;
  return path === '/var'
    ? '/private/var'
    : path === '/tmp'
      ? '/private/tmp'
      : undefined;
}

export async function isTrustedAuthorityPlatformRootAlias(
  path: string,
  initial: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino'>,
): Promise<boolean> {
  const expectedTarget = trustedAuthorityPlatformRootAliasTarget(path);
  if (!expectedTarget) return false;
  try {
    const before = await lstat(path);
    const beforeTarget = await lstat(expectedTarget);
    if (
      !before.isSymbolicLink()
      || initial.dev !== before.dev
      || initial.ino !== before.ino
      || !beforeTarget.isDirectory()
      || beforeTarget.isSymbolicLink()
    ) return false;
    const canonical = realpathNative(path);
    const after = await lstat(path);
    const afterTarget = await lstat(expectedTarget);
    return canonical === expectedTarget
      && realpathNative(expectedTarget) === expectedTarget
      && after.isSymbolicLink()
      && before.dev === after.dev
      && before.ino === after.ino
      && isRevalidatedSameDirectoryIdentity(
        beforeTarget,
        beforeTarget,
        afterTarget,
        afterTarget,
      );
  } catch {
    return false;
  }
}

function canonicalizeTrustedAuthorityPlatformRootAliasSync(
  path: string,
  initial: { dev: number; ino: number },
  initialTarget?: RevalidatedDirectoryIdentity,
): string | undefined {
  const expectedTarget = trustedAuthorityPlatformRootAliasTarget(path);
  if (!expectedTarget) return undefined;
  try {
    const before = lstatSync(path);
    const beforeTarget = lstatSync(expectedTarget);
    if (
      !before.isSymbolicLink()
      || initial.dev !== before.dev
      || initial.ino !== before.ino
    ) return undefined;
    const canonical = realpathNative(path);
    const after = lstatSync(path);
    const afterTarget = lstatSync(expectedTarget);
    return canonical === expectedTarget
      && realpathNative(expectedTarget) === expectedTarget
      && after.isSymbolicLink()
      && before.dev === after.dev
      && before.ino === after.ino
      && isRevalidatedSameDirectoryIdentity(
        initialTarget ?? beforeTarget,
        beforeTarget,
        afterTarget,
        afterTarget,
      )
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}


export interface RevalidatedDirectoryIdentity {
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Windows may report a non-symlink 8.3 spelling and its long spelling for the
 * same directory. Every observation must be a directory with the same
 * identity, so this never blesses a symlink or a replacement race.
 */
export function isRevalidatedSameDirectoryIdentity(
  beforeAlias: RevalidatedDirectoryIdentity,
  beforeCanonical: RevalidatedDirectoryIdentity,
  afterAlias: RevalidatedDirectoryIdentity,
  afterCanonical: RevalidatedDirectoryIdentity,
): boolean {
  const observations = [beforeAlias, beforeCanonical, afterAlias, afterCanonical];
  return observations.every((details) => details.isDirectory() && !details.isSymbolicLink())
    && observations.every((details) => details.dev === beforeAlias.dev && details.ino === beforeAlias.ino);
}

export function canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync(
  path: string,
): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  const components: string[] = [];
  let cursor = assertPathInput(path, 'Darwin directory alias');
  while (dirname(cursor) !== cursor) {
    components.unshift(basename(cursor));
    cursor = dirname(cursor);
  }

  let current = cursor;
  let canonicalCurrent = cursor;
  const observations: Array<{
    alias: string;
    canonical: string;
    beforeAlias: RevalidatedDirectoryIdentity;
    beforeCanonical: RevalidatedDirectoryIdentity;
    trustedRootAlias: boolean;
  }> = [];
  try {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      current = join(current, component);
      let beforeAlias: ReturnType<typeof lstatSync>;
      try {
        beforeAlias = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const candidate = components.slice(index).reduce(
          (root, suffix) => join(root, suffix),
          canonicalCurrent,
        );
        for (const observation of observations) {
          const valid = observation.trustedRootAlias
            ? canonicalizeTrustedAuthorityPlatformRootAliasSync(
                observation.alias,
                observation.beforeAlias,
                observation.beforeCanonical,
              ) === observation.canonical
            : isRevalidatedSameDirectoryIdentity(
                observation.beforeAlias,
                observation.beforeCanonical,
                lstatSync(observation.alias),
                lstatSync(observation.canonical),
              );
          if (!valid) return undefined;
        }
        return candidate;
      }

      if (beforeAlias.isSymbolicLink()) {
        const canonicalAlias = canonicalizeTrustedAuthorityPlatformRootAliasSync(current, beforeAlias);
        if (!canonicalAlias) return undefined;
        observations.push({
          alias: current,
          canonical: canonicalAlias,
          beforeAlias,
          beforeCanonical: lstatSync(canonicalAlias),
          trustedRootAlias: true,
        });
        canonicalCurrent = canonicalAlias;
      } else {
        const canonical = join(canonicalCurrent, component);
        observations.push({
          alias: current,
          canonical,
          beforeAlias,
          beforeCanonical: lstatSync(canonical),
          trustedRootAlias: false,
        });
        canonicalCurrent = canonical;
      }
    }

    for (const observation of observations) {
      const valid = observation.trustedRootAlias
        ? canonicalizeTrustedAuthorityPlatformRootAliasSync(
            observation.alias,
            observation.beforeAlias,
            observation.beforeCanonical,
          ) === observation.canonical
        : isRevalidatedSameDirectoryIdentity(
            observation.beforeAlias,
            observation.beforeCanonical,
            lstatSync(observation.alias),
            lstatSync(observation.canonical),
          );
      if (!valid) return undefined;
    }
    return canonicalCurrent;
  } catch {
    return undefined;
  }
}

/**
 * Revalidates each existing component of a Windows directory path. This
 * admits only non-symlink 8.3/long-name aliases for the same directory.
 */
export function canonicalizeTrustedAuthorityWindowsDirectoryAliasComponentsSync(
  path: string,
): string | undefined {
  if (process.platform !== 'win32') return undefined;

  const components: string[] = [];
  let cursor = assertPathInput(path, 'Windows directory alias');
  while (dirname(cursor) !== cursor) {
    components.unshift(basename(cursor));
    cursor = dirname(cursor);
  }

  let current = cursor;
  let canonicalCurrent = cursor;
  const observations: Array<{
    alias: string;
    canonical: string;
    beforeAlias: RevalidatedDirectoryIdentity;
    beforeCanonical: RevalidatedDirectoryIdentity;
  }> = [];
  try {
    for (const component of components) {
      current = join(current, component);
      const beforeAlias = lstatSync(current);
      const canonical = realpathNative(current);
      observations.push({
        alias: current,
        canonical,
        beforeAlias,
        beforeCanonical: lstatSync(canonical),
      });
      canonicalCurrent = canonical;
    }
    for (const observation of observations) {
      if (!isRevalidatedSameDirectoryIdentity(
        observation.beforeAlias,
        observation.beforeCanonical,
        lstatSync(observation.alias),
        lstatSync(observation.canonical),
      )) return undefined;
    }
    return canonicalCurrent;
  } catch {
    return undefined;
  }
}

function canonicalizeTrustedAuthorityWindowsPathForCreation(path: string): string | undefined {
  if (process.platform !== 'win32') return undefined;

  const resolved = assertPathInput(path, 'Windows authority path');
  let candidate = resolved;
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    suffix.unshift(basename(candidate));
    candidate = parent;
  }

  const canonicalAncestor = canonicalizeTrustedAuthorityWindowsDirectoryAliasComponentsSync(candidate);
  return canonicalAncestor
    ? suffix.reduce((current, segment) => join(current, segment), canonicalAncestor)
    : undefined;
}

function hasTrustedAuthorityCanonicalPath(path: string, canonical: string): boolean {
  return path === canonical
    || canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync(path) === canonical
    || canonicalizeTrustedAuthorityWindowsPathForCreation(path) === canonical;
}

export function canonicalizeAuthorityPathForCreation(path: string, label = 'path'): string {
  const resolved = assertPathInput(path, label);
  let candidate = resolved;
  const suffix: string[] = [];

  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootMissing, `no existing ancestor exists for ${label}`);
    }
    suffix.unshift(basename(candidate));
    candidate = parent;
  }

  const canonicalAncestor = canonicalizeExistingAuthorityPath(candidate, `${label} ancestor`);
  return suffix.reduce((current, segment) => join(current, segment), canonicalAncestor);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function isAuthorityPathWithin(root: string, candidate: string): boolean {
  if (isPathWithin(root, candidate)) return true;
  if (process.platform !== 'win32') return false;

  try {
    const canonicalRoot = canonicalizeTrustedAuthorityWindowsPathForCreation(root);
    const canonicalCandidate = canonicalizeTrustedAuthorityWindowsPathForCreation(candidate);
    return canonicalRoot !== undefined
      && canonicalCandidate !== undefined
      && isPathWithin(canonicalRoot, canonicalCandidate);
  } catch {
    return false;
  }
}


export function resolveAuthorityChildPath(root: string, ...parts: string[]): string {
  const canonicalRoot = canonicalizeExistingAuthorityPath(root, 'authority root');
  if (parts.length === 0) return canonicalRoot;
  for (const part of parts) {
    if (!SAFE_ID_PATTERN.test(part)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority path segment "${part}" is unsafe`);
    }
  }
  const candidate = resolve(canonicalRoot, ...parts);
  const canonicalCandidate = canonicalizeAuthorityPathForCreation(candidate, 'authority child path');
  if (!isAuthorityPathWithin(canonicalRoot, canonicalCandidate)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'authority child path escapes its canonical root');
  }
  return canonicalCandidate;
}

async function assertDirectoryNotSymlink(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!details.isDirectory()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a directory: ${path}`);
  }
}

async function assertPathHasNoSymlinkComponents(path: string, label: string): Promise<void> {
  const target = assertPathInput(path, label);
  const components: string[] = [];
  let cursor = target;
  while (dirname(cursor) !== cursor) {
    components.unshift(basename(cursor));
    cursor = dirname(cursor);
  }

  let current = cursor;
  const rootDetails = await lstat(current);
  if (rootDetails.isSymbolicLink()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} has a symbolic-link root component: ${current}`);
  }
  for (const component of components) {
    current = join(current, component);
    try {
      const details = await lstat(current);
      if (
        details.isSymbolicLink()
        && !await isTrustedAuthorityPlatformRootAlias(current, details)
      ) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} has a symbolic-link component: ${current}`);
      }
    } catch (error) {
      if (error instanceof StateAuthorityError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertAuthorityLocator(
  root: string,
  locator: string,
  expected: string,
  label: string,
): Promise<void> {
  const canonicalRoot = canonicalizeExistingAuthorityPath(root, `${label} root`);
  const resolvedLocator = assertPathInput(locator, label);
  if (resolvedLocator !== expected || !isAuthorityPathWithin(canonicalRoot, resolvedLocator)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} is outside its canonical authority root`);
  }
  await assertPathHasNoSymlinkComponents(resolvedLocator, label);
  if (canonicalizeExistingAuthorityPath(resolvedLocator, label) !== expected) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} canonical path does not match its expected authority locator`);
  }
}

export async function ensureAuthorityDirectory(root: string, directory: string): Promise<string> {
  const canonicalRoot = canonicalizeExistingAuthorityPath(root, 'authority root');
  const target = assertPathInput(directory, 'authority directory');
  if (!isAuthorityPathWithin(canonicalRoot, target)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority directory escapes root: ${target}`);
  }
  const relativeTarget = relative(canonicalRoot, target);
  if (relativeTarget === '') return canonicalRoot;
  const segments = relativeTarget.split(/[\\/]+/);
  const rootIdentity = await captureRootFilesystemIdentity(canonicalRoot);
  let openedRoot: OpenedAuthorityDirectory | undefined;
  let current: OpenedAuthorityDirectory | undefined;
  try {
    openedRoot = await openNoFollowAuthorityDirectory(canonicalRoot, 'authority root', {
      dev: Number(rootIdentity.device),
      ino: Number(rootIdentity.inode),
    });
    current = openedRoot;
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(segment)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority directory segment "${segment}" is unsafe`);
      }
      const stableChildPath = join(current.path, segment);
      const childPath = join(current.descriptor_path, segment);
      try {
        await assertOpenedAuthorityDirectoryCurrent(current, 'authority directory parent');
        await mkdir(childPath, { mode: 0o700 });
        await syncOpenedAuthorityDirectory(current.handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const child = await openNoFollowAuthorityDirectory(childPath, 'authority directory');
      child.path = stableChildPath;
      if (current !== openedRoot) await current.handle?.close();
      current = child;
      await assertOpenedAuthorityDirectoryCurrent(openedRoot, 'authority root');
      const actualRoot = await captureRootFilesystemIdentity(canonicalRoot);
      if (!sameRootFilesystemIdentity(rootIdentity, actualRoot)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority root was replaced while creating an authority directory');
      }
    }
    return target;
  } finally {
    if (current && current !== openedRoot) await current.handle?.close().catch(() => undefined);
    await openedRoot?.handle?.close().catch(() => undefined);
  }
}


interface OpenedAuthorityDirectory {
  handle?: Awaited<ReturnType<typeof open>>;
  descriptor_path: string;
  path: string;
  device: number;
  inode: number;
}

interface AuthorityMutationScope {
  root_path: string;
  root_identity: RootFilesystemIdentity;
  root: OpenedAuthorityDirectory;
  parent: OpenedAuthorityDirectory;
}

/**
 * These hooks are intentionally test-only. They are never persisted or exposed
 * to authority consumers; each sits immediately before an unsafe-looking path
 * boundary so replacement tests exercise the actual implementation boundary.
 */
export interface AtomicAuthorityWriteOptions {
  authority_root?: string;
  expected_root_identity?: RootFilesystemIdentity;
  test_only_after_validation_before_open?: () => void | Promise<void>;
  test_only_before_rename?: (temporary_path: string) => void | Promise<void>;

}

export interface StateAuthorityFilesystemPrimitive {
  directory_open_flags: number | null;
  file_open_flags: number | null;
  descriptor_relative: boolean;
}

/**
 * Linux mutations are pinned to an opened no-follow directory descriptor.
 * Node does not expose an equivalent stable descriptor pathname on Windows or
 * macOS, so those platforms use canonical paths with filesystem identity
 * revalidated before and after every operation.
 */
export function stateAuthorityFilesystemPrimitiveForPlatform(
  platform: NodeJS.Platform = process.platform,
): StateAuthorityFilesystemPrimitive {
  if (platform === 'win32') {
    return {
      directory_open_flags: null,
      file_open_flags: 0,
      descriptor_relative: false,
    };
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : null;
  const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : null;
  if (platform !== 'linux') {
    return {
      directory_open_flags: noFollow === null || directoryOnly === null
        ? null
        : fsConstants.O_RDONLY | directoryOnly | noFollow,
      file_open_flags: noFollow,
      descriptor_relative: false,
    };
  }
  if (directoryOnly === null || noFollow === null) {
    return {
      directory_open_flags: null,
      file_open_flags: null,
      descriptor_relative: false,
    };
  }
  return {
    directory_open_flags: fsConstants.O_RDONLY | directoryOnly | noFollow,
    file_open_flags: noFollow,
    descriptor_relative: true,
  };
}


function noFollowFileOpenFlags(): number | null {
  return stateAuthorityFilesystemPrimitiveForPlatform().file_open_flags;
}

function sameStatIdentity(
  actual: { dev: number; ino: number },
  expected: { dev: number; ino: number },
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function descriptorRelativeDirectoryPath(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string | null> {
  if (!stateAuthorityFilesystemPrimitiveForPlatform().descriptor_relative) return null;
  const held = await handle.stat();
  const candidates = process.platform === 'linux'
    ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
    : [`/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (details.isDirectory() && sameStatIdentity(details, held)) return candidate;
    } catch {
      // Try the next platform-specific descriptor namespace.
    }
  }
  return null;
}

async function syncOpenedAuthorityDirectory(
  handle: Awaited<ReturnType<typeof open>> | undefined,
): Promise<StateAuthorityCapabilityStatus> {
  if (!handle || process.platform === 'win32') return 'unsupported';
  await handle.sync();
  return 'verified';
}

async function openNoFollowAuthorityDirectory(
  path: string,
  label: string,
  expected?: { dev: number; ino: number },
): Promise<OpenedAuthorityDirectory> {
  const primitive = stateAuthorityFilesystemPrimitiveForPlatform();
  const initial = await lstat(path);
  if (initial.isSymbolicLink()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `${label} must not be a symbolic link: ${path}`);
  }
  if (!initial.isDirectory()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `${label} must be a directory: ${path}`);
  }
  if (expected && !sameStatIdentity(initial, expected)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed before it could be opened safely`);
  }
  if (!primitive.descriptor_relative) {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameStatIdentity(initial, current)
      || (expected !== undefined && !sameStatIdentity(current, expected))) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while it was being opened safely`);
    }
    return {
      descriptor_path: path,
      path,
      device: current.dev,
      inode: current.ino,
    };
  }
  const flags = primitive.directory_open_flags;
  if (flags === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow directory opens');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, flags);
    const held = await handle.stat();
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameStatIdentity(initial, held)
      || !sameStatIdentity(current, held)
      || (expected !== undefined && !sameStatIdentity(held, expected))) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while it was being opened safely`);
    }
    const descriptorPath = await descriptorRelativeDirectoryPath(handle);
    if (!descriptorPath) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime cannot address an opened directory for descriptor-relative authority mutation');
    }
    return {
      handle,
      descriptor_path: descriptorPath,
      path,
      device: held.dev,
      inode: held.ino,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function assertOpenedAuthorityDirectoryCurrent(
  directory: OpenedAuthorityDirectory,
  label: string,
): Promise<void> {
  const current = await lstat(directory.path);
  const expected = { dev: directory.device, ino: directory.inode };
  const held = directory.handle ? await directory.handle.stat() : undefined;
  if (current.isSymbolicLink() || !current.isDirectory()
    || !sameStatIdentity(current, expected)
    || (held !== undefined && !sameStatIdentity(held, expected))) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} was replaced during authority mutation`);
  }
}

async function assertAuthorityMutationScopeCurrent(scope: AuthorityMutationScope): Promise<void> {
  await assertOpenedAuthorityDirectoryCurrent(scope.root, 'authority mutation root');
  const rootIdentity = await captureRootFilesystemIdentity(scope.root_path);
  if (!sameRootFilesystemIdentity(scope.root_identity, rootIdentity)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority mutation root fingerprint changed during authority mutation');
  }
  if (scope.parent !== scope.root) {
    await assertOpenedAuthorityDirectoryCurrent(scope.parent, 'authority mutation parent');
  }
}

async function openAuthorityMutationScope(
  target: string,
  options: AtomicAuthorityWriteOptions,
): Promise<AuthorityMutationScope> {
  const requestedTarget = assertPathInput(target, 'authority file');
  await assertPathHasNoSymlinkComponents(requestedTarget, 'authority file');
  const canonicalTarget = canonicalizeAuthorityPathForCreation(requestedTarget, 'authority file');
  const requestedRoot = options.authority_root ?? dirname(requestedTarget);
  const rootPath = canonicalizeExistingAuthorityPath(requestedRoot, 'authority mutation root');
  if (!isAuthorityPathWithin(rootPath, canonicalTarget)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority file escapes its mutation root: ${requestedTarget}`);
  }
  await assertPathHasNoSymlinkComponents(rootPath, 'authority mutation root');
  const rootIdentity = options.expected_root_identity ?? await captureRootFilesystemIdentity(rootPath);
  if (!sameRootFilesystemIdentity(rootIdentity, await captureRootFilesystemIdentity(rootPath))) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority mutation root does not match the expected root fingerprint');
  }
  await options.test_only_after_validation_before_open?.();
  if (!sameRootFilesystemIdentity(rootIdentity, await captureRootFilesystemIdentity(rootPath))) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority mutation root was replaced between validation and open');
  }

  let root: OpenedAuthorityDirectory | undefined;
  let parent: OpenedAuthorityDirectory | undefined;
  try {
    root = await openNoFollowAuthorityDirectory(rootPath, 'authority mutation root', {
      dev: Number(rootIdentity.device),
      ino: Number(rootIdentity.inode),
    });
    const parentPath = dirname(canonicalTarget);
    const relativeParent = relative(rootPath, parentPath);
    const segments = relativeParent === '' ? [] : relativeParent.split(/[\\/]+/);
    let current = root;
    let canonicalCurrentPath = rootPath;
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(segment)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority mutation parent segment "${segment}" is unsafe`);
      }
      const childPath = join(current.descriptor_path, segment);
      canonicalCurrentPath = join(canonicalCurrentPath, segment);
      const opened = await openNoFollowAuthorityDirectory(childPath, 'authority mutation parent');
      opened.path = canonicalCurrentPath;
      if (current !== root) await current.handle?.close();
      current = opened;
    }
    parent = current;
    const scope: AuthorityMutationScope = {
      root_path: rootPath,
      root_identity: rootIdentity,
      root,
      parent,
    };
    await assertAuthorityMutationScopeCurrent(scope);
    return scope;
  } catch (error) {
    await parent?.handle?.close().catch(() => undefined);
    if (root && root !== parent) await root.handle?.close().catch(() => undefined);
    throw error;
  }
}

async function closeAuthorityMutationScope(scope: AuthorityMutationScope): Promise<void> {
  if (scope.parent !== scope.root) await scope.parent.handle?.close();
  await scope.root.handle?.close();
}

async function assertAuthorityMutationTarget(
  scope: AuthorityMutationScope,
  basenameTarget: string,
): Promise<void> {
  const finalFlags = noFollowFileOpenFlags() ?? 0;
  const path = join(scope.parent.descriptor_path, basenameTarget);
  try {
    const initial = await lstat(path);
    if (initial.isSymbolicLink()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `authority file must not be a symbolic link: ${basenameTarget}`);
    }
    if (!initial.isFile()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority target must be a regular file: ${basenameTarget}`);
    }
    const handle = await open(path, fsConstants.O_RDONLY | finalFlags);
    try {
      const held = await handle.stat();
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()
        || !sameStatIdentity(initial, held)
        || !sameStatIdentity(current, held)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority file changed while it was being opened safely: ${basenameTarget}`);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readAuthorityFileWithExpectedIdentity(
  path: string,
  expected: { dev: number; ino: number },
  openFlags: number,
  label: string,
): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | openFlags);
  try {
    const opened = await handle.stat();
    const beforeRead = await lstat(path);
    if (beforeRead.isSymbolicLink() || !beforeRead.isFile()
      || !sameStatIdentity(expected, opened)
      || !sameStatIdentity(opened, beforeRead)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while it was being opened safely`);
    }
    const content = await handle.readFile();
    const afterRead = await lstat(path);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameStatIdentity(opened, afterRead)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `${label} changed while it was being read safely`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function fsyncAuthorityDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    await assertDirectoryNotSymlink(directory, 'authority directory');
    return;
  }
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteAuthorityFile(
  path: string,
  content: string | Buffer,
  options: AtomicAuthorityWriteOptions = {},
): Promise<void> {
  const target = assertPathInput(path, 'authority file');
  const basenameTarget = basename(target);
  if (basenameTarget === '.' || basenameTarget === '..') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'authority file has an unsafe basename');
  }
  const scope = await openAuthorityMutationScope(target, options);
  const noFollow = noFollowFileOpenFlags() ?? 0;
  const temporaryName = `.${basenameTarget}.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
  const temporaryPath = join(scope.parent.descriptor_path, temporaryName);
  const targetPath = join(scope.parent.descriptor_path, basenameTarget);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let temporaryCreated = false;
  const expectedContent = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    await assertAuthorityMutationTarget(scope, basenameTarget);
    handle = await open(
      temporaryPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    const held = await handle.stat();
    temporaryIdentity = held;
    const current = await lstat(temporaryPath);
    if (current.isSymbolicLink() || !current.isFile() || !sameStatIdentity(held, current)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority temporary file changed while it was being opened safely');
    }
    await assertAuthorityMutationScopeCurrent(scope);
    await handle.writeFile(expectedContent);
    await handle.sync();
    if (process.platform === 'win32') {
      await handle.close();
      handle = undefined;
    }

    await assertAuthorityMutationScopeCurrent(scope);
    await options.test_only_before_rename?.(temporaryPath);
    await assertAuthorityMutationScopeCurrent(scope);
    const sourceBeforeRename = await lstat(temporaryPath);
    if (sourceBeforeRename.isSymbolicLink() || !sourceBeforeRename.isFile() || !sameStatIdentity(held, sourceBeforeRename)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority temporary file was replaced before publication');
    }
    const heldContent = handle
      ? await (async () => {
          const buffer = Buffer.alloc(expectedContent.length);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return bytesRead === expectedContent.length ? buffer : Buffer.alloc(0);
        })()
      : await readAuthorityFileWithExpectedIdentity(
          temporaryPath,
          held,
          noFollow,
          'authority temporary file',
        );
    if (!heldContent.equals(expectedContent)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority temporary file content changed before publication');
    }
    await assertAuthorityMutationTarget(scope, basenameTarget);
    await rename(temporaryPath, targetPath);
    temporaryCreated = false;
    await syncOpenedAuthorityDirectory(scope.parent.handle);

    const published = await lstat(targetPath);
    if (published.isSymbolicLink() || !published.isFile() || !sameStatIdentity(held, published)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority destination was replaced during publication');
    }
    const publishedContent = await readAuthorityFileWithExpectedIdentity(
      targetPath,
      held,
      noFollow,
      'authority destination',
    );
    if (!publishedContent.equals(expectedContent)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'authority destination changed during publication verification');
    }
    await assertAuthorityMutationScopeCurrent(scope);
  } catch (error) {
    if (temporaryCreated && temporaryIdentity) {
      try {
        const current = await lstat(temporaryPath);
        await assertAuthorityMutationScopeCurrent(scope);
        if (!current.isSymbolicLink() && current.isFile() && sameStatIdentity(temporaryIdentity, current)) {
          await unlink(temporaryPath);
          await syncOpenedAuthorityDirectory(scope.parent.handle);
        }
      } catch {
        // A substituted temporary must never be deleted by this failed writer.
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await closeAuthorityMutationScope(scope).catch(() => undefined);
  }
}

async function readAuthorityFileNoFollow(
  path: string,
  options: AtomicAuthorityWriteOptions,
): Promise<string | null> {
  const target = assertPathInput(path, 'authority file');
  const basenameTarget = basename(target);
  if (basenameTarget === '.' || basenameTarget === '..') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'authority file has an unsafe basename');
  }
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow final-file opens');
  }
  const scope = await openAuthorityMutationScope(target, options);
  const targetPath = join(scope.parent.descriptor_path, basenameTarget);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertAuthorityMutationScopeCurrent(scope);
    let initial: Awaited<ReturnType<typeof lstat>>;
    try {
      initial = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (initial.isSymbolicLink()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `authority file must not be a symbolic link: ${basenameTarget}`);
    }
    if (!initial.isFile()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `authority file must be a regular file: ${basenameTarget}`);
    }
    try {
      handle = await open(targetPath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `authority file must not be a symbolic link: ${basenameTarget}`);
      }
      throw error;
    }
    const held = await handle.stat();
    const afterOpen = await lstat(targetPath);
    if (afterOpen.isSymbolicLink() || !afterOpen.isFile()
      || !sameStatIdentity(initial, held)
      || !sameStatIdentity(afterOpen, held)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority file changed while it was being opened safely: ${basenameTarget}`);
    }
    await assertAuthorityMutationScopeCurrent(scope);
    const content = await handle.readFile('utf-8');
    const afterRead = await lstat(targetPath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || !sameStatIdentity(afterRead, held)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority file changed while it was being read safely: ${basenameTarget}`);
    }
    await assertAuthorityMutationScopeCurrent(scope);
    return content;
  } finally {
    await handle?.close().catch(() => undefined);
    await closeAuthorityMutationScope(scope).catch(() => undefined);
  }
}

async function appendAuthorityFileNoFollow(
  path: string,
  content: string,
  options: AtomicAuthorityWriteOptions,
): Promise<void> {
  const target = assertPathInput(path, 'authority file');
  const basenameTarget = basename(target);
  if (basenameTarget === '.' || basenameTarget === '..') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'authority file has an unsafe basename');
  }
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow final-file opens');
  }
  const scope = await openAuthorityMutationScope(target, options);
  const targetPath = join(scope.parent.descriptor_path, basenameTarget);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertAuthorityMutationScopeCurrent(scope);
    await assertAuthorityMutationTarget(scope, basenameTarget);
    try {
      handle = await open(targetPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `authority file must not be a symbolic link: ${basenameTarget}`);
      }
      throw error;
    }
    const held = await handle.stat();
    const afterOpen = await lstat(targetPath);
    if (afterOpen.isSymbolicLink() || !afterOpen.isFile() || !sameStatIdentity(held, afterOpen)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority file changed while it was being opened safely: ${basenameTarget}`);
    }
    await assertAuthorityMutationScopeCurrent(scope);
    await handle.writeFile(content);
    await handle.sync();
    const afterWrite = await lstat(targetPath);
    if (afterWrite.isSymbolicLink() || !afterWrite.isFile() || !sameStatIdentity(held, afterWrite)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority file changed while it was being appended safely: ${basenameTarget}`);
    }
    await assertAuthorityMutationScopeCurrent(scope);
    await syncOpenedAuthorityDirectory(scope.parent.handle);
  } finally {
    await handle?.close().catch(() => undefined);
    await closeAuthorityMutationScope(scope).catch(() => undefined);
  }
}

export async function atomicWriteAuthorityJson(
  path: string,
  value: unknown,
  options: AtomicAuthorityWriteOptions = {},
): Promise<void> {
  await atomicWriteAuthorityFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function readAuthorityJson(path: string, code: AuthorityDiagnosticCode): Promise<unknown> {
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow final-file opens');
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(path);
    if (initial.isSymbolicLink()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `authority JSON must not be a symbolic link: ${path}`);
    }
    if (!initial.isFile()) {
      authorityError(code, `authority JSON is not a regular file: ${path}`);
    }
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const held = await handle.stat();
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()
      || !sameStatIdentity(initial, held)
      || !sameStatIdentity(current, held)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority JSON changed while it was being opened safely: ${path}`);
    }
    const raw = await handle.readFile('utf-8');
    const final = await lstat(path);
    if (final.isSymbolicLink() || !final.isFile() || !sameStatIdentity(final, held)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, `authority JSON changed while it was being read safely: ${path}`);
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if (error instanceof SyntaxError) {
      authorityError(code, `authority JSON is invalid: ${path}`);
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      authorityError(code, `authority JSON is missing or its root fingerprint changed: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function workspaceComparableValue(workspace: WorkspaceIdentity): Record<string, unknown> {
  if (workspace.kind === 'git-worktree') {
    return {
      schema_version: workspace.schema_version,
      kind: workspace.kind,
      canonical_path: workspace.canonical_path,
      git_dir: workspace.git_dir,
      git_common_dir: workspace.git_common_dir,
    };
  }
  return {
    schema_version: workspace.schema_version,
    kind: workspace.kind,
    canonical_path: workspace.canonical_path,
  };
}

export function workspaceIdentityDigest(workspace: WorkspaceIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify(workspaceComparableValue(workspace)))
    .digest('hex');
}

export function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.digest === right.digest
    && left.kind === right.kind
    && left.canonical_path === right.canonical_path
    && (left.kind !== 'git-worktree' || right.kind !== 'git-worktree'
      || (left.git_dir === right.git_dir && left.git_common_dir === right.git_common_dir));
}

export function resolveOrdinaryStateRoot(workspace: WorkspaceIdentity): string {
  return join(workspace.canonical_path, '.omx', 'state');
}

export function stateAuthorityPaths(workspace: WorkspaceIdentity): StateAuthorityPaths {
  const workspaceRoot = workspace.canonical_path;
  const omxRoot = join(workspaceRoot, '.omx');
  const bootstrapDirectory = join(omxRoot, 'bootstrap');
  return {
    workspace_root: workspaceRoot,
    omx_root: omxRoot,
    bootstrap_directory: bootstrapDirectory,
    anchor_path: join(bootstrapDirectory, STATE_AUTHORITY_ANCHOR_FILE),
    lock_path: join(bootstrapDirectory, STATE_AUTHORITY_LOCK),
    lock_fence_path: join(bootstrapDirectory, STATE_AUTHORITY_LOCK_FENCE_COUNTER_FILE),

  };
}

export function authorityGenerationPaths(
  canonicalStateRoot: string,
  generationId: string,
): AuthorityGenerationPaths {
  const safeGenerationId = safeIdentifier(generationId, 'generation ID');
  const generationDirectory = join(canonicalStateRoot, 'authority', 'generations', safeGenerationId);
  return {
    generation_directory: generationDirectory,
    authority_path: join(generationDirectory, STATE_AUTHORITY_FILE),
    binding_directory: join(generationDirectory, 'bindings'),
    journal_directory: join(generationDirectory, STATE_AUTHORITY_JOURNAL_DIRECTORY),
  };
}

export function authorityBindingPath(
  canonicalStateRoot: string,
  generationId: string,
  bindingId: string,
): string {
  return join(
    authorityGenerationPaths(canonicalStateRoot, generationId).binding_directory,
    `${safeIdentifier(bindingId, 'binding ID')}.json`,
  );
}

export function authorityJournalPath(
  canonicalStateRoot: string,
  generationId: string,
  operationId: string,
): string {
  return join(
    authorityGenerationPaths(canonicalStateRoot, generationId).journal_directory,
    `${safeIdentifier(operationId, 'operation ID')}.json`,
  );
}

export async function captureRootFilesystemIdentity(root: string): Promise<RootFilesystemIdentity> {
  const canonicalPath = canonicalizeExistingAuthorityPath(root, 'state root');
  const details = await stat(canonicalPath, { bigint: true });
  if (!details.isDirectory()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootMissing, `state root is not a directory: ${canonicalPath}`);
  }
  const device = details.dev.toString();
  const inode = details.ino.toString();
  return {
    schema_version: 1,
    platform: process.platform,
    canonical_path: canonicalPath,
    device,
    inode,
    mode: details.mode.toString(),
    birthtime_ns: details.birthtimeNs.toString(),
    strong_identity: details.dev !== 0n && details.ino !== 0n,
  };
}

export function sameRootFilesystemIdentity(
  left: RootFilesystemIdentity,
  right: RootFilesystemIdentity,
): boolean {
  return left.schema_version === right.schema_version
    && left.platform === right.platform
    && left.canonical_path === right.canonical_path
    && left.device === right.device
    && left.inode === right.inode
    && (
      left.birthtime_ns === '0'
      || right.birthtime_ns === '0'
      || left.birthtime_ns === right.birthtime_ns
    )
    && left.strong_identity
    && right.strong_identity;
}

async function probeAuthorityMutationPrimitive(
  canonicalRoot: string,
): Promise<Pick<
  StateAuthorityFilesystemCapability,
  | 'exclusive_create'
  | 'atomic_rename'
  | 'file_sync'
  | 'directory_sync'
  | 'no_follow_directories'
  | 'revalidated_path_mutation'
>> {
  const primitive = stateAuthorityFilesystemPrimitiveForPlatform();
  const unsupported = (): Pick<
    StateAuthorityFilesystemCapability,
    | 'exclusive_create'
    | 'atomic_rename'
    | 'file_sync'
    | 'directory_sync'
    | 'no_follow_directories'
    | 'revalidated_path_mutation'
  > => ({
    exclusive_create: 'unsupported',
    atomic_rename: 'unsupported',
    file_sync: 'unsupported',
    directory_sync: 'unsupported',
    no_follow_directories: 'unsupported',
    ...(primitive.descriptor_relative ? {} : { revalidated_path_mutation: 'unverified' as const }),
  });
  const unverified = (): Pick<
    StateAuthorityFilesystemCapability,
    | 'exclusive_create'
    | 'atomic_rename'
    | 'file_sync'
    | 'directory_sync'
    | 'no_follow_directories'
    | 'revalidated_path_mutation'
  > => ({
    exclusive_create: 'unverified',
    atomic_rename: 'unverified',
    file_sync: 'unverified',
    directory_sync: 'unverified',
    no_follow_directories: primitive.descriptor_relative ? 'unverified' : 'unsupported',
    ...(primitive.descriptor_relative ? {} : { revalidated_path_mutation: 'unverified' as const }),
  });
  let directory: OpenedAuthorityDirectory | undefined;
  let temporaryPath: string | undefined;
  let finalPath: string | undefined;
  let temporaryCreated = false;
  try {
    directory = await openNoFollowAuthorityDirectory(canonicalRoot, 'state root');
    const noFollow = noFollowFileOpenFlags();
    if (noFollow === null) return unsupported();
    const nonce = randomBytes(8).toString('hex');
    temporaryPath = join(directory.descriptor_path, `.authority-probe-${nonce}.tmp`);
    finalPath = join(directory.descriptor_path, `.authority-probe-${nonce}`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    try {
      const held = await handle.stat();
      const current = await lstat(temporaryPath);
      if (current.isSymbolicLink() || !current.isFile() || !sameStatIdentity(held, current)) return unverified();
      await assertOpenedAuthorityDirectoryCurrent(directory, 'state root');
      await handle.writeFile('authority capability probe\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertOpenedAuthorityDirectoryCurrent(directory, 'state root');
    await rename(temporaryPath, finalPath);
    temporaryCreated = false;
    const directorySync = await syncOpenedAuthorityDirectory(directory.handle);
    const finalHandle = await open(finalPath, fsConstants.O_RDONLY | noFollow);
    try {
      const held = await finalHandle.stat();
      const current = await lstat(finalPath);
      if (current.isSymbolicLink() || !current.isFile() || !sameStatIdentity(held, current)) return unverified();
    } finally {
      await finalHandle.close();
    }
    return {
      exclusive_create: 'verified',
      atomic_rename: 'verified',
      file_sync: 'verified',
      directory_sync: directorySync,
      no_follow_directories: primitive.descriptor_relative ? 'verified' : 'unsupported',
      ...(primitive.descriptor_relative ? {} : { revalidated_path_mutation: 'verified' as const }),
    };
  } catch {
    return unverified();
  } finally {
    if (directory && (temporaryCreated || finalPath)) {
      try {
        await assertOpenedAuthorityDirectoryCurrent(directory, 'state root');
        if (temporaryCreated && temporaryPath) await unlink(temporaryPath).catch(() => undefined);
        if (finalPath) await unlink(finalPath).catch(() => undefined);
        await syncOpenedAuthorityDirectory(directory.handle);
      } catch {
        // The descriptor remains pinned, but a replaced path is not safe to mutate further.
      }
    }
    await directory?.handle?.close().catch(() => undefined);
  }
}

export async function probeStateAuthorityFilesystemCapability(
  root: string,
  now = new Date(),
): Promise<StateAuthorityFilesystemCapability> {
  const canonicalRoot = canonicalizeExistingAuthorityPath(root, 'state root');
  await assertDirectoryNotSymlink(canonicalRoot, 'state root');
  const mutation = await probeAuthorityMutationPrimitive(canonicalRoot);
  const identity = await captureRootFilesystemIdentity(canonicalRoot);
  return {
    schema_version: 1,
    platform: process.platform,
    canonical_path: canonicalRoot,
    exclusive_create: mutation.exclusive_create,
    atomic_rename: mutation.atomic_rename,
    file_sync: mutation.file_sync,
    directory_sync: mutation.directory_sync,
    no_follow_directories: mutation.no_follow_directories,
    ...(mutation.revalidated_path_mutation === undefined
      ? {}
      : { revalidated_path_mutation: mutation.revalidated_path_mutation }),
    strong_root_identity: identity.strong_identity ? 'verified' : 'unsupported',
    probed_at: nowIso(now),
  };
}

function hasVerifiedAuthorityMutationSafety(capability: StateAuthorityFilesystemCapability): boolean {
  return capability.no_follow_directories === 'verified'
    || (capability.no_follow_directories === 'unsupported'
      && capability.revalidated_path_mutation === 'verified'
      && capability.exclusive_create === 'verified'
      && capability.atomic_rename === 'verified'
      && capability.file_sync === 'verified');
}

function assertWorkspaceIdentity(workspace: WorkspaceIdentity): void {
  if (workspace.schema_version !== 1 || (workspace.kind !== 'git-worktree' && workspace.kind !== 'startup-cwd')) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'workspace identity has an unsupported schema or kind');
  }
  const canonicalPath = canonicalizeExistingAuthorityPath(workspace.canonical_path, 'workspace root');
  if (canonicalPath !== workspace.canonical_path || workspace.digest !== workspaceIdentityDigest(workspace)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'workspace identity is not canonical or has an invalid digest');
  }
  if (workspace.kind === 'git-worktree') {
    if (canonicalizeExistingAuthorityPath(workspace.git_dir, 'Git directory') !== workspace.git_dir
      || canonicalizeExistingAuthorityPath(workspace.git_common_dir, 'Git common directory') !== workspace.git_common_dir) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'Git workspace lineage is not canonical');
    }
  }
}

function assertIssuer(issuer: FirstPartyIssuer): void {
  if (issuer.kind !== 'first-party-launcher'
    || !/^[0-9a-f]{64}$/i.test(issuer.package_digest)
    || issuer.package_version.trim() === '') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch, 'alternate root intent issuer is not an authenticated first-party launcher');
  }
}

function normalizeAliases(aliases: Partial<SessionAliasSet> | undefined): SessionAliasSet {
  const native = aliases?.native_session_id;
  if (native !== undefined) safeSessionIdentifier(native, 'native session ID');
  const normalize = (values: string[] | undefined, label: string): string[] => {
    const source = values ?? [];
    if (!Array.isArray(source)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, `${label} must be an array`);
    }
    return [...new Set(source.map((value) => safeSessionIdentifier(value, label)))];
  };
  return {
    native_session_id: native,
    current_session_aliases: normalize(aliases?.current_session_aliases, 'current session alias'),
    previous_session_aliases: normalize(aliases?.previous_session_aliases, 'previous session alias'),
    owner_session_aliases: normalize(aliases?.owner_session_aliases, 'owner session alias'),
  };
}

export function createSessionAuthorityBinding(
  input: CreateSessionAuthorityBindingInput,
  authorityId: string,
  generationId: string,
  fence: number,
  now = new Date(),
): SessionAuthorityBinding {
  return {
    schema_version: 1,
    binding_id: randomUUID(),
    authority_id: safeIdentifier(authorityId, 'authority ID'),
    generation_id: safeIdentifier(generationId, 'generation ID'),
    binding_revision: 1,
    canonical_session_id: safeSessionIdentifier(input.canonical_session_id, 'canonical session ID'),
    aliases: normalizeAliases(input.aliases),
    lifecycle: 'active',
    created_at: nowIso(now),
    updated_at: nowIso(now),
    creation_fence: assertFiniteNonNegativeInteger(fence, 'fence', AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict),
  };
}

export function reviseSessionAuthorityBinding(
  binding: SessionAuthorityBinding,
  aliases: Partial<SessionAliasSet>,
  lifecycle: SessionAuthorityBinding['lifecycle'],
  now = new Date(),
): SessionAuthorityBinding {
  validateSessionAuthorityBinding(binding);
  return {
    ...binding,
    binding_revision: binding.binding_revision + 1,
    aliases: normalizeAliases({ ...binding.aliases, ...aliases }),
    lifecycle,
    updated_at: nowIso(now),
  };
}

export function validateSessionAuthorityBinding(binding: SessionAuthorityBinding): void {
  if (binding.schema_version !== 1
    || !safeIdentifier(binding.binding_id, 'binding ID')
    || !safeIdentifier(binding.authority_id, 'binding authority ID')
    || !safeIdentifier(binding.generation_id, 'binding generation ID')) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'session binding has an unsupported schema');
  }
  assertFiniteNonNegativeInteger(binding.binding_revision, 'binding revision', AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict);
  safeSessionIdentifier(binding.canonical_session_id, 'canonical session ID');
  normalizeAliases(binding.aliases);
  if (binding.lifecycle !== 'active' && binding.lifecycle !== 'terminal') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'session binding has an invalid lifecycle');
  }
}

export function createWorkspaceAuthorityAnchor(
  workspace: WorkspaceIdentity,
  now = new Date(),
): WorkspaceAuthorityAnchor {
  assertWorkspaceIdentity(workspace);
  return {
    schema_version: 1,
    authority_protocol_version: 1,
    workspace_identity: workspace,
    workspace_identity_digest: workspace.digest,
    anchor_revision: 0,
    fencing_token: 0,
    alternate_intents: [],
    aborted_establishments: [],
    updated_at: nowIso(now),
  };
}

export function validateWorkspaceAuthorityAnchor(
  anchor: WorkspaceAuthorityAnchor,
  workspace: WorkspaceIdentity,
): void {
  if (anchor.schema_version !== 1 || anchor.authority_protocol_version !== 1) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor has an unsupported schema or protocol');
  }
  assertWorkspaceIdentity(workspace);
  if (!sameWorkspaceIdentity(anchor.workspace_identity, workspace)
    || anchor.workspace_identity_digest !== workspace.digest) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'workspace authority anchor belongs to a different workspace');
  }
  assertFiniteNonNegativeInteger(anchor.anchor_revision, 'anchor revision', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  assertFiniteNonNegativeInteger(anchor.fencing_token, 'anchor fencing token', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  if (!Array.isArray(anchor.alternate_intents) || !Array.isArray(anchor.aborted_establishments)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor has invalid intent or aborted-establishment collections');
  }
  const seenIntentIds = new Set<string>();
  let preparedIntentCount = 0;
  for (const intent of anchor.alternate_intents) {
    validateStoredAlternateRootIntent(anchor, intent);
    if (seenIntentIds.has(intent.intent_id)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor contains a duplicate alternate intent ID');
    }
    seenIntentIds.add(intent.intent_id);
    if (intent.status === 'prepared' || intent.status === 'preparing') preparedIntentCount += 1;

  }
  if (preparedIntentCount > 1) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentAmbiguous, 'workspace authority anchor contains multiple unresolved alternate intents');
  }
  const activeFields = [
    anchor.active_generation_id,
    anchor.active_generation_locator,
    anchor.active_binding_locator,
    anchor.active_lease,
  ];
  if (activeFields.some((field) => field !== undefined) && activeFields.some((field) => field === undefined)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor has a partial active lease');
  }
  if (anchor.active_lease) {
    safeIdentifier(anchor.active_generation_id!, 'active generation ID');
    safeIdentifier(anchor.active_lease.generation_id, 'active lease generation ID');
    safeIdentifier(anchor.active_lease.binding_id, 'active lease binding ID');
    nonEmptyString(anchor.active_lease.launch_id, 'active lease launch ID', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
    nonEmptyString(anchor.active_lease.owner_nonce, 'active lease owner nonce', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
    if (anchor.active_lease.generation_id !== anchor.active_generation_id
      || anchor.active_lease.fencing_token !== anchor.fencing_token) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority active lease does not match the active generation or fence');
    }
  }
  if (anchor.transport_capability) {
    validateTransportCapabilityMetadata(anchor.transport_capability, anchor);
    if (!anchor.active_lease) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'workspace authority transport capability exists without an active lease');
    }
  }
  if (anchor.pending_operation) validatePendingAuthorityOperation(anchor.pending_operation, anchor);
}

function validatePendingAuthorityOperation(
  pending: PendingAuthorityOperation,
  anchor: WorkspaceAuthorityAnchor,
): void {
  safeIdentifier(pending.operation_id, 'pending operation ID');
  safeIdentifier(pending.generation_id, 'pending operation generation ID');
  nonEmptyString(pending.generation_locator, 'pending operation generation locator', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  nonEmptyString(pending.journal_locator, 'pending operation journal locator', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  nonEmptyString(pending.owner_nonce, 'pending operation owner nonce', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  if (!['generation_establish', 'generation_terminalize', 'launch_transport_publish', 'alternate_root_rollover'].includes(pending.kind)
    || pending.expected_anchor_revision !== anchor.anchor_revision
    || pending.fencing_token !== anchor.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority pending operation has an invalid kind, revision, or fence');
  }
  if (pending.intent_id) safeIdentifier(pending.intent_id, 'pending operation intent ID');
  if (pending.binding_locator) nonEmptyString(pending.binding_locator, 'pending operation binding locator', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  if (pending.source_generation_id) safeIdentifier(pending.source_generation_id, 'pending operation source generation ID');
  if (pending.source_authority_locator) nonEmptyString(pending.source_authority_locator, 'pending operation source authority locator', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  if (pending.source_binding_locator) nonEmptyString(pending.source_binding_locator, 'pending operation source binding locator', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  if (pending.kind === 'generation_establish') {
    if (!pending.target_root_identity) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'ordinary generation establishment pending operation is missing its target root fingerprint');
    }
    const targetRoot = dirname(dirname(dirname(dirname(pending.generation_locator))));
    if (pending.target_root_identity.canonical_path !== targetRoot) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'ordinary generation establishment target root fingerprint does not match its target locator');
    }
  }
}

function validateStoredAlternateRootIntent(
  anchor: WorkspaceAuthorityAnchor,
  intent: AlternateRootBootstrapIntent,
): void {
  if (!intent || typeof intent !== 'object'
    || intent.intent_schema_version !== 1
    || intent.authority_protocol_version !== 1) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace anchor contains an alternate intent with an unsupported schema');
  }
  safeIdentifier(intent.intent_id, 'alternate intent ID');
  safeIdentifier(intent.launch_id, 'alternate intent launch ID');
  nonEmptyString(intent.owner_nonce, 'alternate intent owner nonce', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  assertIssuer(intent.issuer);
  if (!sameWorkspaceIdentity(intent.workspace_identity, anchor.workspace_identity)
    || intent.workspace_identity_digest !== anchor.workspace_identity_digest) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'workspace anchor alternate intent belongs to a different workspace');
  }
  if (!['preparing', 'prepared', 'consumed', 'aborted'].includes(intent.status)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace anchor alternate intent has an invalid status');
  }
  if (Number.isNaN(new Date(intent.created_at).getTime())
    || Number.isNaN(new Date(intent.expires_at).getTime())) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace anchor alternate intent has invalid timestamps');
  }
  const carriesPreparationBoundaryEvidence = Boolean(
    intent.creation_boundary
    && intent.creation_root
    && intent.proposed_root_identity.canonical_path === intent.creation_boundary
    && intent.proposed_root_capability.canonical_path === intent.creation_boundary,
  );
  if (carriesPreparationBoundaryEvidence) {
    if ((intent.status !== 'preparing' && intent.status !== 'aborted')
      || !isAuthorityPathWithin(intent.creation_root!, intent.proposed_state_root)
      || !isAuthorityPathWithin(intent.creation_boundary!, intent.creation_root!)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'workspace anchor alternate preparation intent has invalid creation-boundary evidence');
    }
  } else if (intent.status === 'preparing'
    || intent.proposed_root_identity.canonical_path !== intent.proposed_state_root
    || intent.proposed_root_capability.canonical_path !== intent.proposed_state_root) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'workspace anchor alternate intent root evidence does not match its root');
  }

  assertFiniteNonNegativeInteger(intent.expected_anchor_revision, 'alternate intent expected anchor revision', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
  assertFiniteNonNegativeInteger(intent.fencing_token, 'alternate intent fencing token', AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
}

export async function readWorkspaceAuthorityAnchor(
  workspace: WorkspaceIdentity,
): Promise<WorkspaceAuthorityAnchor | null> {
  assertWorkspaceIdentity(workspace);
  const anchorPath = stateAuthorityPaths(workspace).anchor_path;
  try {
    await lstat(anchorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  await assertPathHasNoSymlinkComponents(anchorPath, 'workspace authority anchor');

  const anchor = await readAuthorityJson(anchorPath, AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed) as WorkspaceAuthorityAnchor;
  validateWorkspaceAuthorityAnchor(anchor, workspace);
  return anchor;
}

/**
 * Child transport construction is synchronous at its call sites. Re-read the
 * final anchor through a no-follow descriptor so a process-local bearer cache
 * cannot outlive a rotation made by another process.
 */
function readWorkspaceAuthorityAnchorForChild(workspace: WorkspaceIdentity): WorkspaceAuthorityAnchor {
  assertWorkspaceIdentity(workspace);
  const anchorPath = stateAuthorityPaths(workspace).anchor_path;
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow workspace anchor opens');
  }
  let descriptor: number | undefined;
  try {
    const before = lstatSync(anchorPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor is not a regular file');
    }
    if (canonicalizeExistingAuthorityPath(anchorPath, 'workspace authority anchor') !== anchorPath) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, 'workspace authority anchor has a symbolic-link component');
    }
    descriptor = openSync(anchorPath, fsConstants.O_RDONLY | noFollow);
    const held = fstatSync(descriptor);
    if (held.dev !== before.dev || held.ino !== before.ino) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor changed while it was opened');
    }
    const content = readFileSync(descriptor, 'utf-8');
    const after = lstatSync(anchorPath);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== held.dev || after.ino !== held.ino) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor changed while it was read');
    }
    let anchor: WorkspaceAuthorityAnchor;
    try {
      anchor = JSON.parse(content) as WorkspaceAuthorityAnchor;
    } catch {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed, 'workspace authority anchor JSON is invalid');
    }
    validateWorkspaceAuthorityAnchor(anchor, workspace);
    return anchor;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'workspace authority anchor is missing during child transport publication');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


async function writeWorkspaceAuthorityAnchorUnchecked(
  workspace: WorkspaceIdentity,
  anchor: WorkspaceAuthorityAnchor,
): Promise<void> {
  validateWorkspaceAuthorityAnchor(anchor, workspace);
  const paths = stateAuthorityPaths(workspace);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.omx_root);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.bootstrap_directory);
  await atomicWriteAuthorityJson(paths.anchor_path, anchor, { authority_root: workspace.canonical_path });
}

export async function writeFencedWorkspaceAuthorityAnchor(
  workspace: WorkspaceIdentity,
  anchor: WorkspaceAuthorityAnchor,
  lock: AcquiredStateAuthorityLock,
): Promise<AcquiredStateAuthorityLock> {
  validateWorkspaceAuthorityAnchor(anchor, workspace);
  if (anchor.fencing_token !== lock.record.fencing_token
    || anchor.anchor_revision !== lock.record.anchor_revision + 1) {
    authorityError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      'fenced anchor publication does not match the lock fence and expected revision',
    );
  }
  const currentLock = await heartbeatWorkspaceAuthorityLock(lock);
  await writeWorkspaceAuthorityAnchorUnchecked(workspace, anchor);
  return currentLock;
}

export function createAlternateRootBootstrapIntent(
  input: CreateAlternateRootIntentInput,
): AlternateRootBootstrapIntent {
  validateWorkspaceAuthorityAnchor(input.anchor, input.workspace_identity);
  assertIssuer(input.issuer);
  safeIdentifier(input.launch_id, 'launch ID');
  nonEmptyString(input.owner_nonce, 'owner nonce', AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch);
  const expiresAt = new Date(input.expires_at);
  const now = input.now ?? new Date();
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentExpired, 'alternate root intent expiration must be in the future');
  }
  const proposedStateRoot = canonicalizeAuthorityPathForCreation(
    input.proposed_state_root,
    'proposed alternate state root',
  );
  if (input.proposed_root_identity.canonical_path !== proposedStateRoot
    || input.proposed_root_capability.canonical_path !== proposedStateRoot) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate root intent root evidence does not match its proposed root');
  }
  return {
    intent_schema_version: 1,
    authority_protocol_version: 1,
    intent_id: input.intent_id ? safeIdentifier(input.intent_id, 'intent ID') : randomUUID(),
    workspace_identity: input.workspace_identity,
    workspace_identity_digest: input.workspace_identity.digest,
    launch_id: input.launch_id,
    issuer: input.issuer,
    owner_nonce: input.owner_nonce,
    expected_anchor_revision: input.anchor.anchor_revision,
    fencing_token: input.anchor.fencing_token,
    proposed_state_root: proposedStateRoot,
    proposed_root_identity: input.proposed_root_identity,
    proposed_root_capability: input.proposed_root_capability,
    intended_consumer_kind: input.intended_consumer_kind,
    created_at: nowIso(now),
    expires_at: expiresAt.toISOString(),
    status: 'prepared',
  };
}

function createAlternateRootPreparationIntent(input: Omit<CreateAlternateRootIntentInput, 'proposed_root_identity' | 'proposed_root_capability'> & {
  creation_boundary: string;
  creation_boundary_identity: RootFilesystemIdentity;
  creation_boundary_capability: StateAuthorityFilesystemCapability;
  creation_root: string;
}): AlternateRootBootstrapIntent {
  validateWorkspaceAuthorityAnchor(input.anchor, input.workspace_identity);
  assertIssuer(input.issuer);
  safeIdentifier(input.launch_id, 'launch ID');
  nonEmptyString(input.owner_nonce, 'owner nonce', AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch);
  const expiresAt = new Date(input.expires_at);
  const now = input.now ?? new Date();
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentExpired, 'alternate root preparation intent expiration must be in the future');
  }
  const creationBoundary = canonicalizeExistingAuthorityPath(input.creation_boundary, 'alternate creation boundary');
  const creationRoot = canonicalizeAuthorityPathForCreation(input.creation_root, 'alternate creation root');
  const proposedStateRoot = canonicalizeAuthorityPathForCreation(input.proposed_state_root, 'proposed alternate state root');
  if (!isAuthorityPathWithin(creationBoundary, creationRoot)
    || !isAuthorityPathWithin(creationRoot, proposedStateRoot)
    || input.creation_boundary_identity.canonical_path !== creationBoundary
    || input.creation_boundary_capability.canonical_path !== creationBoundary) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate root preparation boundary evidence does not match its planned target');
  }
  return {
    intent_schema_version: 1,
    authority_protocol_version: 1,
    intent_id: input.intent_id ? safeIdentifier(input.intent_id, 'intent ID') : randomUUID(),
    workspace_identity: input.workspace_identity,
    workspace_identity_digest: input.workspace_identity.digest,
    launch_id: input.launch_id,
    issuer: input.issuer,
    owner_nonce: input.owner_nonce,
    expected_anchor_revision: input.anchor.anchor_revision,
    fencing_token: input.anchor.fencing_token,
    proposed_state_root: proposedStateRoot,
    proposed_root_identity: input.creation_boundary_identity,
    proposed_root_capability: input.creation_boundary_capability,
    creation_boundary: creationBoundary,
    creation_root: creationRoot,
    intended_consumer_kind: input.intended_consumer_kind,
    created_at: nowIso(now),
    expires_at: expiresAt.toISOString(),
    status: 'preparing',
  };
}

function materializeAlternateRootBootstrapIntent(
  anchor: WorkspaceAuthorityAnchor,
  intentId: string,
  rootIdentity: RootFilesystemIdentity,
  rootCapability: StateAuthorityFilesystemCapability,
  now: Date,
  fencingToken?: number,
): WorkspaceAuthorityAnchor {
  const index = anchor.alternate_intents.findIndex((intent) => intent.intent_id === intentId);
  if (index < 0) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, `alternate root intent ${intentId} does not exist`);
  }
  const intent = anchor.alternate_intents[index];
  if (intent.status !== 'preparing'
    || rootIdentity.canonical_path !== intent.proposed_state_root
    || rootCapability.canonical_path !== intent.proposed_state_root) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, 'alternate root preparation intent cannot be materialized with a different target root');
  }
  const revision = nextAnchorRevision(anchor, now, fencingToken);
  const intents = [...anchor.alternate_intents];
  intents[index] = {
    ...intent,
    proposed_root_identity: rootIdentity,
    proposed_root_capability: rootCapability,
    expected_anchor_revision: revision.anchor_revision,
    fencing_token: revision.fencing_token,
    status: 'prepared',
  };
  return { ...anchor, ...revision, alternate_intents: intents };
}

export function validateAlternateRootBootstrapIntent(
  intent: AlternateRootBootstrapIntent,
  input: AlternateRootIntentValidationInput,
): AlternateRootIntentValidation {
  try {
    validateWorkspaceAuthorityAnchor(input.anchor, input.workspace_identity);
    assertIssuer(input.issuer);
    const now = input.now ?? new Date();
    if (intent.intent_schema_version !== 1 || intent.authority_protocol_version !== 1) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch, 'alternate root intent uses an unsupported protocol') };
    }
    if (intent.status !== 'prepared') {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentReplay, `alternate root intent ${intent.intent_id} is already ${intent.status}`) };
    }
    if (new Date(intent.expires_at).getTime() <= now.getTime()) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentExpired, `alternate root intent ${intent.intent_id} has expired`) };
    }
    if (!sameWorkspaceIdentity(intent.workspace_identity, input.workspace_identity)
      || intent.workspace_identity_digest !== input.workspace_identity.digest) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'alternate root intent belongs to a different workspace') };
    }
    if (intent.launch_id !== input.launch_id
      || intent.owner_nonce !== input.owner_nonce
      || intent.fencing_token !== input.fencing_token
      || intent.expected_anchor_revision !== input.anchor.anchor_revision) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, 'alternate root intent does not match the active launch, anchor revision, or fence') };
    }
    if (intent.issuer.package_digest !== input.issuer.package_digest
      || intent.issuer.package_version !== input.issuer.package_version
      || intent.issuer.kind !== input.issuer.kind
      || intent.intended_consumer_kind !== input.expected_consumer_kind) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch, 'alternate root intent issuer or intended consumer does not match the active first-party launcher') };
    }
    if (intent.proposed_root_identity.canonical_path !== intent.proposed_state_root
      || intent.proposed_root_capability.canonical_path !== intent.proposed_state_root) {
      return { valid: false, diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate root intent root evidence does not match its root') };
    }
    return { valid: true };
  } catch (error) {
    if (error instanceof StateAuthorityError) {
      return { valid: false, diagnostic: diagnostic(error.code, error.message) };
    }
    throw error;
  }
}

function nextAnchorRevision(
  anchor: WorkspaceAuthorityAnchor,
  now: Date,
  fencingToken = anchor.fencing_token + 1,
): Pick<WorkspaceAuthorityAnchor, 'anchor_revision' | 'fencing_token' | 'updated_at'> {
  if (!Number.isSafeInteger(fencingToken) || fencingToken <= anchor.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'next authority anchor fence must advance monotonically');
  }
  return {
    anchor_revision: anchor.anchor_revision + 1,
    fencing_token: fencingToken,
    updated_at: nowIso(now),
  };
}


export function addAlternateRootBootstrapIntent(
  anchor: WorkspaceAuthorityAnchor,
  intent: AlternateRootBootstrapIntent,
  now = new Date(),
  fencingToken?: number,

): WorkspaceAuthorityAnchor {
  validateWorkspaceAuthorityAnchor(anchor, anchor.workspace_identity);
  const prepared = anchor.alternate_intents.filter((entry) => entry.status === 'prepared' || entry.status === 'preparing');

  if (prepared.length > 0) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentAmbiguous, 'a workspace anchor already has an unresolved alternate root intent');
  }
  if (anchor.alternate_intents.some((entry) => entry.intent_id === intent.intent_id)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentReplay, `alternate root intent ${intent.intent_id} already exists`);
  }
  if (intent.expected_anchor_revision !== anchor.anchor_revision || intent.fencing_token !== anchor.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, 'alternate root intent was not prepared for the current anchor revision and fence');
  }
  const revision = nextAnchorRevision(anchor, now, fencingToken);

  return {
    ...anchor,
    ...revision,
    alternate_intents: [
      ...anchor.alternate_intents,
      {
        ...intent,
        expected_anchor_revision: revision.anchor_revision,
        fencing_token: revision.fencing_token,
      },
    ],
  };
}

export function consumeAlternateRootBootstrapIntent(
  anchor: WorkspaceAuthorityAnchor,
  intentId: string,
  validationInput: AlternateRootIntentValidationInput,
  generationId: string,
  now = new Date(),
  fencingToken?: number,

): WorkspaceAuthorityAnchor {
  const index = anchor.alternate_intents.findIndex((intent) => intent.intent_id === intentId);
  if (index < 0) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, `alternate root intent ${intentId} does not exist`);
  }
  const intent = anchor.alternate_intents[index];
  const validation = validateAlternateRootBootstrapIntent(intent, validationInput);
  if (!validation.valid) {
    authorityError(validation.diagnostic!.code, validation.diagnostic!.message);
  }
  const revision = nextAnchorRevision(anchor, now, fencingToken);

  const consumed: AlternateRootBootstrapIntent = {
    ...intent,
    status: 'consumed',
    consumed_by_generation_id: safeIdentifier(generationId, 'generation ID'),
    consumed_at_anchor_revision: revision.anchor_revision,
  };
  const intents = [...anchor.alternate_intents];
  intents[index] = consumed;
  return { ...anchor, ...revision, alternate_intents: intents };
}

export function abortAlternateRootBootstrapIntent(
  anchor: WorkspaceAuthorityAnchor,
  intentId: string,
  reason: string,
  now = new Date(),
  fencingToken?: number,

): WorkspaceAuthorityAnchor {
  const index = anchor.alternate_intents.findIndex((intent) => intent.intent_id === intentId);
  if (index < 0) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, `alternate root intent ${intentId} does not exist`);
  }
  const intent = anchor.alternate_intents[index];
  if (intent.status !== 'prepared' && intent.status !== 'preparing') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentReplay, `alternate root intent ${intentId} is already ${intent.status}`);
  }
  const intents = [...anchor.alternate_intents];
  intents[index] = {
    ...intent,
    status: 'aborted',
    aborted_reason: nonEmptyString(reason, 'intent abort reason', AUTHORITY_DIAGNOSTIC_CODES.intentConflict),
    tombstoned_at: nowIso(now),
  };
  return { ...anchor, ...nextAnchorRevision(anchor, now, fencingToken), alternate_intents: intents };

}

function lockRecordMatches(
  actual: StateAuthorityLockRecord,
  expected: Pick<StateAuthorityLockRecord, 'owner_nonce' | 'fencing_token'>,
): boolean {
  return actual.owner_nonce === expected.owner_nonce && actual.fencing_token === expected.fencing_token;
}

interface StateAuthorityLockSnapshot {
  record: StateAuthorityLockRecord;
  device: number;
  inode: number;
  content_digest: string;
}

interface StateAuthorityLockFenceCounter {
  schema_version: 1;
  last_fencing_token: number;
  updated_at: string;
}

function parseStateAuthorityLockFenceCounter(
  content: string,
  path: string,
): StateAuthorityLockFenceCounter {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock fence counter is malformed: ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock fence counter is malformed: ${path}`);
  }
  const record = value as StateAuthorityLockFenceCounter;
  if (record.schema_version !== 1
    || !Number.isSafeInteger(record.last_fencing_token)
    || record.last_fencing_token < 0
    || typeof record.updated_at !== 'string') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock fence counter is malformed: ${path}`);
  }
  return record;
}

async function readWorkspaceAuthorityLockFenceCounter(
  path: string,
): Promise<StateAuthorityFileSnapshot<StateAuthorityLockFenceCounter> | null> {
  return readStateAuthorityFileSnapshot(path, parseStateAuthorityLockFenceCounter);
}

async function reserveWorkspaceAuthorityLockFence(
  workspace: WorkspaceIdentity,
  requestedFence: number,
  now: Date,
): Promise<number> {
  const paths = stateAuthorityPaths(workspace);
  const counter = await readWorkspaceAuthorityLockFenceCounter(paths.lock_fence_path);
  let floor = counter?.record.last_fencing_token ?? 0;
  if (!counter) {
    const [anchor, existingLock] = await Promise.all([
      readWorkspaceAuthorityAnchor(workspace),
      readWorkspaceAuthorityLockSnapshot(paths.lock_path),
    ]);
    floor = Math.max(floor, anchor?.fencing_token ?? 0, existingLock?.record.fencing_token ?? 0);
  }
  if (floor >= Number.MAX_SAFE_INTEGER) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock fence counter is exhausted');
  }
  const fencingToken = Math.max(floor + 1, requestedFence);
  const next: StateAuthorityLockFenceCounter = {
    schema_version: 1,
    last_fencing_token: fencingToken,
    updated_at: nowIso(now),
  };
  await atomicWriteAuthorityJson(paths.lock_fence_path, next, {
    authority_root: workspace.canonical_path,
  });
  const persisted = await readWorkspaceAuthorityLockFenceCounter(paths.lock_fence_path);
  if (!persisted
    || persisted.record.last_fencing_token !== fencingToken
    || persisted.record.updated_at !== next.updated_at) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock fence counter changed while reserving a fence');
  }
  return fencingToken;
}


function lockSnapshotMatches(
  actual: StateAuthorityLockSnapshot,
  expected: StateAuthorityLockSnapshot,
): boolean {
  return actual.device === expected.device
    && actual.inode === expected.inode
    && actual.content_digest === expected.content_digest;
}

async function readWorkspaceAuthorityLockSnapshot(path: string): Promise<StateAuthorityLockSnapshot | null> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    initial = await lstat(path);
    if (initial.isSymbolicLink() || !initial.isFile()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock is not a regular file');
    }
    const noFollow = noFollowFileOpenFlags();
    if (noFollow === null) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow workspace lock opens');
    }
    handle = await open(path, fsConstants.O_RDONLY | noFollow);

    const held = await handle.stat();
    if (held.dev !== initial.dev || held.ino !== initial.ino) return null;
    const content = await handle.readFile('utf-8');
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()
      || current.dev !== initial.dev || current.ino !== initial.ino
      || current.dev !== held.dev || current.ino !== held.ino) {
      return null;
    }
    return {
      record: JSON.parse(content) as StateAuthorityLockRecord,
      device: initial.dev,
      inode: initial.ino,
      content_digest: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven,
      `workspace authority lock cannot be inspected safely: ${path}`,
    );
  } finally {
    await handle?.close();
  }
}


export function createStateAuthorityLockOwner(now = new Date()): StateAuthorityLockOwner {
  const owner: StateAuthorityLockOwner = {
    host: hostname(),
    pid: process.pid,
    process_started_at: nowIso(now),
  };
  if (process.platform !== 'linux') return owner;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    const statLine = readFileSync(`/proc/${process.pid}/stat`, 'utf-8');
    const command = readFileSync(`/proc/${process.pid}/cmdline`);
    const suffix = statLine.slice(statLine.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = suffix[19];
    if (bootId && startTicks) {
      owner.boot_id = bootId;
      owner.process_started_at = `linux:${startTicks}`;
      owner.command_digest = createHash('sha256').update(command).digest('hex');
    }
  } catch {
    // Platforms without procfs retain a conservative PID-only record.
  }
  return owner;
}

async function inspectLockOwner(owner: StateAuthorityLockOwner): Promise<'exited' | 'live' | 'reused' | 'unproven'> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname()) return 'unproven';
  if (process.platform !== 'linux') return isProcessAlive(owner.pid) ? 'live' : 'exited';
  try {
    const [bootIdRaw, statLine, command] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf-8'),
      readFile(`/proc/${owner.pid}/stat`, 'utf-8'),
      readFile(`/proc/${owner.pid}/cmdline`),
    ]);
    const bootId = bootIdRaw.trim();
    const suffix = statLine.slice(statLine.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = suffix[19];
    const commandDigest = createHash('sha256').update(command).digest('hex');
    if (!startTicks) return 'unproven';
    if ((owner.boot_id && owner.boot_id !== bootId)
      || (owner.process_started_at.startsWith('linux:') && owner.process_started_at !== `linux:${startTicks}`)
      || (owner.command_digest && owner.command_digest !== commandDigest)) {
      return 'reused';
    }
    return 'live';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'exited';
    return 'unproven';
  }
}

interface StateAuthorityLockAcquisitionGuardRecord {
  schema_version: 1;
  kind: 'acquisition-guard';
  owner_nonce: string;
  owner: StateAuthorityLockOwner;
  acquired_at: string;
}

interface StateAuthorityLockAcquisitionGuardSnapshot {
  record: StateAuthorityLockAcquisitionGuardRecord;
  device: number;
  inode: number;
  content_digest: string;
}

interface StateAuthorityLockAcquisitionReclaimClaimRecord {
  schema_version: 1;
  kind: 'stale-guard-reclamation';
  claim_nonce: string;
  owner: StateAuthorityLockOwner;
  acquired_at: string;
  target_guard: {
    owner_nonce: string;
    device: string;
    inode: string;
    content_digest: string;
  };
}

interface StateAuthorityLockAcquisitionReclaimClaimSnapshot {
  record: StateAuthorityLockAcquisitionReclaimClaimRecord;
  device: number;
  inode: number;
  content_digest: string;
}

interface StateAuthorityFileRetirementFinisherRecord {
  schema_version: 1;
  kind: 'coordination-retirement-finisher';
  owner_nonce: string;
  owner: StateAuthorityLockOwner;
  acquired_at: string;
  target: {
    device: string;
    inode: string;
    content_digest: string;
  };
}

interface StateAuthorityFileRetirementFinisherSnapshot {
  record: StateAuthorityFileRetirementFinisherRecord;
  device: number;
  inode: number;
  content_digest: string;
}

interface StateAuthorityFileRetirementFinisherRecoveryRecord {
  schema_version: 1;
  kind: 'coordination-retirement-finisher-recovery';
  owner_nonce: string;
  owner: StateAuthorityLockOwner;
  acquired_at: string;
  recovery_index: number;
  target_finisher: {
    device: string;
    inode: string;
    content_digest: string;
  };
}

interface StateAuthorityFileRetirementFinisherRecoverySnapshot {
  record: StateAuthorityFileRetirementFinisherRecoveryRecord;
  device: number;
  inode: number;
  content_digest: string;
}

interface AcquiredStateAuthorityLockAcquisitionGuard {
  path: string;
  snapshot: StateAuthorityLockAcquisitionGuardSnapshot;
}

interface AcquiredStateAuthorityLockAcquisitionReclaimClaim {
  path: string;
  snapshot: StateAuthorityLockAcquisitionReclaimClaimSnapshot;
}

type StateAuthorityFileSnapshot<T> = {
  record: T;
  device: number;
  inode: number;
  content_digest: string;
};

function authorityFileSnapshotMatches<T>(
  actual: StateAuthorityFileSnapshot<T>,
  expected: StateAuthorityFileSnapshot<T>,
): boolean {
  return actual.device === expected.device
    && actual.inode === expected.inode
    && actual.content_digest === expected.content_digest;
}

function parseStateAuthorityLockAcquisitionGuardRecord(
  content: string,
  path: string,
): StateAuthorityLockAcquisitionGuardRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition guard is malformed: ${path}`);
  }
  if (!value || typeof value !== 'object') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition guard is malformed: ${path}`);
  }
  const record = value as StateAuthorityLockAcquisitionGuardRecord;
  if (record.schema_version !== 1 || record.kind !== 'acquisition-guard'
    || typeof record.owner_nonce !== 'string' || !record.owner_nonce.trim()
    || !record.owner || typeof record.owner !== 'object' || typeof record.acquired_at !== 'string') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition guard is malformed: ${path}`);
  }
  return record;
}

function parseStateAuthorityLockAcquisitionReclaimClaimRecord(
  content: string,
  path: string,
): StateAuthorityLockAcquisitionReclaimClaimRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition reclamation claim is malformed: ${path}`);
  }
  if (!value || typeof value !== 'object') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition reclamation claim is malformed: ${path}`);
  }
  const record = value as StateAuthorityLockAcquisitionReclaimClaimRecord;
  if (record.schema_version !== 1 || record.kind !== 'stale-guard-reclamation'
    || typeof record.claim_nonce !== 'string' || !record.claim_nonce.trim()
    || !record.owner || typeof record.owner !== 'object' || typeof record.acquired_at !== 'string'
    || !record.target_guard || typeof record.target_guard !== 'object'
    || typeof record.target_guard.owner_nonce !== 'string' || !record.target_guard.owner_nonce.trim()
    || !/^[0-9]+$/.test(record.target_guard.device)
    || !/^[0-9]+$/.test(record.target_guard.inode)
    || !/^[a-f0-9]{64}$/i.test(record.target_guard.content_digest)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition reclamation claim is malformed: ${path}`);
  }
  return record;
}

function parseStateAuthorityFileRetirementFinisherRecord(
  content: string,
  path: string,
): StateAuthorityFileRetirementFinisherRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher is malformed: ${path}`);
  }
  if (!value || typeof value !== 'object') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher is malformed: ${path}`);
  }
  const record = value as StateAuthorityFileRetirementFinisherRecord;
  if (record.schema_version !== 1 || record.kind !== 'coordination-retirement-finisher'
    || typeof record.owner_nonce !== 'string' || !record.owner_nonce.trim()
    || !record.owner || typeof record.owner !== 'object' || typeof record.acquired_at !== 'string'
    || !record.target || typeof record.target !== 'object'
    || !/^[0-9]+$/.test(record.target.device)
    || !/^[0-9]+$/.test(record.target.inode)
    || !/^[a-f0-9]{64}$/i.test(record.target.content_digest)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher is malformed: ${path}`);
  }
  return record;
}

function parseStateAuthorityFileRetirementFinisherRecoveryRecord(
  content: string,
  path: string,
): StateAuthorityFileRetirementFinisherRecoveryRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher recovery is malformed: ${path}`);
  }
  if (!value || typeof value !== 'object') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher recovery is malformed: ${path}`);
  }
  const record = value as StateAuthorityFileRetirementFinisherRecoveryRecord;
  if (record.schema_version !== 1 || record.kind !== 'coordination-retirement-finisher-recovery'
    || typeof record.owner_nonce !== 'string' || !record.owner_nonce.trim()
    || !record.owner || typeof record.owner !== 'object' || typeof record.acquired_at !== 'string'
    || !Number.isSafeInteger(record.recovery_index) || record.recovery_index < 0
    || !record.target_finisher || typeof record.target_finisher !== 'object'
    || !/^[0-9]+$/.test(record.target_finisher.device)
    || !/^[0-9]+$/.test(record.target_finisher.inode)
    || !/^[a-f0-9]{64}$/i.test(record.target_finisher.content_digest)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher recovery is malformed: ${path}`);
  }
  return record;
}

async function readStateAuthorityFileSnapshot<T>(
  path: string,
  parse: (content: string, path: string) => T,
): Promise<StateAuthorityFileSnapshot<T> | null> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    initial = await lstat(path);
    if (initial.isSymbolicLink() || !initial.isFile()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock coordination record is not a regular file: ${path}`);
    }
    const noFollow = noFollowFileOpenFlags();
    if (noFollow === null) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow workspace lock coordination opens');
    }
    handle = await open(path, fsConstants.O_RDONLY | noFollow);

    const held = await handle.stat();
    if (held.dev !== initial.dev || held.ino !== initial.ino) return null;
    const content = await handle.readFile('utf-8');
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()
      || current.dev !== initial.dev || current.ino !== initial.ino
      || current.dev !== held.dev || current.ino !== held.ino) {
      return null;
    }
    return {
      record: parse(content, path),
      device: initial.dev,
      inode: initial.ino,
      content_digest: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven,
      `workspace authority lock coordination record cannot be inspected safely: ${path}`,
    );
  } finally {
    await handle?.close();
  }
}

async function createExclusiveStateAuthorityFile<T>(
  path: string,
  record: T,
): Promise<StateAuthorityFileSnapshot<T> | null> {
  const parent = dirname(path);
  await assertDirectoryNotSymlink(parent, 'workspace authority lock coordination parent');
  const temporaryPath = join(parent, `.${basename(path)}.candidate-${process.pid}-${randomBytes(16).toString('hex')}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await fsyncAuthorityDirectory(parent);
    return await readStateAuthorityFileSnapshot(path, (content) => JSON.parse(content) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readStateAuthorityLockAcquisitionGuardSnapshot(
  path: string,
): Promise<StateAuthorityLockAcquisitionGuardSnapshot | null> {
  return readStateAuthorityFileSnapshot(path, parseStateAuthorityLockAcquisitionGuardRecord);
}

async function readStateAuthorityLockAcquisitionReclaimClaimSnapshot(
  path: string,
): Promise<StateAuthorityLockAcquisitionReclaimClaimSnapshot | null> {
  return readStateAuthorityFileSnapshot(path, parseStateAuthorityLockAcquisitionReclaimClaimRecord);
}

async function readStateAuthorityFileRetirementFinisherSnapshot(
  path: string,
): Promise<StateAuthorityFileRetirementFinisherSnapshot | null> {
  return readStateAuthorityFileSnapshot(path, parseStateAuthorityFileRetirementFinisherRecord);
}

function retirementFinisherTargetsSnapshot(
  finisher: StateAuthorityFileRetirementFinisherRecord,
  retirement: StateAuthorityFileSnapshot<unknown>,
): boolean {
  return finisher.target.device === String(retirement.device)
    && finisher.target.inode === String(retirement.inode)
    && finisher.target.content_digest === retirement.content_digest;
}

async function acquireStateAuthorityFileRetirementFinisher(
  path: string,
  retirement: StateAuthorityFileSnapshot<unknown>,
): Promise<StateAuthorityFileRetirementFinisherSnapshot | null> {
  const record: StateAuthorityFileRetirementFinisherRecord = {
    schema_version: 1,
    kind: 'coordination-retirement-finisher',
    owner_nonce: randomBytes(16).toString('hex'),
    owner: createStateAuthorityLockOwner(),
    acquired_at: nowIso(),
    target: {
      device: String(retirement.device),
      inode: String(retirement.inode),
      content_digest: retirement.content_digest,
    },
  };
  const created = await createExclusiveStateAuthorityFile(path, record);
  if (!created) return null;
  const finisher = await readStateAuthorityFileRetirementFinisherSnapshot(path);
  if (!finisher || !authorityFileSnapshotMatches(finisher, created)
    || finisher.record.owner_nonce !== record.owner_nonce
    || !retirementFinisherTargetsSnapshot(finisher.record, retirement)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher changed while establishing: ${path}`);
  }
  return finisher;
}

async function readStateAuthorityFileRetirementFinisherRecoverySnapshot(
  path: string,
): Promise<StateAuthorityFileRetirementFinisherRecoverySnapshot | null> {
  return readStateAuthorityFileSnapshot(path, parseStateAuthorityFileRetirementFinisherRecoveryRecord);
}

function retirementFinisherRecoveryTargetsSnapshot(
  recovery: StateAuthorityFileRetirementFinisherRecoveryRecord,
  finisher: StateAuthorityFileRetirementFinisherSnapshot,
): boolean {
  return recovery.target_finisher.device === String(finisher.device)
    && recovery.target_finisher.inode === String(finisher.inode)
    && recovery.target_finisher.content_digest === finisher.content_digest;
}

async function acquireStateAuthorityFileRetirementFinisherRecovery(
  finishingPath: string,
  finisher: StateAuthorityFileRetirementFinisherSnapshot,
): Promise<StateAuthorityFileRetirementFinisherRecoverySnapshot> {
  const parent = dirname(finishingPath);
  const prefix = `${basename(finishingPath)}.recovery-`;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const entries = await readdir(parent);
    const recoveries: StateAuthorityFileRetirementFinisherRecoverySnapshot[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const index = entry.slice(prefix.length);
      if (!/^(0|[1-9][0-9]*)$/.test(index)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement recovery name is malformed: ${entry}`);
      }
      const recovery = await readStateAuthorityFileRetirementFinisherRecoverySnapshot(join(parent, entry));
      if (!recovery || recovery.record.recovery_index !== Number(index)
        || !retirementFinisherRecoveryTargetsSnapshot(recovery.record, finisher)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement recovery changed: ${entry}`);
      }
      recoveries.push(recovery);
    }
    recoveries.sort((left, right) => left.record.recovery_index - right.record.recovery_index);
    const latest = recoveries.at(-1);
    if (latest) {
      const state = await inspectLockOwner(latest.record.owner);
      if (state === 'live' || state === 'unproven') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock retirement recovery is already in progress: ${finishingPath}`);
      }
    }
    const recoveryIndex = (latest?.record.recovery_index ?? -1) + 1;
    const recoveryPath = join(parent, `${prefix}${recoveryIndex}`);
    const record: StateAuthorityFileRetirementFinisherRecoveryRecord = {
      schema_version: 1,
      kind: 'coordination-retirement-finisher-recovery',
      owner_nonce: randomBytes(16).toString('hex'),
      owner: createStateAuthorityLockOwner(),
      acquired_at: nowIso(),
      recovery_index: recoveryIndex,
      target_finisher: {
        device: String(finisher.device),
        inode: String(finisher.inode),
        content_digest: finisher.content_digest,
      },
    };
    const created = await createExclusiveStateAuthorityFile(recoveryPath, record);
    if (!created) continue;
    const recovery = await readStateAuthorityFileRetirementFinisherRecoverySnapshot(recoveryPath);
    if (!recovery || !authorityFileSnapshotMatches(recovery, created)
      || recovery.record.owner_nonce !== record.owner_nonce
      || !retirementFinisherRecoveryTargetsSnapshot(recovery.record, finisher)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement recovery changed while establishing: ${recoveryPath}`);
    }
    return recovery;
  }
  authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock retirement recovery is already in progress: ${finishingPath}`);
}

function stateAuthorityFileRetirementPath<T>(
  path: string,
  snapshot: StateAuthorityFileSnapshot<T>,
): string {
  return join(
    dirname(path),
    `.${basename(path)}.retiring-${snapshot.device}-${snapshot.inode}-${snapshot.content_digest}`,
  );
}

async function completePendingStateAuthorityFileRetirements<T>(
  path: string,
  parse: (content: string, path: string) => T,
  options: {
    /** Test-only crash seam. It is never persisted or transported. */
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  const parent = dirname(path);
  const prefix = `.${basename(path)}.retiring-`;
  const entries = await readdir(parent);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith('.complete') || entry.endsWith('.finishing') || entry.includes('.finishing.')) continue;
    const retirementPath = join(parent, entry);
    const completionPath = `${retirementPath}.complete`;
    const finishingPath = `${retirementPath}.finishing`;
    const retirement = await readStateAuthorityFileSnapshot(retirementPath, parse);
    if (!retirement) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement evidence disappeared: ${retirementPath}`);
    }
    const completion = await readStateAuthorityFileSnapshot(completionPath, parse);
    if (completion) {
      if (!authorityFileSnapshotMatches(completion, retirement)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement completion changed: ${completionPath}`);
      }
      continue;
    }

    let finisher = await readStateAuthorityFileRetirementFinisherSnapshot(finishingPath);
    let publishedFinisher = false;
    if (!finisher) {
      finisher = await acquireStateAuthorityFileRetirementFinisher(finishingPath, retirement);
      publishedFinisher = finisher !== null;
      if (!finisher) {
        finisher = await readStateAuthorityFileRetirementFinisherSnapshot(finishingPath);
        if (!finisher) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher disappeared: ${finishingPath}`);
        }
      }
    }
    if (!retirementFinisherTargetsSnapshot(finisher.record, retirement)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement finisher targets different evidence: ${finishingPath}`);
    }
    if (publishedFinisher) {
      await options.test_only_after_retirement_finisher_publication?.();
    } else {
      const state = await inspectLockOwner(finisher.record.owner);
      if (state === 'live' || state === 'unproven') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock retirement is already being finalized: ${finishingPath}`);
      }
      await acquireStateAuthorityFileRetirementFinisherRecovery(finishingPath, finisher);
    }

    const current = await readStateAuthorityFileSnapshot(path, parse);
    if (current && !authorityFileSnapshotMatches(current, retirement)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock coordination record changed during retirement');
    }
    if (current) {
      await unlink(path);
      await fsyncAuthorityDirectory(parent);
    }
    try {
      await link(retirementPath, completionPath);
      await fsyncAuthorityDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const persisted = await readStateAuthorityFileSnapshot(completionPath, parse);
      if (!persisted || !authorityFileSnapshotMatches(persisted, retirement)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock retirement completion changed: ${completionPath}`);
      }
    }
  }
}

async function retireStateAuthorityFile<T>(
  path: string,
  expected: StateAuthorityFileSnapshot<T>,
  parse: (content: string, path: string) => T,
  options: {
    /** Test-only crash seam. It is never persisted or transported. */
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const retirementPath = stateAuthorityFileRetirementPath(path, expected);
  try {
    await link(path, retirementPath);
    await fsyncAuthorityDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  const retirement = await readStateAuthorityFileSnapshot(retirementPath, parse);
  if (!retirement || !authorityFileSnapshotMatches(retirement, expected)) return false;
  await completePendingStateAuthorityFileRetirements(path, parse, options);
  return true;
}

function staleGuardClaimTargetsSnapshot(
  claim: StateAuthorityLockAcquisitionReclaimClaimRecord,
  guard: StateAuthorityLockAcquisitionGuardSnapshot,
): boolean {
  return claim.target_guard.owner_nonce === guard.record.owner_nonce
    && claim.target_guard.device === String(guard.device)
    && claim.target_guard.inode === String(guard.inode)
    && claim.target_guard.content_digest === guard.content_digest;
}

async function recoverStaleStateAuthorityLockAcquisitionReclaimClaim(
  claimPath: string,
  snapshot: StateAuthorityLockAcquisitionReclaimClaimSnapshot,
): Promise<boolean> {
  const state = await inspectLockOwner(snapshot.record.owner);
  if (state === 'live' || state === 'unproven') return false;
  return retireStateAuthorityFile(
    claimPath,
    snapshot,
    parseStateAuthorityLockAcquisitionReclaimClaimRecord,
  );
}

async function honorStateAuthorityLockAcquisitionReclaimClaim(
  claimPath: string,
): Promise<'clear' | 'contended' | 'changed'> {
  await completePendingStateAuthorityFileRetirements(
    claimPath,
    parseStateAuthorityLockAcquisitionReclaimClaimRecord,
  );
  const snapshot = await readStateAuthorityLockAcquisitionReclaimClaimSnapshot(claimPath);
  if (!snapshot) return 'clear';
  if (await recoverStaleStateAuthorityLockAcquisitionReclaimClaim(claimPath, snapshot)) return 'changed';
  const current = await readStateAuthorityLockAcquisitionReclaimClaimSnapshot(claimPath);
  if (!current || !authorityFileSnapshotMatches(current, snapshot)) return 'changed';
  return 'contended';
}

async function acquireStateAuthorityLockAcquisitionReclaimClaim(
  claimPath: string,
  guard: StateAuthorityLockAcquisitionGuardSnapshot,
): Promise<AcquiredStateAuthorityLockAcquisitionReclaimClaim | null> {
  await completePendingStateAuthorityFileRetirements(
    claimPath,
    parseStateAuthorityLockAcquisitionReclaimClaimRecord,
  );
  const record: StateAuthorityLockAcquisitionReclaimClaimRecord = {
    schema_version: 1,
    kind: 'stale-guard-reclamation',
    claim_nonce: randomBytes(16).toString('hex'),
    owner: createStateAuthorityLockOwner(),
    acquired_at: nowIso(),
    target_guard: {
      owner_nonce: guard.record.owner_nonce,
      device: String(guard.device),
      inode: String(guard.inode),
      content_digest: guard.content_digest,
    },
  };
  const snapshot = await createExclusiveStateAuthorityFile(claimPath, record);
  if (!snapshot) return null;
  const parsed = await readStateAuthorityLockAcquisitionReclaimClaimSnapshot(claimPath);
  if (!parsed || !authorityFileSnapshotMatches(parsed, snapshot)
    || parsed.record.claim_nonce !== record.claim_nonce) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition reclamation claim changed while establishing: ${claimPath}`);
  }
  return { path: claimPath, snapshot: parsed };
}

async function installStateAuthorityLockAcquisitionGuard(
  path: string,
  options: {
    /** Test-only crash seam. It is never persisted or transported. */
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  } = {},
): Promise<AcquiredStateAuthorityLockAcquisitionGuard | null> {
  await completePendingStateAuthorityFileRetirements(
    path,
    parseStateAuthorityLockAcquisitionGuardRecord,
    options,
  );
  const record: StateAuthorityLockAcquisitionGuardRecord = {
    schema_version: 1,
    kind: 'acquisition-guard',
    owner_nonce: randomBytes(16).toString('hex'),
    owner: createStateAuthorityLockOwner(),
    acquired_at: nowIso(),
  };
  const snapshot = await createExclusiveStateAuthorityFile(path, record);
  if (!snapshot) return null;
  const parsed = await readStateAuthorityLockAcquisitionGuardSnapshot(path);
  if (!parsed || !authorityFileSnapshotMatches(parsed, snapshot)
    || parsed.record.owner_nonce !== record.owner_nonce) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, `workspace authority lock acquisition guard changed while establishing: ${path}`);
  }
  return { path, snapshot: parsed };
}

async function reclaimStaleStateAuthorityLockAcquisitionGuard(
  guardPath: string,
  claimPath: string,
  guard: StateAuthorityLockAcquisitionGuardSnapshot,
  options: {
    test_only_after_stale_guard_reclamation_claim?: () => void | Promise<void>;
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  } = {},
): Promise<AcquiredStateAuthorityLockAcquisitionGuard | null> {
  const claim = await acquireStateAuthorityLockAcquisitionReclaimClaim(claimPath, guard);
  if (!claim) return null;
  const [currentClaim, currentGuard] = await Promise.all([
    readStateAuthorityLockAcquisitionReclaimClaimSnapshot(claim.path),
    readStateAuthorityLockAcquisitionGuardSnapshot(guardPath),
  ]);
  if (!currentClaim || !authorityFileSnapshotMatches(currentClaim, claim.snapshot)
    || !currentGuard || !authorityFileSnapshotMatches(currentGuard, guard)
    || !staleGuardClaimTargetsSnapshot(currentClaim.record, currentGuard)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock acquisition guard changed during stale reclamation');
  }
  await options.test_only_after_stale_guard_reclamation_claim?.();
  if (!await retireStateAuthorityFile(
    guardPath,
    guard,
    parseStateAuthorityLockAcquisitionGuardRecord,
    options,
  )) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock acquisition guard changed before stale reclamation');
  }
  const installed = await installStateAuthorityLockAcquisitionGuard(guardPath);
  if (!installed) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock acquisition guard was replaced during stale reclamation');
  }
  if (!await retireStateAuthorityFile(
    claim.path,
    claim.snapshot,
    parseStateAuthorityLockAcquisitionReclaimClaimRecord,
  )) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock acquisition reclamation claim changed before completion');
  }
  return installed;
}

async function acquireStateAuthorityLockAcquisitionGuard(
  workspace: WorkspaceIdentity,
  options: {
    test_only_after_stale_guard_reclamation_claim?: () => void | Promise<void>;
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  } = {},
): Promise<AcquiredStateAuthorityLockAcquisitionGuard> {
  const paths = stateAuthorityPaths(workspace);
  const guardPath = join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_ACQUISITION_GUARD);
  const claimPath = join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_ACQUISITION_RECLAIM_CLAIM);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimState = await honorStateAuthorityLockAcquisitionReclaimClaim(claimPath);
    if (claimState === 'changed') continue;
    if (claimState === 'contended') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock acquisition reclamation is already in progress: ${claimPath}`);
    }
    const installed = await installStateAuthorityLockAcquisitionGuard(guardPath, {
      test_only_after_retirement_finisher_publication: options.test_only_after_retirement_finisher_publication,
    });
    if (installed) return installed;
    const guard = await readStateAuthorityLockAcquisitionGuardSnapshot(guardPath);
    if (!guard) continue;
    const state = await inspectLockOwner(guard.record.owner);
    if (state === 'live' || state === 'unproven') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock acquisition is already in progress: ${guardPath}`);
    }
    const reclaimed = await reclaimStaleStateAuthorityLockAcquisitionGuard(guardPath, claimPath, guard, options);
    if (reclaimed) return reclaimed;
  }
  authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock acquisition is already in progress: ${guardPath}`);
}

async function releaseStateAuthorityLockAcquisitionGuard(
  guard: AcquiredStateAuthorityLockAcquisitionGuard,
): Promise<void> {
  if (!await retireStateAuthorityFile(
    guard.path,
    guard.snapshot,
    parseStateAuthorityLockAcquisitionGuardRecord,
  )) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock acquisition guard was replaced while held');
  }
}

async function appendWorkspaceAuthorityLockTombstone(
  workspace: WorkspaceIdentity,
  lock: StateAuthorityLockRecord,
  snapshot: StateAuthorityLockSnapshot,
  proof: StateAuthorityLockTakeoverProof,
  replacementFence: number,
): Promise<void> {
  const paths = stateAuthorityPaths(workspace);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.bootstrap_directory);
  const tombstonePath = join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_TOMBSTONE_FILE);
  const existing = await readAuthorityFileNoFollow(tombstonePath, {
    authority_root: workspace.canonical_path,
  }) ?? '';
  const next = `${existing}${JSON.stringify({
    schema_version: 1,
    event: 'stale_lock_takeover',
    stale_lock: lock,
    stale_lock_snapshot: {
      device: String(snapshot.device),
      inode: String(snapshot.inode),
      content_digest: snapshot.content_digest,
    },
    proof,
    replacement_fencing_token: replacementFence,
    recorded_at: nowIso(),
  })}\n`;
  await atomicWriteAuthorityFile(tombstonePath, next, { authority_root: workspace.canonical_path });
}

async function recoverStaleWorkspaceAuthorityLock(
  workspace: WorkspaceIdentity,
  replacement: StateAuthorityLockRecord,
  options: {
    /** Test-only race seam. It is never persisted or transported. */
    test_only_after_final_stale_lock_identity_check?: () => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const paths = stateAuthorityPaths(workspace);
  const inspected = await readWorkspaceAuthorityLockSnapshot(paths.lock_path);
  if (!inspected) return false;
  const stale = inspected.record;
  if (stale.schema_version !== 1 || typeof stale.owner_nonce !== 'string'
    || !stale.owner || typeof stale.owner !== 'object') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock is malformed and cannot be taken over safely');
  }
  const state = await inspectLockOwner(stale.owner);
  if (state === 'live' || state === 'unproven') return false;
  const proof: StateAuthorityLockTakeoverProof = {
    kind: 'owner-exited',
    owner_nonce: stale.owner_nonce,
    fencing_token: stale.fencing_token,
    verified_at: nowIso(),
  };
  const denial = canTakeOverWorkspaceAuthorityLock(stale, proof);
  if (denial) authorityError(denial.code, denial.message);

  await options.test_only_after_final_stale_lock_identity_check?.();
  const afterTestSeam = await readWorkspaceAuthorityLockSnapshot(paths.lock_path);
  if (!afterTestSeam || !lockSnapshotMatches(afterTestSeam, inspected)) return false;

  await appendWorkspaceAuthorityLockTombstone(workspace, stale, afterTestSeam, proof, replacement.fencing_token);
  const atRenameBoundary = await readWorkspaceAuthorityLockSnapshot(paths.lock_path);
  if (!atRenameBoundary || !lockSnapshotMatches(atRenameBoundary, inspected)) return false;

  const stalePath = join(paths.bootstrap_directory, `${STATE_AUTHORITY_LOCK}.stale-${stale.fencing_token}-${randomBytes(8).toString('hex')}`);
  try {
    await rename(paths.lock_path, stalePath);
    await fsyncAuthorityDirectory(paths.bootstrap_directory);
    const quarantined = await readWorkspaceAuthorityLockSnapshot(stalePath);
    if (!quarantined || !lockSnapshotMatches(quarantined, inspected)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock changed at the stale-lock quarantine boundary');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}


export async function acquireWorkspaceAuthorityLock(
  workspace: WorkspaceIdentity,
  input: {
    fencing_token: number;
    anchor_revision: number;
    owner?: StateAuthorityLockOwner;
    now?: Date;
    owner_nonce?: string;
    /** Test-only race seam. It is never persisted or transported. */
    test_only_after_final_stale_lock_identity_check?: () => void | Promise<void>;
    /** Test-only claim-election seam. It is never persisted or transported. */
    test_only_after_stale_guard_reclamation_claim?: () => void | Promise<void>;
    /** Test-only crash seam. It is never persisted or transported. */
    test_only_after_retirement_finisher_publication?: () => void | Promise<void>;
  },
): Promise<AcquiredStateAuthorityLock> {
  assertWorkspaceIdentity(workspace);
  const paths = stateAuthorityPaths(workspace);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.omx_root);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.bootstrap_directory);
  const now = input.now ?? new Date();
  const requestedFence = assertFiniteNonNegativeInteger(
    input.fencing_token,
    'lock fencing token',
    AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch,
  );
  const anchorRevision = assertFiniteNonNegativeInteger(
    input.anchor_revision,
    'lock anchor revision',
    AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch,
  );


  const guard = await acquireStateAuthorityLockAcquisitionGuard(workspace, {
    test_only_after_stale_guard_reclamation_claim: input.test_only_after_stale_guard_reclamation_claim,
    test_only_after_retirement_finisher_publication: input.test_only_after_retirement_finisher_publication,
  });
  try {
    const fencingToken = await reserveWorkspaceAuthorityLockFence(workspace, requestedFence, now);
    const record: StateAuthorityLockRecord = {
      schema_version: 1,
      owner_nonce: input.owner_nonce ?? randomBytes(16).toString('hex'),
      fencing_token: fencingToken,
      anchor_revision: anchorRevision,
      owner: input.owner ?? createStateAuthorityLockOwner(now),
      acquired_at: nowIso(now),
      heartbeat_at: nowIso(now),
    };
    nonEmptyString(record.owner_nonce, 'lock owner nonce', AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const installed = await createExclusiveStateAuthorityFile(paths.lock_path, record);
      if (installed) {
        const persisted = installed.record as StateAuthorityLockRecord;
        if (!lockRecordMatches(persisted, record)
          || persisted.anchor_revision !== record.anchor_revision
          || persisted.schema_version !== 1) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven, 'workspace authority lock publication does not match its fully synced ownership record');
        }
        return { path: paths.lock_path, record };
      }
      if (attempt === 0 && await recoverStaleWorkspaceAuthorityLock(workspace, record, {
        test_only_after_final_stale_lock_identity_check: input.test_only_after_final_stale_lock_identity_check,
      })) {
        continue;
      }
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock is already held: ${paths.lock_path}`);
    }

    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, `workspace authority lock is already held: ${paths.lock_path}`);
  } finally {
    await releaseStateAuthorityLockAcquisitionGuard(guard);
  }
}
async function acquireCurrentWorkspaceAuthorityLock(
  workspace: WorkspaceIdentity,
  now?: Date,
): Promise<{ lock: AcquiredStateAuthorityLock; anchor: WorkspaceAuthorityAnchor | null }> {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    try {
      const lock = await acquireWorkspaceAuthorityLock(workspace, {
        fencing_token: (anchor?.fencing_token ?? 0) + 1,
        anchor_revision: anchor?.anchor_revision ?? 0,
        ...(now ? { now } : {}),
      });
      return { lock, anchor };
    } catch (error) {
      if (!(error instanceof StateAuthorityError) || error.code !== AUTHORITY_DIAGNOSTIC_CODES.lockHeld) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, 'timed out waiting for the workspace authority lock');
}

async function readLockFromHandle(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<StateAuthorityLockRecord> {
  const raw = await handle.readFile('utf-8');
  let record: StateAuthorityLockRecord;
  try {
    record = JSON.parse(raw) as StateAuthorityLockRecord;
  } catch {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, `workspace authority lock is malformed: ${path}`);
  }
  if (record.schema_version !== 1 || typeof record.owner_nonce !== 'string') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, `workspace authority lock has an unsupported schema: ${path}`);
  }
  return record;
}

async function assertLockHandleIsCurrent(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([handle.stat(), lstat(path)]);
  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock was replaced while held');
  }
}

export async function heartbeatWorkspaceAuthorityLock(
  lock: AcquiredStateAuthorityLock,
  now = new Date(),
): Promise<AcquiredStateAuthorityLock> {
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow workspace lock opens');
  }
  const workspace = resolveWorkspaceIdentity(dirname(dirname(dirname(lock.path))));
  const paths = stateAuthorityPaths(workspace);
  if (paths.lock_path !== lock.path) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock path is not rooted in its canonical bootstrap directory');
  }
  const guard = await acquireStateAuthorityLockAcquisitionGuard(workspace);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lock.path, fsConstants.O_RDONLY | noFollow);
    await assertLockHandleIsCurrent(handle, lock.path);
    const current = await readLockFromHandle(handle, lock.path);
    if (!lockRecordMatches(current, lock.record)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock heartbeat owner does not match');
    }
    if (process.platform === 'win32') {
      await handle.close();
      handle = undefined;
      const beforePublish = await readWorkspaceAuthorityLockSnapshot(lock.path);
      if (!beforePublish || !lockRecordMatches(beforePublish.record, current)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock changed before heartbeat publication');
      }
    }
    const next: StateAuthorityLockRecord = { ...current, heartbeat_at: nowIso(now) };
    await atomicWriteAuthorityJson(lock.path, next, { authority_root: workspace.canonical_path });
    const published = await readWorkspaceAuthorityLockSnapshot(lock.path);
    if (!published || !lockRecordMatches(published.record, next)
      || published.record.anchor_revision !== next.anchor_revision
      || published.record.heartbeat_at !== next.heartbeat_at) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock heartbeat publication could not be verified');
    }
    return { path: lock.path, record: next };
  } finally {
    await handle?.close();
    await releaseStateAuthorityLockAcquisitionGuard(guard);
  }
}

export async function releaseWorkspaceAuthorityLock(lock: AcquiredStateAuthorityLock): Promise<void> {
  const noFollow = noFollowFileOpenFlags();
  if (noFollow === null) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'the runtime does not expose no-follow workspace lock opens');
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lock.path, fsConstants.O_RDWR | noFollow);
    await assertLockHandleIsCurrent(handle, lock.path);
    const held = await handle.stat();
    const current = await readLockFromHandle(handle, lock.path);
    if (!lockRecordMatches(current, lock.record)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock release owner does not match');
    }
    if (process.platform === 'win32') {
      await handle.close();
      handle = undefined;
      const [pathStat, snapshot] = await Promise.all([
        lstat(lock.path),
        readWorkspaceAuthorityLockSnapshot(lock.path),
      ]);
      if (!sameStatIdentity(held, pathStat) || !snapshot || !lockRecordMatches(snapshot.record, current)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockOwnerMismatch, 'workspace authority lock changed before release');
      }
    }
    await unlink(lock.path);
  } finally {
    await handle?.close();
  }
  await fsyncAuthorityDirectory(dirname(lock.path));
}

export function canTakeOverWorkspaceAuthorityLock(
  lock: StateAuthorityLockRecord,
  proof: StateAuthorityLockTakeoverProof | null,
): AuthorityDiagnostic | null {
  if (!proof
    || proof.kind !== 'owner-exited'
    || proof.owner_nonce !== lock.owner_nonce
    || proof.fencing_token !== lock.fencing_token) {
    return diagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven,
      'workspace authority lock takeover requires proof that the exact prior owner cannot resume',
    );
  }
  return null;
}

export function validateStateAuthorityGeneration(generation: StateAuthorityGeneration): void {
  if (generation.schema_version !== 1
    || generation.authority_protocol_version !== 1
    || generation.status !== 'committed') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityProtocolIncompatible, 'state authority generation has an unsupported schema, protocol, or status');
  }
  safeIdentifier(generation.authority_id, 'authority ID');
  safeIdentifier(generation.generation_id, 'generation ID');
  assertWorkspaceIdentity(generation.workspace_identity);
  if (generation.workspace_identity_digest !== generation.workspace_identity.digest) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'state authority generation workspace digest does not match');
  }
  if (generation.canonical_omx_root !== dirname(generation.canonical_state_root)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, 'state authority generation OMX root does not contain its state root');
  }
  assertFiniteNonNegativeInteger(generation.creation_fence, 'generation creation fence', AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed);
}

export async function validateStateAuthority(
  generation: StateAuthorityGeneration,
  input: StateAuthorityValidationInput,
): Promise<StateAuthorityValidation> {
  const diagnostics: AuthorityDiagnostic[] = [];
  try {
    validateStateAuthorityGeneration(generation);
  } catch (error) {
    if (error instanceof StateAuthorityError) {
      return { valid: false, diagnostics: [diagnostic(error.code, error.message)] };
    }
    throw error;
  }
  if (!sameWorkspaceIdentity(generation.workspace_identity, input.workspace_identity)) {
    diagnostics.push(diagnostic(AUTHORITY_DIAGNOSTIC_CODES.workspaceMismatch, 'state authority generation belongs to a different workspace'));
  }
  try {
    await assertPathHasNoSymlinkComponents(generation.canonical_state_root, 'state authority root');
    const actual = await captureRootFilesystemIdentity(generation.canonical_state_root);
    if (!sameRootFilesystemIdentity(generation.root_identity, actual)) {
      diagnostics.push(diagnostic(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'state authority root fingerprint changed after establishment'));
    }
    if (generation.root_capability.strong_root_identity !== 'verified'
      || !hasVerifiedAuthorityMutationSafety(generation.root_capability)) {
      diagnostics.push(diagnostic(
        AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
        'state authority root lacks strong identity or verified safe authority mutation support',
      ));
    }
  } catch (error) {
    if (error instanceof StateAuthorityError) diagnostics.push(diagnostic(error.code, error.message));
    else throw error;
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateJournalTransition(
  current: StateAuthorityJournalStatus,
  next: StateAuthorityJournalStatus,
): void {
  const allowed: Record<StateAuthorityJournalStatus, readonly StateAuthorityJournalStatus[]> = {
    prepared: ['applying', 'aborted'],
    applying: ['committed', 'aborted'],
    committed: [],
    aborted: [],
  };
  if (!allowed[current].includes(next)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalTransitionInvalid, `journal cannot transition from ${current} to ${next}`);
  }
}

export function validateStateAuthorityJournal(journal: StateAuthorityOperationJournal): void {
  if (journal.schema_version !== 1 || journal.authority_protocol_version !== 1) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'authority journal has an unsupported schema or protocol');
  }
  safeIdentifier(journal.operation_id, 'journal operation ID');
  safeIdentifier(journal.authority_id, 'journal authority ID');
  safeIdentifier(journal.generation_id, 'journal generation ID');
  if (!['generation_establish', 'generation_terminalize', 'launch_transport_publish', 'alternate_root_rollover'].includes(journal.kind)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'authority journal has an invalid operation kind');
  }
  if (!['prepared', 'applying', 'committed', 'aborted'].includes(journal.status)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'authority journal has an invalid status');
  }
  assertFiniteNonNegativeInteger(journal.binding_revision, 'journal binding revision', AUTHORITY_DIAGNOSTIC_CODES.journalMalformed);
  if (journal.kind === 'launch_transport_publish') {
    if (!journal.binding_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'launch transport journal is missing its binding ID');
    }
    safeIdentifier(journal.binding_id, 'launch transport journal binding ID');
  } else if (journal.binding_id !== undefined) {
    safeIdentifier(journal.binding_id, 'journal binding ID');
  }
  assertFiniteNonNegativeInteger(journal.expected_anchor_revision, 'journal expected anchor revision', AUTHORITY_DIAGNOSTIC_CODES.journalMalformed);
  assertFiniteNonNegativeInteger(journal.fencing_token, 'journal fencing token', AUTHORITY_DIAGNOSTIC_CODES.journalMalformed);
  if (!/^[0-9a-f]{64}$/i.test(journal.effects_digest) || !Array.isArray(journal.completed_steps)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'authority journal has an invalid effects digest or completed steps');
  }
}

export function createStateAuthorityJournal(input: Omit<StateAuthorityOperationJournal, 'schema_version' | 'authority_protocol_version' | 'status' | 'created_at' | 'updated_at' | 'completed_steps'> & {
  now?: Date;
}): StateAuthorityOperationJournal {
  const now = input.now ?? new Date();
  const journal: StateAuthorityOperationJournal = {
    schema_version: 1,
    authority_protocol_version: 1,
    operation_id: input.operation_id,
    kind: input.kind,
    status: 'prepared',
    authority_id: input.authority_id,
    generation_id: input.generation_id,
    binding_revision: input.binding_revision,
    ...(input.binding_id === undefined ? {} : { binding_id: input.binding_id }),
    workspace_identity_digest: input.workspace_identity_digest,
    expected_anchor_revision: input.expected_anchor_revision,
    fencing_token: input.fencing_token,
    created_at: nowIso(now),
    updated_at: nowIso(now),
    effects_digest: input.effects_digest,
    completed_steps: [],
  };
  validateStateAuthorityJournal(journal);
  return journal;
}

export function transitionStateAuthorityJournal(
  journal: StateAuthorityOperationJournal,
  next: StateAuthorityJournalStatus,
  options: { completed_step?: string; blocked_reason?: string; now?: Date } = {},
): StateAuthorityOperationJournal {
  validateStateAuthorityJournal(journal);
  validateJournalTransition(journal.status, next);
  const steps = options.completed_step
    ? [...new Set([...journal.completed_steps, safeIdentifier(options.completed_step, 'journal completed step')])]
    : [...journal.completed_steps];
  return {
    ...journal,
    status: next,
    completed_steps: steps,
    blocked_reason: options.blocked_reason,
    updated_at: nowIso(options.now ?? new Date()),
  };
}

export async function readStateAuthorityJournal(path: string): Promise<StateAuthorityOperationJournal> {
  await assertPathHasNoSymlinkComponents(path, 'authority journal');
  const journal = await readAuthorityJson(path, AUTHORITY_DIAGNOSTIC_CODES.journalMalformed) as StateAuthorityOperationJournal;
  validateStateAuthorityJournal(journal);
  return journal;
}

export async function writeStateAuthorityJournal(
  path: string,
  journal: StateAuthorityOperationJournal,
  authorityRoot?: string,
  expectedRootIdentity?: RootFilesystemIdentity,
): Promise<void> {
  validateStateAuthorityJournal(journal);
  await assertPathHasNoSymlinkComponents(path, 'authority journal');
  await atomicWriteAuthorityJson(path, journal, authorityRoot
    ? { authority_root: authorityRoot, ...(expectedRootIdentity ? { expected_root_identity: expectedRootIdentity } : {}) }
    : {});
}



export function evaluateStateAuthorityBootstrap(
  evidence: StateAuthorityBootstrapEvidence,
): StateAuthorityBootstrapDecisionResult {
  if (evidence.has_pending_operation) return { decision: 'recover-pending' };
  if (evidence.has_active_generation) return { decision: 'resolve-active' };
  if (evidence.requested_resume) {
    return {
      decision: 'deny-resume-missing',
      diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.resumeEvidenceMissing, 'requested state authority resume has no proven active authority'),
    };
  }
  if (evidence.authenticated_prepared_intent_count > 1 || evidence.valid_legacy_candidate_count > 1) {
    return {
      decision: 'deny-ambiguous',
      diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.intentAmbiguous, 'multiple authority candidates or prepared alternate intents are present'),
    };
  }
  if (evidence.has_terminal_lineage) return { decision: 'rollover' };
  if (evidence.legacy_artifact_paths.length === 0) return { decision: 'establish-pristine' };
  if (evidence.valid_legacy_candidate_count === 1) return { decision: 'migrate-legacy' };
  return {
    decision: 'deny-legacy-unproven',
    diagnostic: diagnostic(AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven, 'legacy authority-like artifacts exist without one proven migration candidate'),
  };
}

async function hasLegacyAuthorityArtifacts(stateRoot: string): Promise<boolean> {
  try {
    const entries = await readdir(stateRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.name === 'session.json' || entry.name.endsWith('-state.json')) return true;
        continue;
      }
      if (await hasLegacyAuthorityArtifacts(join(stateRoot, entry.name))) return true;
    }
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    return true;
  }
}

/**
 * A missing anchor is not pristine when first-party protocol evidence survives.
 * This deliberately inspects only bounded bootstrap/authority namespaces so
 * ordinary-root legacy artifacts remain eligible for deterministic migration.
 */
async function hasSurvivingStateAuthorityProtocolEvidence(workspace: WorkspaceIdentity): Promise<boolean> {
  const paths = stateAuthorityPaths(workspace);
  try {
    await assertPathHasNoSymlinkComponents(paths.bootstrap_directory, 'state authority bootstrap evidence directory');
    if ((await readdir(paths.bootstrap_directory, { withFileTypes: true })).length > 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const authorityDirectory = join(resolveOrdinaryStateRoot(workspace), 'authority');
  try {
    await assertPathHasNoSymlinkComponents(authorityDirectory, 'state authority protocol evidence directory');
    const entries = await readdir(authorityDirectory, { withFileTypes: true });
    return entries.some((entry) => entry.name === 'generations'
      || entry.name === STATE_AUTHORITY_TOMBSTONE_FILE
      || entry.name === STATE_AUTHORITY_FILE
      || entry.name === STATE_AUTHORITY_JOURNAL_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface UnanchoredPristinePreparation {
  state_root: string;
  root_identity: RootFilesystemIdentity;
  journal_path: string;
  journal: StateAuthorityOperationJournal;
}

function assertUnanchoredPristineJournal(
  journal: StateAuthorityOperationJournal,
  workspace: WorkspaceIdentity,
  stateRoot: string,
  generationId: string,
  journalPath: string,
): void {
  const createdAt = new Date(journal.created_at);
  const updatedAt = new Date(journal.updated_at);
  if (journal.kind !== 'generation_establish'
    || journal.status !== 'prepared'
    || journal.workspace_identity_digest !== workspace.digest
    || journal.generation_id !== generationId
    || journal.authority_id !== generationId
    || journal.binding_revision !== 0
    || journal.binding_id !== undefined
    || journal.expected_anchor_revision !== 1
    || journal.completed_steps.length !== 0
    || journal.blocked_reason !== undefined
    || Number.isNaN(createdAt.getTime())
    || Number.isNaN(updatedAt.getTime())
    || journal.created_at !== journal.updated_at
    || journalPath !== authorityJournalPath(stateRoot, generationId, journal.operation_id)
    || journal.effects_digest !== journalEffectsDigest({
      workspace: workspace.digest,
      source_generation: 'none',
      target_generation: generationId,
      target_root: stateRoot,
    })) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'unanchored pristine authority preparation journal is foreign, malformed, or no longer journal-first');
  }
}

async function inspectUnanchoredPristinePreparation(
  workspace: WorkspaceIdentity,
): Promise<UnanchoredPristinePreparation | null> {
  const stateRoot = resolveOrdinaryStateRoot(workspace);
  if (!existsSync(stateRoot)) return null;
  await assertPathHasNoSymlinkComponents(stateRoot, 'unanchored pristine authority root');
  const canonicalStateRoot = canonicalizeExistingAuthorityPath(stateRoot, 'unanchored pristine authority root');
  if (!hasTrustedAuthorityCanonicalPath(stateRoot, canonicalStateRoot)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'unanchored pristine authority root is not the deterministic workspace state root');
  }
  const authorityDirectory = join(canonicalStateRoot, 'authority');
  let authorityEntries: Dirent[];
  try {
    await assertPathHasNoSymlinkComponents(authorityDirectory, 'unanchored pristine authority directory');
    authorityEntries = await readdir(authorityDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (authorityEntries.length !== 1 || authorityEntries[0]?.name !== 'generations'
    || authorityEntries[0].isSymbolicLink() || !authorityEntries[0].isDirectory()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'unanchored pristine authority evidence is ambiguous or malformed');
  }
  const generationsDirectory = join(authorityDirectory, 'generations');
  await assertPathHasNoSymlinkComponents(generationsDirectory, 'unanchored pristine generation directory');
  const generations = await readdir(generationsDirectory, { withFileTypes: true });
  if (generations.length !== 1 || generations[0]?.isSymbolicLink() || !generations[0]?.isDirectory()
    || !SAFE_ID_PATTERN.test(generations[0].name)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentAmbiguous, 'unanchored pristine authority evidence has no single safe generation');
  }
  const generationId = generations[0].name;
  const generationPaths = authorityGenerationPaths(canonicalStateRoot, generationId);
  await assertPathHasNoSymlinkComponents(generationPaths.journal_directory, 'unanchored pristine journal directory');
  const journals = await readdir(generationPaths.journal_directory, { withFileTypes: true });
  if (journals.length !== 1 || journals[0]?.isSymbolicLink() || !journals[0]?.isFile() || !journals[0].name.endsWith('.json')) {
    return null;
  }
  const journalPath = join(generationPaths.journal_directory, journals[0].name);
  const journal = await readStateAuthorityJournal(journalPath);
  if (
    journal.status !== 'prepared' ||
    journal.kind !== 'generation_establish'
  ) {
    return null;
  }
  const generationEntries = await readdir(generationPaths.generation_directory, { withFileTypes: true });
  const expectedGenerationDirectories = new Set(['bindings', STATE_AUTHORITY_JOURNAL_DIRECTORY]);
  if (generationEntries.length !== expectedGenerationDirectories.size
    || generationEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory() || !expectedGenerationDirectories.has(entry.name))) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'unanchored pristine authority generation contains effects before an anchor was published');
  }
  await assertPathHasNoSymlinkComponents(generationPaths.binding_directory, 'unanchored pristine binding directory');
  if ((await readdir(generationPaths.binding_directory, { withFileTypes: true })).length !== 0) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'unanchored pristine authority generation has binding effects before anchor publication');
  }
  assertUnanchoredPristineJournal(journal, workspace, canonicalStateRoot, generationId, journalPath);
  return {
    state_root: canonicalStateRoot,
    root_identity: await captureRootFilesystemIdentity(canonicalStateRoot),
    journal_path: journalPath,
    journal,
  };
}

async function recoverUnanchoredPristinePreparation(
  workspace: WorkspaceIdentity,
  now: Date,
): Promise<boolean> {
  const inspected = await inspectUnanchoredPristinePreparation(workspace);
  if (!inspected) return false;
  const { lock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  try {
    if (await readWorkspaceAuthorityAnchor(workspace)) return false;
    const current = await inspectUnanchoredPristinePreparation(workspace);
    if (!current
      || current.journal_path !== inspected.journal_path
      || current.journal.operation_id !== inspected.journal.operation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'unanchored pristine authority preparation changed during recovery');
    }
    if (!sameRootFilesystemIdentity(inspected.root_identity, current.root_identity)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'unanchored pristine authority root was replaced during recovery');
    }
    await writeStateAuthorityJournal(
      current.journal_path,
      transitionStateAuthorityJournal(current.journal, 'aborted', {
        blocked_reason: 'unanchored pristine authority preparation recovered before anchor publication',
        now,
      }),
      current.state_root,
      current.root_identity,
    );
    return true;
  } finally {
    await releaseWorkspaceAuthorityLock(lock);
  }
}

async function isProvenLegacyAuthorityCandidate(
  stateRoot: string,
  workspace: WorkspaceIdentity,
  input: InitializeStateAuthorityInput,
  allowUnscopedDeterministicRoot = false,
): Promise<boolean> {
  const sessionPath = join(stateRoot, 'session.json');
  try {
    const fileStat = await lstat(sessionPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return false;
    const session = JSON.parse(await readFile(sessionPath, 'utf-8')) as Record<string, unknown>;
    const sessionId = typeof session.session_id === 'string' ? session.session_id.trim() : '';
    const sessionCwd = typeof session.cwd === 'string' ? session.cwd.trim() : '';
    if (!sessionId) return false;
    if (sessionCwd) {
      const legacyWorkspace = resolveWorkspaceIdentity(sessionCwd);
      if (legacyWorkspace.digest !== workspace.digest) return false;
    }
    const aliases = input.session_binding.aliases;
    const acceptedSessionIds = new Set([
      input.session_binding.canonical_session_id,
      ...(aliases?.current_session_aliases ?? []),
      ...(aliases?.previous_session_aliases ?? []),
      ...(aliases?.owner_session_aliases ?? []),
      aliases?.native_session_id,
    ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()));
    return acceptedSessionIds.has(sessionId);
  } catch (error) {
    return allowUnscopedDeterministicRoot && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
function requestedBindingMatchesActive(
  requested: CreateSessionAuthorityBindingInput,
  active: SessionAuthorityBinding,
): boolean {
  const activeIds = new Set([
    active.canonical_session_id,
    active.aliases.native_session_id,
    ...active.aliases.current_session_aliases,
    ...active.aliases.previous_session_aliases,
    ...active.aliases.owner_session_aliases,
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()));
  const requestedAliases = requested.aliases;
  const requestedIds = [
    requested.canonical_session_id,
    requestedAliases?.native_session_id,
    ...(requestedAliases?.current_session_aliases ?? []),
    ...(requestedAliases?.previous_session_aliases ?? []),
    ...(requestedAliases?.owner_session_aliases ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
  return requestedIds.some((value) => activeIds.has(value));
}

function mergeSessionAliases(
  active: SessionAliasSet,
  requested: Partial<SessionAliasSet> | undefined,
): Partial<SessionAliasSet> {
  return {
    native_session_id: requested?.native_session_id ?? active.native_session_id,
    current_session_aliases: [...new Set([...active.current_session_aliases, ...(requested?.current_session_aliases ?? [])])],
    previous_session_aliases: [...new Set([...active.previous_session_aliases, ...(requested?.previous_session_aliases ?? [])])],
    owner_session_aliases: [...new Set([...active.owner_session_aliases, ...(requested?.owner_session_aliases ?? [])])],
  };
}
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function mayTerminalizeRecordedGeneration(generation: StateAuthorityGeneration): Promise<boolean> {
  const owner: StateAuthorityLockOwner = {
    host: hostname(),
    pid: generation.created_by_pid,
    process_started_at: generation.created_by_process_started_at ?? generation.created_at,
    ...(generation.created_by_boot_id ? { boot_id: generation.created_by_boot_id } : {}),
    ...(generation.created_by_command_digest ? { command_digest: generation.created_by_command_digest } : {}),
  };
  const state = await inspectLockOwner(owner);
  return state === 'exited' || state === 'reused';
}

function createGeneration(
  workspace: WorkspaceIdentity,
  stateRoot: string,
  rootIdentity: RootFilesystemIdentity,
  rootCapability: StateAuthorityFilesystemCapability,
  fence: number,
  priorGenerationId: string | undefined,
  now: Date,
  generationId = randomUUID(),
): StateAuthorityGeneration {
  const authorityId = safeIdentifier(generationId, 'generation ID');
  const creator = createStateAuthorityLockOwner(now);
  return {
    schema_version: 1,
    authority_protocol_version: 1,
    authority_id: authorityId,
    generation_id: authorityId,
    status: 'committed',
    canonical_state_root: stateRoot,
    canonical_omx_root: dirname(stateRoot),
    root_identity: rootIdentity,
    root_capability: rootCapability,
    workspace_identity: workspace,
    workspace_identity_digest: workspace.digest,
    creation_fence: fence,
    prior_generation_id: priorGenerationId,
    created_at: nowIso(now),
    created_by_pid: creator.pid,
    created_by_process_started_at: creator.process_started_at,
    created_by_boot_id: creator.boot_id,
    created_by_command_digest: creator.command_digest,
  };
}

async function ensureStateAuthorityGenerationDirectories(
  workspace: WorkspaceIdentity,
  stateRoot: string,
  generationId: string,
): Promise<AuthorityGenerationPaths> {
  if (isAuthorityPathWithin(workspace.canonical_path, stateRoot)) {
    await ensureAuthorityDirectory(workspace.canonical_path, dirname(stateRoot));
    await ensureAuthorityDirectory(workspace.canonical_path, stateRoot);
  } else {
    await assertPathHasNoSymlinkComponents(stateRoot, 'legacy state root');
    await assertDirectoryNotSymlink(stateRoot, 'legacy state root');
  }

  const paths = authorityGenerationPaths(stateRoot, generationId);
  await ensureAuthorityDirectory(stateRoot, join(stateRoot, 'authority'));
  await ensureAuthorityDirectory(stateRoot, join(stateRoot, 'authority', 'generations'));
  await ensureAuthorityDirectory(stateRoot, paths.generation_directory);
  await ensureAuthorityDirectory(stateRoot, paths.binding_directory);
  await ensureAuthorityDirectory(stateRoot, paths.journal_directory);
  return paths;
}

async function readActiveGeneration(
  anchor: WorkspaceAuthorityAnchor,
): Promise<{ generation: StateAuthorityGeneration; authorityPath: string; binding: SessionAuthorityBinding }> {
  if (!anchor.active_generation_locator || !anchor.active_binding_locator || !anchor.active_generation_id || !anchor.active_lease) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMissing, 'workspace anchor has no active authority generation');
  }
  const generation = await readAuthorityJson(
    anchor.active_generation_locator,
    AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
  ) as StateAuthorityGeneration;
  validateStateAuthorityGeneration(generation);
  if (generation.generation_id !== anchor.active_generation_id
    || generation.authority_id !== anchor.active_lease.generation_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed, 'active generation does not match the anchor active generation ID and lease');
  }
  await assertPathHasNoSymlinkComponents(generation.canonical_state_root, 'active state root');
  const expectedAuthorityPath = authorityGenerationPaths(
    generation.canonical_state_root,
    generation.generation_id,
  ).authority_path;
  await assertAuthorityLocator(
    generation.canonical_state_root,
    anchor.active_generation_locator,
    expectedAuthorityPath,
    'active authority locator',
  );
  const binding = await readAuthorityJson(
    anchor.active_binding_locator,
    AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
  ) as SessionAuthorityBinding;
  validateSessionAuthorityBinding(binding);
  const expectedBindingPath = authorityBindingPath(
    generation.canonical_state_root,
    generation.generation_id,
    binding.binding_id,
  );
  await assertAuthorityLocator(
    generation.canonical_state_root,
    anchor.active_binding_locator,
    expectedBindingPath,
    'active binding locator',
  );
  if (binding.authority_id !== generation.authority_id
    || binding.generation_id !== generation.generation_id
    || binding.lifecycle !== 'active'
    || binding.binding_id !== anchor.active_lease.binding_id
    || binding.creation_fence > anchor.fencing_token
    || generation.creation_fence > anchor.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'active session binding does not satisfy the active authority generation and lease invariant');
  }
  return { generation, authorityPath: expectedAuthorityPath, binding };
}

function transportCapabilityMatchesActiveAuthority(
  metadata: StateAuthorityTransportCapabilityMetadata,
  anchor: WorkspaceAuthorityAnchor,
  active: Awaited<ReturnType<typeof readActiveGeneration>>,
): boolean {
  const lease = anchor.active_lease;
  return metadata.status === 'active'
    && Boolean(lease)
    && metadata.workspace_identity_digest === anchor.workspace_identity_digest
    && metadata.authority_id === active.generation.authority_id
    && metadata.generation_id === active.generation.generation_id
    && metadata.binding_id === active.binding.binding_id
    && metadata.binding_revision <= active.binding.binding_revision
    && metadata.lease_launch_id === lease?.launch_id;
}

/**
 * Mint an opaque child-transport bearer after the active authority is already
 * committed. Only its digest and active tuple are durable; the raw value stays
 * in this process until a child environment is built.
 */
export async function mintStateAuthorityTransportCapability(
  context: ResolvedStateAuthorityContext,
  input: MintStateAuthorityTransportCapabilityInput = {},
): Promise<MintedStateAuthorityTransportCapability> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttl_ms ?? STATE_AUTHORITY_TRANSPORT_CAPABILITY_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > STATE_AUTHORITY_TRANSPORT_CAPABILITY_MAX_TTL_MS) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'transport capability lifetime must be positive and bounded');
  }
  const capability = randomBytes(32).toString('base64url');
  const { lock } = await acquireCurrentWorkspaceAuthorityLock(context.workspace_identity, now);
  try {
    const anchor = await readWorkspaceAuthorityAnchor(context.workspace_identity);
    if (!anchor) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'cannot mint transport capability without an active workspace anchor');
    }
    const active = await readActiveGeneration(anchor);
    if (context.workspace_identity.digest !== anchor.workspace_identity_digest
      || context.generation.authority_id !== active.generation.authority_id
      || context.generation.generation_id !== active.generation.generation_id
      || context.session_binding?.binding_id !== active.binding.binding_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'cannot mint transport capability for a stale authority context');
    }
    const metadata: StateAuthorityTransportCapabilityMetadata = {
      schema_version: 1,
      status: 'active',
      capability_digest: transportCapabilityDigest(capability),
      workspace_identity_digest: anchor.workspace_identity_digest,
      authority_id: active.generation.authority_id,
      generation_id: active.generation.generation_id,
      binding_id: active.binding.binding_id,
      binding_revision: active.binding.binding_revision,
      lease_launch_id: anchor.active_lease!.launch_id,
      lease_owner_nonce: lock.record.owner_nonce,
      fencing_token: lock.record.fencing_token,
      issued_at: nowIso(now),
      expires_at: nowIso(new Date(now.getTime() + ttlMs)),
    };
    const mintedAnchor = nextFencedAnchor(anchor, lock, now, { transport_capability: metadata });
    await writeFencedWorkspaceAuthorityAnchor(context.workspace_identity, mintedAnchor, lock);
    stateAuthorityTransportCapabilityCache.set(
      transportCapabilityCacheKey(
        metadata.workspace_identity_digest,
        metadata.generation_id,
        metadata.binding_id,
        metadata.binding_revision,
      ),
      { capability, metadata },
    );
    return { capability, metadata };
  } finally {
    await releaseWorkspaceAuthorityLock(lock);
  }
}

/** Validates and remembers an inherited opaque transport bearer. */
export async function validateStateAuthorityTransportCapability(
  context: ResolvedStateAuthorityContext,
  capability: string,
  now = new Date(),
): Promise<StateAuthorityTransportCapabilityMetadata> {
  if (typeof capability !== 'string' || capability.length < 32) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'inherited state-authority transport capability is missing or malformed');
  }
  const anchor = await readWorkspaceAuthorityAnchor(context.workspace_identity);
  if (!anchor) authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'inherited state-authority transport has no active workspace anchor');
  const metadata = anchor.transport_capability;
  if (!metadata) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'inherited state-authority transport capability is absent from the active anchor');
  }
  validateTransportCapabilityMetadata(metadata, anchor);
  const active = await readActiveGeneration(anchor);
  if (!transportCapabilityMatchesActiveAuthority(metadata, anchor, active)
    || context.authority_path !== active.authorityPath
    || context.generation.authority_id !== active.generation.authority_id
    || context.generation.generation_id !== active.generation.generation_id
    || context.session_binding?.binding_id !== active.binding.binding_id
    || (context.session_binding?.binding_revision ?? -1) < metadata.binding_revision) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'inherited state-authority transport capability does not match the active authority tuple');
  }
  if (new Date(metadata.expires_at).getTime() <= now.getTime()) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityExpired, 'inherited state-authority transport capability has expired');
  }
  const actualDigest = Buffer.from(transportCapabilityDigest(capability), 'hex');
  const expectedDigest = Buffer.from(metadata.capability_digest, 'hex');
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'inherited state-authority transport capability digest does not match the active anchor');
  }
  stateAuthorityTransportCapabilityCache.set(
    transportCapabilityCacheKey(
      metadata.workspace_identity_digest,
      metadata.generation_id,
      metadata.binding_id,
      metadata.binding_revision,
    ),
    { capability, metadata },
  );
  return metadata;
}

/** Returns a locally held bearer suitable only for post-commit child publication. */
export function stateAuthorityTransportCapabilityForChild(
  authority: Pick<ResolvedStateAuthorityContext, 'workspace_identity' | 'generation' | 'session_binding'>,
  now = new Date(),
): string {
  const binding = authority.session_binding;
  if (!binding) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'cannot publish child transport without an active authority binding');
  }
  const key = transportCapabilityCacheKey(
    authority.workspace_identity.digest,
    authority.generation.generation_id,
    binding.binding_id,
    binding.binding_revision,
  );
  let cached = stateAuthorityTransportCapabilityCache.get(key);
  if (!cached) {
    for (const candidate of stateAuthorityTransportCapabilityCache.values()) {
      if (candidate.metadata.workspace_identity_digest === authority.workspace_identity.digest
        && candidate.metadata.generation_id === authority.generation.generation_id
        && candidate.metadata.binding_id === binding.binding_id
        && candidate.metadata.binding_revision <= binding.binding_revision
        && (!cached || candidate.metadata.binding_revision > cached.metadata.binding_revision)) {
        cached = candidate;
      }
    }
    if (cached) stateAuthorityTransportCapabilityCache.set(key, cached);
  }
  if (!cached || cached.metadata.status !== 'active' || new Date(cached.metadata.expires_at).getTime() <= now.getTime()) {
    stateAuthorityTransportCapabilityCache.delete(key);
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityExpired, 'no live post-commit state-authority transport capability is available for child publication');
  }

  try {
    const anchor = readWorkspaceAuthorityAnchorForChild(authority.workspace_identity);
    const metadata = anchor.transport_capability;
    if (!metadata) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'active workspace authority anchor has no child transport capability');
    }
    validateTransportCapabilityMetadata(metadata, anchor);
    if (metadata.status !== 'active'
      || metadata.workspace_identity_digest !== authority.workspace_identity.digest
      || metadata.authority_id !== authority.generation.authority_id
      || metadata.generation_id !== authority.generation.generation_id
      || metadata.binding_id !== binding.binding_id
      || metadata.binding_revision > binding.binding_revision
      || anchor.active_generation_id !== authority.generation.generation_id
      || anchor.active_lease?.generation_id !== authority.generation.generation_id
      || anchor.active_lease?.binding_id !== binding.binding_id
      || metadata.lease_launch_id !== anchor.active_lease?.launch_id
      || metadata.capability_digest !== transportCapabilityDigest(cached.capability)
      || new Date(metadata.expires_at).getTime() <= now.getTime()) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid, 'cached child transport capability no longer matches the active persisted authority metadata');
    }
    return cached.capability;
  } catch (error) {
    for (const [candidateKey, candidate] of stateAuthorityTransportCapabilityCache.entries()) {
      if (candidateKey === key
        || (candidate.metadata.workspace_identity_digest === authority.workspace_identity.digest
          && candidate.metadata.generation_id === authority.generation.generation_id
          && candidate.metadata.binding_id === binding.binding_id)) {
        stateAuthorityTransportCapabilityCache.delete(candidateKey);
      }
    }
    throw error;
  }
}

export async function initializeStateAuthority(
  input: InitializeStateAuthorityInput,
): Promise<ResolvedStateAuthorityContext> {
  const workspace = resolveWorkspaceIdentity(input.startup_cwd);
  assertWorkspaceIdentity(workspace);
  safeIdentifier(input.launch_id, 'launch ID');
  safeSessionIdentifier(input.session_binding.canonical_session_id, 'canonical session ID');
  normalizeAliases(input.session_binding.aliases);
  const paths = stateAuthorityPaths(workspace);
  const anchorBeforeEstablishment = await readWorkspaceAuthorityAnchor(workspace);
  const missingAnchorProtocolEvidence = anchorBeforeEstablishment === null
    && await hasSurvivingStateAuthorityProtocolEvidence(workspace);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.omx_root);
  await ensureAuthorityDirectory(workspace.canonical_path, paths.bootstrap_directory);

  const now = input.now ?? new Date();
  const recoveredUnanchoredPristinePreparation = missingAnchorProtocolEvidence
    && await recoverUnanchoredPristinePreparation(workspace, now);

  await recoverPendingAlternateRootRollover(workspace, now);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { lock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
    let prepared: {
      source?: { generation: StateAuthorityGeneration; authorityPath: string; binding: SessionAuthorityBinding; bindingPath: string };
      canonicalStateRoot: string;
      rootIdentity: RootFilesystemIdentity;
      generation: StateAuthorityGeneration;
      binding: SessionAuthorityBinding;
      generationPaths: AuthorityGenerationPaths;
      bindingPath: string;
      pending: PendingAuthorityOperation;
    } | undefined;
    try {
      const anchor = await readWorkspaceAuthorityAnchor(workspace);
      if (anchor?.pending_operation) {
        await recoverPendingAlternateRootRolloverLocked(workspace, anchor, lock, now);
        continue;
      }
      if (!anchor && (anchorBeforeEstablishment !== null || (missingAnchorProtocolEvidence && !recoveredUnanchoredPristinePreparation))) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.resumeEvidenceMissing, 'workspace authority anchor is missing despite surviving generation, journal, tombstone, or bootstrap protocol evidence');
      }


      let source: { generation: StateAuthorityGeneration; authorityPath: string; binding: SessionAuthorityBinding; bindingPath: string } | undefined;
      if (anchor?.active_generation_id) {
        const active = await readActiveGeneration(anchor);
        const validation = await validateStateAuthority(active.generation, { workspace_identity: workspace });
        if (!validation.valid) {
          const failure = validation.diagnostics[0];
          authorityError(failure.code, failure.message);
        }
        if (requestedBindingMatchesActive(input.session_binding, active.binding)) {
          const binding = input.session_binding.aliases
            ? {
              ...reviseSessionAuthorityBinding(
                active.binding,
                {
                  ...mergeSessionAliases(active.binding.aliases, input.session_binding.aliases),
                  previous_session_aliases: [...new Set([
                    ...active.binding.aliases.previous_session_aliases,
                    ...(input.session_binding.aliases.previous_session_aliases ?? []),
                    ...(input.session_binding.canonical_session_id !== active.binding.canonical_session_id
                      ? [active.binding.canonical_session_id]
                      : []),
                  ])],
                },
                'active',
                now,
              ),
              canonical_session_id: input.session_binding.canonical_session_id,
            }
            : active.binding;
          if (binding !== active.binding) {
            if (!anchor.active_binding_locator) {
              authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'active authority binding locator is missing');
            }
            await atomicWriteAuthorityJson(anchor.active_binding_locator, binding, {
              authority_root: active.generation.canonical_state_root,
              expected_root_identity: active.generation.root_identity,
            });
            // Alias-only binding revisions preserve a bearer whose binding tuple
            // remains active; the fenced anchor revision records the update.
            await writeFencedWorkspaceAuthorityAnchor(
              workspace,
              nextFencedAnchor(anchor, lock, now, {}),
              lock,
            );
          }
          return {
            observed_cwd: canonicalizeExistingAuthorityPath(input.observed_cwd ?? input.startup_cwd, 'observed cwd'),
            workspace_identity: workspace,
            canonical_state_root: active.generation.canonical_state_root,
            authority_path: active.authorityPath,
            anchor_path: paths.anchor_path,
            generation: active.generation,
            session_binding: binding,
          };
        }
        if (!await mayTerminalizeRecordedGeneration(active.generation)) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'requested launch session does not match a provably exited active authority binding');
        }
        source = {
          generation: active.generation,
          authorityPath: active.authorityPath,
          binding: active.binding,
          bindingPath: anchor.active_binding_locator!,
        };
      }
      if (source) {
        await abortUnanchoredPreparedRolloverJournals(anchor!, source.generation, now);
      }

      const ordinaryStateRoot = resolveOrdinaryStateRoot(workspace);
      let stateRoot = ordinaryStateRoot;
      if (!anchor) {
        const candidates = [ordinaryStateRoot];
        const legacyCandidate = input.legacy_state_root_candidate?.trim();
        if (legacyCandidate) {
          const resolvedCandidate = resolve(input.startup_cwd, legacyCandidate);
          if (resolvedCandidate !== ordinaryStateRoot) {
            await assertPathHasNoSymlinkComponents(resolvedCandidate, 'legacy state-root candidate');
            if (await hasLegacyAuthorityArtifacts(resolvedCandidate)) {
              authorityError(AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven, 'alternate legacy state-root candidates require managed authority corroboration and cannot be established from a caller-writable session pointer');
            }
          }
        }
        const proven: string[] = [];
        for (const candidate of candidates) {
          await assertPathHasNoSymlinkComponents(candidate, 'legacy state-root candidate');
          if (!await hasLegacyAuthorityArtifacts(candidate)) continue;
          if (!await isProvenLegacyAuthorityCandidate(candidate, workspace, input, candidate === ordinaryStateRoot)) {
            authorityError(AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven, 'cannot establish authority over unproven legacy state-root artifacts');
          }
          proven.push(candidate);
        }
        if (proven.length > 1) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven, 'multiple proven legacy state roots make migration ambiguous');
        }
        stateRoot = proven[0] ?? ordinaryStateRoot;
      }
      if (stateRoot === ordinaryStateRoot) {
        await ensureAuthorityDirectory(workspace.canonical_path, ordinaryStateRoot);
      } else {
        await assertPathHasNoSymlinkComponents(stateRoot, 'legacy state root');
        await assertDirectoryNotSymlink(stateRoot, 'legacy state root');
      }
      const canonicalStateRoot = canonicalizeExistingAuthorityPath(stateRoot, 'state root');
      const rootIdentity = await captureRootFilesystemIdentity(canonicalStateRoot);
      const rootCapability = await probeStateAuthorityFilesystemCapability(canonicalStateRoot, now);
      if (!sameRootFilesystemIdentity(rootIdentity, await captureRootFilesystemIdentity(canonicalStateRoot))) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'state root was replaced while its authority capability was being established');
      }
      if (!rootIdentity.strong_identity
        || rootCapability.strong_root_identity !== 'verified'
        || !hasVerifiedAuthorityMutationSafety(rootCapability)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'state root lacks strong identity or verified safe authority mutation support');
      }
      if (!source) {
        await abortUnanchoredPreparedOrdinaryEstablishments(canonicalStateRoot, rootIdentity, anchor, now);
      }

      const baseAnchor = anchor ?? createWorkspaceAuthorityAnchor(workspace, now);
      const operationId = `ordinary-rollover-${randomUUID()}`;
      const generationId = randomUUID();
      const pendingFence = lock.record.fencing_token;
      const targetFence = pendingFence + 1;
      const generationPaths = authorityGenerationPaths(canonicalStateRoot, generationId);
      const generation = createGeneration(
        workspace,
        canonicalStateRoot,
        rootIdentity,
        rootCapability,
        targetFence,
        source?.generation.generation_id ?? baseAnchor.last_terminal?.generation_id,
        now,
        generationId,
      );
      const binding = createSessionAuthorityBinding(
        input.session_binding,
        generation.authority_id,
        generation.generation_id,
        targetFence,
        now,
      );
      const bindingPath = authorityBindingPath(canonicalStateRoot, generationId, binding.binding_id);
      if (!source) {
        await ensureStateAuthorityGenerationDirectories(workspace, canonicalStateRoot, generationId);
      }
      const journalRoot = source?.generation.canonical_state_root ?? canonicalStateRoot;
      const journalGenerationId = source?.generation.generation_id ?? generationId;
      const journalPath = authorityJournalPath(journalRoot, journalGenerationId, operationId);
      const pending: PendingAuthorityOperation = {
        operation_id: operationId,
        generation_id: generationId,
        generation_locator: generationPaths.authority_path,
        binding_locator: bindingPath,
        journal_locator: journalPath,
        expected_anchor_revision: baseAnchor.anchor_revision + 1,
        owner_nonce: lock.record.owner_nonce,
        fencing_token: pendingFence,
        kind: 'generation_establish',
        created_at: nowIso(now),
        target_root_identity: rootIdentity,
        ...(source ? {
          source_generation_id: source.generation.generation_id,
          source_authority_locator: source.authorityPath,
          source_binding_locator: source.bindingPath,
        } : {}),
      };
      const journal = createStateAuthorityJournal({
        operation_id: operationId,
        kind: 'generation_establish',
        authority_id: generation.authority_id,
        generation_id: generationId,
        binding_revision: source?.binding.binding_revision ?? 0,
        workspace_identity_digest: workspace.digest,
        expected_anchor_revision: pending.expected_anchor_revision,
        fencing_token: pending.fencing_token,
        effects_digest: journalEffectsDigest({
          workspace: workspace.digest,
          source_generation: source?.generation.generation_id ?? 'none',
          target_generation: generationId,
          target_root: canonicalStateRoot,
        }),
        now,
      });
      await writeStateAuthorityJournal(
        journalPath,
        journal,
        journalRoot,
        source?.generation.root_identity ?? rootIdentity,
      );
      injectOrdinaryRolloverFault(input, 'after_prepared_journal');
      const preparedAnchor = nextFencedAnchor(baseAnchor, lock, now, { pending_operation: pending });
      await writeFencedWorkspaceAuthorityAnchor(workspace, preparedAnchor, lock);
      injectOrdinaryRolloverFault(input, 'after_pending_anchor');
      prepared = {
        source,
        canonicalStateRoot,
        rootIdentity,
        generation,
        binding,
        generationPaths,
        bindingPath,
        pending: preparedAnchor.pending_operation!,
      };
    } finally {
      await releaseWorkspaceAuthorityLock(lock);
    }
    if (!prepared) continue;

    const { lock: applyLock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
    try {
      const anchor = await readWorkspaceAuthorityAnchor(workspace);
      if (!anchor) authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'ordinary generation establishment anchor disappeared before target creation');
      const pending = assertOrdinaryGenerationEstablishmentPending(anchor, prepared.pending.operation_id);
      const journal = await readPendingOrdinaryGenerationEstablishmentJournal(pending);
      if (journal.status !== 'prepared') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment is not prepared for target effects');
      }
      await writeStateAuthorityJournal(
        pending.journal_locator,
        transitionStateAuthorityJournal(journal, 'applying', { completed_step: 'pending_anchor_published', now }),
        prepared.source?.generation.canonical_state_root ?? prepared.canonicalStateRoot,
        prepared.source?.generation.root_identity ?? prepared.rootIdentity,
      );
      injectOrdinaryRolloverFault(input, 'after_applying_journal');
      const targetPaths = await ensureStateAuthorityGenerationDirectories(
        workspace,
        prepared.canonicalStateRoot,
        prepared.generation.generation_id,
      );
      if (targetPaths.authority_path !== pending.generation_locator || pending.binding_locator !== prepared.bindingPath) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'ordinary generation establishment target locators changed during creation');
      }
      await atomicWriteAuthorityJson(targetPaths.authority_path, prepared.generation, {
        authority_root: prepared.canonicalStateRoot,
        expected_root_identity: prepared.rootIdentity,
      });
      injectOrdinaryRolloverFault(input, 'after_target_generation');
      await atomicWriteAuthorityJson(prepared.bindingPath, prepared.binding, {
        authority_root: prepared.canonicalStateRoot,
        expected_root_identity: prepared.rootIdentity,
      });
      injectOrdinaryRolloverFault(input, 'after_target_binding');
    } finally {
      await releaseWorkspaceAuthorityLock(applyLock);
    }

    const { lock: switchLock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
    let targetGeneration!: StateAuthorityGeneration;
    let targetBinding!: SessionAuthorityBinding;
    try {
      const anchor = await readWorkspaceAuthorityAnchor(workspace);
      if (!anchor) authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'ordinary generation establishment anchor disappeared before target switch');
      const pending = assertOrdinaryGenerationEstablishmentPending(anchor, prepared.pending.operation_id);
      const journal = await readPendingOrdinaryGenerationEstablishmentJournal(pending);
      if (journal.status !== 'applying' || !pending.binding_locator) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment lacks applying journal or target binding evidence');
      }
      const sourceIsActive = prepared.source
        ? anchor.active_generation_id === prepared.source.generation.generation_id
        : !anchor.active_generation_id;
      if (!sourceIsActive) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'ordinary generation establishment source changed before commit');
      }
      targetGeneration = await readAuthorityJson(pending.generation_locator, AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed) as StateAuthorityGeneration;
      validateStateAuthorityGeneration(targetGeneration);
      await assertAuthorityLocator(
        prepared.canonicalStateRoot,
        pending.generation_locator,
        authorityGenerationPaths(prepared.canonicalStateRoot, pending.generation_id).authority_path,
        'ordinary generation establishment target generation locator',
      );
      targetBinding = await readAuthorityJson(pending.binding_locator, AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict) as SessionAuthorityBinding;
      validateSessionAuthorityBinding(targetBinding);
      await assertAuthorityLocator(
        prepared.canonicalStateRoot,
        pending.binding_locator,
        authorityBindingPath(prepared.canonicalStateRoot, pending.generation_id, targetBinding.binding_id),
        'ordinary generation establishment target binding locator',
      );
      if (targetGeneration.generation_id !== pending.generation_id
        || targetBinding.generation_id !== pending.generation_id
        || targetBinding.authority_id !== targetGeneration.authority_id
        || targetBinding.lifecycle !== 'active') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment target generation and binding do not cross-link');
      }
      const targetValidation = await validateStateAuthority(targetGeneration, { workspace_identity: workspace });
      if (!targetValidation.valid) {
        const failure = targetValidation.diagnostics[0];
        authorityError(failure.code, failure.message);
      }
      const switched = nextFencedAnchor(anchor, switchLock, now, {
        pending_operation: pending,
        ...(prepared.source ? {
          last_terminal: {
            generation_id: prepared.source.generation.generation_id,
            generation_locator: prepared.source.authorityPath,
            binding_revision: prepared.source.binding.binding_revision + 1,
            operation_id: pending.operation_id,
            status: 'terminal' as const,
            terminal_at: nowIso(now),
          },
        } : {}),
        active_generation_id: targetGeneration.generation_id,
        active_generation_locator: pending.generation_locator,
        active_binding_locator: pending.binding_locator,
        active_lease: {
          launch_id: input.launch_id,
          generation_id: targetGeneration.generation_id,
          binding_id: targetBinding.binding_id,
          acquired_at: nowIso(now),
          owner_nonce: switchLock.record.owner_nonce,
          fencing_token: switchLock.record.fencing_token,
        },
      });
      await writeFencedWorkspaceAuthorityAnchor(workspace, switched, switchLock);
      injectOrdinaryRolloverFault(input, 'after_switched_anchor');
      if (prepared.source) {
        await terminalizeRolloverSourceBinding(pending, now);
      }
      injectOrdinaryRolloverFault(input, 'after_terminal_binding');
      await writeStateAuthorityJournal(
        pending.journal_locator,
        transitionStateAuthorityJournal(journal, 'committed', { completed_step: 'source_binding_terminalized', now }),
        prepared.source?.generation.canonical_state_root ?? prepared.canonicalStateRoot,
        prepared.source?.generation.root_identity ?? prepared.rootIdentity,
      );
      injectOrdinaryRolloverFault(input, 'after_committed_journal');
    } finally {
      await releaseWorkspaceAuthorityLock(switchLock);
    }

    const { lock: finalizeLock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
    try {
      const anchor = await readWorkspaceAuthorityAnchor(workspace);
      if (!anchor) authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'ordinary generation establishment anchor disappeared before finalization');
      const pending = assertOrdinaryGenerationEstablishmentPending(anchor, prepared.pending.operation_id);
      const journal = await readPendingOrdinaryGenerationEstablishmentJournal(pending);
      if (anchor.active_generation_id !== targetGeneration.generation_id || journal.status !== 'committed') {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment cannot finalize before a committed target switch');
      }
      const finalized = nextFencedAnchor(anchor, finalizeLock, now, { pending_operation: undefined });
      await writeFencedWorkspaceAuthorityAnchor(workspace, finalized, finalizeLock);
    } finally {
      await releaseWorkspaceAuthorityLock(finalizeLock);
    }
    return {
      observed_cwd: canonicalizeExistingAuthorityPath(input.observed_cwd ?? input.startup_cwd, 'observed cwd'),
      workspace_identity: workspace,
      canonical_state_root: targetGeneration.canonical_state_root,
      authority_path: prepared.generationPaths.authority_path,
      anchor_path: paths.anchor_path,
      generation: targetGeneration,
      session_binding: targetBinding,
    };
  }
  authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, 'timed out establishing a fenced ordinary state authority generation');
}

export async function resolveStateAuthority(
  input: ResolveStateAuthorityInput,
): Promise<StateAuthorityResolution> {
  const workspace = resolveWorkspaceIdentity(input.startup_cwd);
  const diagnostics: AuthorityDiagnostic[] = [];
  const observedCwd = canonicalizeExistingAuthorityPath(input.observed_cwd ?? input.startup_cwd, 'observed cwd');
  if (!isAuthorityPathWithin(workspace.canonical_path, observedCwd)) {
    diagnostics.push(diagnostic(
      AUTHORITY_DIAGNOSTIC_CODES.observedCwdOutsideWorkspace,
      'observed cwd is outside the established workspace; committed authority remains unchanged',
      false,
    ));
  }

  let anchor: WorkspaceAuthorityAnchor | null;
  try {
    await recoverPendingAlternateRootRollover(workspace);
    anchor = await readWorkspaceAuthorityAnchor(workspace);
  } catch (error) {
    if (error instanceof StateAuthorityError) {
      return { diagnostics: [...diagnostics, diagnostic(error.code, error.message)], can_mutate: false };
    }
    throw error;
  }
  if (!anchor || !anchor.active_generation_id) {
    return {
      diagnostics: [...diagnostics, diagnostic(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'no committed active authority exists for this workspace')],
      can_mutate: false,
    };
  }

  try {
    const active = await readActiveGeneration(anchor);
    const validation = await validateStateAuthority(active.generation, { workspace_identity: workspace });
    diagnostics.push(...validation.diagnostics);
    if (!active.binding) {
      diagnostics.push(diagnostic(AUTHORITY_DIAGNOSTIC_CODES.authorityMissing, 'active authority generation has no session binding'));
      return { diagnostics, can_mutate: false };
    }
    if (input.session_id) {
      const aliases = active.binding.aliases;
      const matches = input.session_id === active.binding.canonical_session_id
        || input.session_id === aliases.native_session_id
        || aliases.current_session_aliases.includes(input.session_id)
        || aliases.previous_session_aliases.includes(input.session_id)
        || aliases.owner_session_aliases.includes(input.session_id);
      if (!matches) {
        diagnostics.push(diagnostic(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'requested session does not match the active authority binding'));
      }
    }
    return {
      context: {
        observed_cwd: observedCwd,
        workspace_identity: workspace,
        canonical_state_root: active.generation.canonical_state_root,
        authority_path: active.authorityPath,
        anchor_path: stateAuthorityPaths(workspace).anchor_path,
        generation: active.generation,
        session_binding: active.binding,
      },
      diagnostics,
      can_mutate: diagnostics.every((entry) => !entry.fatal),
    };
  } catch (error) {
    if (error instanceof StateAuthorityError) {
      diagnostics.push(diagnostic(error.code, error.message));
      return { diagnostics, can_mutate: false };
    }
    throw error;
  }
}

export async function resolveStateAuthorityForGuard(
  input: ResolveStateAuthorityInput,
): Promise<ResolvedStateAuthorityContext> {
  const resolution = await resolveStateAuthority(input);
  if (!resolution.context || !resolution.can_mutate) {
    const failure = resolution.diagnostics.find((entry) => entry.fatal)
      ?? diagnostic(AUTHORITY_DIAGNOSTIC_CODES.authorityMissing, 'no committed state authority is available');
    authorityError(failure.code, failure.message);
  }
  return resolution.context;
}

export const resolveStateAuthorityForMutation = resolveStateAuthorityForGuard;

export async function appendStateAuthorityEvidence(
  generation: StateAuthorityGeneration,
  event: Record<string, unknown>,
): Promise<void> {
  validateStateAuthorityGeneration(generation);
  const evidenceDirectory = join(generation.canonical_state_root, 'authority');
  await ensureAuthorityDirectory(generation.canonical_state_root, evidenceDirectory);
  await appendAuthorityFileNoFollow(
    join(evidenceDirectory, STATE_AUTHORITY_TOMBSTONE_FILE),
    `${JSON.stringify({
      schema_version: 1,
      authority_id: generation.authority_id,
      generation_id: generation.generation_id,
      recorded_at: nowIso(),
      event,
    })}\n`,
    {
      authority_root: generation.canonical_state_root,
      expected_root_identity: generation.root_identity,
    },
  );
}

export async function readStateAuthorityEvidence(
  generation: StateAuthorityGeneration,
): Promise<string | null> {
  validateStateAuthorityGeneration(generation);
  return readAuthorityFileNoFollow(
    join(generation.canonical_state_root, 'authority', STATE_AUTHORITY_TOMBSTONE_FILE),
    {
      authority_root: generation.canonical_state_root,
      expected_root_identity: generation.root_identity,
    },
  );
}

export async function migrateLegacyStateAuthority(): Promise<never> {
  authorityError(
    AUTHORITY_DIAGNOSTIC_CODES.ownerConfirmationRequired,
    'legacy authority migration requires a separately implemented corroborated migration coordinator',
  );
}

async function refreshStateAuthorityContext(
  context: ResolvedStateAuthorityContext,
): Promise<ResolvedStateAuthorityContext> {
  const anchor = await readWorkspaceAuthorityAnchor(context.workspace_identity);
  if (!anchor || anchor.active_generation_id !== context.generation.generation_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'state authority context is no longer the active generation');
  }
  const active = await readActiveGeneration(anchor);
  const validation = await validateStateAuthority(active.generation, {
    workspace_identity: context.workspace_identity,
  });
  if (!validation.valid) {
    const failure = validation.diagnostics[0];
    authorityError(failure.code, failure.message);
  }
  return {
    observed_cwd: context.observed_cwd,
    workspace_identity: context.workspace_identity,
    canonical_state_root: active.generation.canonical_state_root,
    authority_path: active.authorityPath,
    anchor_path: stateAuthorityPaths(context.workspace_identity).anchor_path,
    generation: active.generation,
    session_binding: active.binding,
  };
}

const inProcessAuthorityTransactionTails = new Map<string, Promise<void>>();

async function withInProcessAuthorityTransaction<T>(
  workspaceIdentityDigest: string,
  callback: () => Promise<T>,
): Promise<T> {
  const predecessor = inProcessAuthorityTransactionTails.get(workspaceIdentityDigest) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = predecessor.catch(() => undefined).then(() => current);
  inProcessAuthorityTransactionTails.set(workspaceIdentityDigest, tail);
  await predecessor.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (inProcessAuthorityTransactionTails.get(workspaceIdentityDigest) === tail) {
      inProcessAuthorityTransactionTails.delete(workspaceIdentityDigest);
    }
  }
}

export async function withStateAuthorityTransaction<T>(
  context: ResolvedStateAuthorityContext,
  callback: (context: ResolvedStateAuthorityContext, lock: AcquiredStateAuthorityLock) => Promise<T>,
): Promise<T> {
  return await withInProcessAuthorityTransaction(context.workspace_identity.digest, async () => {
    await refreshStateAuthorityContext(context);
    const { lock } = await acquireCurrentWorkspaceAuthorityLock(context.workspace_identity);
    let callbackFailed = false;
    try {
      const anchor = await readWorkspaceAuthorityAnchor(context.workspace_identity);
      if (anchor?.pending_operation) {
        await recoverPendingAlternateRootRolloverLocked(context.workspace_identity, anchor, lock, new Date());
      }
      const refreshed = await refreshStateAuthorityContext(context);
      return await callback(refreshed, lock);
    } catch (error) {
      callbackFailed = true;
      throw error;
    } finally {
      try {
        await releaseWorkspaceAuthorityLock(lock);
      } catch (releaseError) {
        if (!callbackFailed) throw releaseError;
      }
    }
  });
}

function launchTransportEffectsDigest(
  context: ResolvedStateAuthorityContext,
  bindingKey: string,
  effects: Record<string, string>,
): string {
  return journalEffectsDigest({
    authority_id: context.generation.authority_id,
    binding_id: context.session_binding?.binding_id ?? '',
    binding_key: bindingKey,
    binding_revision: String(context.session_binding?.binding_revision ?? -1),
    generation_id: context.generation.generation_id,
    workspace_identity_digest: context.workspace_identity.digest,
    ...effects,
  });
}

async function readActiveLaunchTransportPublication(
  context: ResolvedStateAuthorityContext,
  operationId: string,
): Promise<StateAuthorityLaunchTransportPublication> {
  const binding = context.session_binding;
  if (!binding || binding.lifecycle !== 'active') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'launch transport requires an active authority binding');
  }
  const anchor = await readWorkspaceAuthorityAnchor(context.workspace_identity);
  if (!anchor || !anchor.active_lease) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorMissing, 'launch transport requires a committed active authority anchor');
  }
  const active = await readActiveGeneration(anchor);
  const validation = await validateStateAuthority(active.generation, {
    workspace_identity: context.workspace_identity,
  });
  if (!validation.valid) {
    const failure = validation.diagnostics[0];
    authorityError(failure.code, failure.message);
  }
  if (
    active.generation.authority_id !== context.generation.authority_id
    || active.generation.generation_id !== context.generation.generation_id
    || active.binding.binding_id !== binding.binding_id
    || active.binding.binding_revision !== binding.binding_revision
    || anchor.active_lease.generation_id !== active.generation.generation_id
    || anchor.active_lease.binding_id !== active.binding.binding_id
    || anchor.workspace_identity_digest !== context.workspace_identity.digest
  ) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'launch transport authority tuple no longer matches the active committed anchor');
  }
  return {
    operation_id: operationId,
    authority_protocol_version: STATE_AUTHORITY_PROTOCOL_VERSION,
    authority_id: active.generation.authority_id,
    generation_id: active.generation.generation_id,
    binding_id: active.binding.binding_id,
    binding_revision: active.binding.binding_revision,
    workspace_identity_digest: anchor.workspace_identity_digest,
    anchor_revision: anchor.anchor_revision,
    fencing_token: anchor.active_lease.fencing_token,
    root_identity: active.generation.root_identity,
  };
}

function assertActiveLaunchTransportPublication(
  expected: StateAuthorityLaunchTransportPublication,
  actual: StateAuthorityLaunchTransportPublication,
): void {
  if (
    expected.operation_id !== actual.operation_id
    || expected.authority_protocol_version !== actual.authority_protocol_version
    || expected.authority_id !== actual.authority_id
    || expected.generation_id !== actual.generation_id
    || expected.binding_id !== actual.binding_id
    || expected.binding_revision !== actual.binding_revision
    || expected.workspace_identity_digest !== actual.workspace_identity_digest
    || expected.anchor_revision !== actual.anchor_revision
    || expected.fencing_token !== actual.fencing_token
    || !sameRootFilesystemIdentity(expected.root_identity, actual.root_identity)
  ) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'launch transport authority tuple changed while the publication transaction was active');
  }
}

/** Validates that a persisted launch transport record still names the exact active authority. */
export async function validateCommittedStateAuthorityLaunchTransportPublication(
  context: ResolvedStateAuthorityContext,
  publication: StateAuthorityLaunchTransportPublication,
): Promise<void> {
  assertActiveLaunchTransportPublication(
    publication,
    await readActiveLaunchTransportPublication(context, publication.operation_id),
  );
}

function assertLaunchTransportJournal(
  journal: StateAuthorityOperationJournal,
  publication: StateAuthorityLaunchTransportPublication,
  effectsDigest: string,
): void {
  if (
    journal.kind !== 'launch_transport_publish'
    || journal.operation_id !== publication.operation_id
    || journal.authority_id !== publication.authority_id
    || journal.generation_id !== publication.generation_id
    || journal.binding_id !== publication.binding_id
    || journal.binding_revision !== publication.binding_revision
    || journal.workspace_identity_digest !== publication.workspace_identity_digest
    || journal.expected_anchor_revision !== publication.anchor_revision
    || journal.fencing_token < publication.fencing_token
    || journal.effects_digest !== effectsDigest

    || journal.status === 'aborted'
  ) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'launch transport journal does not match the active authority tuple or requested effect');
  }
}

/**
 * Proves that the named child-visible launch transport effect was durably
 * committed for the exact current authority tuple without reading a bearer.
 */
export async function validateCommittedStateAuthorityLaunchTransportJournal(
  context: ResolvedStateAuthorityContext,
  input: { operation_id: string; effects_digest: string },
): Promise<void> {
  const operationId = safeIdentifier(input.operation_id, 'launch transport operation ID');
  if (!/^[0-9a-f]{64}$/i.test(input.effects_digest)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'launch transport effects digest is malformed');
  }
  const publication = await readActiveLaunchTransportPublication(context, operationId);
  const journalPath = authorityJournalPath(
    publication.root_identity.canonical_path,
    publication.generation_id,
    operationId,
  );
  const journal = await readStateAuthorityJournal(journalPath);
  assertLaunchTransportJournal(journal, publication, input.effects_digest);
  if (journal.status !== 'committed') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'launch transport journal is not committed');
  }
}


/**
 * Establishes durable journal custody before any persistent child-visible
 * effect. The effect is published and verified while the journal is applying;
 * only then is the journal committed and control returned to the caller.
 * Committed retries replay the idempotent publish and verification callbacks.
 */
export async function publishStateAuthorityLaunchTransport<T>(
  input: PublishStateAuthorityLaunchTransportInput<T>,
): Promise<T> {
  const bindingKey = nonEmptyString(
    input.binding_key,
    'launch transport binding key',
    AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
  );
  const effectsDigest = launchTransportEffectsDigest(input.context, bindingKey, input.effects);
  const operationId = `launch-transport-${createHash('sha256').update(JSON.stringify({
    authority_id: input.context.generation.authority_id,
    binding_id: input.context.session_binding?.binding_id ?? '',
    binding_key: bindingKey,
    binding_revision: input.context.session_binding?.binding_revision ?? -1,
    effects_digest: effectsDigest,
    generation_id: input.context.generation.generation_id,
    workspace_identity_digest: input.context.workspace_identity.digest,
  })).digest('hex')}`;

  return await withStateAuthorityTransaction(input.context, async (context, lock) => {
    const publication = await readActiveLaunchTransportPublication(context, operationId);
    const journalPath = authorityJournalPath(
      context.canonical_state_root,
      context.generation.generation_id,
      operationId,
    );
    let journal: StateAuthorityOperationJournal;
    if (existsSync(journalPath)) {
      journal = await readStateAuthorityJournal(journalPath);
      assertLaunchTransportJournal(journal, publication, effectsDigest);
    } else {
      journal = createStateAuthorityJournal({
        operation_id: operationId,
        kind: 'launch_transport_publish',
        authority_id: publication.authority_id,
        generation_id: publication.generation_id,
        binding_revision: publication.binding_revision,
        binding_id: publication.binding_id,
        workspace_identity_digest: publication.workspace_identity_digest,
        expected_anchor_revision: publication.anchor_revision,
        fencing_token: lock.record.fencing_token,
        effects_digest: effectsDigest,
      });
      await writeStateAuthorityJournal(
        journalPath,
        journal,
        context.canonical_state_root,
        publication.root_identity,
      );
      if (input.test_only_fault_injection === 'after_prepared_journal') {
        throw new Error('injected launch transport crash after prepared journal');
      }
    }

    let result: T;
    if (journal.status === 'prepared') {
      journal = transitionStateAuthorityJournal(journal, 'applying', {
        completed_step: 'journal-prepared',
      });
      await writeStateAuthorityJournal(
        journalPath,
        journal,
        context.canonical_state_root,
        publication.root_identity,
      );
    }
    if (journal.status === 'applying') {
      await input.prepare?.(context, publication);
      assertActiveLaunchTransportPublication(
        publication,
        await readActiveLaunchTransportPublication(context, operationId),
      );
      if (input.test_only_fault_injection === 'after_applying_journal') {
        throw new Error('injected launch transport crash after applying journal');
      }
      result = await input.publish(context, publication);
      if (input.test_only_fault_injection === 'after_persistent_publication') {
        throw new Error('injected launch transport crash after persistent publication');
      }
      assertActiveLaunchTransportPublication(
        publication,
        await readActiveLaunchTransportPublication(context, operationId),
      );
      await input.verify(context, publication);
      assertActiveLaunchTransportPublication(
        publication,
        await readActiveLaunchTransportPublication(context, operationId),
      );
      journal = transitionStateAuthorityJournal(journal, 'committed', {
        completed_step: 'persistent-transport-verified',
      });
      await writeStateAuthorityJournal(
        journalPath,
        journal,
        context.canonical_state_root,
        publication.root_identity,
      );
      if (input.test_only_fault_injection === 'after_committed_journal') {
        throw new Error('injected launch transport crash after committed journal');
      }
    } else if (journal.status === 'committed') {
      result = await input.publish(context, publication);
      assertActiveLaunchTransportPublication(
        publication,
        await readActiveLaunchTransportPublication(context, operationId),
      );
      await input.verify(context, publication);
      assertActiveLaunchTransportPublication(
        publication,
        await readActiveLaunchTransportPublication(context, operationId),
      );
    } else {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'launch transport journal did not reach applying or committed state');
    }
    await heartbeatWorkspaceAuthorityLock(lock);
    return result;
  });
}

function sealFencedAnchor(
  anchor: WorkspaceAuthorityAnchor,
  lock: AcquiredStateAuthorityLock,
): WorkspaceAuthorityAnchor {
  if (anchor.anchor_revision !== lock.record.anchor_revision + 1
    || anchor.fencing_token !== lock.record.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'authority anchor does not match the lock revision and fence');
  }
  const transportCapability = anchor.transport_capability;
  return {
    ...anchor,
    ...(transportCapability ? { transport_capability: transportCapability } : {}),
    ...(anchor.active_lease ? {
      active_lease: {
        ...anchor.active_lease,
        owner_nonce: lock.record.owner_nonce,
        fencing_token: anchor.fencing_token,
      },
    } : {}),
    ...(anchor.pending_operation ? {
      pending_operation: {
        ...anchor.pending_operation,
        expected_anchor_revision: anchor.anchor_revision,
        fencing_token: anchor.fencing_token,
      },
    } : {}),
  };
}

function nextFencedAnchor(
  anchor: WorkspaceAuthorityAnchor,
  lock: AcquiredStateAuthorityLock,
  now: Date,
  changes: Partial<WorkspaceAuthorityAnchor>,
): WorkspaceAuthorityAnchor {
  return sealFencedAnchor({
    ...anchor,
    ...nextAnchorRevision(anchor, now, lock.record.fencing_token),
    ...changes,
  }, lock);
}

function journalEffectsDigest(values: Record<string, string>): string {
  const ordered = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function assertAlternateRolloverPending(
  anchor: WorkspaceAuthorityAnchor,
  operationId: string,
): PendingAuthorityOperation {
  const pending = anchor.pending_operation;
  if (!pending || pending.kind !== 'alternate_root_rollover' || pending.operation_id !== operationId) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'workspace authority does not contain the expected alternate-root rollover operation');
  }
  return pending;
}

async function readPendingRolloverJournal(
  pending: PendingAuthorityOperation,
): Promise<StateAuthorityOperationJournal> {
  await assertPathHasNoSymlinkComponents(pending.journal_locator, 'alternate-root rollover journal locator');
  const journal = await readStateAuthorityJournal(pending.journal_locator);
  if (journal.kind !== 'alternate_root_rollover'
    || journal.operation_id !== pending.operation_id
    || journal.generation_id !== pending.generation_id
    || journal.authority_id !== pending.generation_id
    || journal.expected_anchor_revision > pending.expected_anchor_revision
    || journal.fencing_token > pending.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover journal does not match its pending operation');
  }
  return journal;
}

async function abortUnanchoredPreparedOrdinaryEstablishments(
  stateRoot: string,
  expectedRootIdentity: RootFilesystemIdentity,
  anchor: WorkspaceAuthorityAnchor | null,
  now: Date,
): Promise<void> {
  const generationsDirectory = join(stateRoot, 'authority', 'generations');
  try {
    await assertPathHasNoSymlinkComponents(generationsDirectory, 'ordinary generation establishment directory');
    const generations = await readdir(generationsDirectory, { withFileTypes: true });
    for (const generation of generations) {
      if (generation.isSymbolicLink()) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `ordinary generation establishment directory is a symbolic link: ${generation.name}`);
      }
      if (!generation.isDirectory()) continue;
      if (!SAFE_ID_PATTERN.test(generation.name)) {
        authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, `ordinary generation establishment directory has an unsafe name: ${generation.name}`);
      }
      const journalDirectory = authorityGenerationPaths(stateRoot, generation.name).journal_directory;
      let journals: Dirent[];
      try {
        journals = await readdir(journalDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const journalEntry of journals) {
        if (journalEntry.isSymbolicLink()) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, `ordinary generation establishment journal is a symbolic link: ${journalEntry.name}`);
        }
        if (!journalEntry.isFile() || !journalEntry.name.endsWith('.json')) continue;
        const journalPath = join(journalDirectory, journalEntry.name);
        const journal = await readStateAuthorityJournal(journalPath);
        if (journal.kind !== 'generation_establish' || journal.status !== 'prepared') continue;
        if (anchor?.pending_operation?.operation_id === journal.operation_id) continue;
        await writeStateAuthorityJournal(
          journalPath,
          transitionStateAuthorityJournal(journal, 'aborted', {
            blocked_reason: 'unanchored prepared ordinary establishment recovered before retry',
            now,
          }),
          stateRoot,
          expectedRootIdentity,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function abortUnanchoredPreparedRolloverJournals(
  anchor: WorkspaceAuthorityAnchor,
  source: StateAuthorityGeneration,
  now: Date,
): Promise<void> {
  const journalDirectory = authorityGenerationPaths(source.canonical_state_root, source.generation_id).journal_directory;
  await assertPathHasNoSymlinkComponents(journalDirectory, 'alternate-root rollover journal directory');
  const entries = await readdir(journalDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const journalPath = join(journalDirectory, entry.name);
    const journal = await readStateAuthorityJournal(journalPath);
    if (!['alternate_root_rollover', 'generation_establish'].includes(journal.kind) || journal.status !== 'prepared') continue;
    if (anchor.pending_operation?.operation_id === journal.operation_id) continue;
    await writeStateAuthorityJournal(
      journalPath,
      transitionStateAuthorityJournal(journal, 'aborted', {
        blocked_reason: 'unanchored prepared authority journal recovered before retry',
        now,
      }),
      source.canonical_state_root,
      source.root_identity,
    );
  }
}

async function terminalizeRolloverSourceBinding(
  pending: PendingAuthorityOperation,
  now: Date,
): Promise<SessionAuthorityBinding> {
  if (!pending.source_generation_id || !pending.source_binding_locator || !pending.source_authority_locator) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'alternate-root rollover pending operation is missing its source authority locators');
  }
  const source = await readAuthorityJson(
    pending.source_authority_locator,
    AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
  ) as StateAuthorityGeneration;
  validateStateAuthorityGeneration(source);
  if (source.generation_id !== pending.source_generation_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover source generation does not match its pending operation');
  }
  await assertAuthorityLocator(
    source.canonical_state_root,
    pending.source_authority_locator,
    authorityGenerationPaths(source.canonical_state_root, source.generation_id).authority_path,
    'alternate-root rollover source authority locator',
  );
  const binding = await readAuthorityJson(
    pending.source_binding_locator,
    AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
  ) as SessionAuthorityBinding;
  validateSessionAuthorityBinding(binding);
  await assertAuthorityLocator(
    source.canonical_state_root,
    pending.source_binding_locator,
    authorityBindingPath(source.canonical_state_root, source.generation_id, binding.binding_id),
    'alternate-root rollover source binding locator',
  );
  if (binding.generation_id !== source.generation_id || binding.authority_id !== source.authority_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'alternate-root rollover source binding does not belong to its source generation');
  }
  if (binding.lifecycle === 'terminal') return binding;
  const terminal = reviseSessionAuthorityBinding(binding, binding.aliases, 'terminal', now);
  await atomicWriteAuthorityJson(pending.source_binding_locator, terminal, {
    authority_root: source.canonical_state_root,
    expected_root_identity: source.root_identity,
  });
  return terminal;
}

async function authorityRootForPendingJournal(
  pending: PendingAuthorityOperation,
): Promise<{ root: string; identity: RootFilesystemIdentity }> {
  if (pending.source_authority_locator && pending.source_generation_id) {
    const source = await readAuthorityJson(
      pending.source_authority_locator,
      AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
    ) as StateAuthorityGeneration;
    validateStateAuthorityGeneration(source);
    if (source.generation_id !== pending.source_generation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'pending authority journal source generation does not match its operation');
    }
    await assertAuthorityLocator(
      source.canonical_state_root,
      pending.source_authority_locator,
      authorityGenerationPaths(source.canonical_state_root, source.generation_id).authority_path,
      'pending authority journal source locator',
    );
    if (pending.journal_locator !== authorityJournalPath(source.canonical_state_root, source.generation_id, pending.operation_id)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'pending authority journal locator escapes its authenticated source generation');
    }
    const actual = await captureRootFilesystemIdentity(source.canonical_state_root);
    if (!sameRootFilesystemIdentity(source.root_identity, actual)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'pending authority journal source root was replaced');
    }
    return { root: source.canonical_state_root, identity: source.root_identity };
  }
  if (pending.kind === 'generation_establish' && pending.target_root_identity) {
    const root = ordinaryGenerationEstablishmentTargetRoot(pending);
    await assertPathHasNoSymlinkComponents(root, 'pending ordinary authority journal target root');
    const actual = await captureRootFilesystemIdentity(root);
    if (!sameRootFilesystemIdentity(pending.target_root_identity, actual)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'pending ordinary authority journal target root was replaced');
    }
    if (pending.journal_locator !== authorityJournalPath(root, pending.generation_id, pending.operation_id)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'pending ordinary authority journal locator escapes its authenticated target generation');
    }
    return { root, identity: pending.target_root_identity };
  }
  authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'pending authority journal has no authenticated source or target root');
}

async function writePendingStateAuthorityJournal(
  pending: PendingAuthorityOperation,
  journal: StateAuthorityOperationJournal,
): Promise<void> {
  const journalRoot = await authorityRootForPendingJournal(pending);
  await writeStateAuthorityJournal(pending.journal_locator, journal, journalRoot.root, journalRoot.identity);
}

function injectOrdinaryRolloverFault(
  input: InitializeStateAuthorityInput,
  point: OrdinaryStateAuthorityRolloverFaultInjectionPoint,
): void {
  if (input.test_only_ordinary_rollover_fault_injection === point) {
    throw new Error(`injected ordinary generation rollover crash at ${point}`);
  }
}

function assertOrdinaryGenerationEstablishmentPending(
  anchor: WorkspaceAuthorityAnchor | null,
  operationId: string,
): PendingAuthorityOperation {
  const pending = anchor?.pending_operation;
  if (!pending || pending.kind !== 'generation_establish' || pending.operation_id !== operationId) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'workspace authority does not contain the expected ordinary generation establishment');
  }
  return pending;
}

function ordinaryGenerationEstablishmentTargetRoot(pending: PendingAuthorityOperation): string {
  const targetRoot = dirname(dirname(dirname(dirname(pending.generation_locator))));
  const expected = authorityGenerationPaths(targetRoot, pending.generation_id).authority_path;
  if (expected !== pending.generation_locator) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'ordinary generation establishment target locator is not rooted in a canonical generation path');
  }
  return targetRoot;
}

async function readPendingOrdinaryGenerationEstablishmentJournal(
  pending: PendingAuthorityOperation,
): Promise<StateAuthorityOperationJournal> {
  await assertPathHasNoSymlinkComponents(pending.journal_locator, 'ordinary generation establishment journal locator');
  const journal = await readStateAuthorityJournal(pending.journal_locator);
  if (journal.kind !== 'generation_establish'
    || journal.operation_id !== pending.operation_id
    || journal.generation_id !== pending.generation_id
    || journal.authority_id !== pending.generation_id
    || journal.expected_anchor_revision > pending.expected_anchor_revision
    || journal.fencing_token > pending.fencing_token) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment journal does not match its pending operation');
  }
  return journal;
}

async function ordinaryGenerationEstablishmentSource(
  pending: PendingAuthorityOperation,
): Promise<{ generation: StateAuthorityGeneration; binding: SessionAuthorityBinding } | undefined> {
  if (!pending.source_generation_id && !pending.source_authority_locator && !pending.source_binding_locator) return undefined;
  if (!pending.source_generation_id || !pending.source_authority_locator || !pending.source_binding_locator) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'ordinary generation establishment has partial source authority evidence');
  }
  const generation = await readAuthorityJson(
    pending.source_authority_locator,
    AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed,
  ) as StateAuthorityGeneration;
  validateStateAuthorityGeneration(generation);
  if (generation.generation_id !== pending.source_generation_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment source generation does not match its pending operation');
  }
  await assertAuthorityLocator(
    generation.canonical_state_root,
    pending.source_authority_locator,
    authorityGenerationPaths(generation.canonical_state_root, generation.generation_id).authority_path,
    'ordinary generation establishment source authority locator',
  );
  const binding = await readAuthorityJson(
    pending.source_binding_locator,
    AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
  ) as SessionAuthorityBinding;
  validateSessionAuthorityBinding(binding);
  await assertAuthorityLocator(
    generation.canonical_state_root,
    pending.source_binding_locator,
    authorityBindingPath(generation.canonical_state_root, generation.generation_id, binding.binding_id),
    'ordinary generation establishment source binding locator',
  );
  if (binding.generation_id !== generation.generation_id || binding.authority_id !== generation.authority_id) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict, 'ordinary generation establishment source binding does not belong to its source generation');
  }
  return { generation, binding };
}

async function recoverPendingOrdinaryGenerationEstablishmentLocked(
  workspace: WorkspaceIdentity,
  anchor: WorkspaceAuthorityAnchor,
  lock: AcquiredStateAuthorityLock,
  now: Date,
): Promise<WorkspaceAuthorityAnchor> {
  const pending = anchor.pending_operation;
  if (!pending || pending.kind !== 'generation_establish') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'workspace authority has no ordinary generation establishment to recover');
  }
  const journal = await readPendingOrdinaryGenerationEstablishmentJournal(pending);
  const source = await ordinaryGenerationEstablishmentSource(pending);
  const targetRoot = ordinaryGenerationEstablishmentTargetRoot(pending);
  await assertPathHasNoSymlinkComponents(targetRoot, 'ordinary generation establishment target root');
  if (!pending.target_root_identity) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'ordinary generation establishment pending operation is missing target root fingerprint evidence');
  }
  const actualTargetRoot = await captureRootFilesystemIdentity(targetRoot);
  if (!sameRootFilesystemIdentity(pending.target_root_identity, actualTargetRoot)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'ordinary generation establishment target root was replaced before recovery');
  }
  const targetIsActive = anchor.active_generation_id === pending.generation_id;
  const sourceIsActive = source
    ? anchor.active_generation_id === source.generation.generation_id
    : !anchor.active_generation_id;
  if (!targetIsActive && !sourceIsActive) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment has neither its source nor target active');
  }

  if (targetIsActive) {
    const target = await readActiveGeneration(anchor);
    if (target.generation.generation_id !== pending.generation_id
      || target.authorityPath !== pending.generation_locator
      || anchor.active_binding_locator !== pending.binding_locator) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment target active links do not match its pending operation');
    }
    const validation = await validateStateAuthority(target.generation, { workspace_identity: workspace });
    if (!validation.valid) {
      const failure = validation.diagnostics[0];
      authorityError(failure.code, failure.message);
    }
  }

  const journalRoot = source?.generation.canonical_state_root ?? targetRoot;
  const journalRootIdentity = source?.generation.root_identity ?? pending.target_root_identity;
  if (journal.status === 'prepared' || (journal.status === 'applying' && sourceIsActive)) {
    if (source && source.binding.lifecycle !== 'active') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'ordinary generation establishment source became terminal before a target anchor switch');
    }
    await writeStateAuthorityJournal(
      pending.journal_locator,
      transitionStateAuthorityJournal(journal, 'aborted', { blocked_reason: 'restart before ordinary authority commit', now }),
      journalRoot,
      journalRootIdentity,
    );
    const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
    await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
    return next;
  }
  if (journal.status === 'aborted') {
    if (!sourceIsActive) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'aborted ordinary generation establishment unexpectedly switched the active generation');
    }
    const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
    await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
    return next;
  }
  if (!targetIsActive) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'committed ordinary generation establishment does not have its target generation active');
  }
  if (journal.status === 'applying') {
    if (source) await terminalizeRolloverSourceBinding(pending, now);
    await writeStateAuthorityJournal(
      pending.journal_locator,
      transitionStateAuthorityJournal(journal, 'committed', { completed_step: 'source_binding_terminalized', now }),
      journalRoot,
      journalRootIdentity,
    );
  }
  const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
  await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
  return next;
}

async function recoverPendingAlternateRootRolloverLocked(
  workspace: WorkspaceIdentity,
  anchor: WorkspaceAuthorityAnchor,
  lock: AcquiredStateAuthorityLock,
  now: Date,
): Promise<WorkspaceAuthorityAnchor> {
  const pending = anchor.pending_operation;
  if (!pending) return anchor;
  if (pending.kind === 'generation_establish') {
    return recoverPendingOrdinaryGenerationEstablishmentLocked(workspace, anchor, lock, now);
  }
  if (pending.kind !== 'alternate_root_rollover') {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'workspace authority has an unsupported pending operation');
  }
  const journal = await readPendingRolloverJournal(pending);
  const intent = pending.intent_id
    ? anchor.alternate_intents.find((entry) => entry.intent_id === pending.intent_id)
    : undefined;
  const targetIsActive = anchor.active_generation_id === pending.generation_id;
  const sourceIsActive = anchor.active_generation_id === pending.source_generation_id;
  if (!targetIsActive && !sourceIsActive) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover pending operation has neither source nor target active');
  }
  if (targetIsActive) {
    const target = await readActiveGeneration(anchor);
    if (target.generation.generation_id !== pending.generation_id
      || target.authorityPath !== pending.generation_locator
      || (pending.binding_locator && anchor.active_binding_locator !== pending.binding_locator)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover target active links do not match its pending operation');
    }
    const validation = await validateStateAuthority(target.generation, { workspace_identity: workspace });
    if (!validation.valid) {
      const failure = validation.diagnostics[0];
      authorityError(failure.code, failure.message);
    }
  }
  if (journal.status === 'prepared' || (journal.status === 'applying' && sourceIsActive)) {
    if (intent) {
      if (intent.status === 'preparing') {
        if (!intent.creation_boundary) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalMalformed, 'alternate-root rollover preparation intent has no creation boundary');
        }
        await assertPathHasNoSymlinkComponents(intent.creation_boundary, 'alternate-root rollover preparation boundary');
        const actualBoundary = await captureRootFilesystemIdentity(intent.creation_boundary);
        if (!sameRootFilesystemIdentity(intent.proposed_root_identity, actualBoundary)) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate-root rollover preparation boundary was replaced before recovery');
        }
        if (existsSync(intent.proposed_state_root)) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate-root rollover target appeared before its preparation intent was materialized');
        }
      } else if (intent.status === 'prepared' && existsSync(intent.proposed_state_root)) {
        await assertPathHasNoSymlinkComponents(intent.proposed_state_root, 'alternate-root rollover recovery root');
        const actual = await captureRootFilesystemIdentity(intent.proposed_state_root);
        if (!sameRootFilesystemIdentity(intent.proposed_root_identity, actual)) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate-root rollover recovery root was replaced before commit');
        }
      }
      if (intent.status === 'prepared' || intent.status === 'preparing') {
        await writePendingStateAuthorityJournal(
          pending,
          transitionStateAuthorityJournal(journal, 'aborted', { blocked_reason: 'restart before alternate authority commit', now }),
        );
        const aborted = abortAlternateRootBootstrapIntent(
          anchor,
          intent.intent_id,
          'restart before alternate authority commit',
          now,
          lock.record.fencing_token,
        );
        const next = sealFencedAnchor({ ...aborted, pending_operation: undefined }, lock);
        await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
        return next;
      }
    }
    await writePendingStateAuthorityJournal(
      pending,
      transitionStateAuthorityJournal(journal, 'aborted', { blocked_reason: 'restart before alternate root intent preparation', now }),
    );
    const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
    await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
    return next;
  }
  if (journal.status === 'aborted') {
    if (!sourceIsActive) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'aborted alternate-root rollover unexpectedly switched active generation');
    }
    const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
    await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
    return next;
  }
  if (!targetIsActive) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'committed alternate-root rollover does not have its target generation active');
  }
  if (journal.status === 'applying') {
    await terminalizeRolloverSourceBinding(pending, now);
    await writePendingStateAuthorityJournal(
      pending,
      transitionStateAuthorityJournal(journal, 'committed', { completed_step: 'source_binding_terminalized', now }),
    );
  }
  const next = nextFencedAnchor(anchor, lock, now, { pending_operation: undefined });
  await writeFencedWorkspaceAuthorityAnchor(workspace, next, lock);
  return next;
}

async function recoverPendingAlternateRootRollover(
  workspace: WorkspaceIdentity,
  now = new Date(),
): Promise<void> {
  const initial = await readWorkspaceAuthorityAnchor(workspace);
  if (!initial?.pending_operation) return;
  const { lock } = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  try {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    if (anchor?.pending_operation) await recoverPendingAlternateRootRolloverLocked(workspace, anchor, lock, now);
  } finally {
    await releaseWorkspaceAuthorityLock(lock);
  }
}

export type RolloverStateAuthorityFaultInjectionPoint =
  | 'after_prepared_journal'
  | 'after_pending_anchor'
  | 'after_prepared_intent'
  | 'after_target_generation'
  | 'after_target_binding'
  | 'after_switched_anchor'
  | 'after_terminal_binding'
  | 'after_committed_journal';

export interface RolloverStateAuthorityToAlternateRootInput {
  context: ResolvedStateAuthorityContext;
  proposed_state_root: string;
  creation_root: string;
  launch_id: string;
  consumer_kind: AlternateRootConsumerKind;
  issuer: FirstPartyIssuer;
  now?: Date;
  /** Test-only crash seam. It is never persisted or transported. */
  fault_injection?: RolloverStateAuthorityFaultInjectionPoint;
  /** Test-only concurrency barrier. It is never persisted or transported. */
  test_only_after_preparation_lock_acquired?: () => void | Promise<void>;
  /** Test-only concurrency barrier. It is never persisted or transported. */
  test_only_after_pending_recovery_before_preparation_lock?: () => void | Promise<void>;
}

function injectRolloverFault(
  input: RolloverStateAuthorityToAlternateRootInput,
  point: RolloverStateAuthorityFaultInjectionPoint,
): void {
  if (input.fault_injection === point) {
    throw new Error(`injected alternate-root rollover crash at ${point}`);
  }
}

export async function rolloverStateAuthorityToAlternateRoot(
  input: RolloverStateAuthorityToAlternateRootInput,
): Promise<ResolvedStateAuthorityContext> {
  assertIssuer(input.issuer);
  safeIdentifier(input.launch_id, 'launch ID');
  const now = input.now ?? new Date();
  const requestedCreationRoot = assertPathInput(input.creation_root, 'alternate creation root');
  await assertPathHasNoSymlinkComponents(requestedCreationRoot, 'alternate creation root');
  const requestedProposedStateRoot = assertPathInput(input.proposed_state_root, 'alternate state root');
  if (!isPathWithin(requestedCreationRoot, requestedProposedStateRoot)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'alternate state root escapes its creation root');
  }
  await assertPathHasNoSymlinkComponents(requestedProposedStateRoot, 'alternate state root');
  let requestedCreationBoundary = requestedCreationRoot;
  while (!existsSync(requestedCreationBoundary)) {
    const parent = dirname(requestedCreationBoundary);
    if (parent === requestedCreationBoundary) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityMissing, 'alternate creation root has no existing ancestor');
    }
    requestedCreationBoundary = parent;
  }
  const creationRootSuffix = relative(requestedCreationBoundary, requestedCreationRoot);
  const proposedStateRootSuffix = relative(requestedCreationBoundary, requestedProposedStateRoot);
  const lexicalSuffixesWithinBoundary = !creationRootSuffix.startsWith('..')
    && !isAbsolute(creationRootSuffix)
    && !proposedStateRootSuffix.startsWith('..')
    && !isAbsolute(proposedStateRootSuffix);
  const creationBoundary = canonicalizeExistingAuthorityPath(requestedCreationBoundary, 'alternate creation boundary');
  let creationRoot: string;
  let proposedStateRoot: string;
  if (lexicalSuffixesWithinBoundary) {
    creationRoot = resolve(creationBoundary, creationRootSuffix);
    proposedStateRoot = resolve(creationBoundary, proposedStateRootSuffix);
  } else if (process.platform === 'win32') {
    creationRoot = canonicalizeAuthorityPathForCreation(requestedCreationRoot, 'alternate creation root');
    proposedStateRoot = canonicalizeAuthorityPathForCreation(requestedProposedStateRoot, 'alternate state root');
  } else {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'alternate path escapes its existing boundary');
  }
  if (!isAuthorityPathWithin(creationBoundary, creationRoot)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'alternate creation root escapes its existing boundary');
  }
  if (!isAuthorityPathWithin(creationRoot, proposedStateRoot)) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'alternate state root escapes its creation root');
  }
  await assertPathHasNoSymlinkComponents(proposedStateRoot, 'alternate state root');

  const workspace = input.context.workspace_identity;
  await recoverPendingAlternateRootRollover(workspace, now);
  await input.test_only_after_pending_recovery_before_preparation_lock?.();
  let operationId!: string;
  let targetGenerationId!: ReturnType<typeof randomUUID>;
  let targetBinding!: SessionAuthorityBinding;
  let targetBindingPath!: string;
  let targetGeneration!: StateAuthorityGeneration;
  let targetAuthorityPath!: string;
  let pending!: PendingAuthorityOperation;
  let canonicalStateRoot!: string;
  let targetRootIdentity!: RootFilesystemIdentity;
  let targetRootCapability!: StateAuthorityFilesystemCapability;


  let prepared = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const preparedLock = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
    let pendingObserved = false;
    try {
      await input.test_only_after_preparation_lock_acquired?.();
      const anchor = await readWorkspaceAuthorityAnchor(workspace);
      if (anchor?.pending_operation) {
        pendingObserved = true;
      } else {
        if (!anchor || anchor.active_generation_id !== input.context.generation.generation_id) {
          authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'alternate authority rollover source is no longer active');
        }
        const source = await readActiveGeneration(anchor);
        const sourceValidation = await validateStateAuthority(source.generation, { workspace_identity: workspace });
        if (!sourceValidation.valid) {
          const failure = sourceValidation.diagnostics[0];
          authorityError(failure.code, failure.message);
        }
        await abortUnanchoredPreparedRolloverJournals(anchor, source.generation, now);
        operationId = `alternate-rollover-${randomUUID()}`;
        targetGenerationId = randomUUID();
        const targetFence = anchor.fencing_token + 4;
        targetBinding = createSessionAuthorityBinding({
          canonical_session_id: source.binding.canonical_session_id,
          aliases: source.binding.aliases,
        }, targetGenerationId, targetGenerationId, targetFence, now);
        targetAuthorityPath = authorityGenerationPaths(proposedStateRoot, targetGenerationId).authority_path;
        targetBindingPath = authorityBindingPath(proposedStateRoot, targetGenerationId, targetBinding.binding_id);
        const journalPath = authorityJournalPath(
          source.generation.canonical_state_root,
          source.generation.generation_id,
          operationId,
        );
        pending = {
          operation_id: operationId,
          generation_id: targetGenerationId,
          generation_locator: targetAuthorityPath,
          binding_locator: targetBindingPath,
          journal_locator: journalPath,
          expected_anchor_revision: anchor.anchor_revision + 1,
          owner_nonce: preparedLock.lock.record.owner_nonce,
          fencing_token: preparedLock.lock.record.fencing_token,
          kind: 'alternate_root_rollover',
          created_at: nowIso(now),
          source_generation_id: source.generation.generation_id,
          source_authority_locator: source.authorityPath,
          source_binding_locator: anchor.active_binding_locator,
        };
        const journal = createStateAuthorityJournal({
          operation_id: operationId,
          kind: 'alternate_root_rollover',
          authority_id: targetGenerationId,
          generation_id: targetGenerationId,
          binding_revision: source.binding.binding_revision,
          workspace_identity_digest: workspace.digest,
          expected_anchor_revision: pending.expected_anchor_revision,
          fencing_token: pending.fencing_token,
          effects_digest: journalEffectsDigest({
            workspace: workspace.digest,
            source_generation: source.generation.generation_id,
            target_generation: targetGenerationId,
            target_root: proposedStateRoot,
            creation_boundary: creationBoundary,
            creation_root: creationRoot,
          }),
          now,
        });
        await writeStateAuthorityJournal(
          journalPath,
          journal,
          source.generation.canonical_state_root,
          source.generation.root_identity,
        );
        injectRolloverFault(input, 'after_prepared_journal');
        const preparedAnchor = nextFencedAnchor(anchor, preparedLock.lock, now, { pending_operation: pending });
        await writeFencedWorkspaceAuthorityAnchor(workspace, preparedAnchor, preparedLock.lock);
        pending = preparedAnchor.pending_operation!;
        injectRolloverFault(input, 'after_pending_anchor');
        prepared = true;
      }
    } finally {
      await releaseWorkspaceAuthorityLock(preparedLock.lock);
    }
    if (prepared) break;
    if (!pendingObserved) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, 'alternate authority rollover preparation did not establish or observe a pending operation');
    }
    await recoverPendingAlternateRootRollover(workspace, now);
  }
  if (!prepared) {
    authorityError(AUTHORITY_DIAGNOSTIC_CODES.lockHeld, 'timed out recovering a pending alternate-root rollover before preparation');
  }

  const applyLock = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  let intent: AlternateRootBootstrapIntent;
  try {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    if (!anchor || anchor.active_generation_id !== input.context.generation.generation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'alternate authority rollover source changed before alternate-root effects');
    }
    pending = assertAlternateRolloverPending(anchor, operationId);
    const journal = await readPendingRolloverJournal(pending);
    if (journal.status !== 'prepared') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover journal is not prepared for alternate-root effects');
    }

    const boundaryIdentity = await captureRootFilesystemIdentity(creationBoundary);
    if (!sameRootFilesystemIdentity(boundaryIdentity, await captureRootFilesystemIdentity(creationBoundary))) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate creation boundary was replaced while preparation intent was being established');
    }
    if (!boundaryIdentity.strong_identity) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'alternate creation boundary lacks strong identity for preparation intent custody');
    }
    const boundaryCapability: StateAuthorityFilesystemCapability = {
      schema_version: 1,
      platform: process.platform,
      canonical_path: creationBoundary,
      exclusive_create: 'unverified',
      atomic_rename: 'unverified',
      file_sync: 'unverified',
      directory_sync: 'unverified',
      no_follow_directories: 'unverified',
      strong_root_identity: 'verified',
      probed_at: nowIso(now),
    };
    const preparationIntent = createAlternateRootPreparationIntent({
      anchor,
      workspace_identity: workspace,
      launch_id: input.launch_id,
      issuer: input.issuer,
      owner_nonce: pending.owner_nonce,
      proposed_state_root: proposedStateRoot,
      creation_boundary: creationBoundary,
      creation_root: creationRoot,
      creation_boundary_identity: boundaryIdentity,
      creation_boundary_capability: boundaryCapability,
      intended_consumer_kind: input.consumer_kind,
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      now,
    });
    const intentAnchor = addAlternateRootBootstrapIntent(anchor, preparationIntent, now, applyLock.lock.record.fencing_token);
    const preparedWithIntent = sealFencedAnchor({
      ...intentAnchor,
      pending_operation: { ...pending, intent_id: preparationIntent.intent_id },
    }, applyLock.lock);
    await writeFencedWorkspaceAuthorityAnchor(workspace, preparedWithIntent, applyLock.lock);
    pending = preparedWithIntent.pending_operation!;
    intent = preparedWithIntent.alternate_intents.find((entry) => entry.intent_id === preparationIntent.intent_id)!;
    injectRolloverFault(input, 'after_prepared_intent');

    await writePendingStateAuthorityJournal(
      pending,
      transitionStateAuthorityJournal(journal, 'applying', { completed_step: 'preparation_intent_published', now }),
    );
    await ensureAuthorityDirectory(creationBoundary, creationRoot);
    await ensureAuthorityDirectory(creationRoot, dirname(proposedStateRoot));
    await ensureAuthorityDirectory(creationRoot, proposedStateRoot);
    await assertPathHasNoSymlinkComponents(proposedStateRoot, 'alternate state root');
    canonicalStateRoot = canonicalizeExistingAuthorityPath(proposedStateRoot, 'alternate state root');
    if (!hasTrustedAuthorityCanonicalPath(proposedStateRoot, canonicalStateRoot)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootSymlink, 'alternate state root canonical path changed during rollover');
    }
    targetRootIdentity = await captureRootFilesystemIdentity(canonicalStateRoot);
    targetRootCapability = await probeStateAuthorityFilesystemCapability(canonicalStateRoot, now);
    if (!sameRootFilesystemIdentity(targetRootIdentity, await captureRootFilesystemIdentity(canonicalStateRoot))) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate state root was replaced while its authority capability was being established');
    }
    if (!targetRootIdentity.strong_identity
      || targetRootCapability.strong_root_identity !== 'verified'
      || !hasVerifiedAuthorityMutationSafety(targetRootCapability)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak, 'alternate state root lacks strong identity or verified safe authority mutation support');
    }
  } finally {
    await releaseWorkspaceAuthorityLock(applyLock.lock);
  }

  const materializeLock = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  try {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    if (!anchor || anchor.active_generation_id !== input.context.generation.generation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'alternate authority rollover source changed before target authority publication');
    }
    pending = assertAlternateRolloverPending(anchor, operationId);
    const journal = await readPendingRolloverJournal(pending);
    if (journal.status !== 'applying' || !pending.intent_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover lost its applying journal or preparation intent before target authority publication');
    }
    const preparingIntent = anchor.alternate_intents.find((entry) => entry.intent_id === pending.intent_id);
    if (!preparingIntent || preparingIntent.status !== 'preparing') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, 'alternate-root rollover preparation intent is not available for target authority publication');
    }
    const actualTargetRoot = await captureRootFilesystemIdentity(canonicalStateRoot);
    if (!sameRootFilesystemIdentity(actualTargetRoot, targetRootIdentity)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate state root was replaced before its preparation intent could be materialized');
    }
    const materializedAnchor = sealFencedAnchor({
      ...materializeAlternateRootBootstrapIntent(
        anchor,
        preparingIntent.intent_id,
        targetRootIdentity,
        targetRootCapability,
        now,
        materializeLock.lock.record.fencing_token,
      ),
      pending_operation: pending,
    }, materializeLock.lock);
    await writeFencedWorkspaceAuthorityAnchor(workspace, materializedAnchor, materializeLock.lock);
    pending = materializedAnchor.pending_operation!;
    intent = materializedAnchor.alternate_intents.find((entry) => entry.intent_id === pending.intent_id)!;

    targetGeneration = createGeneration(
      workspace,
      canonicalStateRoot,
      targetRootIdentity,
      targetRootCapability,
      materializedAnchor.fencing_token + 1,
      anchor.active_generation_id,
      now,
      targetGenerationId,
    );
    const generationPaths = await ensureStateAuthorityGenerationDirectories(
      workspace,
      canonicalStateRoot,
      targetGeneration.generation_id,
    );
    if (generationPaths.authority_path !== targetAuthorityPath || targetBindingPath !== authorityBindingPath(canonicalStateRoot, targetGenerationId, targetBinding.binding_id)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot, 'alternate-root rollover target locators changed during creation');
    }
    await atomicWriteAuthorityJson(generationPaths.authority_path, targetGeneration, {
      authority_root: canonicalStateRoot,
      expected_root_identity: targetRootIdentity,
    });
    injectRolloverFault(input, 'after_target_generation');
    await atomicWriteAuthorityJson(targetBindingPath, targetBinding, {
      authority_root: canonicalStateRoot,
      expected_root_identity: targetRootIdentity,
    });
    injectRolloverFault(input, 'after_target_binding');
  } finally {
    await releaseWorkspaceAuthorityLock(materializeLock.lock);
  }

  const switchLock = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  try {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    if (!anchor || anchor.active_generation_id !== input.context.generation.generation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'alternate authority rollover source changed before commit');
    }
    pending = assertAlternateRolloverPending(anchor, operationId);
    const journal = await readPendingRolloverJournal(pending);
    if (journal.status !== 'applying' || !pending.intent_id || !pending.binding_locator) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover is missing prepared intent or target binding evidence');
    }
    intent = anchor.alternate_intents.find((entry) => entry.intent_id === pending.intent_id)!;
    if (!intent) authorityError(AUTHORITY_DIAGNOSTIC_CODES.intentConflict, 'alternate-root rollover prepared intent is missing');
    await assertPathHasNoSymlinkComponents(intent.proposed_state_root, 'alternate-root rollover target root');
    const actualRoot = await captureRootFilesystemIdentity(intent.proposed_state_root);
    if (!sameRootFilesystemIdentity(intent.proposed_root_identity, actualRoot)) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch, 'alternate-root rollover target root was replaced before commit');
    }
    const persistedGeneration = await readAuthorityJson(pending.generation_locator, AUTHORITY_DIAGNOSTIC_CODES.authorityMalformed) as StateAuthorityGeneration;
    validateStateAuthorityGeneration(persistedGeneration);
    await assertAuthorityLocator(intent.proposed_state_root, pending.generation_locator, authorityGenerationPaths(intent.proposed_state_root, pending.generation_id).authority_path, 'alternate-root rollover target generation locator');
    const persistedBinding = await readAuthorityJson(pending.binding_locator, AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict) as SessionAuthorityBinding;
    validateSessionAuthorityBinding(persistedBinding);
    await assertAuthorityLocator(intent.proposed_state_root, pending.binding_locator, authorityBindingPath(intent.proposed_state_root, pending.generation_id, persistedBinding.binding_id), 'alternate-root rollover target binding locator');
    if (persistedGeneration.generation_id !== pending.generation_id
      || persistedBinding.generation_id !== pending.generation_id
      || persistedBinding.authority_id !== persistedGeneration.authority_id
      || persistedBinding.lifecycle !== 'active') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover target generation and binding do not cross-link');
    }
    const generationValidation = await validateStateAuthority(persistedGeneration, { workspace_identity: workspace });
    if (!generationValidation.valid) {
      const failure = generationValidation.diagnostics[0];
      authorityError(failure.code, failure.message);
    }
    const consumedAnchor = consumeAlternateRootBootstrapIntent(anchor, intent.intent_id, {
      anchor,
      workspace_identity: workspace,
      launch_id: input.launch_id,
      issuer: input.issuer,
      owner_nonce: pending.owner_nonce,
      fencing_token: anchor.fencing_token,
      expected_consumer_kind: input.consumer_kind,
      now,
    }, persistedGeneration.generation_id, now, switchLock.lock.record.fencing_token);
    const switched = sealFencedAnchor({
      ...consumedAnchor,
      pending_operation: pending,
      last_terminal: {
        generation_id: anchor.active_generation_id,
        generation_locator: anchor.active_generation_locator!,
        binding_revision: anchor.active_lease!.binding_id === persistedBinding.binding_id
          ? persistedBinding.binding_revision
          : (await readActiveGeneration(anchor)).binding.binding_revision + 1,
        operation_id: operationId,
        status: 'terminal',
        terminal_at: nowIso(now),
      },
      active_generation_id: persistedGeneration.generation_id,
      active_generation_locator: pending.generation_locator,
      active_binding_locator: pending.binding_locator,
      active_lease: {
        launch_id: input.launch_id,
        generation_id: persistedGeneration.generation_id,
        binding_id: persistedBinding.binding_id,
        acquired_at: nowIso(now),
        owner_nonce: switchLock.lock.record.owner_nonce,
        fencing_token: consumedAnchor.fencing_token,
      },
    }, switchLock.lock);
    await writeFencedWorkspaceAuthorityAnchor(workspace, switched, switchLock.lock);
    injectRolloverFault(input, 'after_switched_anchor');
    await terminalizeRolloverSourceBinding(pending, now);
    injectRolloverFault(input, 'after_terminal_binding');
    await writePendingStateAuthorityJournal(
      pending,
      transitionStateAuthorityJournal(journal, 'committed', { completed_step: 'source_binding_terminalized', now }),
    );
    injectRolloverFault(input, 'after_committed_journal');
    targetGeneration = persistedGeneration;
    targetBinding = persistedBinding;
    targetAuthorityPath = pending.generation_locator;
    targetBindingPath = pending.binding_locator;
  } finally {
    await releaseWorkspaceAuthorityLock(switchLock.lock);
  }

  const finalizeLock = await acquireCurrentWorkspaceAuthorityLock(workspace, now);
  try {
    const anchor = await readWorkspaceAuthorityAnchor(workspace);
    if (!anchor || anchor.active_generation_id !== targetGeneration.generation_id) {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict, 'alternate authority rollover target changed before finalization');
    }
    pending = assertAlternateRolloverPending(anchor, operationId);
    const journal = await readPendingRolloverJournal(pending);
    if (journal.status !== 'committed') {
      authorityError(AUTHORITY_DIAGNOSTIC_CODES.journalConflict, 'alternate-root rollover cannot finalize an uncommitted journal');
    }
    const finalized = nextFencedAnchor(anchor, finalizeLock.lock, now, { pending_operation: undefined });
    await writeFencedWorkspaceAuthorityAnchor(workspace, finalized, finalizeLock.lock);
  } finally {
    await releaseWorkspaceAuthorityLock(finalizeLock.lock);
  }

  return {
    observed_cwd: input.context.observed_cwd,
    workspace_identity: workspace,
    canonical_state_root: targetGeneration.canonical_state_root,
    authority_path: targetAuthorityPath,
    anchor_path: stateAuthorityPaths(workspace).anchor_path,
    generation: targetGeneration,
    session_binding: targetBinding,
  };
}
