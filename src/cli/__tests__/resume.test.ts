import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ORIGINAL_TEST_UMASK = process.umask(0o077);
after(() => process.umask(ORIGINAL_TEST_UMASK));
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  StateAuthorityError,
  initializeStateAuthority,
  publishStateAuthorityLaunchTransport,
  rolloverStateAuthorityToAlternateRoot,
  mintStateAuthorityTransportCapability,
  validateCommittedStateAuthorityLaunchTransportJournal,
  validateCommittedStateAuthorityLaunchTransportPublication,
  type ResolvedStateAuthorityContext,
} from '../../state/authority.js';
import { discoverProjectRuntimeCodexHomes } from '../project-runtime-codex-homes.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.OMX_STARTUP_CWD;
  delete inheritedEnv.OMX_ROOT;
  delete inheritedEnv.OMX_STATE_ROOT;
  delete inheritedEnv.OMX_TEAM_STATE_ROOT;
  delete inheritedEnv.OMX_STATE_AUTHORITY_PATH;
  delete inheritedEnv.OMX_STATE_AUTHORITY_ID;
  delete inheritedEnv.OMX_STATE_AUTHORITY_GENERATION_ID;
  delete inheritedEnv.OMX_STATE_AUTHORITY_WORKSPACE_DIGEST;
  delete inheritedEnv.OMX_STATE_AUTHORITY_CAPABILITY;
  delete inheritedEnv.OMX_SESSION_ID;
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...inheritedEnv,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}


const TEST_AUTHORITY_ISSUER = {
  kind: 'first-party-launcher' as const,
  package_version: 'test',
  package_digest: '0'.repeat(64),
};

function authorityTransport(authority: ResolvedStateAuthorityContext): NodeJS.ProcessEnv {
  const sessionId = authority.session_binding?.canonical_session_id;
  if (!sessionId) throw new Error('fixture authority must have a canonical session binding');
  return buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId });
}

function launchTransportEffectsDigest(
  authority: Pick<ResolvedStateAuthorityContext, 'generation' | 'session_binding' | 'workspace_identity'>,
  bindingKey: string,
  effects: Record<string, string>,
): string {
  const ordered = Object.fromEntries(Object.entries({
    authority_id: authority.generation.authority_id,
    binding_id: authority.session_binding?.binding_id ?? '',
    binding_key: bindingKey,
    binding_revision: String(authority.session_binding?.binding_revision ?? -1),
    generation_id: authority.generation.generation_id,
    workspace_identity_digest: authority.workspace_identity.digest,
    ...effects,
  }).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
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

function madmaxMetadataContentDigest(runDir: string, sourceCwd: string, argv: string[]): string {
  return createHash('sha256').update(JSON.stringify({
    run_dir: runDir,
    source_cwd: sourceCwd,
    argv,
    detached_launch_context: createHash('sha256').update(JSON.stringify({
      source_cwd: canonicalizeLaunchCwd(sourceCwd),
      argv,
      run_identity: runDir,
    })).digest('hex').slice(0, 32),
  })).digest('hex');
}

async function writeCommittedMadmaxPublication(
  cwd: string,
  runDir: string,
  argv: string[] = ['--madmax'],
): Promise<ResolvedStateAuthorityContext> {
  await mkdir(runDir, { recursive: true });
  const initial = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: 'resume-madmax-source',
    session_binding: { canonical_session_id: 'resume-madmax' },
  });
  const authority = await rolloverStateAuthorityToAlternateRoot({
    context: initial,
    proposed_state_root: join(runDir, '.omx', 'state'),
    creation_root: runDir,
    launch_id: 'resume-madmax-run',
    consumer_kind: 'madmax',
    issuer: TEST_AUTHORITY_ISSUER,
  });
  const bindingKey = `madmax-root-${createHash('sha256').update(runDir).digest('hex').slice(0, 32)}`;
  const effects = {
    effect: 'madmax-metadata-registry',
    run_dir_digest: createHash('sha256').update(runDir).digest('hex'),
    source_cwd_digest: createHash('sha256').update(cwd).digest('hex'),
    metadata_content_digest: madmaxMetadataContentDigest(runDir, cwd, argv),
  };
  const effectsDigest = launchTransportEffectsDigest(authority, bindingKey, effects);
  await mintStateAuthorityTransportCapability(authority);
  const publication = await publishStateAuthorityLaunchTransport({
    context: authority,
    binding_key: bindingKey,
    effects,
    publish: async (_context, record) => {
      await writeFile(join(runDir, '.omxbox-run.json'), `${JSON.stringify({
        launcher: 'omx --madmax',
        cwd: runDir,
        source_cwd: cwd,
        run_dir: runDir,
        argv,
        transport_status: 'committed',
        authority_protocol_version: record.authority_protocol_version,
        authority_operation_id: record.operation_id,
        authority_id: record.authority_id,
        authority_generation_id: record.generation_id,
        authority_binding_id: record.binding_id,
        authority_binding_revision: record.binding_revision,
        authority_workspace_digest: record.workspace_identity_digest,
        authority_anchor_revision: record.anchor_revision,
        authority_fencing_token: record.fencing_token,
        authority_state_root: join(runDir, '.omx', 'state'),
        authority_root_identity: record.root_identity,
        authority_effects_digest: effectsDigest,
      })}\n`);
      return record;
    },
    verify: async (context, record) => {
      await validateCommittedStateAuthorityLaunchTransportPublication(context, record);
    },
  });
  await validateCommittedStateAuthorityLaunchTransportPublication(authority, publication);
  await validateCommittedStateAuthorityLaunchTransportJournal(authority, {
    operation_id: publication.operation_id,
    effects_digest: effectsDigest,
  });
  return authority;
}

describe('omx resume', () => {
  it('exposes project-local Codex history artifacts to codex resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-history-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const canonicalProjectCodexHome = join(await realpath(wd), '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const rolloutPath = join(projectCodexHome, 'sessions', '2026', '06', '03', 'rollout-session-2712.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(dirname(rolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await writeFile(join(projectCodexHome, 'state_5.sqlite'), 'state db placeholder');
      await writeFile(join(projectCodexHome, 'state_5.sqlite-wal'), 'state db wal placeholder');
      await writeFile(rolloutPath, '{"type":"session_meta","payload":{"id":"session-2712"}}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
printf 'sqlite-home:%s\n' "$CODEX_SQLITE_HOME"
if [ -f "$CODEX_HOME/state_5.sqlite" ]; then echo state-present=yes; else echo state-present=no; fi
if [ -f "$CODEX_HOME/state_5.sqlite-wal" ]; then echo wal-present=yes; else echo wal-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/03/rollout-session-2712.jsonl" ]; then echo rollout-present=yes; else echo rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, new RegExp(`sqlite-home:${canonicalProjectCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stdout, /codex-home:.*\.omx\/runtime\/codex-home\//);
      assert.match(result.stdout, /state-present=yes/);
      assert.match(result.stdout, /wal-present=yes/);
      assert.match(result.stdout, /rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists project-scope runtime Codex transcripts after cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-history-cleanup-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
mkdir -p "$CODEX_HOME/sessions/2026/06/16"
printf '{"type":"session_meta","payload":{"id":"session-2835"}}\n' > "$CODEX_HOME/sessions/2026/06/16/rollout-session-2835.jsonl"
printf '{"session_id":"session-2835"}\n' > "$CODEX_HOME/history.jsonl"
printf '{"id":"session-2835"}\n' > "$CODEX_HOME/session_index.jsonl"
printf 'fake-codex:%s\n' "$*"
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.equal(
        await readFile(join(projectCodexHome, 'sessions', '2026', '06', '16', 'rollout-session-2835.jsonl'), 'utf-8'),
        '{"type":"session_meta","payload":{"id":"session-2835"}}\n',
      );
      assert.equal(await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'), '{"session_id":"session-2835"}\n');
      assert.equal(await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'), '{"id":"session-2835"}\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('includes generated project runtime Codex home sessions for plain resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-generated-runtime-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-runtime-session.jsonl" ]; then echo runtime-rollout-present=yes; else echo runtime-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /codex-home:.*\.omx\/runtime\/codex-home\//);
      assert.match(result.stdout, /runtime-rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('merges symlinked project runtime history during plain resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-symlinked-runtime-history-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const previousRuntimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime-a');
      const duplicateRuntimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime-b');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const projectRolloutPath = join(projectCodexHome, 'sessions', '2026', '06', '18', 'rollout-project-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(dirname(projectRolloutPath), { recursive: true });
      await mkdir(previousRuntimeCodexHome, { recursive: true });
      await mkdir(duplicateRuntimeCodexHome, { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await writeFile(projectRolloutPath, '{"type":"session_meta","payload":{"id":"project-session"}}\n');
      await writeFile(join(projectCodexHome, 'history.jsonl'), '{"session_id":"project-session"}\n');
      await writeFile(join(projectCodexHome, 'session_index.jsonl'), '{"id":"project-session"}\n');
      await symlink(join(projectCodexHome, 'sessions'), join(previousRuntimeCodexHome, 'sessions'), 'dir');
      await symlink(join(projectCodexHome, 'history.jsonl'), join(previousRuntimeCodexHome, 'history.jsonl'));
      await symlink(join(projectCodexHome, 'session_index.jsonl'), join(previousRuntimeCodexHome, 'session_index.jsonl'));
      await symlink(join(projectCodexHome, 'sessions'), join(duplicateRuntimeCodexHome, 'sessions'), 'dir');
      await symlink(join(projectCodexHome, 'history.jsonl'), join(duplicateRuntimeCodexHome, 'history.jsonl'));
      await symlink(join(projectCodexHome, 'session_index.jsonl'), join(duplicateRuntimeCodexHome, 'session_index.jsonl'));

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
printf 'history-lines:%s\n' "$(wc -l < "$CODEX_HOME/history.jsonl")"
printf 'index-lines:%s\n' "$(wc -l < "$CODEX_HOME/session_index.jsonl")"
if [ -f "$CODEX_HOME/sessions/2026/06/18/rollout-project-session.jsonl" ]; then echo project-rollout-present=yes; else echo project-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.doesNotMatch(result.stderr, /EISDIR/);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /project-rollout-present=yes/);
      assert.match(result.stdout, /history-lines:\s*1\b/);
      assert.match(result.stdout, /index-lines:\s*1\b/);
      assert.equal(await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'), '{"session_id":"project-session"}\n');
      assert.equal(await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'), '{"id":"project-session"}\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not duplicate generated runtime history across repeated plain resume cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-runtime-history-dedupe-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await writeFile(join(projectCodexHome, 'history.jsonl'), '{"session_id":"project-session"}\n');
      await writeFile(join(projectCodexHome, 'session_index.jsonl'), '{"id":"project-session"}\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');
      await writeFile(join(runtimeCodexHome, 'history.jsonl'), '{"session_id":"runtime-session"}\n');
      await writeFile(join(runtimeCodexHome, 'session_index.jsonl'), '{"id":"runtime-session"}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const env = {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      };

      const first = runOmx(wd, ['resume'], env);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      const second = runOmx(wd, ['resume'], env);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);

      assert.equal(
        await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'),
        '{"session_id":"project-session"}\n{"session_id":"runtime-session"}\n',
      );
      assert.equal(
        await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'),
        '{"id":"project-session"}\n{"id":"runtime-session"}\n',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses --codex-home as an explicit resume escape hatch', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-codex-home-'));
    try {
      const home = join(wd, 'home');
      const explicitCodexHome = join(wd, 'explicit-codex-home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const rolloutPath = join(explicitCodexHome, 'sessions', '2026', '06', '17', 'rollout-explicit-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(dirname(rolloutPath), { recursive: true });
      await writeFile(rolloutPath, '{"type":"session_meta","payload":{"id":"explicit-session"}}\n');
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-explicit-session.jsonl" ]; then echo explicit-rollout-present=yes; else echo explicit-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--codex-home', explicitCodexHome, '--last'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
      assert.match(result.stdout, new RegExp(`codex-home:${explicitCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stdout, /explicit-rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('filters resume to generated project runtime homes with --project', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-filter-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const projectRolloutPath = join(projectCodexHome, 'sessions', '2026', '06', '17', 'rollout-project-session.jsonl');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(dirname(projectRolloutPath), { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(projectRolloutPath, '{"type":"session_meta","payload":{"id":"project-session"}}\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-runtime-session.jsonl" ]; then echo runtime-rollout-present=yes; else echo runtime-rollout-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-project-session.jsonl" ]; then echo project-rollout-present=yes; else echo project-rollout-present=no; fi
mkdir -p "$CODEX_HOME/sessions/2026/06/18"
printf '{"type":"session_meta","payload":{"id":"new-project-resume"}}\n' > "$CODEX_HOME/sessions/2026/06/18/rollout-new-project-resume.jsonl"
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--project'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /runtime-rollout-present=yes/);
      assert.match(result.stdout, /project-rollout-present=no/);
      const runtimeDirs = await readdir(join(wd, '.omx', 'runtime', 'codex-home'));
      const persistedNewTranscript = await Promise.all(runtimeDirs.map(async (dir) => {
        const transcript = join(wd, '.omx', 'runtime', 'codex-home', dir, 'sessions', '2026', '06', '18', 'rollout-new-project-resume.jsonl');
        return readFile(transcript, 'utf-8').catch(() => '');
      }));
      assert.ok(persistedNewTranscript.some((content) => content.includes('new-project-resume')));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores bare madmax registry sessions during plain resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-madmax-runtime-'));
    try {
      const home = join(wd, 'home');
      const runsRoot = join(wd, 'runs');
      const projectCodexHome = join(wd, '.codex');
      const madmaxCodexHome = join(runsRoot, 'run-associated', '.omx', 'runtime', 'codex-home', 'omx-madmax-runtime');
      const unrelatedCodexHome = join(runsRoot, 'run-unrelated', '.omx', 'runtime', 'codex-home', 'omx-unrelated-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const associatedRolloutPath = join(madmaxCodexHome, 'sessions', '2026', '06', '17', 'rollout-madmax-session.jsonl');
      const unrelatedRolloutPath = join(unrelatedCodexHome, 'sessions', '2026', '06', '17', 'rollout-unrelated-session.jsonl');
      const unrelatedSource = join(wd, 'unrelated-source');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(dirname(associatedRolloutPath), { recursive: true });
      await mkdir(dirname(unrelatedRolloutPath), { recursive: true });
      await mkdir(unrelatedSource, { recursive: true });
      await writeFile(associatedRolloutPath, '{"type":"session_meta","payload":{"id":"madmax-session"}}\n');
      await writeFile(unrelatedRolloutPath, '{"type":"session_meta","payload":{"id":"unrelated-session"}}\n');
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({ source_cwd: wd, run_dir: join(runsRoot, 'run-associated') })}\n${JSON.stringify({ source_cwd: unrelatedSource, run_dir: join(runsRoot, 'run-unrelated') })}\n`);
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      const authority = await initializeStateAuthority({
        startup_cwd: wd,
        observed_cwd: wd,
        launch_id: 'resume-bare-madmax',
        session_binding: { canonical_session_id: 'resume-bare-madmax' },
      });
      await mintStateAuthorityTransportCapability(authority);
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-madmax-session.jsonl" ]; then echo madmax-rollout-present=yes; else echo madmax-rollout-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-unrelated-session.jsonl" ]; then echo unrelated-rollout-present=yes; else echo unrelated-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        ...authorityTransport(authority),
        HOME: home,
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /madmax-rollout-present=no/);
      assert.match(result.stdout, /unrelated-rollout-present=no/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('includes a committed madmax runtime publication when OMX_RUNS_DIR is foreign', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-madmax-committed-'));
    try {
      const home = join(wd, 'home');
      const runsRoot = join(wd, 'runs');
      const foreignRunsRoot = join(wd, 'foreign-runs');
      const projectCodexHome = join(wd, '.codex');
      const associatedRun = join(runsRoot, 'run-associated');
      const unrelatedRun = join(runsRoot, 'run-unrelated');
      const madmaxCodexHome = join(associatedRun, '.omx', 'runtime', 'codex-home', 'omx-madmax-runtime');
      const unrelatedCodexHome = join(unrelatedRun, '.omx', 'runtime', 'codex-home', 'omx-unrelated-runtime');
      const unrelatedSource = join(wd, 'unrelated-source');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const associatedRolloutPath = join(madmaxCodexHome, 'sessions', '2026', '06', '17', 'rollout-madmax-session.jsonl');
      const unrelatedRolloutPath = join(unrelatedCodexHome, 'sessions', '2026', '06', '17', 'rollout-unrelated-session.jsonl');

      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(projectCodexHome, { recursive: true }),
        mkdir(dirname(associatedRolloutPath), { recursive: true }),
        mkdir(dirname(unrelatedRolloutPath), { recursive: true }),
        mkdir(unrelatedSource, { recursive: true }),
        mkdir(foreignRunsRoot, { recursive: true }),
      ]);
      await writeFile(associatedRolloutPath, '{"type":"session_meta","payload":{"id":"madmax-session"}}\n');
      await writeFile(unrelatedRolloutPath, '{"type":"session_meta","payload":{"id":"unrelated-session"}}\n');
      const authority = await writeCommittedMadmaxPublication(wd, associatedRun);
      await writeFile(join(unrelatedRun, '.omxbox-run.json'), JSON.stringify({
        source_cwd: unrelatedSource,
        run_dir: unrelatedRun,
      }));
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: wd, run_dir: associatedRun })}\n${JSON.stringify({ source_cwd: unrelatedSource, run_dir: unrelatedRun })}\n`,
      );
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-madmax-session.jsonl" ]; then echo madmax-rollout-present=yes; else echo madmax-rollout-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-unrelated-session.jsonl" ]; then echo unrelated-rollout-present=yes; else echo unrelated-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        ...authorityTransport(authority),
        HOME: home,
        OMX_RUNS_DIR: foreignRunsRoot,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /madmax-rollout-present=yes/);
      assert.match(result.stdout, /unrelated-rollout-present=no/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails resume closed for forged current-workspace madmax publication evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-madmax-forged-'));
    const previousRunsDir = process.env.OMX_RUNS_DIR;
    try {
      const runsRoot = join(wd, '.omxbox-runs');
      const foreignRunsRoot = join(wd, 'foreign-runs');
      const runDir = join(runsRoot, 'run-forged');
      const authority = await writeCommittedMadmaxPublication(wd, runDir);
      await mkdir(foreignRunsRoot, { recursive: true });
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({ source_cwd: authority.workspace_identity.canonical_path, run_dir: runDir })}\n`);
      await writeFile(join(runDir, '.omxbox-run.json'), JSON.stringify({
        cwd: runDir,
        source_cwd: authority.workspace_identity.canonical_path,
        run_dir: runDir,
        argv: ['--madmax'],
        transport_status: 'committed',
        authority_protocol_version: 1,
        authority_operation_id: 'forged-launch-transport-operation',
      }));

      process.env.OMX_RUNS_DIR = foreignRunsRoot;
      await assert.rejects(
        () => discoverProjectRuntimeCodexHomes(wd),
        (error: unknown) => error instanceof StateAuthorityError
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      );
      const result = runOmx(wd, ['resume'], { ...authorityTransport(authority), OMX_RUNS_DIR: foreignRunsRoot });
      assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /current workspace madmax metadata has an incomplete or malformed committed authority publication/);
    } finally {
      if (typeof previousRunsDir === 'string') process.env.OMX_RUNS_DIR = previousRunsDir;
      else delete process.env.OMX_RUNS_DIR;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preflights madmax resume to current plugin cache after old cache deletion', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-madmax-plugin-preflight-'));
    try {
      const home = join(wd, 'home');
      const runsRoot = join(wd, 'runs');
      const projectCodexHome = join(wd, '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const manifest = JSON.parse(await readFile(join(repoRoot, 'plugins', 'oh-my-codex', '.codex-plugin', 'plugin.json'), 'utf-8')) as { version: string };
      const currentVersion = manifest.version;
      const oldVersion = '0.0.0-resume-stale';
      const oldCacheDir = join(projectCodexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex', oldVersion);

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(runsRoot, { recursive: true });
      await mkdir(join(projectCodexHome, 'sessions', '2026', '06', '17'), { recursive: true });
      await mkdir(join(oldCacheDir, '.codex-plugin'), { recursive: true });
      await mkdir(join(oldCacheDir, 'hooks'), { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(projectCodexHome, 'sessions', '2026', '06', '17', 'rollout-stale-session.jsonl'), '{"type":"session_meta","payload":{"id":"stale-session"}}\n');
      await writeFile(join(projectCodexHome, 'config.toml'), [
        '[plugins."oh-my-codex@oh-my-codex-local"]',
        'enabled = true',
        '',
        '[marketplaces.oh-my-codex-local]',
        'source_type = "local"',
        'source = "/deleted/old/omx"',
        '',
      ].join('\n'));
      await writeFile(join(oldCacheDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-codex',
        version: oldVersion,
        skills: './skills/',
        hooks: './hooks/hooks.json',
      }, null, 2));
      await writeFile(join(oldCacheDir, 'hooks', 'hooks.json'), '{}\n');
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await rm(oldCacheDir, { recursive: true, force: true });

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
if [ -f "$CODEX_HOME/plugins/cache/oh-my-codex-local/oh-my-codex/${currentVersion}/hooks/codex-native-hook.mjs" ]; then echo current-hook-present=yes; else echo current-hook-present=no; fi
if [ -e "$CODEX_HOME/plugins/cache/oh-my-codex-local/oh-my-codex/${oldVersion}" ]; then echo old-cache-present=yes; else echo old-cache-present=no; fi
case "$(cat "$CODEX_HOME/config.toml")" in *'source = "${repoRoot}"'*) echo marketplace-current=yes;; *) echo marketplace-current=no;; esac
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['--madmax', 'resume', 'stale-session'], {
        HOME: home,
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*resume stale-session\b/);
      assert.match(result.stdout, /current-hook-present=yes/);
      assert.match(result.stdout, /old-cache-present=no/);
      assert.match(result.stdout, /marketplace-current=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps project runtime history unchanged when madmax registry evidence is unauthenticated', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-madmax-dedupe-'));
    try {
      const home = join(wd, 'home');
      const runsRoot = join(wd, 'runs');
      const projectCodexHome = join(wd, '.codex');
      const madmaxCodexHome = join(runsRoot, 'run-associated', '.omx', 'runtime', 'codex-home', 'omx-madmax-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const associatedRolloutPath = join(madmaxCodexHome, 'sessions', '2026', '06', '17', 'rollout-madmax-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(dirname(associatedRolloutPath), { recursive: true });
      await writeFile(join(projectCodexHome, 'history.jsonl'), '{"session_id":"project-session"}\n');
      await writeFile(join(projectCodexHome, 'session_index.jsonl'), '{"id":"project-session"}\n');
      await writeFile(associatedRolloutPath, '{"type":"session_meta","payload":{"id":"madmax-session"}}\n');
      await writeFile(join(madmaxCodexHome, 'history.jsonl'), '{"session_id":"madmax-session"}\n');
      await writeFile(join(madmaxCodexHome, 'session_index.jsonl'), '{"id":"madmax-session"}\n');
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({ source_cwd: wd, run_dir: join(runsRoot, 'run-associated') })}\n`);
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      const env = {
        HOME: home,
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      };

      const first = runOmx(wd, ['resume'], env);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      const second = runOmx(wd, ['resume'], env);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);

      assert.equal(
        await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'),
        '{"session_id":"project-session"}\n',
      );
      assert.equal(
        await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'),
        '{"id":"project-session"}\n',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves transcript mtimes while materializing runtime history for updated sort', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-updated-sort-mtime-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const previousRuntimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const oldRolloutPath = join(projectCodexHome, 'sessions', '2024', '01', '02', 'rollout-old-a.jsonl');
      const newerRolloutPath = join(projectCodexHome, 'sessions', '2024', '03', '04', 'rollout-old-b.jsonl');
      const oldMtime = new Date('2024-01-02T03:04:05Z');
      const newerMtime = new Date('2024-03-04T05:06:07Z');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(dirname(oldRolloutPath), { recursive: true });
      await mkdir(dirname(newerRolloutPath), { recursive: true });
      await mkdir(previousRuntimeCodexHome, { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await writeFile(oldRolloutPath, '{"type":"session_meta","payload":{"id":"old-a"}}\n');
      await writeFile(newerRolloutPath, '{"type":"session_meta","payload":{"id":"old-b"}}\n');
      await utimes(oldRolloutPath, oldMtime, oldMtime);
      await utimes(newerRolloutPath, newerMtime, newerMtime);
      await symlink(join(projectCodexHome, 'sessions'), join(previousRuntimeCodexHome, 'sessions'), 'dir');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\\n' "$*"
find "$CODEX_HOME/sessions" -type f -name '*.jsonl' -exec stat -c '%y %n' {} \\; | sort
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--sort', 'updated'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --sort updated\b/);
      assert.match(result.stdout, /2024-01-02 03:04:05\.\d+ .*rollout-old-a\.jsonl/);
      assert.match(result.stdout, /2024-03-04 05:06:07\.\d+ .*rollout-old-b\.jsonl/);
      assert.equal((await stat(oldRolloutPath)).mtime.toISOString(), oldMtime.toISOString());
      assert.equal((await stat(newerRolloutPath)).mtime.toISOString(), newerMtime.toISOString());
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('forwards --last to codex resume through the normal launch wrapper', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--last'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes resume --help through to codex instead of printing top-level omx help', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--help'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --help\b/);
      assert.doesNotMatch(result.stdout, /Unknown command: resume/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preflights default user plugin cache before madmax resume while preserving stale cache metadata', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-madmax-resume-default-cache-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      const staleVersion = '0.0.0-stale';
      const staleCacheDir = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex', staleVersion);
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version: string };
      const expectedCacheDir = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex', packageJson.version);

      await mkdir(join(staleCacheDir, '.codex-plugin'), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(staleCacheDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-codex', version: staleVersion }));
      await writeFile(join(codexHome, 'config.toml'), '[plugins]\n"oh-my-codex@oh-my-codex-local" = true\n');
      await writeFile(fakeCodexPath, `#!/bin/sh
set -eu
selected_codex_home="\${CODEX_HOME:-$HOME/.codex}"
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$selected_codex_home"
if [ -f "$selected_codex_home/plugins/cache/oh-my-codex-local/oh-my-codex/${packageJson.version}/.codex-plugin/plugin.json" ]; then echo current-cache=yes; else echo current-cache=no; fi
if [ -d "$selected_codex_home/plugins/cache/oh-my-codex-local/oh-my-codex/${staleVersion}" ]; then echo stale-cache=yes; else echo stale-cache=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['--madmax', 'resume', 'session-after-update'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_LAUNCH_POLICY: 'direct',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume session-after-update\b/);
      assert.match(result.stdout, /current-cache=yes/);
      assert.match(result.stdout, /stale-cache=yes/);
      const repairedConfig = await readFile(join(codexHome, 'config.toml'), 'utf-8');
      assert.doesNotThrow(() => TOML.parse(repairedConfig));
      assert.doesNotMatch(repairedConfig, /^"oh-my-codex@oh-my-codex-local"\s*=/m);
      assert.match(repairedConfig, /^\[plugins\."oh-my-codex@oh-my-codex-local"\]$/m);
      assert.deepEqual(
        new Set(await readdir(join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex'))),
        new Set([packageJson.version, staleVersion]),
      );
      assert.equal(
        JSON.parse(await readFile(join(expectedCacheDir, '.codex-plugin', 'plugin.json'), 'utf-8')).version,
        packageJson.version,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps stale plugin cache directories when live resume process does not mention cache path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-madmax-resume-live-cache-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      const staleVersion = '0.0.0-live-stale';
      const staleCacheDir = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex', staleVersion);
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version: string };

      await mkdir(join(staleCacheDir, '.codex-plugin'), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(staleCacheDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-codex', version: staleVersion }));
      await writeFile(join(codexHome, 'config.toml'), '[plugins]\n"oh-my-codex@oh-my-codex-local" = true\n');
      await writeFile(fakePsPath, `#!/bin/sh
printf '123 1 codex resume live-session-after-update\\n'
`);
      await chmod(fakePsPath, 0o755);
      await writeFile(fakeCodexPath, `#!/bin/sh
set -eu
selected_codex_home="\${CODEX_HOME:-$HOME/.codex}"
printf 'fake-codex:%s\n' "$*"
if [ -f "$selected_codex_home/plugins/cache/oh-my-codex-local/oh-my-codex/${packageJson.version}/.codex-plugin/plugin.json" ]; then echo current-cache=yes; else echo current-cache=no; fi
if [ -d "$selected_codex_home/plugins/cache/oh-my-codex-local/oh-my-codex/${staleVersion}" ]; then echo live-stale-cache=yes; else echo live-stale-cache=no; fi
`);
      await chmod(fakeCodexPath, 0o755);

      const result = runOmx(wd, ['--madmax', 'resume', 'live-session-after-update'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_LAUNCH_POLICY: 'direct',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume live-session-after-update\b/);
      assert.match(result.stdout, /current-cache=yes/);
      assert.match(result.stdout, /live-stale-cache=yes/);
      assert.deepEqual(
        new Set(await readdir(join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex'))),
        new Set([packageJson.version, staleVersion]),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not bootstrap plugin mode during clean legacy resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-clean-legacy-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, `#!/bin/sh
set -eu
selected_codex_home="\${CODEX_HOME:-$HOME/.codex}"
printf 'fake-codex:%s\n' "$*"
if [ -f "$selected_codex_home/config.toml" ]; then echo config-created=yes; else echo config-created=no; fi
if [ -d "$selected_codex_home/plugins/cache/oh-my-codex-local/oh-my-codex" ]; then echo plugin-cache-created=yes; else echo plugin-cache-created=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', 'legacy-session'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_LAUNCH_POLICY: 'direct',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume legacy-session\b/);
      assert.match(result.stdout, /config-created=no/);
      assert.match(result.stdout, /plugin-cache-created=no/);
      await assert.rejects(readFile(join(codexHome, 'config.toml'), 'utf-8'), /ENOENT/);
      await assert.rejects(readFile(join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex'), 'utf-8'), /ENOENT/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
