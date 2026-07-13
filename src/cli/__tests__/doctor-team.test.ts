import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { delimiter, join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  initializeStateAuthority,
  rolloverStateAuthorityToAlternateRoot,
  mintStateAuthorityTransportCapability,
  stateAuthorityTransportCapabilityForChild,
  type ResolvedStateAuthorityContext,
} from '../../state/authority.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
  if (envOverrides.PATH !== undefined) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env[process.platform === 'win32' ? 'Path' : 'PATH'] = envOverrides.PATH;
  }
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}


const TEST_AUTHORITY_ISSUER = {
  kind: 'first-party-launcher' as const,
  package_version: 'test',
  package_digest: '0'.repeat(64),
};

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd, stdio: 'ignore' });
}

function addDisposableWorktree(workspace: string, target: string): void {
  execFileSync('git', ['worktree', 'add', '--detach', target], { cwd: workspace, stdio: 'ignore' });
}

function authorityTransport(authority: ResolvedStateAuthorityContext): Record<string, string> {
  const root = dirname(authority.generation.canonical_omx_root);
  return {
    OMX_STARTUP_CWD: authority.workspace_identity.canonical_path,
    OMX_ROOT: root,
    OMX_STATE_ROOT: root,
    OMX_TEAM_STATE_ROOT: authority.canonical_state_root,
    OMX_STATE_AUTHORITY_PATH: authority.authority_path,
    OMX_STATE_AUTHORITY_ID: authority.generation.authority_id,
    OMX_STATE_AUTHORITY_GENERATION_ID: authority.generation.generation_id,
    OMX_STATE_AUTHORITY_WORKSPACE_DIGEST: authority.workspace_identity.digest,
    OMX_STATE_AUTHORITY_CAPABILITY: stateAuthorityTransportCapabilityForChild(authority),
    OMX_SESSION_ID: authority.session_binding?.canonical_session_id ?? '',
  };
}

async function createAlternateAuthority(
  workspace: string,
  alternateStateRoot: string,
  launchId: string,
): Promise<{
  initial: ResolvedStateAuthorityContext;
  active: ResolvedStateAuthorityContext;
  initialTransport: Record<string, string>;
  activeTransport: Record<string, string>;
}> {
  const initial = await initializeStateAuthority({
    startup_cwd: workspace,
    observed_cwd: workspace,
    launch_id: `${launchId}-source`,
    session_binding: { canonical_session_id: `${launchId}-session` },
  });
  await mintStateAuthorityTransportCapability(initial);
  const initialTransport = authorityTransport(initial);
  await mkdir(dirname(dirname(alternateStateRoot)), { recursive: true });
  const active = await rolloverStateAuthorityToAlternateRoot({
    context: initial,
    proposed_state_root: alternateStateRoot,
    creation_root: dirname(dirname(alternateStateRoot)),
    launch_id: `${launchId}-alternate`,
    consumer_kind: 'boxed',
    issuer: TEST_AUTHORITY_ISSUER,
  });
  await mintStateAuthorityTransportCapability(active);
  return { initial, active, initialTransport, activeTransport: authorityTransport(active) };
}
function testPath(fakeBin: string): string {
  const inheritedPath = process.platform === 'win32'
    ? process.env.Path ?? process.env.PATH
    : process.env.PATH ?? process.env.Path;
  return [fakeBin, inheritedPath]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .join(delimiter);
}


async function createFakeTmuxBin(wd: string, script: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(tmuxPath, script);
  await chmod(tmuxPath, 0o755);
  if (process.platform === 'win32') {
    await writeFile(join(fakeBin, 'tmux.cmd'), '@echo off\r\nsh "%~dp0tmux" %*\r\n');
  }
  return fakeBin;
}

describe('omx doctor --team', () => {
  it('exits non-zero and prints resume_blocker when team state references missing tmux session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'alpha',
        tmux_session: 'omx-team-alpha',
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /resume_blocker/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns without failing when a prompt worker pid is live but identity cannot be verified', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-prompt-'));
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false,
    });
    const sleeperPid = sleeper.pid ?? 0;

    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'prompt-alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'prompt-alpha',
        worker_launch_mode: 'prompt',
        tmux_session: 'prompt-team-alpha',
        workers: [{ name: 'worker-1', pid: sleeperPid }],
      }));
      await writeFile(join(teamRoot, 'manifest.v2.json'), JSON.stringify({
        name: 'prompt-alpha',
        policy: { worker_launch_mode: 'prompt' },
        tmux_session: 'prompt-team-alpha',
        workers: [{ name: 'worker-1', pid: sleeperPid }],
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# prompt-mode teams do not require tmux session checks\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /prompt_resume_unavailable/);
      assert.match(res.stdout, /prompt-alpha\/worker-1/);
      assert.match(res.stdout, new RegExp(String(sleeperPid)));
      assert.match(res.stdout, /cannot verify that the PID still belongs/);
      assert.match(res.stdout, /Results: 1 warnings, 0 failed/);
    } finally {
      if (sleeperPid > 0) {
        try {
          process.kill(sleeperPid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit resume_blocker when tmux is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'alpha',
        tmux_session: 'omx-team-alpha',
      }));

      const res = runOmx(wd, ['doctor', '--team'], { PATH: '' });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /resume_blocker/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints slow_shutdown when shutdown request is stale and ack missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const workerDir = join(wd, '.omx', 'state', 'team', 'beta', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team', 'beta', 'config.json'), JSON.stringify({
        name: 'beta',
        tmux_session: 'omx-team-beta',
      }));

      const requestedAt = new Date(Date.now() - 60_000).toISOString();
      await writeFile(join(workerDir, 'shutdown-request.json'), JSON.stringify({ requested_at: requestedAt }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /slow_shutdown/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints delayed_status_lag when worker is working and heartbeat is stale', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const workerDir = join(wd, '.omx', 'state', 'team', 'gamma', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team', 'gamma', 'config.json'), JSON.stringify({
        name: 'gamma',
        tmux_session: 'omx-team-gamma',
      }));

      const lastTurnAt = new Date(Date.now() - 120_000).toISOString();
      await writeFile(join(workerDir, 'status.json'), JSON.stringify({ state: 'working', updated_at: new Date().toISOString() }));
      await writeFile(join(workerDir, 'heartbeat.json'), JSON.stringify({
        pid: 123,
        last_turn_at: lastTurnAt,
        turn_count: 10,
        alive: true,
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /delayed_status_lag/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints orphan_tmux_session as warning when tmux session cannot be attributed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-orphan"; exit 0; fi\nexit 0\n');

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /orphan_tmux_session/);
      assert.match(res.stdout, /possibly external project/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints stale_leader when HUD state is old and team tmux session is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'epsilon');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'epsilon',
        tmux_session: 'omx-team-epsilon',
      }));

      // Stale HUD state (leader inactive for 5 minutes)
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      }));

      // Fake tmux reports the team session exists.
      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-epsilon"; exit 0; fi\nexit 0\n');

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit stale_leader when HUD state is fresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'zeta');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'zeta',
        tmux_session: 'omx-team-zeta',
      }));

      // Fresh HUD state (leader active 10 seconds ago)
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 10_000).toISOString(),
        turn_count: 20,
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-zeta"; exit 0; fi\nexit 0\n');

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.doesNotMatch(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit stale_leader when leader recently checked team status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const teamRoot = join(stateDir, 'team', 'eta');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'eta',
        tmux_session: 'omx-team-eta',
      }));

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: new Date(Date.now() - 5_000).toISOString(),
        last_source: 'team_status',
        last_team_name: 'eta',
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-eta"; exit 0; fi\nexit 0\n');

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit orphan_tmux_session when tmux reports no server running', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const fakeBin = await createFakeTmuxBin(
        wd,
        '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "no server running on /tmp/tmux-1000/default" 1>&2; exit 1; fi\nexit 0\n',
      );

      const res = runOmx(wd, ['doctor', '--team'], { PATH: testPath(fakeBin) });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /orphan_tmux_session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects inherited authority from a sibling linked worktree but uses the canonical alternate authority root from a nested cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-doctor-team-authority-'));
    const workspace = join(root, 'workspace');
    const disposableCwd = join(root, 'disposable-worktree');
    const nestedCwd = join(workspace, 'nested');
    try {
      await mkdir(workspace, { recursive: true });
      initGitRepo(workspace);
      addDisposableWorktree(workspace, disposableCwd);
      await mkdir(nestedCwd, { recursive: true });
      const { active } = await createAlternateAuthority(
        workspace,
        join(root, 'alternate-runtime', '.omx', 'state'),
        'doctor-alternate-authority',
      );
      const authoritativeTeam = join(active.canonical_state_root, 'team', 'alternate-authority');
      const cwdLocalTeam = join(nestedCwd, '.omx', 'state', 'team', 'cwd-decoy');
      await Promise.all([
        mkdir(authoritativeTeam, { recursive: true }),
        mkdir(cwdLocalTeam, { recursive: true }),
      ]);
      await writeFile(join(authoritativeTeam, 'config.json'), JSON.stringify({
        name: 'alternate-authority',
        tmux_session: 'omx-team-alternate-authority',
      }));
      await writeFile(join(cwdLocalTeam, 'config.json'), JSON.stringify({
        name: 'cwd-decoy',
        tmux_session: 'omx-team-cwd-decoy',
      }));
      const fakeBin = await createFakeTmuxBin(root, '#!/bin/sh\n# list-sessions succeeds with no sessions\nexit 0\n');
      const sibling = runOmx(disposableCwd, ['doctor', '--team'], {
        ...authorityTransport(active),
        PATH: testPath(fakeBin),
      });

      assert.equal(sibling.status, 1, sibling.stderr || sibling.stdout);
      assert.match(
        sibling.stdout,
        /\[XX\] authority_observed_cwd_outside_workspace: cannot resolve inherited authority: inherited state-authority transport cannot be used from an unrelated workspace cwd/,
      );
      assert.doesNotMatch(sibling.stdout, /alternate-authority references missing tmux session/);
      assert.doesNotMatch(sibling.stdout, /cwd-decoy references missing tmux session/);

      const res = runOmx(nestedCwd, ['doctor', '--team'], {
        ...authorityTransport(active),
        PATH: testPath(fakeBin),
      });
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /\[XX\] resume_blocker: alternate-authority references missing tmux session omx-team-alternate-authority/,
      );
      assert.doesNotMatch(res.stdout, /cwd-decoy references missing tmux session/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for stale transport and conflicting inherited aliases from a nested authority workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-doctor-team-authority-denial-'));
    const workspace = join(root, 'workspace');
    const nestedCwd = join(workspace, 'nested');
    try {
      await mkdir(workspace, { recursive: true });
      initGitRepo(workspace);
      await mkdir(nestedCwd, { recursive: true });
      const { initialTransport, activeTransport } = await createAlternateAuthority(
        workspace,
        join(root, 'alternate-runtime', '.omx', 'state'),
        'doctor-authority-denial',
      );
      const fakeBin = await createFakeTmuxBin(root, '#!/bin/sh\nexit 0\n');
      const stale = runOmx(nestedCwd, ['doctor', '--team'], {
        ...initialTransport,
        PATH: testPath(fakeBin),
      });
      assert.equal(stale.status, 1, stale.stderr || stale.stdout);
      assert.match(
        stale.stdout,
        /\[XX\] authority_anchor_revision_conflict: cannot resolve inherited authority: inherited state-authority transport does not match the active anchor, generation, binding, fence, and filesystem-validated authority context/,
      );

      const conflicting = runOmx(nestedCwd, ['doctor', '--team'], {
        ...activeTransport,
        OMX_TEAM_STATE_ROOT: join(root, 'foreign-state'),
        PATH: testPath(fakeBin),
      });
      assert.equal(conflicting.status, 1, conflicting.stderr || conflicting.stdout);
      assert.match(
        conflicting.stdout,
        /\[XX\] authority_workspace_mismatch: OMX_TEAM_STATE_ROOT conflicts with the persisted authority state root; remove the override and relaunch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
