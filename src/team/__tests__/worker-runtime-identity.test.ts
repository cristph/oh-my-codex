import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { delimiter, join, resolve } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  initTeamState,
  createTask,
  readTeamConfig,
  saveTeamConfig,
} from '../state.js';
import {
  startTeam as rawStartTeam,
  shutdownTeam,
  resolveWorkerLaunchArgsFromEnv,
  type TeamRuntime,
} from '../runtime.js';
import { scaleUp } from '../scaling.js';
import { createTeamSession } from '../tmux-session.js';

import {
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
} from '../../state/authority.js';
import { resolveTeamLowComplexityDefaultModel } from '../model-contract.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

function testAuthoritySessionId(cwd: string): string {
  return `team-start-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24)}`;
}

async function startTeam(
  ...args: Parameters<typeof rawStartTeam>
): ReturnType<typeof rawStartTeam> {
  const cwd = args[5];
  const canonicalSessionId = testAuthoritySessionId(cwd);
  const requestedSessionId = process.env.OMX_SESSION_ID?.trim() || canonicalSessionId;
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `${canonicalSessionId}-launch`,
    session_binding: {
      canonical_session_id: canonicalSessionId,
      ...(requestedSessionId === canonicalSessionId
        ? {}
        : { aliases: { current_session_aliases: [requestedSessionId] } }),
    },
  });
  await mintStateAuthorityTransportCapability(authority);
  const transport = buildStateAuthorityTransportEnv(authority, {
    OMX_SESSION_ID: requestedSessionId,
  });
  const previous = new Map(
    Object.keys(transport).map((key) => [key, process.env[key]]),
  );

  Object.assign(process.env, transport);
  try {
    return await rawStartTeam(...args);
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

function expectedLowComplexityModel(codexHomeOverride?: string): string {
  return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
}

function pathEnvironmentKey(): 'PATH' | 'Path' {
  return Object.hasOwn(process.env, 'Path') ? 'Path' : 'PATH';
}

async function writeNodeCommandStub(
  directory: string,
  name: string,
  source: string,
): Promise<void> {
  if (process.platform === 'win32') {
    const scriptPath = join(directory, `${name}-stub.cjs`);
    await writeFile(scriptPath, source);
    await writeFile(
      join(directory, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
    return;
  }
  await writeFile(join(directory, name), `#!/usr/bin/env node\n${source}`, {
    mode: 0o755,
  });
}

function prependPath(directory: string, previous?: string): string {
  return [directory, previous].filter((entry): entry is string => Boolean(entry)).join(delimiter);
}

async function readRegularFilesRecursively(
  directory: string,
): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...(await readRegularFilesRecursively(path)));
    } else if (entry.isFile()) {
      contents.push(await readFile(path, 'utf8'));
    }
  }
  return contents;
}

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const prev = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  let restoreImmediately = true;
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(() => {
        if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
        else delete process.env.OMX_TEAM_WORKER;
      }) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
    }
  }
}

function withMockPromptModeCodexAllowed<T>(fn: () => T): T {
  const previous = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';
  let restoreImmediately = true;
  const restore = () => {
    if (typeof previous === 'string')
      process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = previous;
    else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(restore) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) restore();
  }
}

describe('worker runtime identity contract', () => {
  it('keeps low-complexity launch defaults without changing the role lane', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
    );
    assert.deepEqual(args, [
      '--no-alt-screen',
      '--model',
      expectedLowComplexityModel(),
    ]);
  });

  it('startTeam preserves low-complexity assigned roles as outer runtime identities', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-identity-start-'));
    const binDir = join(cwd, 'bin');
    const captureDir = join(cwd, 'captures');
    const promptsDir = join(cwd, '.codex', 'prompts');
    await mkdir(binDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      join(promptsDir, 'explore.md'),
      '<identity>You are Explorer.</identity>',
    );
    await writeFile(
      join(promptsDir, 'style-reviewer.md'),
      '<identity>You are Style Reviewer.</identity>',
    );
    await writeFile(
      join(promptsDir, 'sisyphus-lite.md'),
      '<identity>You are Sisyphus-lite.</identity>',
    );
    await writeNodeCommandStub(
      binDir,
      'codex',
      `const fs = require('fs');
const path = require('path');
const worker = String(process.env.OMX_TEAM_WORKER || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '__');
const [teamName, workerName] = String(process.env.OMX_TEAM_INTERNAL_WORKER || '').split('/');
let plannedState = false;
try {
  const teamRoot = path.join(process.env.OMX_TEAM_STATE_ROOT, 'team', teamName);
  const config = JSON.parse(fs.readFileSync(path.join(teamRoot, 'manifest.v2.json'), 'utf8'));
  const configWorker = Array.isArray(config.workers) && config.workers.find((candidate) => candidate && candidate.name === workerName);
  const identity = JSON.parse(fs.readFileSync(path.join(teamRoot, 'workers', workerName, 'identity.json'), 'utf8'));
  const inbox = fs.readFileSync(path.join(teamRoot, 'workers', workerName, 'inbox.md'), 'utf8');
  plannedState = Boolean(
    configWorker
    && identity.name === workerName
    && identity.team_state_root === process.env.OMX_TEAM_STATE_ROOT
    && typeof inbox === 'string',
  );

} catch {}
const out = path.join(process.env.OMX_ARGV_CAPTURE_DIR, worker + '.json');
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), worker, plannedState }, null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
    );

    const pathKey = pathEnvironmentKey();
    const prevPath = process.env[pathKey];
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevCaptureDir = process.env.OMX_ARGV_CAPTURE_DIR;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    process.env[pathKey] = prependPath(binDir, prevPath);
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
    delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-low-role-routing',
            'low complexity routing handoff',
            'executor',
            2,
            [
              {
                subject: 'map files',
                description: 'map files',
                owner: 'worker-1',
                role: 'explore',
              },
              {
                subject: 'review style',
                description: 'review style',
                owner: 'worker-2',
                role: 'style-reviewer',
              },
            ],
            cwd,
          ),
        ),
      );

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal(runtime.config.workers[0]?.role, 'explore');
      assert.equal(runtime.config.workers[1]?.role, 'style-reviewer');

      const worker1Instructions = await readFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          runtime.teamName,
          'workers',
          'worker-1',
          'AGENTS.md',
        ),
        'utf-8',
      );
      const worker2Instructions = await readFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          runtime.teamName,
          'workers',
          'worker-2',
          'AGENTS.md',
        ),
        'utf-8',
      );
      assert.match(
        worker1Instructions,
        /You are operating as the \*\*explore\*\* role/,
      );
      assert.match(worker1Instructions, /You are Explorer\./);
      assert.doesNotMatch(worker1Instructions, /Sisyphus-lite/);
      assert.match(
        worker2Instructions,
        /You are operating as the \*\*style-reviewer\*\* role/,
      );
      assert.match(worker2Instructions, /You are Style Reviewer\./);
      assert.doesNotMatch(worker2Instructions, /Sisyphus-lite/);

      let worker1Args: string[] | null = null;
      let worker2Args: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const worker1Path = join(
          captureDir,
          'team-low-role-routing__worker-1.json',
        );
        const worker2Path = join(
          captureDir,
          'team-low-role-routing__worker-2.json',
        );
        if (existsSync(worker1Path) && existsSync(worker2Path)) {
          const worker1Capture = JSON.parse(
            await readFile(worker1Path, 'utf-8'),
          ) as { argv: string[]; plannedState: boolean };
          const worker2Capture = JSON.parse(
            await readFile(worker2Path, 'utf-8'),
          ) as { argv: string[]; plannedState: boolean };
          worker1Args = worker1Capture.argv;
          worker2Args = worker2Capture.argv;
          assert.equal(worker1Capture.plannedState, true);
          assert.equal(worker2Capture.plannedState, true);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(worker1Args, 'worker-1 argv capture file should be written');
      assert.ok(worker2Args, 'worker-2 argv capture file should be written');
      const worker1Joined = worker1Args!.join(' ');
      const worker2Joined = worker2Args!.join(' ');
      assert.match(worker1Joined, /model_reasoning_effort="low"/);
      assert.match(worker1Joined, /--model gpt-5\.6-luna/);
      assert.match(worker2Joined, /model_reasoning_effort="low"/);
      assert.match(worker2Joined, /--model gpt-5\.6-luna/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(
          () => {},
        );
      }
      if (typeof prevPath === 'string') process.env[pathKey] = prevPath;
      else delete process.env[pathKey];
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string')
        process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string')
        process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevCaptureDir === 'string')
        process.env.OMX_ARGV_CAPTURE_DIR = prevCaptureDir;
      else delete process.env.OMX_ARGV_CAPTURE_DIR;
      if (typeof prevLaunchArgs === 'string')
        process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scaleUp preserves low-complexity assigned roles as outer runtime identities', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-identity-scale-'));
    const fakeBinDir = await mkdtemp(
      join(tmpdir(), 'omx-runtime-identity-scale-bin-'),
    );
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const pathKey = pathEnvironmentKey();
    const previousPath = process.env[pathKey];

    try {
      await writeNodeCommandStub(
        fakeBinDir,
        'tmux',
        `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(tmuxLogPath)}, args.join(' ') + '\\n');
switch (args[0] || '') {
  case '-V': console.log('tmux 3.2a'); break;
  case 'split-window': console.log('%31'); break;
  case 'list-panes': console.log('42424'); break;
  case 'capture-pane': console.log(''); break;
}
`,
      );
      process.env[pathKey] = prependPath(fakeBinDir, previousPath);

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(
        join(cwd, '.codex', 'prompts', 'explore.md'),
        '<identity>You are Explorer.</identity>',
      );
      await writeFile(
        join(cwd, '.codex', 'prompts', 'sisyphus-lite.md'),
        '<identity>You are Sisyphus-lite.</identity>',
      );
      await mkdir(join(cwd, '.omx', 'state', 'team', 'low-role-scale'), {
        recursive: true,
      });
      await writeFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          'low-role-scale',
          'worker-agents.md',
        ),
        '# Base worker instructions\n',
      );

      await initTeamState(
        'low-role-scale',
        'task',
        'executor',
        1,
        cwd,
        undefined,
        process.env,
        {
        workspace_mode: 'single',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
        },
      );
      await createTask(
        'low-role-scale',
        {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
        },
        cwd,
      );

      const config = await readTeamConfig('low-role-scale', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-low-role-scale';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'low-role-scale',
        'manifest.v2.json',
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        policy?: Record<string, unknown>;
      };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'low-role-scale',
        1,
        'executor',
        [
          {
            subject: 'map files',
            description: 'map files',
            owner: 'worker-2',
            role: 'explore',
          },
        ],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          'low-role-scale',
          'workers',
          'worker-2',
          'AGENTS.md',
        ),
        'utf-8',
      );
      assert.match(
        workerAgents,
        /You are operating as the \*\*explore\*\* role/,
      );
      assert.match(workerAgents, /You are Explorer\./);
      assert.doesNotMatch(workerAgents, /Sisyphus-lite/);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /runtime\/worker-2-startup\.sh/);
      const startupScript = await readFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          'low-role-scale',
          'runtime',
          'worker-2-startup.sh',
        ),
        'utf-8',
      );
      assert.match(startupScript, /gpt-5\.6-luna/);
      assert.match(startupScript, /model_reasoning_effort.*low/);
    } finally {
      if (typeof previousPath === 'string') process.env[pathKey] = previousPath;
      else delete process.env[pathKey];
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scaleUp recomputes worker CLI from exact-role-resolved launch args instead of inherited non-Codex model routing', async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'omx-runtime-identity-scale-exact-'),
    );
    const fakeBinDir = await mkdtemp(
      join(tmpdir(), 'omx-runtime-identity-scale-exact-bin-'),
    );
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const pathKey = pathEnvironmentKey();
    const previousPath = process.env[pathKey];

    try {
      await writeNodeCommandStub(
        fakeBinDir,
        'tmux',
        `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(tmuxLogPath)}, args.join(' ') + '\\n');
switch (args[0] || '') {
  case '-V': console.log('tmux 3.2a'); break;
  case 'split-window': console.log('%31'); break;
  case 'list-panes': console.log('42424'); break;
  case 'capture-pane': console.log(''); break;
}
`,
      );
      await writeFile(tmuxLogPath, '');
      process.env[pathKey] = prependPath(fakeBinDir, previousPath);

      await mkdir(join(cwd, '.omx', 'state', 'team', 'exact-role-cli'), {
        recursive: true,
      });
      await writeFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          'exact-role-cli',
          'worker-agents.md',
        ),
        '# Base worker instructions\n',
      );

      await initTeamState('exact-role-cli', 'task', 'executor', 1, cwd);
      await createTask(
        'exact-role-cli',
        {
        subject: 'architecture follow-up',
        description: 'exact-role scale-up regression',
        status: 'pending',
        owner: 'worker-3',
        role: 'architect',
        },
        cwd,
      );

      const config = await readTeamConfig('exact-role-cli', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-exact-role-cli';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      config.next_worker_index = 3;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'exact-role-cli',
        'manifest.v2.json',
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        policy?: Record<string, unknown>;
      };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'exact-role-cli',
        1,
        'executor',
        [
          {
            subject: 'architecture follow-up',
            description: 'exact-role scale-up regression',
            owner: 'worker-3',
            role: 'architect',
          },
        ],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen',
          OMX_TEAM_WORKER_INHERITED_MODEL: 'claude-sonnet-4-6',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerIdentity = JSON.parse(
        await readFile(
          join(
            cwd,
            '.omx',
            'state',
            'team',
            'exact-role-cli',
            'workers',
            'worker-3',
            'identity.json',
          ),
          'utf-8',
        ),
      ) as { worker_cli?: string; role?: string };
      assert.equal(workerIdentity.role, 'architect');
      assert.equal(workerIdentity.worker_cli, 'codex');

      const startupScript = await readFile(
        join(
          cwd,
          '.omx',
          'state',
          'team',
          'exact-role-cli',
          'runtime',
          'worker-3-startup.sh',
        ),
        'utf-8',
      );
      assert.match(startupScript, /codex/);
      assert.doesNotMatch(startupScript, /\bclaude\b/);
      assert.doesNotMatch(startupScript, /\bgemini\b/);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /worker-3-startup\.sh/);
      assert.doesNotMatch(tmuxLog, /\bclaude\b/);
      assert.doesNotMatch(tmuxLog, /\bgemini\b/);
    } finally {
      if (typeof previousPath === 'string') process.env[pathKey] = previousPath;
      else delete process.env[pathKey];
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('injects exact authenticated authority into an existing tmux server without persisting it', async () => {
    const cwd = await realpath(await mkdtemp(
      join(tmpdir(), 'omx-runtime-identity-authority-tmux-'),
    ));
    const fakeBinDir = await mkdtemp(
      join(tmpdir(), 'omx-runtime-identity-authority-tmux-bin-'),
    );
    const capabilityMarkerPath = join(
      fakeBinDir,
      'authority-capability-received',
    );
    const authorityImportMapPath = join(fakeBinDir, 'authority-import-map.json');
    const injectionCanaryPath = join(fakeBinDir, 'provider-injection-canary');
    const tmuxArgvLogPath = join(fakeBinDir, 'tmux-argv.jsonl');
    const authorityRestoreMarkerPath = join(
      fakeBinDir,
      'authority-environment-restored',
    );
    const authorityEnvKeys = [
      'OMX_STARTUP_CWD',
      'OMX_STATE_AUTHORITY_PATH',
      'OMX_STATE_AUTHORITY_ID',
      'OMX_STATE_AUTHORITY_GENERATION_ID',
      'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
      'OMX_STATE_AUTHORITY_CAPABILITY',
    ];
    const providerEnvKey = 'OMX_TEST_PROVIDER_SECRET';
    const providerValue =
      `provider secret "quoted" \\ $HOME $(touch ${injectionCanaryPath}); literal-end`;

    const pathKey = pathEnvironmentKey();
    const previousPath = process.env[pathKey];
    const previousEnv = new Map(
      [
        'TMUX',
        'TMUX_PANE',
        'CODEX_HOME',
        'OMX_TEAM_WORKER_LAUNCH_MODE',
        'OMX_TEAM_SKIP_READY_WAIT',
        'OMX_TEAM_WORKER_CLI',
        'OMX_SESSION_ID',
        providerEnvKey,
        `OMX_TEST_EXPECTED_${providerEnvKey}`,
        ...authorityEnvKeys,
        ...authorityEnvKeys.map((key) => `OMX_TEST_EXPECTED_${key}`),
      ].map((key) => [key, process.env[key]]),
    );

    let runtime: TeamRuntime | null = null;
    try {
      await writeNodeCommandStub(
        fakeBinDir,
        'tmux',
        `const fs = require('fs');
const args = process.argv.slice(2);
const { spawnSync } = require('child_process');
const command = args[0] || '';
if (command === '-V') { console.log('tmux 3.2a'); process.exit(0); }
if (command === 'display-message') {
  console.log(args.join(' ').includes('#{window_width}') ? '120' : 'leader:0 %1');
  process.exit(0);
}
if (command === 'list-panes') {
  if (args.join(' ').includes('#{pane_pid}')) process.exit(0);
  console.log('%1\\tzsh\\tzsh\\n%2\\tzsh\\tzsh\\n%3\\tzsh\\tzsh');
  process.exit(0);
}
if (command === 'show-environment') {
  const requestedName = args.at(-1) || '';
  if (requestedName.startsWith('OMX_TMUX_IMPORT_') && fs.existsSync(${JSON.stringify(authorityImportMapPath)})) {
    const bindings = JSON.parse(fs.readFileSync(${JSON.stringify(authorityImportMapPath)}, 'utf8'));
    const targetName = Object.keys(bindings).find((candidate) => bindings[candidate] === requestedName);
    if (targetName) {
      console.log(requestedName + '=' + (process.env['OMX_TEST_EXPECTED_' + targetName] || ''));
      process.exit(0);
    }
  }
  console.log('OMX_TEST_PROVIDER_SECRET=previous-provider-$HOME-\${OMX_LITERAL_PREVIOUS_SECRET}');
  process.exit(0);
}
if (command === 'source-file') {
  fs.appendFileSync(${JSON.stringify(tmuxArgvLogPath)}, JSON.stringify(args) + '\\n');
  const input = fs.readFileSync(0, 'utf8');
  const required = [
    'OMX_STARTUP_CWD',
    'OMX_STATE_AUTHORITY_PATH',
    'OMX_STATE_AUTHORITY_ID',
    'OMX_STATE_AUTHORITY_GENERATION_ID',
    'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
    'OMX_STATE_AUTHORITY_CAPABILITY',
    'OMX_TEST_PROVIDER_SECRET',
  ];
  const quote = (value) => '"' + value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\$/g, '\\\\$') + '"';
  const lines = input.split(/\\r?\\n/).filter(Boolean);
  const bindings = {};
  const claimedSources = new Set();
  let exact = args.length === 2 && args[1] === '-';
  for (const targetName of required) {
    const expected = process.env['OMX_TEST_EXPECTED_' + targetName];
    const parsed = lines
      .filter((line) => line.endsWith(' ' + quote(expected || '')))
      .map((line) => line.match(/^set-environment -t "[^"]+" (OMX_TMUX_IMPORT_[A-Za-z0-9_]+) /))
      .find((match) => match && !claimedSources.has(match[1]));
    if (!parsed) exact = false;
    else {
      bindings[targetName] = parsed[1];
      claimedSources.add(parsed[1]);
    }
  }
  exact = exact && required.every((key) => !new RegExp('set-environment -t "[^"]+" ' + key + ' ').test(input));
  if (exact) fs.writeFileSync(${JSON.stringify(authorityImportMapPath)}, JSON.stringify(bindings));
  const restoresInheritedEnvironment = input.includes(' OMX_TMUX_IMPORT_')
    && input.includes(' -u ')
    && required.every((key) => !new RegExp('set-environment -t "[^"]+" ' + key + ' ').test(input));
  if (restoresInheritedEnvironment) fs.writeFileSync(${JSON.stringify(join(fakeBinDir, 'authority-environment-restored'))}, 'restored');
  process.exit(0);
}
if (command === 'set-environment') {
  if (args.includes('-u') && fs.existsSync(${JSON.stringify(authorityImportMapPath)})) {
    const sourceName = args.at(-1) || '';
    const bindings = JSON.parse(fs.readFileSync(${JSON.stringify(authorityImportMapPath)}, 'utf8'));
    for (const targetName of Object.keys(bindings)) {
      if (bindings[targetName] === sourceName) delete bindings[targetName];
    }
    fs.writeFileSync(${JSON.stringify(authorityImportMapPath)}, JSON.stringify(bindings));
  }
  process.exit(0);
}
if (command === 'split-window') {
  fs.appendFileSync(${JSON.stringify(tmuxArgvLogPath)}, JSON.stringify(args) + '\\n');
  if (!fs.existsSync(${JSON.stringify(authorityImportMapPath)}) || args.some((value) => value === '-e')) process.exit(1);
  const startupCommand = args.at(-1) || '';
  if (!startupCommand.includes('omx_import_assignment=$(')) {
    console.log('hud-pane');
    process.exit(0);
  }
  const bindings = JSON.parse(fs.readFileSync(${JSON.stringify(authorityImportMapPath)}, 'utf8'));
  const exactBindings = Object.entries(bindings).every(([targetName, sourceName]) => {
    const firstAssignmentIndex = startupCommand.indexOf('omx_import_assignment=$(');
    const sourceIndex = startupCommand.indexOf(String(sourceName), firstAssignmentIndex);
    const exportIndex = startupCommand.indexOf('export "' + targetName + '=', sourceIndex);
    const nextSourceIndex = startupCommand.indexOf('omx_import_assignment=$(', sourceIndex + String(sourceName).length);
    return firstAssignmentIndex >= 0
      && sourceIndex >= firstAssignmentIndex
      && exportIndex > sourceIndex
      && (nextSourceIndex < 0 || exportIndex < nextSourceIndex);
  });
  if (!exactBindings) process.exit(1);
  const execution = spawnSync('sh', ['-c', startupCommand], {
    cwd: ${JSON.stringify(cwd)},
    env: process.env,
    encoding: 'utf8',
  });
  if (execution.error || execution.status !== 0) process.exit(1);
  const internalTeamMatch = startupCommand.match(/[\\/]state[\\/]team[\\/]([^\\/]+)[\\/]runtime[\\/]/);
  if (internalTeamMatch) fs.writeFileSync(${JSON.stringify(join(fakeBinDir, 'internal-team-name'))}, internalTeamMatch[1]);
  console.log(args.includes('-h') ? '%2' : '%3');
  process.exit(0);
}
if (command === 'send-keys') {
  const internalTeamName = fs.readFileSync(${JSON.stringify(join(fakeBinDir, 'internal-team-name'))}, 'utf8').trim();
  const statusPath = ${JSON.stringify(join(cwd, '.omx', 'state', 'team'))} + '/' + internalTeamName + '/workers/worker-1/status.json';
  fs.mkdirSync(require('path').dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({ state: 'working', current_task_id: '1', updated_at: new Date().toISOString() }));
  process.exit(0);
}

process.exit(0);
`,
      );

      await writeNodeCommandStub(
        fakeBinDir,
        'codex',
        `const fs = require('fs');
const capability = process.env.OMX_STATE_AUTHORITY_CAPABILITY || '';
const provider = process.env[${JSON.stringify(providerEnvKey)}] || '';
const expectedCapability = process.env.OMX_TEST_EXPECTED_OMX_STATE_AUTHORITY_CAPABILITY || '';
const expectedProvider = process.env.OMX_TEST_EXPECTED_OMX_TEST_PROVIDER_SECRET || '';
if (!capability || capability !== expectedCapability || provider !== expectedProvider) process.exit(1);
fs.writeFileSync(${JSON.stringify(capabilityMarkerPath)}, 'received');`,
      );
      process.env[pathKey] = prependPath(fakeBinDir, previousPath);
      process.env.TMUX = 'leader-session,stub,0';
      process.env.TMUX_PANE = '%1';
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
      const codexHome = join(fakeBinDir, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          'model_provider = "test-provider"',
          '',
          '[model_providers.test-provider]',
          `env_key = "${providerEnvKey}"`,
          '',
        ].join('\n'),
      );
      process.env.CODEX_HOME = codexHome;
      process.env[providerEnvKey] = providerValue;

      const authority = await initializeStateAuthority({
        startup_cwd: cwd,
        observed_cwd: cwd,
        launch_id: 'worker-runtime-preexisting-tmux-authority',
        session_binding: {
          canonical_session_id:
            'worker-runtime-preexisting-tmux-authority-session',
        },
      });
      const minted = await mintStateAuthorityTransportCapability(authority);
      const workerAuthorityTransport = {
        OMX_STARTUP_CWD: authority.workspace_identity.canonical_path,
        OMX_STATE_AUTHORITY_PATH: authority.authority_path,
        OMX_STATE_AUTHORITY_ID: authority.generation.authority_id,
        OMX_STATE_AUTHORITY_GENERATION_ID: authority.generation.generation_id,
        OMX_STATE_AUTHORITY_WORKSPACE_DIGEST:
          authority.workspace_identity.digest,
        OMX_STATE_AUTHORITY_CAPABILITY: minted.capability,
      };
      const workerTransport = {
        ...workerAuthorityTransport,
        [providerEnvKey]: providerValue,
      };
      Object.assign(
        process.env,
        workerAuthorityTransport,
        Object.fromEntries(
          Object.entries(workerTransport).map(([key, value]) => [
            `OMX_TEST_EXPECTED_${key}`,
            value,
          ]),
        ),
      );
      process.env.OMX_SESSION_ID =
        'worker-runtime-preexisting-tmux-authority-session';

      // Bypass the fixture wrapper to exercise the manually assembled transport.
      runtime = await withoutTeamWorkerEnv(() =>
        rawStartTeam(
          'pre-existing-tmux-authority',
          'propagate authority to an existing tmux leader worker',
          'executor',
          1,
          [
            {
              subject: 'authority handoff',
              description: 'authority handoff',
              owner: 'worker-1',
            },
          ],
          cwd,
        ),
      );

      assert.equal(await readFile(capabilityMarkerPath, 'utf8'), 'received');
      assert.equal(
        await readFile(authorityRestoreMarkerPath, 'utf8'),
        'restored',
      );
      assert.equal(existsSync(injectionCanaryPath), false);
      assert.deepEqual(
        JSON.parse(await readFile(authorityImportMapPath, 'utf8')),
        {},
      );
      const tmuxArgv = (await readFile(tmuxArgvLogPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const authoritySourceArgv = tmuxArgv.find(
        (args) => args[0] === 'source-file',
      );
      assert.deepEqual(authoritySourceArgv, ['source-file', '-']);
      const workerSplitArgv = tmuxArgv.find(
        (args) => args[0] === 'split-window',
      );
      assert.ok(workerSplitArgv);
      assert.equal(workerSplitArgv.includes('-e'), false);
      for (const argv of tmuxArgv) {
        assert.equal(
          argv.some((value) => value.includes(minted.capability)),
          false,
        );
        assert.equal(
          argv.some((value) => value.includes(providerValue)),
          false,
        );
        assert.equal(
          argv.some((value) =>
            Object.keys(workerTransport).some((key) =>
              value.startsWith(`${key}=`),
            ),
          ),
          false,
        );
      }
      const teamRoot = join(
        authority.canonical_state_root,
        'team',
        runtime.teamName,
      );
      const startupScriptPath = join(
        teamRoot,
        'runtime',
        'worker-1-startup.sh',
      );
      assert.equal(existsSync(startupScriptPath), true, 'expected the managed worker startup script');
      const startupScript = await readFile(startupScriptPath, 'utf8');
      const persistedWorkerFiles = await readRegularFilesRecursively(teamRoot);
      for (const value of persistedWorkerFiles) {
        assert.equal(value.includes(minted.capability), false);
        assert.equal(value.includes(providerValue), false);
      }
      for (const key of [
        'OMX_STARTUP_CWD',
        'OMX_STATE_AUTHORITY_PATH',
        'OMX_STATE_AUTHORITY_ID',
        'OMX_STATE_AUTHORITY_GENERATION_ID',
        'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
        'OMX_STATE_AUTHORITY_CAPABILITY',
        providerEnvKey,
      ]) {
        assert.doesNotMatch(startupScript, new RegExp(key));
      }
      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;

      await rm(capabilityMarkerPath, { force: true });
      await rm(authorityRestoreMarkerPath, { force: true });
      await writeFile(tmuxArgvLogPath, '');
      Object.assign(
        process.env,
        Object.fromEntries(
          authorityEnvKeys.map((key) => [key, `ambient-${key}`]),
        ),
      );
      const directSession = createTeamSession(
        'authority-client-environment',
        1,
        cwd,
        [],
        [{ env: workerAuthorityTransport, workerCli: 'codex' }],
      );
      assert.deepEqual(directSession.workerPaneIds, ['%2']);
      assert.equal(await readFile(capabilityMarkerPath, 'utf8'), 'received');
      assert.equal(
        await readFile(authorityRestoreMarkerPath, 'utf8'),
        'restored',
      );
      assert.equal(existsSync(injectionCanaryPath), false);
      assert.deepEqual(
        JSON.parse(await readFile(authorityImportMapPath, 'utf8')),
        {},
      );
      const directTmuxArgv = (await readFile(tmuxArgvLogPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(
        directTmuxArgv.find((args) => args[0] === 'source-file'),
        ['source-file', '-'],
      );
      const directSplitArgv = directTmuxArgv.find(
        (args) => args[0] === 'split-window',
      );
      assert.ok(directSplitArgv);
      assert.equal(directSplitArgv.includes('-e'), false);
      assert.equal(
        directTmuxArgv.some((args) =>
          args.some(
            (value) =>
              value.includes(minted.capability) ||
              value.includes(providerValue),
          ),
        ),
        false,
      );

      await rm(capabilityMarkerPath, { force: true });
      await writeFile(tmuxArgvLogPath, '');
      const incompleteTransport: Record<string, string> = {
        ...workerAuthorityTransport,
      };
      delete incompleteTransport.OMX_STATE_AUTHORITY_CAPABILITY;
      assert.throws(
        () =>
          createTeamSession(
            'authority-client-environment-incomplete',
            1,
            cwd,
            [],
            [{ env: incompleteTransport, workerCli: 'codex' }],
          ),
        /authority transport is incomplete/,
      );
      assert.equal(existsSync(capabilityMarkerPath), false);
      assert.equal(await readFile(tmuxArgvLogPath, 'utf8'), '');

      const unsafeTransport = {
        ...workerAuthorityTransport,
        OMX_STATE_AUTHORITY_CAPABILITY: `${minted.capability}\nunsafe`,
      };
      assert.throws(
        () =>
          createTeamSession(
            'authority-client-environment-unsafe',
            1,
            cwd,
            [],
            [{ env: unsafeTransport, workerCli: 'codex' }],
          ),
        /unsafe environment value/,
      );
      assert.equal(await readFile(tmuxArgvLogPath, 'utf8'), '');
    } finally {
      if (runtime)
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(
          () => {},
        );
      if (typeof previousPath === 'string') process.env[pathKey] = previousPath;
      else delete process.env[pathKey];
      for (const [key, value] of previousEnv) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
