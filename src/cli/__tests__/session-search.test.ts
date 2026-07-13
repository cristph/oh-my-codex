import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSessionFrictionArgs,
  parseSessionSearchArgs,
} from '../session-search.js';

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
  envOverrides: Record<string, string> = {},
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

  it('rejects bare and forged-operation madmax records until a committed authority publication validates them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const associatedCodexHome = join(
      runsRoot,
      'run-associated',
      '.omx',
      'runtime',
      'codex-home',
      'omx-madmax-a',
    );
    const unrelatedCodexHome = join(
      runsRoot,
      'run-unrelated',
      '.omx',
      'runtime',
      'codex-home',
      'omx-madmax-b',
    );
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
            payload: {
              id: 'madmax-session',
              timestamp: '2026-03-11T12:00:00.000Z',
              cwd,
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'associated madmax boxed search target',
            },
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
            payload: {
              id: 'unrelated-session',
              timestamp: '2026-03-11T12:00:00.000Z',
              cwd: unrelatedSource,
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'associated madmax boxed search target unrelated',
            },
          },
        ],
      );
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: cwd, run_dir: join(runsRoot, 'run-associated') })}\n${JSON.stringify({ source_cwd: unrelatedSource, run_dir: join(runsRoot, 'run-unrelated') })}\n`,
      );
      await writeFile(
        join(runsRoot, 'run-associated', '.omxbox-run.json'),
        JSON.stringify({
          launcher: 'omx --madmax',
          cwd: join(runsRoot, 'run-associated'),
          source_cwd: cwd,
          run_dir: join(runsRoot, 'run-associated'),
          argv: ['--madmax'],
          transport_status: 'committed',
          authority_protocol_version: 1,
          authority_operation_id: 'forged-launch-transport-operation',
          authority_id: 'forged-authority',
          authority_generation_id: 'forged-generation',
          authority_binding_id: 'forged-binding',
          authority_binding_revision: 1,
          authority_workspace_digest: 'forged-workspace',
          authority_anchor_revision: 1,
          authority_fencing_token: 1,
          authority_state_root: join(
            runsRoot,
            'run-associated',
            '.omx',
            'state',
          ),
          authority_root_identity: {
            schema_version: 1,
            platform: process.platform,
            canonical_path: join(runsRoot, 'run-associated', '.omx', 'state'),
            device: '1',
            inode: '1',
            mode: '700',
            birthtime_ns: '1',
            strong_identity: false,
          },
          authority_effects_digest: '0'.repeat(64),
        }),
      );

      const result = runOmx(
        cwd,
        [
          'session',
          'search',
          'associated madmax boxed search target',
          '--json',
        ],
        {
        HOME: home,
        CODEX_HOME: '',
        OMX_RUNS_DIR: runsRoot,
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string; transcript_path: string }>;
        sources: Array<{ codex_home: string }>;
      };
      assert.deepEqual(parsed.results, []);
      assert.equal(
        parsed.sources.some((source) =>
          source.codex_home.startsWith('madmax:'),
        ),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects symlinked and prefix-adjacent madmax run candidates with Windows-safe containment', async (t) => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'omx-session-search-madmax-escape-'),
    );
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const escapedRun = join(cwd, 'runs-escape', 'run-outside');
    const linkedRun = join(runsRoot, 'run-linked');
    try {
      await writeRollout(
        join(escapedRun, '.omx', 'runtime', 'codex-home', 'omx-escaped'),
        '2026-03-11T12:00:00.000Z',
        'rollout-escaped.jsonl',
        [
          {
            type: 'session_meta',
            payload: {
              id: 'escaped-session',
              timestamp: '2026-03-11T12:00:00.000Z',
              cwd,
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'symlink escaped madmax candidate',
            },
          },
        ],
      );
      await mkdir(runsRoot, { recursive: true });
      try {
        await symlink(escapedRun, linkedRun, 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'EPERM' ||
          code === 'EACCES' ||
          code === 'ENOSYS' ||
          code === 'ENOTSUP'
        ) {
          t.skip(`directory symlinks are unavailable on this host (${code})`);
          return;
        }
        throw error;
      }
      await writeFile(
        join(runsRoot, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: cwd, run_dir: linkedRun })}\n${JSON.stringify({ source_cwd: cwd, run_dir: escapedRun })}\n`,
      );

      const result = runOmx(
        cwd,
        ['session', 'search', 'symlink escaped madmax candidate', '--json'],
        {
          HOME: home,
          CODEX_HOME: '',
          OMX_RUNS_DIR: runsRoot,
          OMX_ROOT: '',
          OMX_STATE_ROOT: '',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string }>;
      };
      assert.deepEqual(parsed.results, []);
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
