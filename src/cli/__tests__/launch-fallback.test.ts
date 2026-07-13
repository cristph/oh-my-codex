import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD_TMUX_HEIGHT_LINES } from '../../hud/constants.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import {
  canonicalizeExistingAuthorityPath,
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
} from '../../state/authority.js';
import { DETACHED_TMUX_HISTORY_LIMIT } from '../index.js';

const CLI_SPAWN_TIMEOUT_MS = 60_000;

function buildRunOmxEnv(envOverrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('OMX_') ||
      key.startsWith('CODEX_') ||
      key === 'TMUX' ||
      key === 'TMUX_PANE' ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_TEST_CONTEXT'
    ) {
      delete env[key];
    }
  }
  const pathOverride = envOverrides.PATH;
  const overrides = { ...envOverrides };
  delete overrides.PATH;
  if (pathOverride !== undefined) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
  }
  return {
    ...env,
    ...overrides,
    ...(pathOverride === undefined
      ? {}
      : { [process.platform === 'win32' ? 'Path' : 'PATH']: pathOverride }),
  };
}

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    timeout: CLI_SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: buildRunOmxEnv(envOverrides),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function normalizeDarwinTmpPath(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function canonicalTestPath(path: string): string {
  return canonicalizeExistingAuthorityPath(path);
}


function platformTestPath(fakeBin: string): string {
  const inheritedPath = process.platform === 'win32'
    ? process.env.Path ?? process.env.PATH
    : process.env.PATH ?? process.env.Path;
  return [fakeBin, inheritedPath]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .join(delimiter);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


async function authenticatedLaunchTransport(
  cwd: string,
  launchId: string,
): Promise<{ env: Record<string, string>; capability: string }> {
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: launchId,
    session_binding: { canonical_session_id: `${launchId}-session` },
  });
  await mintStateAuthorityTransportCapability(authority);
  const env = buildStateAuthorityTransportEnv(authority, {});
  const capability = env.OMX_STATE_AUTHORITY_CAPABILITY;
  if (!capability) throw new Error('expected authenticated state-authority capability');
  return { env: env as Record<string, string>, capability };
}



async function createGitRepo(wd: string): Promise<string> {
  const repo = join(wd, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
  if (process.platform === 'win32' && !basename(path).includes('.')) {
    await writeFile(`${path}.cmd`, `@echo off\r\nsh "%~dp0${basename(path)}" %*\r\n`);
    if (basename(path) === 'codex') {
      const nodeHostedPath = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(dirname(nodeHostedPath), { recursive: true });
      await writeFile(
        nodeHostedPath,
        [
          "const { spawnSync } = require('node:child_process');",
          `const script = ${JSON.stringify(path)};`,
          "const result = spawnSync('sh', [script, ...process.argv.slice(2)], { env: process.env, stdio: 'inherit' });",
          'if (result.error) throw result.error;',
          'process.exit(result.status ?? 1);',
          '',
        ].join('\n'),
      );
    }
  }
}

async function createLaunchFixture(
  wd: string,
  tmuxScript: (tmuxLogPath: string) => string,
): Promise<{ env: Record<string, string>; tmuxLogPath: string }> {
  const home = join(wd, 'home');
  const fakeBin = join(wd, 'bin');
  const tmuxLogPath = join(wd, 'tmux.log');

  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExecutable(
    join(fakeBin, 'codex'),
    '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
  );
  await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(join(fakeBin, 'tmux'), tmuxScript(tmuxLogPath));

  return {
    tmuxLogPath,
    env: {
      HOME: home,
      PATH: platformTestPath(fakeBin),
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: '',
      OMX_STATE_ROOT: '',
    },
  };
}

describe('omx launch fallback when tmux is unavailable', () => {
  it('surfaces direct Codex startup stderr and preserves the child exit code', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-child-error-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'codex-startup-boom\\n' >&2
exit 42
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(wd, ['--direct', '--version'], {
        HOME: home,
        PATH: platformTestPath(fakeBin),
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        TMUX: '',
        TMUX_PANE: '',
      });


      assert.equal(result.status, 42, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /codex-startup-boom/);
      assert.match(result.stderr, /\[omx\] codex exited with code 42/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports a missing Codex executable instead of exiting silently', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-missing-codex-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(wd, ['--direct', '--version'], {
        HOME: home,
        PATH: fakeBin,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        TMUX: '',
        TMUX_PANE: '',
      });


      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /failed to launch codex: executable not found in PATH/);
      assert.notEqual(result.stderr.trim(), '');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches codex directly without tmux ENOENT noise', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-fallback-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      if (process.platform === 'win32') {
        await writeExecutable(fakeCodexPath, await readFile(fakeCodexPath, 'utf-8'));
        await writeExecutable(fakePsPath, await readFile(fakePsPath, 'utf-8'));
      }

      const result = runOmx(
        wd,
        ['--xhigh', '--madmax'],
        {
          HOME: home,
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
        },
      );


      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stdout, /fake-codex:.*model_reasoning_effort="xhigh"/);
      assert.doesNotMatch(result.stderr, /spawnSync tmux ENOENT/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omx --worktree disposable state root', () => {
  it('establishes a worktree-local committed authority before launching Codex', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-worktree-state-'));
    try {
      const repo = await createGitRepo(wd);
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex-authority-path:%s\n' "$OMX_STATE_AUTHORITY_PATH"
printf 'fake-codex-workspace:%s\n' "$OMX_STATE_AUTHORITY_WORKSPACE_DIGEST"
printf 'fake-codex:%s\n' "$*"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--worktree', '--version'], {
        HOME: home,
        PATH: platformTestPath(fakeBin),
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });


      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const normalizedStdout = result.stdout;
      assert.match(
        normalizedStdout,
        new RegExp(`fake-codex-omx-root:${escapeRegExp(canonicalTestPath(worktreePath))}`),
      );
      const authorityPath = normalizedStdout.match(/fake-codex-authority-path:(.*)/)?.[1] ?? '';
      const workspaceDigest = normalizedStdout.match(/fake-codex-workspace:(.*)/)?.[1] ?? '';
      const childAuthority = JSON.parse(await readFile(authorityPath, 'utf-8')) as {
        canonical_state_root: string;
        workspace_identity: { canonical_path: string; digest: string };
      };
      assert.equal(
        canonicalTestPath(childAuthority.canonical_state_root),
        join(canonicalTestPath(worktreePath), '.omx', 'state'),
      );
      assert.equal(
        canonicalTestPath(childAuthority.workspace_identity.canonical_path),
        canonicalTestPath(worktreePath),
      );
      assert.equal(childAuthority.workspace_identity.digest, workspaceDigest);
      assert.equal(existsSync(join(worktreePath, '.omx', 'state')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when ambient OMX_ROOT conflicts with committed launch authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-worktree-explicit-root-'));
    try {
      const repo = await createGitRepo(wd);
      const explicitRoot = join(wd, 'explicit-root');
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex:%s\n' "$*"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--worktree', '--version'], {
        HOME: home,
        PATH: platformTestPath(fakeBin),
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: explicitRoot,
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });


      assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /OMX_ROOT conflicts with the authenticated state authority/i);
      assert.doesNotMatch(result.stdout, /fake-codex/);
      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.equal(existsSync(join(repo, '.omx', 'state')), false);
      assert.equal(existsSync(join(worktreePath, '.omx', 'state')), true);
      assert.equal(existsSync(explicitRoot), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps direct madmax worktree launches bound to the boxed run root', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-worktree-root-'));
    try {
      const repo = await createGitRepo(wd);
      const runs = join(wd, 'runs');
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-pwd:%s\n' "$PWD"
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex-box:%s\n' "$OMXBOX_ACTIVE"
printf 'fake-codex-source:%s\n' "$OMX_SOURCE_CWD"
printf 'fake-codex-context:%s\n' "$OMX_MADMAX_DETACHED_CONTEXT"
printf 'fake-codex-authority-path:%s\n' "$OMX_STATE_AUTHORITY_PATH"
printf 'fake-codex-authority-id:%s\n' "$OMX_STATE_AUTHORITY_ID"
printf 'fake-codex-authority-generation:%s\n' "$OMX_STATE_AUTHORITY_GENERATION_ID"
printf 'fake-codex:%s\n' "$*"
`,

      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--madmax', '--worktree', '--version'], {
        HOME: home,
        PATH: platformTestPath(fakeBin),
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_RUNS_DIR: runs,
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });


      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      const normalizedStdout = result.stdout;
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(
        normalizedStdout,
        new RegExp(`fake-codex-pwd:${escapeRegExp(canonicalTestPath(worktreePath))}`),
      );
      const rootMatch = normalizedStdout.match(/fake-codex-omx-root:(.*)/);
      assert.ok(rootMatch, normalizedStdout);
      const boxedRoot = rootMatch[1];
      assert.match(boxedRoot, new RegExp(`^${escapeRegExp(canonicalTestPath(runs))}/run-`));
      assert.notEqual(boxedRoot, canonicalTestPath(repo));
      assert.notEqual(boxedRoot, canonicalTestPath(worktreePath));
      assert.match(normalizedStdout, /fake-codex-box:1/);
      assert.match(
        normalizedStdout,
        new RegExp(`fake-codex-source:${escapeRegExp(canonicalTestPath(repo))}`),
      );
      assert.match(normalizedStdout, /fake-codex-context:[0-9a-f]{32}/);
      const authorityPath = normalizedStdout.match(/fake-codex-authority-path:(.*)/)?.[1] ?? '';
      const authorityId = normalizedStdout.match(/fake-codex-authority-id:(.*)/)?.[1] ?? '';
      const authorityGenerationId = normalizedStdout.match(/fake-codex-authority-generation:(.*)/)?.[1] ?? '';
      assert.match(authorityPath, new RegExp(`^${escapeRegExp(boxedRoot)}/\\.omx/state/authority/generations/`));
      const childAuthority = JSON.parse(await readFile(authorityPath, 'utf-8')) as {
        authority_id: string;
        generation_id: string;
        canonical_state_root: string;
        workspace_identity: { canonical_path: string };
      };
      assert.equal(childAuthority.authority_id, authorityId);
      assert.equal(childAuthority.generation_id, authorityGenerationId);
      assert.equal(canonicalTestPath(childAuthority.canonical_state_root), join(boxedRoot, '.omx', 'state'));
      assert.equal(
        canonicalTestPath(childAuthority.workspace_identity.canonical_path),
        canonicalTestPath(worktreePath),
      );

      const metadata = JSON.parse(await readFile(join(boxedRoot, '.omxbox-run.json'), 'utf-8')) as {
        authority_id?: string;
        authority_generation_id?: string;
        authority_state_root?: string;
      };
      assert.equal(metadata.authority_id, childAuthority.authority_id);
      assert.equal(metadata.authority_generation_id, childAuthority.generation_id);
      assert.equal(canonicalTestPath(metadata.authority_state_root ?? ''), canonicalTestPath(childAuthority.canonical_state_root));
      const registry = await readFile(join(runs, 'registry.jsonl'), 'utf-8');
      assert.match(registry, new RegExp(`"authority_generation_id":"${escapeRegExp(childAuthority.generation_id)}"`));
      assert.doesNotMatch(registry, /OMX_STATE_AUTHORITY_CAPABILITY/);
      const launchJournals = await Promise.all(
        (await readdir(join(dirname(authorityPath), 'journals')))
          .filter((entry) => entry.endsWith('.json'))
          .map(async (entry) => JSON.parse(await readFile(join(dirname(authorityPath), 'journals', entry), 'utf-8')) as {
            kind?: string;
            status?: string;
          }),
      );
      assert.ok(launchJournals.some((journal) => journal.kind === 'launch_transport_publish' && journal.status === 'committed'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('Hermes MCP tmux bridge launch', () => {
  it('creates a detached tmux session without attach-session under OMX_HERMES_MCP_BRIDGE', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-hermes-bridge-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V|list-sessions)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane)
    exit 0
    ;;
  attach-session)
    printf 'attach must not be called for Hermes MCP bridge\n' >&2
    exit 99
    ;;
esac
exit 0
`,
      );

      const result = runOmx(wd, ['--tmux', 'bridge prompt'], {
        ...env,
        OMX_HERMES_MCP_BRIDGE: '1',
        TMUX: '',
        TMUX_PANE: '',
      });


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(tmuxLog, /tmux:new-session /);
      assert.match(tmuxLog, /tmux:split-window /);
      assert.doesNotMatch(tmuxLog, /tmux:attach-session/);
      assert.doesNotMatch(result.stderr, /failed to attach detached tmux session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omx launcher when tmux is available', () => {
  it('rejects a detached madmax record unless it matches the current committed authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-reuse-'));
    try {
      const runs = join(wd, 'runs');
      const activeMarker = join(wd, 'active-session');
      const instanceMarker = join(wd, 'active-instance');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    test -f "${activeMarker}"
    exit $?
    ;;
  new-session)
    prev=''
    for arg in "$@"; do
      if [ "$prev" = '-s' ]; then printf '%s\n' "$arg" > "${activeMarker}"; fi
      prev="$arg"
    done
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      cat "${activeMarker}"
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_attached}' ]; then
      printf '1\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ]; then
      cat "${instanceMarker}"
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option)
    if [ "$4" = '@omx_instance_id' ]; then
      printf '%s\n' "$5" > "${instanceMarker}"
    fi
    exit 0
    ;;
  set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMXBOX_ACTIVE: '1',
        OMX_MADMAX_DETACHED_CONTEXT: 'boxed-context-under-test',
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };
      const first = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);

      const second = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      assert.doesNotMatch(second.stderr, /madmax detached launch already active for this context/);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
      assert.equal((tmuxLog.match(/tmux:has-session/g) || []).length, 0);
      assert.equal((tmuxLog.match(/tmux:attach-session/g) || []).length, 2);
      const forgedRecordPath = join(runs, 'active-detached', 'boxed-context-under-test.json');
      assert.equal(existsSync(forgedRecordPath), false);
      const activeRecordDirectory = join(runs, 'active-detached');
      const activeRecordNames = (await readdir(activeRecordDirectory))
        .filter((entry) => entry.endsWith('.json'));
      assert.equal(activeRecordNames.length, 2);
      for (const activeRecordName of activeRecordNames) {
        const activeRecord = await readFile(join(activeRecordDirectory, activeRecordName), 'utf-8');
        assert.match(activeRecord, /"authority_protocol_version": 1/);
        assert.match(activeRecord, /"authority_generation_id"/);
        assert.match(activeRecord, /"authority_binding_id"/);
        assert.match(activeRecord, /"authority_fencing_token"/);
        assert.match(activeRecord, /"authority_root_identity"/);
        assert.match(activeRecord, /"tmux_pane_id": "%12"/);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('records boxed runtime identity for detached madmax worktree launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-worktree-detached-'));
    try {
      const repo = await createGitRepo(wd);
      const runs = join(wd, 'runs');
      const instanceMarker = join(wd, 'active-instance');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    printf '%%77\n'
    exit 0
    ;;
  source-file)
    while IFS= read -r line; do
      case "$line" in
        *OMX_TMUX_IMPORT_*_MANIFEST*) printf 'tmux:manifest:%s\n' "$line" >> "${logPath}" ;;
      esac
    done
    exit 0
    ;;
  split-window)
    printf '%%78\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      printf 'detached-session\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_attached}' ]; then
      printf '1\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ] && [ -f "${instanceMarker}" ]; then
      cat "${instanceMarker}"
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option)
    if [ "$4" = '@omx_instance_id' ]; then
      printf '%s\n' "$5" > "${instanceMarker}"
    fi
    exit 0
    ;;
  set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(repo, ['--madmax', '--worktree', '--tmux'], {
        ...env,
        OMX_RUNS_DIR: runs,
        TMUX: '',
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);

      const activeFiles = await readdir(join(runs, 'active-detached'));
      assert.equal(activeFiles.length, 1);
      const activeRecord = JSON.parse(await readFile(join(runs, 'active-detached', activeFiles[0]), 'utf-8'));
      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.match(activeRecord.run_dir, new RegExp(`^${escapeRegExp(canonicalTestPath(runs))}/run-`));
      assert.equal(canonicalTestPath(activeRecord.source_cwd), canonicalTestPath(repo));
      assert.equal(canonicalTestPath(activeRecord.worktree_cwd), canonicalTestPath(worktreePath));
      assert.equal(activeRecord.session_id.startsWith('omx-'), true);
      assert.equal(activeRecord.tmux_pane_id, '%77');
      assert.equal(activeRecord.authority_protocol_version, 1);
      assert.equal(typeof activeRecord.authority_generation_id, 'string');
      assert.equal(typeof activeRecord.authority_binding_id, 'string');
      assert.equal(typeof activeRecord.authority_fencing_token, 'number');
      assert.equal(typeof activeRecord.authority_root_identity?.canonical_path, 'string');

      const tmuxLog = normalizeDarwinTmpPath(await readFile(tmuxLogPath, 'utf-8'));
      const newSessionCommand = tmuxLog
        .split('\n')
        .find((line) => line.startsWith('tmux:new-session '));
      const manifestCommand = tmuxLog
        .split('\n')
        .find((line) => line.startsWith('tmux:manifest:'));
      assert.ok(newSessionCommand);
      assert.ok(manifestCommand);
      assert.match(manifestCommand, /OMX_ROOT/);
      assert.match(manifestCommand, /OMXBOX_ACTIVE/);
      assert.match(manifestCommand, /OMX_SOURCE_CWD/);
      assert.match(manifestCommand, /OMX_MADMAX_DETACHED_CONTEXT/);
      assert.match(manifestCommand, /OMX_STATE_AUTHORITY_CAPABILITY/);
      assert.match(tmuxLog, /tmux:source-file -/);
      assert.doesNotMatch(newSessionCommand, /OMX_ROOT|OMXBOX_ACTIVE|OMX_SOURCE_CWD|OMX_MADMAX_DETACHED_CONTEXT|OMX_STATE_AUTHORITY_CAPABILITY/);
      assert.doesNotMatch(tmuxLog, /(?:^|\s)OMX_STATE_AUTHORITY_CAPABILITY=[A-Za-z0-9]/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not mutate a stale active-detached tmux session without OMX ownership proof', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-stale-active-'));
    try {
      const runs = join(wd, 'runs');
      const activeDir = join(runs, 'active-detached');
      await mkdir(activeDir, { recursive: true });
      await writeFile(
        join(activeDir, 'boxed-context-under-test.json'),
        `${JSON.stringify({
          version: 1,
          context_key: 'boxed-context-under-test',
          created_at: new Date().toISOString(),
          source_cwd: wd,
          argv: ['--madmax', '--tmux'],
          run_dir: wd,
          tmux_session_name: 'user-owned-session',
          session_id: 'expected-omx-session-id',
          tmux_pane_id: '%99',
        })}\n`,
      );
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      printf 'user-owned-session\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ]; then
      printf 'different-session-id\n'
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(wd, ['--madmax', '--tmux'], {
        ...env,
        OMX_RUNS_DIR: runs,
        OMXBOX_ACTIVE: '1',
        OMX_MADMAX_DETACHED_CONTEXT: 'boxed-context-under-test',
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /tmux:set-option .* -t user-owned-session .*history-limit/);
      assert.doesNotMatch(tmuxLog, /tmux:clear-history .*user-owned-session|tmux:clear-history .*%99/);
      assert.match(tmuxLog, /tmux:new-session /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not let cancel mutate a bare madmax registry candidate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-cancel-denial-'));
    try {
      const runs = join(wd, 'runs');
      const runDir = join(runs, 'run-forged');
      const statePath = join(runDir, '.omx', 'state', 'ralph-state.json');
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ active: true, current_phase: 'running' }));
      await writeFile(
        join(runs, 'registry.jsonl'),
        `${JSON.stringify({ source_cwd: wd, run_dir: runDir })}\n`,
      );

      const result = runOmx(wd, ['cancel'], {
        OMX_RUNS_DIR: runs,
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /cancel requires a committed authenticated state authority/i);
      const stored = JSON.parse(await readFile(statePath, 'utf-8')) as { active?: unknown };
      assert.equal(stored.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not reuse the same active-detached lock for independent --madmax --high launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-independent-high-'));
    try {
      const runs = join(wd, 'runs');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) printf '%%12\n'; exit 0 ;;
  split-window) printf 'hud-pane\n'; exit 0 ;;
  display-message) if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then printf '/tmp/tmux-test.sock\n'; else printf '0\n'; fi; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
esac
exit 0
`,
      );
      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };

      const first = runOmx(wd, ['--madmax', '--high', '--tmux'], baseEnv);
      const second = runOmx(wd, ['--madmax', '--high', '--tmux'], baseEnv);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      assert.doesNotMatch(first.stderr + second.stderr, /timed out waiting for madmax detached launch context lock/);
      assert.doesNotMatch(second.stderr, /madmax detached launch already active for this context/);

      const registryEntries = (await readFile(join(runs, 'registry.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { detached_launch_context: string });
      assert.equal(registryEntries.length, 2);
      assert.notEqual(
        registryEntries[0]!.detached_launch_context,
        registryEntries[1]!.detached_launch_context,
        'independent launches must get distinct active-detached lock identities',
      );
      assert.equal(
        existsSync(join(runs, 'active-detached', `${registryEntries[0]!.detached_launch_context}.json`)),
        true,
      );
      assert.equal(
        existsSync(join(runs, 'active-detached', `${registryEntries[1]!.detached_launch_context}.json`)),
        true,
      );

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows distinct madmax detached launch contexts to create separate sessions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-distinct-'));
    try {
      const runs = join(wd, 'runs');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) printf '%%12\n'; exit 0 ;;
  split-window) printf 'hud-pane\n'; exit 0 ;;
  display-message) if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then printf '/tmp/tmux-test.sock\n'; else printf '0\n'; fi; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
esac
exit 0
`,
      );
      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };
      const first = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      const second = runOmx(wd, ['--madmax', '--xhigh', '--tmux'], baseEnv);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches --madmax through explicitly requested detached tmux so HUD bootstrap can run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      if (process.platform === 'win32') {
        await writeExecutable(fakeCodexPath, await readFile(fakeCodexPath, 'utf-8'));
        await writeExecutable(fakePsPath, await readFile(fakePsPath, 'utf-8'));
        await writeExecutable(fakeTmuxPath, await readFile(fakeTmuxPath, 'utf-8'));
      }

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_LAUNCH_POLICY: 'direct',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /tmux:show-options -gv history-limit/);
      assert.doesNotMatch(tmuxLog, /tmux:set-option -g[q ]+history-limit/);
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.match(tmuxLog, new RegExp(`tmux:set-option -q -t .* history-limit ${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(tmuxLog, new RegExp(`tmux:set-option -pq -t %12 history-limit ${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(
        tmuxLog,
        /tmux:set-hook -t .* client-detached\[[0-9]+\] if-shell -F '#\{==:#\{session_attached\},0\}' 'run-shell -b "tmux clear-history -t %12 >\/dev\/null 2>&1 \|\| true"'/,
      );
      assert.match(tmuxLog, new RegExp(`tmux:split-window -v -l ${HUD_TMUX_HEIGHT_LINES} .* -t `));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps detached tmux new-session bounded while importing provider and authority env without serializing raw values', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-parent-env-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const envLogPath = join(wd, 'codex-env.log');
      const tmuxLogPath = join(wd, 'tmux.log');
      const restoreMarkerPath = join(wd, 'tmux-environment-restored');
      const tmuxFixtureStatePath = join(wd, 'tmux-fixture-state.json');
      const tmuxFixtureProgramPath = join(fakeBin, 'tmux-fixture.cjs');
      const codexFixtureProgramPath = join(fakeBin, 'codex-fixture.cjs');
      const injectionCanaryPath = join(wd, 'provider-injection-canary');
      const providerSecret =
        `provider secret "quoted" \\ $HOME $(touch ${injectionCanaryPath}); literal-end`;
      const inheritedCiEnvironment = Object.fromEntries(
        Array.from({ length: 512 }, (_, index) => [
          `CI_OMX_BOUND_${index}`,
          `ci-value-${index}`,
        ]),
      );

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        codexFixtureProgramPath,
        `const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const capability = process.env.OMX_STATE_AUTHORITY_CAPABILITY || '';
const provider = process.env.CUSTOM_LLM_API_KEY || '';
const expectedProvider = process.env.OMX_TEST_EXPECTED_PROVIDER_SECRET || '';
if (!capability || provider !== expectedProvider || process.env.IS_GAJAE_SLOP_GENERATOR !== '1') process.exit(91);
const persisted = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(candidate);
    else if (entry.isFile()) persisted.push(fs.readFileSync(candidate));
  }
};
visit(${JSON.stringify(wd)});
if (persisted.some((value) => value.includes(capability) || value.includes(provider))) process.exit(92);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
fs.writeFileSync(${JSON.stringify(envLogPath)}, [
  'provider_digest=' + digest(provider),
  'authority_digest=' + digest(capability),
  'marker=1',
  'persisted_corpus_clean=1',
].join('\\n') + '\\n');
process.exit(130);`,
      );
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
exec "${process.execPath}" "${codexFixtureProgramPath}" "$@"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
      await writeFile(
        tmuxFixtureProgramPath,
        `const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const command = args[0] || '';
const statePath = ${JSON.stringify(tmuxFixtureStatePath)};
const logPath = ${JSON.stringify(tmuxLogPath)};
const restoreMarkerPath = ${JSON.stringify(restoreMarkerPath)};
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const parseLine = (line) => {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === ' ') index += 1;
    if (index >= line.length) break;
    if (line[index] === '"') {
      index += 1;
      let value = '';
      while (index < line.length && line[index] !== '"') {
        if (line[index] === '\\\\' && index + 1 < line.length) {
          value += line[index + 1];
          index += 2;
        } else {
          value += line[index];
          index += 1;
        }
      }
      if (line[index] !== '"') process.exit(99);
      index += 1;
      tokens.push(value);
    } else {
      const start = index;
      while (index < line.length && line[index] !== ' ') index += 1;
      tokens.push(line.slice(start, index));
    }
  }
  return tokens;
};
fs.appendFileSync(logPath, 'tmux:' + args.join(' ') + '\\n');
if (command === '-V') { console.log('tmux 3.2a'); process.exit(0); }
if (command === 'list-sessions') { console.log('existing-server-session'); process.exit(0); }
if (command === 'new-session') {
  if (args.includes('-e')) process.exit(97);
  const state = readState();
  state.startupCommand = args.at(-1) || '';
  writeState(state);
  console.log('%12');
  process.exit(0);
}
if (command === 'source-file') {
  const input = fs.readFileSync(0, 'utf8');
  const state = readState();
  const sourceValues = {};
  let restored = false;
  for (const line of input.split(/\\r?\\n/).filter(Boolean)) {
    const tokens = parseLine(line);
    if (tokens[0] !== 'set-environment') continue;
    const separator = tokens.indexOf('--');
    const name = separator >= 0 ? tokens[separator + 1] : '';
    const value = separator >= 0 ? tokens[separator + 2] : undefined;
    if (!name.startsWith('OMX_TMUX_IMPORT_')) continue;
    if (tokens.includes('-u') || tokens.includes('-r')) restored = true;
    else if (value !== undefined) sourceValues[name] = value;
  }
  if (Object.keys(sourceValues).length > 0 && !state.startupRan) {
    const childEnv = { ...process.env };
    const manifestEntry = Object.entries(sourceValues).find(([sourceName]) => sourceName.endsWith('_MANIFEST'));
    const manifestMatch = manifestEntry?.[1].match(/^v1:([0-9]+):(.*)$/);
    const targetNames = manifestMatch?.[2].split(',') ?? [];
    const sourcePrefix = manifestEntry?.[0].slice(0, -'_MANIFEST'.length) ?? '';
    if (!manifestMatch || Number(manifestMatch[1]) !== targetNames.length) process.exit(96);
    for (const [sourceName, value] of Object.entries(sourceValues)) {
      childEnv['OMX_TEST_TMUX_SOURCE_' + sourceName] = value;
      if (sourceName.endsWith('_MANIFEST')) continue;
      const sourceIndex = Number(sourceName.slice(sourcePrefix.length + 1));
      const targetName = targetNames[sourceIndex];
      if (!Number.isSafeInteger(sourceIndex) || !targetName) process.exit(96);
      if (targetName === 'CUSTOM_LLM_API_KEY' && value !== process.env.OMX_TEST_EXPECTED_PROVIDER_SECRET) process.exit(95);
    }
    const execution = spawnSync('sh', ['-c', state.startupCommand || ''], {
      cwd: ${JSON.stringify(wd)},
      env: childEnv,
      encoding: 'utf8',
    });
    if (execution.error || (execution.status !== 0 && execution.status !== 130)) process.exit(98);
    state.startupRan = true;
    writeState(state);
  }
  if (restored) fs.writeFileSync(restoreMarkerPath, 'restored');
  process.exit(0);
}
if (command === 'show-environment') {
  const requestedName = args.at(-1) || '';
  const value = process.env['OMX_TEST_TMUX_SOURCE_' + requestedName];
  if (value !== undefined) console.log(requestedName + '=' + value);
  else {
    console.log('CUSTOM_LLM_API_KEY=previous-provider-baseline');
    console.log('-OMX_STATE_AUTHORITY_CAPABILITY');
  }
  process.exit(0);
}
if (command === 'display-message') {
  console.log(args[1] === '-p' && args[2] === '#{socket_path}' ? '/tmp/tmux-test.sock' : '0');
  process.exit(0);
}
if (command === 'show-options') { console.log('off'); process.exit(0); }
if (command === 'split-window') { console.log('hud-pane'); process.exit(0); }
process.exit(0);
`,
      );
      await writeExecutable(
        join(fakeBin, 'tmux'),
        `#!/bin/sh
exec "${process.execPath}" "${tmuxFixtureProgramPath}" "$@"
`,
      );

      const result = runOmx(wd, ['--tmux', '--madmax'], {
        HOME: home,
        PATH: platformTestPath(fakeBin),
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        TMUX: '',
        TMUX_PANE: '',
        CUSTOM_LLM_API_KEY: providerSecret,
        OMX_TEST_EXPECTED_PROVIDER_SECRET: providerSecret,
        IS_GAJAE_SLOP_GENERATOR: '1',
        ...inheritedCiEnvironment,
      });

      const failureLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(
        result.status,
        0,
        [result.error, result.stderr, result.stdout, failureLog].filter(Boolean).join('\n'),
      );
      const childEvidence = await readFile(envLogPath, 'utf-8');
      assert.match(
        childEvidence,
        new RegExp(`^provider_digest=${createHash('sha256').update(providerSecret).digest('hex')}$`, 'm'),
      );
      assert.match(childEvidence, /^authority_digest=[0-9a-f]{64}$/m);
      assert.match(childEvidence, /^marker=1$/m);
      assert.match(childEvidence, /^persisted_corpus_clean=1$/m);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const tmuxScript = await readFile(join(fakeBin, 'tmux'), 'utf-8');
      const tmuxState = await readFile(tmuxFixtureStatePath, 'utf-8');
      assert.match(tmuxLog, /tmux:new-session /);
      const newSessionCommand = tmuxLog
        .split('\n')
        .find((line) => line.startsWith('tmux:new-session '));
      assert.ok(newSessionCommand);
      assert.ok(
        newSessionCommand.length < 15_000,
        `new-session command unexpectedly grew to ${newSessionCommand.length} bytes for ${Object.keys(inheritedCiEnvironment).length} inherited variables`,
      );
      assert.doesNotMatch(newSessionCommand, new RegExp(escapeRegExp(providerSecret)));
      assert.equal((tmuxLog.match(/tmux:source-file -/g) || []).length, 2);
      assert.ok(
        tmuxLog.indexOf('tmux:split-window ') < tmuxLog.lastIndexOf('tmux:source-file -'),
        'session environment must remain available until the HUD split has inherited it',
      );
      assert.match(tmuxLog, /tmux:wait-for -S /);
      assert.match(tmuxLog, /tmux:wait-for omx-detached-launch-[0-9a-f]+-environment-imported/);
      assert.doesNotMatch(tmuxLog, /^tmux:new-session .* -e [A-Z_][A-Z0-9_]*(?: |$)/m);
      assert.doesNotMatch(tmuxLog, /tmux:wait-for -[LU] /);
      assert.doesNotMatch(tmuxLog, new RegExp(escapeRegExp(providerSecret)));
      assert.doesNotMatch(tmuxScript, new RegExp(escapeRegExp(providerSecret)));
      assert.doesNotMatch(tmuxState, new RegExp(escapeRegExp(providerSecret)));
      assert.equal(existsSync(injectionCanaryPath), false);
      assert.equal(await readFile(restoreMarkerPath, 'utf-8'), 'restored');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly with --direct and skips detached tmux bootstrap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--direct', '--madmax'],
        {
          ...env,
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /new-session|split-window|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly from OMX_LAUNCH_POLICY=direct and skips detached tmux bootstrap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-env-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax'],
        {
          ...env,
          OMX_LAUNCH_POLICY: 'direct',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /new-session|split-window|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly inside tmux with --direct and skips HUD/mouse/extended-key tmux calls', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-inside-tmux-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--direct', '--madmax'],
        {
          ...env,
          TMUX: '/tmp/tmux-1000/default,123,0',
          TMUX_PANE: '%1',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /split-window|show-options|extended-keys|mouse on/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves HUD split behavior inside tmux when no direct override is present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-inside-tmux-managed-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  list-panes)
    exit 0
    ;;
  split-window)
    printf '%s\n' '%hud'
    exit 0
    ;;
  display-message)
    case "$*" in
      *'#{socket_path}'*) printf '/tmp/tmux-test.sock\n' ;;
      *'#S'*) printf 'managed-session\n' ;;
      *) printf '0\n' ;;
    esac
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|kill-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax'],
        {
          ...env,
          TMUX: '/tmp/tmux-1000/default,123,0',
          TMUX_PANE: '%1',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(tmuxLog, new RegExp(`tmux:split-window -v -l ${HUD_TMUX_HEIGHT_LINES}`));
      assert.match(tmuxLog, /tmux:set-option -t managed-session mouse on/);
      assert.match(tmuxLog, /tmux:set-option -sq extended-keys always/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('treats a missing tmux server socket as safe for detached tmux startup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-missing-socket-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.6a\n'
    exit 0
    ;;
  list-sessions)
    printf 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\n' >&2
    exit 1
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      if (process.platform === 'win32') {
        await writeExecutable(fakeCodexPath, await readFile(fakeCodexPath, 'utf-8'));
        await writeExecutable(fakePsPath, await readFile(fakePsPath, 'utf-8'));
        await writeExecutable(fakeTmuxPath, await readFile(fakeTmuxPath, 'utf-8'));
      }

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(tmuxLog, /tmux:list-sessions/);
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.doesNotMatch(result.stderr, /server\/socket is unusable/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back directly when tmux is installed but the server socket is unusable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-stale-socket-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.6a\n'
    exit 0
    ;;
  list-sessions)
    printf 'error connecting to /tmp/tmux-1000/default (Operation not permitted)\n' >&2
    exit 1
    ;;
esac
printf 'unexpected tmux command: %s\n' "$*" >&2
exit 1
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      if (process.platform === 'win32') {
        await writeExecutable(fakeCodexPath, await readFile(fakeCodexPath, 'utf-8'));
        await writeExecutable(fakePsPath, await readFile(fakePsPath, 'utf-8'));
        await writeExecutable(fakeTmuxPath, await readFile(fakeTmuxPath, 'utf-8'));
      }

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stderr, /server\/socket is unusable/);
      assert.doesNotMatch(tmuxLog, /new-session|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back and falls back directly when attaching the detached tmux session fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-attach-fail-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  attach-session)
    printf 'error connecting to /tmp/tmux-1000/default (Operation not permitted)\n' >&2
    exit 1
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      if (process.platform === 'win32') {
        await writeExecutable(fakeCodexPath, await readFile(fakeCodexPath, 'utf-8'));
        await writeExecutable(fakePsPath, await readFile(fakePsPath, 'utf-8'));
        await writeExecutable(fakeTmuxPath, await readFile(fakeTmuxPath, 'utf-8'));
      }

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.match(tmuxLog, /tmux:kill-session -t /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back with guidance when WSL Windows Terminal attach exits without attaching', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-attach-noop-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          ...env,
          TMUX: '',
          TMUX_PANE: '',
          WSL_DISTRO_NAME: 'Ubuntu',
          WSL_INTEROP: '/run/WSL/1_interop',
          WT_SESSION: 'windows-terminal-session',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stderr, /attach-session returned immediately without attaching a client/i);
      assert.match(result.stderr, /Falling back to direct Codex launch/i);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.match(tmuxLog, /tmux:display-message -p -t .* #\{session_attached\}/);
      assert.match(tmuxLog, /tmux:kill-session -t /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves the requested cwd through detached tmux launch when an unsupported SHELL value falls back away from rc-driven cwd drift', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-cwd-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');
      const codexLogPath = join(wd, 'codex.log');
      const tmuxEnvironmentPath = join(wd, 'tmux-environment');
      const tmuxWaitPath = join(wd, 'tmux-wait');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.profile'), 'cd ..\n');
      await writeFile(join(home, '.zshrc'), 'cd ..\n');
      await writeFile(join(home, '.bashrc'), 'cd ..\n');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${codexLogPath}"
printf 'codex-pwd:%s\\n' "$(pwd)" >> "${codexLogPath}"
exit 0
`,
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
cmd="$1"
shift || true
case "$cmd" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    for last; do :; done
    if [ -n "\${last:-}" ]; then
      /bin/sh -c "$last" </dev/null >/dev/null 2>&1 &
    fi
    printf '%%12\n'
    exit 0
    ;;
  source-file)
    while IFS= read -r line; do
      set -- $line
      if [ "$1" = 'set-environment' ] && [ "$2" = '-t' ]; then
        name=\${5#\\"}
        name=\${name%\\"}
        case "$name" in
          OMX_TMUX_IMPORT_*_MANIFEST)
            value=\${6#\\"}
            value=\${value%\\"}
            ;;
          *) value="$PATH" ;;
        esac
        printf '%s=%s\n' "$name" "$value" >> "${tmuxEnvironmentPath}"
      fi
    done
    exit 0
    ;;
  wait-for)
    if [ "$1" = '-S' ]; then
      : > "${tmuxWaitPath}-\${2}"
      exit 0
    fi
    case "$1" in
      *environment-import-ready) exit 0 ;;
    esac
    while [ ! -f "${tmuxWaitPath}-\${1}" ]; do sleep 0.01; done
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$1" = '-p' ] && [ "$2" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-environment)
    for last; do :; done
    requested=\${last#\\"}
    requested=\${requested%\\"}
    if [ -f "${tmuxEnvironmentPath}" ]; then
      while IFS= read -r assignment; do
        case "$assignment" in
          "$requested="*) printf '%s\n' "$assignment"; exit 0 ;;
        esac
      done < "${tmuxEnvironmentPath}"
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  attach-session)
    while [ ! -f "${codexLogPath}" ]; do sleep 0.01; done
    exit 0
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          SHELL: '/definitely/missing-shell',
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxEnvironment = await readFile(tmuxEnvironmentPath, 'utf-8');
      assert.match(tmuxEnvironment, /OMX_TMUX_IMPORT_[a-f0-9]{32}_MANIFEST=v1:/);
      assert.doesNotMatch(tmuxEnvironment, /OMX_STATE_AUTHORITY_CAPABILITY=[A-Za-z0-9]/);
      const codexLog = normalizeDarwinTmpPath(await readFile(codexLogPath, 'utf-8'));
      assert.match(codexLog, /codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(codexLog, new RegExp(`codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(wd))}`));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to /bin/sh for detached tmux launch when SHELL drifts to an unsupported path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-shell-fallback-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');
      const codexLogPath = join(wd, 'codex.log');
      const tmuxEnvironmentPath = join(wd, 'tmux-environment');
      const tmuxWaitPath = join(wd, 'tmux-wait');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.profile'), 'cd ..\n');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${codexLogPath}"
printf 'codex-pwd:%s\\n' "$(pwd)" >> "${codexLogPath}"
exit 0
`,
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
cmd="$1"
shift || true
case "$cmd" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    for last; do :; done
    if [ -n "\${last:-}" ]; then
      /bin/sh -c "$last" </dev/null >/dev/null 2>&1 &
    fi
    printf '%%12\n'
    exit 0
    ;;
  source-file)
    while IFS= read -r line; do
      set -- $line
      if [ "$1" = 'set-environment' ] && [ "$2" = '-t' ]; then
        name=\${5#\\"}
        name=\${name%\\"}
        case "$name" in
          OMX_TMUX_IMPORT_*_MANIFEST)
            value=\${6#\\"}
            value=\${value%\\"}
            ;;
          *) value="$PATH" ;;
        esac
        printf '%s=%s\n' "$name" "$value" >> "${tmuxEnvironmentPath}"
      fi
    done
    exit 0
    ;;
  wait-for)
    if [ "$1" = '-S' ]; then
      : > "${tmuxWaitPath}-\${2}"
      exit 0
    fi
    case "$1" in
      *environment-import-ready) exit 0 ;;
    esac
    while [ ! -f "${tmuxWaitPath}-\${1}" ]; do sleep 0.01; done
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$1" = '-p' ] && [ "$2" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-environment)
    for last; do :; done
    requested=\${last#\\"}
    requested=\${requested%\\"}
    if [ -f "${tmuxEnvironmentPath}" ]; then
      while IFS= read -r assignment; do
        case "$assignment" in
          "$requested="*) printf '%s\n' "$assignment"; exit 0 ;;
        esac
      done < "${tmuxEnvironmentPath}"
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  attach-session)
    while [ ! -f "${codexLogPath}" ]; do sleep 0.01; done
    exit 0
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          SHELL: '/bin/not-a-real-shell',
          PATH: platformTestPath(fakeBin),
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );


      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const tmuxEnvironment = await readFile(tmuxEnvironmentPath, 'utf-8');
      assert.match(tmuxEnvironment, /OMX_TMUX_IMPORT_[a-f0-9]{32}_MANIFEST=v1:/);
      assert.doesNotMatch(tmuxEnvironment, /OMX_STATE_AUTHORITY_CAPABILITY=[A-Za-z0-9]/);
      const codexLog = normalizeDarwinTmpPath(await readFile(codexLogPath, 'utf-8'));
      assert.match(tmuxLog, /\/bin\/sh/);
      assert.doesNotMatch(tmuxLog, /not-a-real-shell/);
      assert.match(codexLog, /codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(codexLog, new RegExp(`codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(wd))}`));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
