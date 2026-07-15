import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
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
import {
  parseSessionFrictionArgs,
  parseSessionSearchArgs,
} from '../session-search.js';

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
    launch_id: 'session-search-madmax-source',
    session_binding: { canonical_session_id: 'session-search-madmax' },
  });
  const authority = await rolloverStateAuthorityToAlternateRoot({
    context: initial,
    proposed_state_root: join(runDir, '.omx', 'state'),
    creation_root: runDir,
    launch_id: 'session-search-madmax-run',
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

async function writeRollout(
  codexHomeDir: string,
  isoDate: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
): Promise<void> {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  const dir = join(codexHomeDir, 'sessions', year, month, day);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, fileName),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf-8',
  );
}

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('parseSessionSearchArgs', () => {
  it('parses query tokens and flags', () => {
    const parsed = parseSessionSearchArgs([
      'team',
      'api',
      '--limit',
      '5',
      '--project=current',
      '--codex-home',
      '/tmp/codex',
      '--json',
    ]);
    assert.equal(parsed.options.query, 'team api');
    assert.equal(parsed.options.limit, 5);
    assert.equal(parsed.options.project, 'current');
    assert.equal(parsed.options.codexHomeDir, '/tmp/codex');
    assert.equal(parsed.json, true);
  });
});

describe('parseSessionFrictionArgs', () => {
  it('parses friction flags without accepting positional payloads', () => {
    const parsed = parseSessionFrictionArgs([
      '--limit=3',
      '--project',
      'all',
      '--session',
      'abc',
      '--codex-home',
      '/tmp/codex',
      '--json',
    ]);
    assert.equal(parsed.options.limit, 3);
    assert.equal(parsed.options.project, 'all');
    assert.equal(parsed.options.session, 'abc');
    assert.equal(parsed.options.codexHomeDir, '/tmp/codex');
    assert.equal(parsed.json, true);
    assert.throws(
      () => parseSessionFrictionArgs(['raw prompt']),
      /Unexpected positional argument/,
    );
  });
});

describe('omx session search', () => {
  it('prints structured JSON results for matching transcripts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-cli-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(
        codexHomeDir,
        '2026-03-10T12:00:00.000Z',
        'rollout-2026-03-10T12-00-00-session-a.jsonl',
        [
        {
          type: 'session_meta',
          payload: {
            id: 'session-a',
            timestamp: '2026-03-10T12:00:00.000Z',
            cwd,
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Show previous discussions of team api in recent runs.',
          },
        },
        ],
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'team api', '--project', 'current', '--json'],
        {
        CODEX_HOME: codexHomeDir,
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        query: string;
        results: Array<{ session_id: string; snippet: string; cwd: string }>;
      };
      assert.equal(parsed.query, 'team api');
      assert.equal(parsed.results.length, 1);
      assert.equal(parsed.results[0].session_id, 'session-a');
      assert.equal(parsed.results[0].cwd, cwd);
      assert.match(parsed.results[0].snippet, /team api/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches generated project runtime Codex homes in a project repo', async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'omx-session-search-cli-project-'),
    );
    const home = join(cwd, 'home');
    const defaultCodexHome = join(home, '.codex');
    const runtimeCodexHome = join(
      cwd,
      '.omx',
      'runtime',
      'codex-home',
      'omx-runtime-a',
    );
    try {
      await writeRollout(
        defaultCodexHome,
        '2026-03-10T12:00:00.000Z',
        'rollout-default.jsonl',
        [
        {
          type: 'session_meta',
            payload: {
              id: 'default-session',
              timestamp: '2026-03-10T12:00:00.000Z',
              cwd,
        },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'generated project search default',
            },
          },
        ],
      );
      await writeRollout(
        runtimeCodexHome,
        '2026-03-11T12:00:00.000Z',
        'rollout-runtime.jsonl',
        [
        {
          type: 'session_meta',
            payload: {
              id: 'runtime-session',
              timestamp: '2026-03-11T12:00:00.000Z',
              cwd,
        },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'generated project search runtime',
            },
          },
        ],
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'generated project search', '--json'],
        {
        HOME: home,
        CODEX_HOME: '',
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const expectedRuntimeCodexHome = await realpath(runtimeCodexHome);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string }>;
        sources: Array<{ codex_home: string }>;
      };
      assert.deepEqual(
        parsed.results.map((result) => result.session_id).sort(),
        ['default-session', 'runtime-session'],
      );
      assert.ok(
        parsed.sources.some((source) => source.codex_home === defaultCodexHome),
      );
      assert.ok(
        parsed.sources.some(
          (source) =>
            source.codex_home === runtimeCodexHome ||
            source.codex_home === expectedRuntimeCodexHome,
        ),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects current-workspace forged madmax publication evidence instead of silently omitting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-forged-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, '.omxbox-runs');
    const foreignRunsRoot = join(cwd, 'foreign-runs');
    const runDir = join(runsRoot, 'run-forged');
    const previousRunsDir = process.env.OMX_RUNS_DIR;
    try {
      const authority = await writeCommittedMadmaxPublication(cwd, runDir);
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
        () => discoverProjectRuntimeCodexHomes(cwd),
        (error: unknown) => error instanceof StateAuthorityError
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      );
      const result = runOmx(
        cwd,
        ['session', 'search', 'forged madmax evidence', '--json'],
        {
          ...authorityTransport(authority),
          HOME: home,
          CODEX_HOME: '',
          OMX_RUNS_DIR: foreignRunsRoot,
        },
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /current workspace madmax metadata has an incomplete or malformed committed authority publication/);
    } finally {
      if (typeof previousRunsDir === 'string') process.env.OMX_RUNS_DIR = previousRunsDir;
      else delete process.env.OMX_RUNS_DIR;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('derives active committed madmax history when OMX_RUNS_DIR is absent or foreign', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-authoritative-'));
    const runsRoot = join(cwd, 'runs');
    const foreignRunsRoot = join(cwd, 'foreign-runs');
    const runDir = join(runsRoot, 'run-associated');
    const codexHome = join(runDir, '.omx', 'runtime', 'codex-home', 'omx-madmax-runtime');
    const previousRunsDir = process.env.OMX_RUNS_DIR;
    try {
      await writeRollout(
        codexHome,
        '2026-03-11T12:00:00.000Z',
        'rollout-authoritative.jsonl',
        [{
          type: 'session_meta',
          payload: { id: 'authoritative-madmax-session', cwd },
        }],
      );
      const authority = await writeCommittedMadmaxPublication(cwd, runDir);
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: authority.workspace_identity.canonical_path, run_dir: runDir })}\n`,
      );

      const canonicalCodexHome = await realpath(codexHome);
      delete process.env.OMX_RUNS_DIR;
      const withoutAmbientRoot = await discoverProjectRuntimeCodexHomes(cwd);
      assert.ok(withoutAmbientRoot.some((home) => home.path === canonicalCodexHome));

      await mkdir(foreignRunsRoot, { recursive: true });
      process.env.OMX_RUNS_DIR = foreignRunsRoot;
      const withForeignAmbientRoot = await discoverProjectRuntimeCodexHomes(cwd);
      assert.ok(withForeignAmbientRoot.some((home) => home.path === canonicalCodexHome));
    } finally {
      if (typeof previousRunsDir === 'string') process.env.OMX_RUNS_DIR = previousRunsDir;
      else delete process.env.OMX_RUNS_DIR;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects malformed registry evidence for the active committed madmax run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-malformed-registry-'));
    const runsRoot = join(cwd, 'runs');
    const runDir = join(runsRoot, 'run-associated');
    const previousRunsDir = process.env.OMX_RUNS_DIR;
    try {
      const authority = await writeCommittedMadmaxPublication(cwd, runDir);
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: authority.workspace_identity.canonical_path, run_dir: 42 })}\n`,
      );
      delete process.env.OMX_RUNS_DIR;

      await assert.rejects(
        () => discoverProjectRuntimeCodexHomes(cwd),
        (error: unknown) => error instanceof StateAuthorityError
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      );
    } finally {
      if (typeof previousRunsDir === 'string') process.env.OMX_RUNS_DIR = previousRunsDir;
      else delete process.env.OMX_RUNS_DIR;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns no madmax runtime history when the workspace has no authority anchor or runs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-clean-'));
    try {
      assert.deepEqual(await discoverProjectRuntimeCodexHomes(cwd), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches a committed madmax publication while ignoring unrelated candidates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-committed-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const associatedRun = join(runsRoot, 'run-associated');
    const unrelatedRun = join(runsRoot, 'run-unrelated');
    const associatedCodexHome = join(associatedRun, '.omx', 'runtime', 'codex-home', 'omx-madmax-a');
    const unrelatedCodexHome = join(unrelatedRun, '.omx', 'runtime', 'codex-home', 'omx-madmax-b');
    const unrelatedSource = join(cwd, 'unrelated-source');
    try {
      await mkdir(unrelatedSource, { recursive: true });
      await writeRollout(
        associatedCodexHome,
        '2026-03-11T12:00:00.000Z',
        'rollout-associated.jsonl',
        [
          {
            type: 'session_meta',
            payload: { id: 'madmax-session', timestamp: '2026-03-11T12:00:00.000Z', cwd },
          },
          {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'associated madmax committed search target' },
          },
        ],
      );
      await writeRollout(
        unrelatedCodexHome,
        '2026-03-11T12:00:00.000Z',
        'rollout-unrelated.jsonl',
        [
          {
            type: 'session_meta',
            payload: { id: 'unrelated-session', timestamp: '2026-03-11T12:00:00.000Z', cwd: unrelatedSource },
          },
          {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'unrelated madmax committed search target' },
          },
        ],
      );
      const authority = await writeCommittedMadmaxPublication(cwd, associatedRun);
      await writeFile(join(unrelatedRun, '.omxbox-run.json'), JSON.stringify({
        source_cwd: unrelatedSource,
        run_dir: unrelatedRun,
      }));
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: cwd, run_dir: associatedRun })}\n${JSON.stringify({ source_cwd: unrelatedSource, run_dir: unrelatedRun })}\n`,
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'madmax committed search target', '--json'],
        {
          ...authorityTransport(authority),
          HOME: home,
          CODEX_HOME: '',
          OMX_RUNS_DIR: runsRoot,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string }>;
        sources: Array<{ codex_home: string }>;
      };
      assert.deepEqual(parsed.results.map((entry) => entry.session_id), ['madmax-session']);
      assert.ok(parsed.sources.some((source) => source.codex_home.startsWith('madmax:')));
      assert.equal(parsed.results.some((entry) => entry.session_id === 'unrelated-session'), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects prefix-adjacent madmax run candidates with Windows-safe containment', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-prefix-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const escapedRun = join(cwd, 'runs-escape', 'run-outside');
    try {
      await Promise.all([
        mkdir(runsRoot, { recursive: true }),
        mkdir(escapedRun, { recursive: true }),
      ]);
      const authority = await initializeStateAuthority({
        startup_cwd: cwd,
        observed_cwd: cwd,
        launch_id: 'session-search-prefix-adjacent',
        session_binding: { canonical_session_id: 'session-search-prefix-adjacent' },
      });
      await mintStateAuthorityTransportCapability(authority);
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: cwd, run_dir: escapedRun })}\n`,
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'prefix adjacent madmax candidate', '--json'],
        {
          ...authorityTransport(authority),
          HOME: home,
          CODEX_HOME: '',
          OMX_RUNS_DIR: runsRoot,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual((JSON.parse(result.stdout) as { results: unknown[] }).results, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects symlinked madmax run candidates', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-symlink-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const escapedRun = join(cwd, 'runs-escape', 'run-outside');
    const linkedRun = join(runsRoot, 'run-linked');
    try {
      await Promise.all([
        mkdir(runsRoot, { recursive: true }),
        mkdir(escapedRun, { recursive: true }),
      ]);
      const authority = await initializeStateAuthority({
        startup_cwd: cwd,
        observed_cwd: cwd,
        launch_id: 'session-search-symlinked',
        session_binding: { canonical_session_id: 'session-search-symlinked' },
      });
      await mintStateAuthorityTransportCapability(authority);
      try {
        await symlink(escapedRun, linkedRun, 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'EPERM'
          || code === 'EACCES'
          || code === 'ENOSYS'
          || code === 'ENOTSUP'
        ) {
          t.skip(`directory symlinks are unavailable on this host (${code})`);
          return;
        }
        throw error;
      }
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: cwd, run_dir: linkedRun })}\n`,
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'symlinked madmax candidate', '--json'],
        {
          ...authorityTransport(authority),
          HOME: home,
          CODEX_HOME: '',
          OMX_RUNS_DIR: runsRoot,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual((JSON.parse(result.stdout) as { results: unknown[] }).results, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches only the explicit --codex-home path', async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'omx-session-search-cli-codex-home-'),
    );
    const home = join(cwd, 'home');
    const explicitCodexHome = join(cwd, 'explicit-codex-home');
    try {
      await writeRollout(
        join(home, '.codex'),
        '2026-03-10T12:00:00.000Z',
        'rollout-default.jsonl',
        [
          {
            type: 'session_meta',
            payload: {
              id: 'default-session',
              timestamp: '2026-03-10T12:00:00.000Z',
              cwd,
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'explicit codex home target default',
            },
          },
        ],
      );
      await writeRollout(
        explicitCodexHome,
        '2026-03-11T12:00:00.000Z',
        'rollout-explicit.jsonl',
        [
          {
            type: 'session_meta',
            payload: {
              id: 'explicit-session',
              timestamp: '2026-03-11T12:00:00.000Z',
              cwd,
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'explicit codex home target chosen',
            },
          },
        ],
      );

      const result = runOmx(
        cwd,
        [
          'session',
          'search',
          'explicit codex home target',
          '--codex-home',
          explicitCodexHome,
          '--json',
        ],
        {
        HOME: home,
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string }>;
      };
      assert.deepEqual(
        parsed.results.map((entry) => entry.session_id),
        ['explicit-session'],
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('omx session friction', () => {
  it('prints public-safe JSON for local session friction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-friction-cli-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(
        codexHomeDir,
        '2026-06-24T09:00:00.000Z',
        'rollout-cli-friction.jsonl',
        [
        {
          type: 'session_meta',
          timestamp: '2026-06-24T09:00:00.000Z',
            payload: {
              id: 'cli-friction',
              timestamp: '2026-06-24T09:00:00.000Z',
              cwd,
            },
        },
        {
          type: 'event_msg',
          timestamp: '2026-06-24T09:01:00.000Z',
            payload: {
              type: 'user_message',
              message: 'do not leak this raw user text',
            },
        },
        {
          type: 'response_item',
          timestamp: '2026-06-24T09:02:00.000Z',
            payload: {
              type: 'function_call',
              name: 'bash',
              arguments: '{"command":"echo secret"}',
        },
          },
        ],
      );

      const result = runOmx(
        cwd,
        ['session', 'friction', '--codex-home', codexHomeDir, '--json'],
        {
        CODEX_HOME: codexHomeDir,
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        privacy: { mode: string; excludes: string[] };
        sessions: Array<{
          session_id: string;
          counters: { tool_calls: number };
          source: { codex_home: string; transcript_ref: string };
        }>;
      };
      assert.equal(parsed.privacy.mode, 'metadata-only');
      assert.equal(parsed.sessions[0].session_id, 'cli-friction');
      assert.equal(parsed.sessions[0].counters.tool_calls, 1);
      assert.equal(parsed.sessions[0].source.codex_home, 'explicit-codex-home');
      assert.match(parsed.sessions[0].source.transcript_ref, /^[a-f0-9]{12}$/);
      assert.doesNotMatch(result.stdout, /do not leak/);
      assert.doesNotMatch(result.stdout, /echo secret/);
      assert.doesNotMatch(
        result.stdout,
        new RegExp(codexHomeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.doesNotMatch(result.stdout, /sessions\//);
      assert.doesNotMatch(result.stdout, /rollout-cli-friction/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
