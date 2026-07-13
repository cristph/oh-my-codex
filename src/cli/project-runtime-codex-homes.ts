import { execFileSync } from 'node:child_process';

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  resolveStateAuthority,
  validateCommittedStateAuthorityLaunchTransportJournal,
  validateCommittedStateAuthorityLaunchTransportPublication,
  type ResolvedStateAuthorityContext,
  type StateAuthorityLaunchTransportPublication,
} from '../state/authority.js';

import { omxRoot } from '../utils/paths.js';

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
function launchTransportEffectsDigest(
  context: Pick<ResolvedStateAuthorityContext, 'generation' | 'session_binding' | 'workspace_identity'>,
  bindingKey: string,
  effects: Record<string, string>,
): string {
  const ordered = Object.fromEntries(Object.entries({
    authority_id: context.generation.authority_id,
    binding_id: context.session_binding?.binding_id ?? '',
    binding_key: bindingKey,
    binding_revision: String(context.session_binding?.binding_revision ?? -1),
    generation_id: context.generation.generation_id,
    workspace_identity_digest: context.workspace_identity.digest,
    ...effects,
  }).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export async function discoverProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const localHomes = await discoverLocalProjectRuntimeCodexHomes(cwd);
  const madmaxHomes = await discoverAssociatedMadmaxRuntimeCodexHomes(cwd);
  return [...localHomes, ...madmaxHomes].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
    return b.path.localeCompare(a.path);
  });
}

async function discoverLocalProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const root = join(omxRoot(cwd), 'runtime', 'codex-home');
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const homes: ProjectRuntimeCodexHome[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('omx-')) continue;
    const home = join(root, entry.name);
    const sessions = join(home, 'sessions');
    if (!existsSync(sessions)) continue;
    homes.push({
      path: home,
      sessionCountHint: await countImmediateSessionEntries(sessions),
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
  const runsRoot = resolveMadmaxRunsRoot(env);
  let canonicalRunsRoot: string;
  try {
    canonicalRunsRoot = realpathSync(runsRoot);
  } catch {
    return [];
  }
  const associatedRunDirs = await discoverAssociatedMadmaxRunDirs(
    cwd,
    canonicalRunsRoot,
    resolution.context,
  );
  const homes: ProjectRuntimeCodexHome[] = [];
  for (const runDir of associatedRunDirs) {
    const codexHomeRoot = join(runDir, '.omx', 'runtime', 'codex-home');
    const entries = await readdir(codexHomeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('omx-')) continue;
      const home = join(codexHomeRoot, entry.name);
      const sessions = join(home, 'sessions');
      let canonicalHome: string;
      let canonicalSessions: string;
      try {
        const homeStat = lstatSync(home);
        const sessionsStat = lstatSync(sessions);
        if (
          homeStat.isSymbolicLink()
          || !homeStat.isDirectory()
          || sessionsStat.isSymbolicLink()
          || !sessionsStat.isDirectory()
        ) continue;
        canonicalHome = realpathSync(home);
        canonicalSessions = realpathSync(sessions);
      } catch {
        continue;
      }
      if (
        !isPathWithin(canonicalHome, runDir)
        || !isPathWithin(canonicalSessions, canonicalHome)
      ) continue;
      homes.push({
        path: canonicalHome,
        sessionCountHint: await countImmediateSessionEntries(canonicalSessions),
        source: 'madmax-run',
        publicLabel: `madmax:${entry.name}`,
      });
    }
  }
  return homes;
}

async function discoverAssociatedMadmaxRunDirs(
  cwd: string,
  runsRoot: string,
  authority: ResolvedStateAuthorityContext,
): Promise<string[]> {
  const seen = new Set<string>();
  const runDirs: string[] = [];
  const addCandidate = async (raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object') return;
    const record = raw as Record<string, unknown>;
    const runDir = typeof record.run_dir === 'string'
      ? record.run_dir.trim()
      : typeof record.cwd === 'string'
        ? record.cwd.trim()
        : '';
    if (!runDir) return;
    let canonicalRunDir: string;
    try {
      const requestedRunDir = resolve(runDir);
      const requestedRunStat = lstatSync(requestedRunDir);
      if (requestedRunStat.isSymbolicLink() || !requestedRunStat.isDirectory()) return;
      canonicalRunDir = realpathSync(requestedRunDir);
      if (
        !isPathWithin(canonicalRunDir, runsRoot)
        || lstatSync(canonicalRunDir).isSymbolicLink()
        || !lstatSync(canonicalRunDir).isDirectory()
      ) return;
    } catch {
      return;
    }

    if (seen.has(canonicalRunDir)) return;
    if (!await isCommittedMadmaxRunForWorkspace(canonicalRunDir, cwd, authority)) return;
    seen.add(canonicalRunDir);
    runDirs.push(canonicalRunDir);
  };

  const rawRegistry = await readFile(join(runsRoot, 'registry.jsonl'), 'utf-8').catch(() => '');
  for (const line of rawRegistry.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      await addCandidate(JSON.parse(trimmed));
    } catch {}
  }

  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    await addCandidate({ run_dir: join(runsRoot, entry.name) });
  }
  return runDirs.sort((a, b) => b.localeCompare(a));
}

async function isCommittedMadmaxRunForWorkspace(
  runDir: string,
  cwd: string,
  authority: ResolvedStateAuthorityContext,
): Promise<boolean> {
  let metadata: Record<string, unknown>;
  try {
    const metadataPath = join(runDir, '.omxbox-run.json');
    const before = lstatSync(metadataPath);
    if (before.isSymbolicLink() || !before.isFile()) return false;
    const raw = await readFile(metadataPath, 'utf-8');
    const after = lstatSync(metadataPath);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    metadata = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  const transport = publicationFromMadmaxMetadata(metadata);
  if (!transport) return false;
  const canonicalSource = canonicalizeComparableProjectPath(transport.sourceCwd);
  const canonicalCwd = canonicalizeComparableProjectPath(cwd);
  if (
    canonicalSource !== canonicalCwd
    && canonicalSource !== authority.workspace_identity.canonical_path
  ) return false;
  if (
    resolve(transport.runDir) !== runDir
    || metadata.cwd !== transport.runDir
    || metadata.authority_state_root !== join(runDir, '.omx', 'state')
    || runDir !== dirname(authority.generation.canonical_omx_root)
  ) return false;

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
  ) return false;
  try {
    await validateCommittedStateAuthorityLaunchTransportPublication(authority, transport.publication);
    await validateCommittedStateAuthorityLaunchTransportJournal(authority, {
      operation_id: transport.publication.operation_id,
      effects_digest: transport.effectsDigest,
    });
    return true;
  } catch {
    return false;
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