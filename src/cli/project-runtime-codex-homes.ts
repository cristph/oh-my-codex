import { execFileSync } from 'node:child_process';

import { lstatSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  resolveStateAuthority,
  validateCommittedStateAuthorityLaunchTransportJournal,
  validateCommittedStateAuthorityLaunchTransportPublication,
  type ResolvedStateAuthorityContext,
  type StateAuthorityLaunchTransportPublication,
} from '../state/authority.js';

import { resolveWorkspaceIdentity } from '../utils/git-layout.js';

export interface ProjectRuntimeCodexHome {
  path: string;
  sessionCountHint: number;
  source: 'project' | 'madmax-run';
  publicLabel?: string;
}

interface MadmaxPublicationMetadata {
  publication: StateAuthorityLaunchTransportPublication;
  effectsDigest: string;
  sourceCwd: string;
  runDir: string;
  argv: string[];
}
function launchTransportEffectsDigestForPublication(
  publication: Pick<
    StateAuthorityLaunchTransportPublication,
    'authority_id' | 'binding_id' | 'binding_revision' | 'generation_id' | 'workspace_identity_digest'
  >,
  bindingKey: string,
  effects: Record<string, string>,
): string {
  const ordered = Object.fromEntries(Object.entries({
    authority_id: publication.authority_id,
    binding_id: publication.binding_id,
    binding_key: bindingKey,
    binding_revision: String(publication.binding_revision),
    generation_id: publication.generation_id,
    workspace_identity_digest: publication.workspace_identity_digest,
    ...effects,
  }).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function launchTransportEffectsDigest(
  context: Pick<ResolvedStateAuthorityContext, 'generation' | 'session_binding' | 'workspace_identity'>,
  bindingKey: string,
  effects: Record<string, string>,
): string {
  return launchTransportEffectsDigestForPublication({
    authority_id: context.generation.authority_id,
    binding_id: context.session_binding?.binding_id ?? '',
    binding_revision: context.session_binding?.binding_revision ?? -1,
    generation_id: context.generation.generation_id,
    workspace_identity_digest: context.workspace_identity.digest,
  }, bindingKey, effects);
}

export async function discoverProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const localHomes = await discoverLocalProjectRuntimeCodexHomes(cwd);
  const madmaxHomes = await discoverAssociatedMadmaxRuntimeCodexHomes(cwd);
  return [...localHomes, ...madmaxHomes].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
    return b.path.localeCompare(a.path);
  });
}

function canonicalRuntimeCodexHomeRoot(root: string): string | null {
  try {
    const before = lstatSync(root);
    if (before.isSymbolicLink() || !before.isDirectory()) return null;
    const canonicalRoot = realpathSync(root);
    const after = lstatSync(root);
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) return null;
    return canonicalRoot;
  } catch {
    return null;
  }
}

function resolveContainedRuntimeCodexHome(
  canonicalRoot: string,
  entryName: string,
): { home: string; sessions: string } | null {
  const home = join(canonicalRoot, entryName);
  const sessions = join(home, 'sessions');
  try {
    const homeBefore = lstatSync(home);
    const sessionsBefore = lstatSync(sessions);
    if (
      homeBefore.isSymbolicLink()
      || !homeBefore.isDirectory()
      || sessionsBefore.isSymbolicLink()
      || !sessionsBefore.isDirectory()
    ) return null;
    const canonicalHome = realpathSync(home);
    const canonicalSessions = realpathSync(sessions);
    const homeAfter = lstatSync(home);
    const sessionsAfter = lstatSync(sessions);
    if (
      homeAfter.isSymbolicLink()
      || !homeAfter.isDirectory()
      || homeBefore.dev !== homeAfter.dev
      || homeBefore.ino !== homeAfter.ino
      || sessionsAfter.isSymbolicLink()
      || !sessionsAfter.isDirectory()
      || sessionsBefore.dev !== sessionsAfter.dev
      || sessionsBefore.ino !== sessionsAfter.ino
      || !isPathWithin(canonicalHome, canonicalRoot)
      || !isPathWithin(canonicalSessions, canonicalHome)
    ) return null;
    return { home: canonicalHome, sessions: canonicalSessions };
  } catch {
    return null;
  }
}

async function discoverLocalProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const workspace = resolveWorkspaceIdentity(cwd);
  const root = canonicalRuntimeCodexHomeRoot(
    join(workspace.canonical_path, '.omx', 'runtime', 'codex-home'),
  );
  if (!root) return [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const homes: ProjectRuntimeCodexHome[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('omx-')) continue;
    const runtimeHome = resolveContainedRuntimeCodexHome(root, entry.name);
    if (!runtimeHome) continue;
    homes.push({
      path: runtimeHome.home,
      sessionCountHint: await countImmediateSessionEntries(runtimeHome.sessions),
      source: 'project',
    });
  }
  return homes;
}

async function discoverAssociatedMadmaxRuntimeCodexHomes(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRuntimeCodexHome[]> {
  const resolution = await resolveStateAuthority({ startup_cwd: cwd, observed_cwd: cwd });
  if (!resolution.context || !resolution.can_mutate) return [];
  const associatedRunDirs = await discoverAssociatedMadmaxRunDirs(
    cwd,
    resolveMadmaxRunsRoot(env),
    resolution.context,
  );
  const homes: ProjectRuntimeCodexHome[] = [];
  for (const runDir of associatedRunDirs) {
    const codexHomeRoot = canonicalRuntimeCodexHomeRoot(
      join(runDir, '.omx', 'runtime', 'codex-home'),
    );
    if (!codexHomeRoot || !isPathWithin(codexHomeRoot, runDir)) continue;
    const entries = await readdir(codexHomeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.name.startsWith('omx-')) continue;
      const runtimeHome = resolveContainedRuntimeCodexHome(codexHomeRoot, entry.name);
      if (!runtimeHome) continue;
      homes.push({
        path: runtimeHome.home,
        sessionCountHint: await countImmediateSessionEntries(runtimeHome.sessions),
        source: 'madmax-run',
        publicLabel: `madmax:${entry.name}`,
      });
    }
  }
  return homes;
}

async function discoverAssociatedMadmaxRunDirs(
  cwd: string,
  ambientRunsRoot: string,
  authority: ResolvedStateAuthorityContext,
): Promise<string[]> {
  const activeRunDir = dirname(authority.generation.canonical_omx_root);
  const authoritativeRunsRoot = resolveCommittedMadmaxRunsRoot(authority, ambientRunsRoot);

  const seen = new Set<string>();
  const runDirs: string[] = [];
  const addCandidate = async (
    raw: unknown,
    requireRegistryEvidence = false,
  ): Promise<boolean> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (requireRegistryEvidence) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          'current workspace madmax registry record is malformed',
        );
      }
      return false;
    }
    const record = raw as Record<string, unknown>;
    const runDir = typeof record.run_dir === 'string'
      ? record.run_dir.trim()
      : typeof record.cwd === 'string'
        ? record.cwd.trim()
        : '';
    if (!runDir) {
      if (requireRegistryEvidence) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          'current workspace madmax registry record is missing its run directory',
        );
      }
      return false;
    }
    let canonicalRunDir: string;
    try {
      const requestedRunDir = resolve(runDir);
      const requestedRunStat = lstatSync(requestedRunDir);
      if (requestedRunStat.isSymbolicLink() || !requestedRunStat.isDirectory()) {
        if (requireRegistryEvidence) {
          throw new StateAuthorityError(
            AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
            `current workspace madmax registry run directory is not a regular directory: ${runDir}`,
          );
        }
        return false;
      }
      canonicalRunDir = realpathSync(requestedRunDir);
      const canonicalRunStat = lstatSync(canonicalRunDir);
      if (
        !isPathWithin(canonicalRunDir, authoritativeRunsRoot)
        || canonicalRunStat.isSymbolicLink()
        || !canonicalRunStat.isDirectory()
      ) {
        if (requireRegistryEvidence) {
          throw new StateAuthorityError(
            AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
            `current workspace madmax registry run directory escapes the committed runs root: ${runDir}`,
          );
        }
        return false;
      }
    } catch (error) {
      if (error instanceof StateAuthorityError) throw error;
      if (requireRegistryEvidence) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          `current workspace madmax registry run directory cannot be validated: ${runDir}`,
        );
      }
      return false;
    }

    if (seen.has(canonicalRunDir)) return true;
    if (!await isCommittedMadmaxRunForWorkspace(
      canonicalRunDir,
      cwd,
      authority,
      requireRegistryEvidence && typeof record.source_cwd === 'string'
        ? record.source_cwd.trim() || undefined
        : undefined,
    )) {
      if (requireRegistryEvidence) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
          `current workspace madmax registry record is not durably authorized for this workspace: ${canonicalRunDir}`,
        );
      }
      return false;
    }
    seen.add(canonicalRunDir);
    runDirs.push(canonicalRunDir);
    return true;
  };

  const hasActiveMadmaxPublication = await addCandidate({ run_dir: activeRunDir });
  if (!hasActiveMadmaxPublication) return [];

  const rawRegistry = await readCurrentWorkspaceMadmaxRegistry(authoritativeRunsRoot);
  if (rawRegistry !== null) {
    for (const line of rawRegistry.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          'current workspace madmax registry is malformed',
        );
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          'current workspace madmax registry record is malformed',
        );
      }
      const rawRecord = record as Record<string, unknown>;
      const rawSourceCwd = rawRecord.source_cwd;
      const sourceCwd = typeof rawSourceCwd === 'string' ? rawSourceCwd.trim() : '';
      if (!sourceCwd) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          'current workspace madmax registry record cannot be proven foreign',
        );
      }
      if (!sourceNamesCurrentWorkspace(sourceCwd, cwd, authority)) continue;
      await addCandidate(rawRecord, true);
    }
  }

  return runDirs.sort((a, b) => b.localeCompare(a));
}

async function readCurrentWorkspaceMadmaxRegistry(runsRoot: string): Promise<string | null> {
  const registryPath = join(runsRoot, 'registry.jsonl');
  try {
    const before = lstatSync(registryPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new StateAuthorityError(
        AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
        `current workspace madmax registry is not a regular file: ${registryPath}`,
      );
    }
    const raw = await readFile(registryPath, 'utf-8');
    const after = lstatSync(registryPath);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new StateAuthorityError(
        AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
        `current workspace madmax registry changed while it was being validated: ${registryPath}`,
      );
    }
    return raw;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      `current workspace madmax registry cannot be read: ${registryPath}`,
    );
  }
}

function resolveCommittedMadmaxRunsRoot(
  authority: ResolvedStateAuthorityContext,
  ambientRunsRoot: string,
): string {
  const committedRunsRoot = dirname(dirname(authority.generation.canonical_omx_root));
  let canonicalCommittedRunsRoot: string;
  try {
    canonicalCommittedRunsRoot = realpathSync(committedRunsRoot);
  } catch (error) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
      `current workspace madmax run root cannot be resolved from the committed authority: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const canonicalAmbientRunsRoot = realpathSync(ambientRunsRoot);
    if (canonicalAmbientRunsRoot === canonicalCommittedRunsRoot) {
      return canonicalAmbientRunsRoot;
    }
  } catch {
    // A missing or unreadable ambient candidate root cannot affect authority.
  }
  return canonicalCommittedRunsRoot;
}

function sourceNamesCurrentWorkspace(
  sourceCwd: string,
  cwd: string,
  authority: ResolvedStateAuthorityContext,
): boolean {
  const canonicalSource = canonicalizeComparableProjectPath(sourceCwd);
  return (
    canonicalSource === canonicalizeComparableProjectPath(cwd)
    || canonicalSource === authority.workspace_identity.canonical_path
  );
}

async function isCommittedMadmaxRunForWorkspace(
  runDir: string,
  cwd: string,
  authority: ResolvedStateAuthorityContext,
  declaredSourceCwd?: string,
): Promise<boolean> {
  const currentCandidate = (
    runDir === dirname(authority.generation.canonical_omx_root)
    || Boolean(
      declaredSourceCwd
      && sourceNamesCurrentWorkspace(declaredSourceCwd, cwd, authority),
    )
  );
  let metadata: Record<string, unknown>;
  try {
    const metadataPath = join(runDir, '.omxbox-run.json');
    const before = lstatSync(metadataPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      if (currentCandidate) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          `current workspace madmax metadata is not a regular file: ${runDir}`,
        );
      }
      return false;
    }
    const raw = await readFile(metadataPath, 'utf-8');
    const after = lstatSync(metadataPath);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      if (currentCandidate) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
          `current workspace madmax metadata changed while it was being validated: ${runDir}`,
        );
      }
      return false;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (currentCandidate) {
        throw new StateAuthorityError(
          AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
          `current workspace madmax metadata is malformed: ${runDir}`,
        );
      }
      return false;
    }
    metadata = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    if (currentCandidate) {
      throw new StateAuthorityError(
        AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
        `current workspace madmax metadata cannot be read or parsed: ${runDir}`,
      );
    }
    return false;
  }

  const sourceCwd = typeof metadata.source_cwd === 'string' ? metadata.source_cwd.trim() : '';
  if (!sourceCwd) {
    if (currentCandidate) {
      throw new StateAuthorityError(
        AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
        `current workspace madmax metadata is missing its source workspace: ${runDir}`,
      );
    }
    return false;
  }
  if (!sourceNamesCurrentWorkspace(sourceCwd, cwd, authority)) {
    if (currentCandidate) {
      throw new StateAuthorityError(
        AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
        `current workspace madmax metadata names a different source workspace: ${runDir}`,
      );
    }
    return false;
  }
  const transport = publicationFromMadmaxMetadata(metadata);
  if (!transport) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      `current workspace madmax metadata has an incomplete or malformed committed authority publication: ${runDir}`,
    );
  }
  if (
    resolve(transport.runDir) !== runDir
    || metadata.cwd !== transport.runDir
    || metadata.authority_state_root !== join(runDir, '.omx', 'state')
    || runDir !== dirname(authority.generation.canonical_omx_root)
  ) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
      `current workspace madmax metadata does not match the active authority root: ${runDir}`,
    );
  }

  const bindingKey = `madmax-root-${createHash('sha256').update(runDir).digest('hex').slice(0, 32)}`;
  const effects = {
    effect: 'madmax-metadata-registry',
    run_dir_digest: createHash('sha256').update(runDir).digest('hex'),
    source_cwd_digest: createHash('sha256').update(transport.sourceCwd).digest('hex'),
    metadata_content_digest: madmaxMetadataContentDigest(runDir, transport.sourceCwd, transport.argv),
  };
  if (
    transport.effectsDigest
      !== launchTransportEffectsDigest(authority, bindingKey, effects)
  ) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
      `current workspace madmax metadata effects digest does not match the active authority: ${runDir}`,
    );
  }
  try {
    await validateCommittedStateAuthorityLaunchTransportPublication(authority, transport.publication);
    await validateCommittedStateAuthorityLaunchTransportJournal(authority, {
      operation_id: transport.publication.operation_id,
      effects_digest: transport.effectsDigest,
    });
    return true;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
      `current workspace madmax authority evidence cannot be validated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function publicationFromMadmaxMetadata(raw: Record<string, unknown>): MadmaxPublicationMetadata | null {
  const rootIdentity = raw.authority_root_identity;
  const sourceCwd = typeof raw.source_cwd === 'string' ? raw.source_cwd.trim() : '';
  const runDir = typeof raw.run_dir === 'string' ? raw.run_dir.trim() : '';
  const effectsDigest = typeof raw.authority_effects_digest === 'string'
    ? raw.authority_effects_digest.trim()
    : '';
  const argv = Array.isArray(raw.argv) && raw.argv.every((value) => typeof value === 'string')
    ? raw.argv
    : null;
  if (
    raw.transport_status !== 'committed'
    || raw.authority_protocol_version !== 1
    || typeof raw.authority_operation_id !== 'string'
    || typeof raw.authority_id !== 'string'
    || typeof raw.authority_generation_id !== 'string'
    || typeof raw.authority_binding_id !== 'string'
    || !Number.isSafeInteger(raw.authority_binding_revision)
    || typeof raw.authority_workspace_digest !== 'string'
    || !Number.isSafeInteger(raw.authority_anchor_revision)
    || !Number.isSafeInteger(raw.authority_fencing_token)
    || !rootIdentity
    || !sourceCwd
    || !runDir
    || !effectsDigest
    || !argv
    || Object.prototype.hasOwnProperty.call(raw, 'OMX_STATE_AUTHORITY_CAPABILITY')
  ) return null;
  return {
    publication: {
      operation_id: raw.authority_operation_id,
      authority_protocol_version: 1,
      authority_id: raw.authority_id,
      generation_id: raw.authority_generation_id,
      binding_id: raw.authority_binding_id,
      binding_revision: raw.authority_binding_revision as number,
      workspace_identity_digest: raw.authority_workspace_digest,
      anchor_revision: raw.authority_anchor_revision as number,
      fencing_token: raw.authority_fencing_token as number,
      root_identity: rootIdentity as StateAuthorityLaunchTransportPublication['root_identity'],
    },
    effectsDigest,
    sourceCwd,
    runDir,
    argv,
  };
}

function madmaxMetadataContentDigest(runDir: string, sourceCwd: string, argv: string[]): string {
  return createHash('sha256').update(JSON.stringify({
    run_dir: runDir,
    source_cwd: sourceCwd,
    argv,
    detached_launch_context: createHash('sha256').update(JSON.stringify({
      source_cwd: canonicalizeLaunchCwd(sourceCwd),
      argv: normalizeMadmaxDetachedLaunchArgv(argv),
      run_identity: runDir,
    })).digest('hex').slice(0, 32),
  })).digest('hex');
}

function canonicalizeLaunchCwd(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function normalizeMadmaxDetachedLaunchArgv(argv: readonly string[]): string[] {
  const passthrough: string[] = [];
  const semanticFlags = new Set<string>();
  let reasoningFlag: string | null = null;
  let afterEndOfOptions = false;
  for (const arg of argv) {
    if (afterEndOfOptions) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      afterEndOfOptions = true;
      passthrough.push(arg);
      continue;
    }
    if (arg === '--tmux' || arg === '--direct') continue;
    if (arg === '--madmax' || arg === '--madmax-spark') {
      semanticFlags.add(arg);
      continue;
    }
    if (arg === '--high' || arg === '--xhigh') {
      reasoningFlag = arg;
      continue;
    }
    passthrough.push(arg);
  }
  return [...Array.from(semanticFlags).sort(), ...(reasoningFlag ? [reasoningFlag] : []), ...passthrough];
}

function resolveMadmaxRunsRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.OMX_RUNS_DIR || join(homedir(), '.omx-runs'));
}

function canonicalizeComparableProjectPath(rawPath: string): string {
  const resolved = resolve(rawPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function countImmediateSessionEntries(sessionsDir: string): Promise<number> {
  const years = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  return years.filter((entry) => entry.isDirectory()).length;
}