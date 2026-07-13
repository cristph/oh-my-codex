import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';


const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');

const STATE_AUTHORITY_ENV_KEYS = [
  'OMX_STARTUP_CWD',
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
  'OMX_SESSION_ID',
] as const;

async function establishCommittedAuthority(
  cwd: string,
  sessionId: string,
): Promise<NodeJS.ProcessEnv> {
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `cli-session-scope-${sessionId}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  return buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId });
}

function unauthenticatedEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(STATE_AUTHORITY_ENV_KEYS.map((key) => [key, undefined])),
    ...overrides,
  };
}

function runOmxWithEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: 'utf-8',
    env: childEnv,
  });
}

describe('CLI session-scoped state parity', () => {
  it('status and cancel include session-scoped states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-scope-'));
    try {
      const authorityTransport = await establishCommittedAuthority(wd, 'sess1');

      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess1' }));
      const scopedDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      await mkdir(scopedDir, { recursive: true });
      await writeFile(join(scopedDir, 'team-state.json'), JSON.stringify({
        active: true,
        current_phase: 'team-exec',
      }));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');
      if (statusResult.error && /(EPERM|EACCES)/i.test(statusResult.error.message)) return;
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /team: ACTIVE/);

      const cancelResult = runOmxWithEnv(wd, authorityTransport, 'cancel');

      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: team/);

      const updated = JSON.parse(await readFile(join(scopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.active, false);
      assert.equal(updated.current_phase, 'cancelled');
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed without committed authority and preserves unmatched implicit session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-unmatched-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'canonical-session';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ralphPath = join(sessionDir, 'ralph-state.json');
      const nativeStopPath = join(sessionDir, 'native-stop-state.json');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(ralphPath, JSON.stringify({ active: true, current_phase: 'executing' }));
      await writeFile(nativeStopPath, JSON.stringify({
        sessions: { [sessionId]: { last_signature: 'ralph-stop|pending' } },
      }));

      const cancelResult = runOmxWithEnv(
        wd,
        { OMX_SESSION_ID: 'unmatched-session' },
        'cancel',
        '--force',
      );

      assert.equal(cancelResult.status, 1, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stderr, /requires a committed authenticated state authority/);
      assert.deepEqual(
        JSON.parse(await readFile(ralphPath, 'utf-8')),
        { active: true, current_phase: 'executing' },
      );
      assert.deepEqual(
        JSON.parse(await readFile(nativeStopPath, 'utf-8')),
        { sessions: { [sessionId]: { last_signature: 'ralph-stop|pending' } } },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('status does not report a root fallback mode as active after current-session clear', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-clear-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-clear';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'legacy-root',
      }));
      await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'session-active',
      }));

      const clearResult = runOmxWithEnv(
        wd,
        authorityTransport,
        'state',
        'clear',
        '--input',
        '{"mode":"deep-interview"}',
        '--json',
      );
      assert.equal(clearResult.status, 0, clearResult.stderr || clearResult.stdout);
      assert.match(clearResult.stdout, /"cleared":true/);

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');

      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.doesNotMatch(statusResult.stdout, /deep-interview: ACTIVE/);
      assert.match(statusResult.stdout, /deep-interview: inactive \(phase: cleared\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not cancel unauthenticated hook-visible run-dir session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-worktree-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-runs-'));
    try {
      const sessionId = 'sess-run-dir-cancel';
      const runDir = join(runsRoot, 'run-20260610121751-b6c4');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(runSessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'deep-interview',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({
        launcher: 'omx --madmax',
        created_at: '2026-06-10T12:17:51.000Z',
        cwd: runDir,
        source_cwd: wd,
        argv: ['codex'],
        run_dir: runDir,
      })}\n`);

      const listResult = runOmxWithEnv(wd, unauthenticatedEnv({}), 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });

      const cancelResult = runOmxWithEnv(
        wd,
        unauthenticatedEnv({ OMX_RUNS_DIR: runsRoot }),
        'cancel',
      );
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr || cancelResult.stdout, /cancel requires a committed authenticated state authority/i);


      const autopilot = JSON.parse(await readFile(join(runSessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, true);
      assert.equal(autopilot.current_phase, 'deep-interview');

      const skillActive = JSON.parse(await readFile(join(runSessionDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(skillActive.active, true);
      assert.equal(skillActive.phase, 'deep-interview');
      assert.deepEqual(
        skillActive.active_skills.map((skill: { active: unknown; phase: unknown }) => ({
          active: skill.active,
          phase: skill.phase,
        })),
        [{ active: true, phase: 'deep-interview' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('does not report unauthenticated hook-visible run-dir session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-status-worktree-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-status-runs-'));
    try {
      const sessionId = 'sess-run-dir-status';
      const runDir = join(runsRoot, 'run-20260610121751-c7d5');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({
        launcher: 'omx --madmax',
        created_at: '2026-06-10T12:17:51.000Z',
        cwd: runDir,
        source_cwd: wd,
        argv: ['codex'],
        run_dir: runDir,
      })}\n`);

      const listResult = runOmxWithEnv(wd, unauthenticatedEnv({}), 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });

      const statusResult = runOmxWithEnv(
        wd,
        unauthenticatedEnv({ OMX_RUNS_DIR: runsRoot }),
        'status',
      );
      assert.notEqual(statusResult.status, 0);
      assert.match(statusResult.stderr || statusResult.stdout, /status requires a committed authenticated state authority/i);

    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('does not trust a bare active record from an explicit worktree_cwd alias', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-source-'));
    const worktree = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-wt-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-runs-'));
    try {
      const sessionId = 'sess-run-dir-worktree-alias';
      const runDir = join(runsRoot, 'run-20260610121751-a11a');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(worktree, '.omx', 'state'), { recursive: true });
      await mkdir(join(runsRoot, 'active-detached'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(runsRoot, 'active-detached', 'ctx-worktree-alias.json'), `${JSON.stringify({
        version: 1,
        context_key: 'ctx-worktree-alias',
        created_at: '2026-06-10T12:17:51.000Z',
        source_cwd: wd,
        worktree_cwd: worktree,
        argv: ['--madmax', '--worktree', '--tmux'],
        run_dir: runDir,
        tmux_session_name: 'omx-detached',
        session_id: sessionId,
        tmux_pane_id: '%42',
      })}\n`);

      const statusResult = runOmxWithEnv(
        worktree,
        unauthenticatedEnv({ OMX_RUNS_DIR: runsRoot }),
        'status',
      );
      assert.notEqual(statusResult.status, 0);
      assert.match(statusResult.stderr || statusResult.stdout, /status requires a committed authenticated state authority/i);

      const cancelResult = runOmxWithEnv(
        worktree,
        unauthenticatedEnv({ OMX_RUNS_DIR: runsRoot }),
        'cancel',
      );
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr || cancelResult.stdout, /cancel requires a committed authenticated state authority/i);

      const autopilot = JSON.parse(await readFile(join(runSessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, true);
      assert.equal(autopilot.current_phase, 'deep-interview');
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('reports stale current-autopilot in status when no authoritative active modes exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-stale-current-autopilot-'));
    try {
      const authorityTransport = await establishCommittedAuthority(wd, 'sess-stale-autopilot');

      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-stale-autopilot' }, null, 2));
      const currentAutopilotPath = join(stateDir, 'current-autopilot.json');
      const currentAutopilot = {
        active: true,
        current_phase: 'complete',
        session_id: 'sess-stale-autopilot',
        tmux_pane_id: '%42',
      };
      await writeFile(currentAutopilotPath, JSON.stringify(currentAutopilot, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: STALE \(phase: complete\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);

      const listResult = runOmxWithEnv(wd, authorityTransport, 'state', 'list-active', '--json');

      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });
      assert.deepEqual(JSON.parse(await readFile(currentAutopilotPath, 'utf-8')), currentAutopilot);
      assert.equal(statusResult.stdout.trim(), 'autopilot: STALE (phase: complete)');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports stale current-autopilot alongside inactive authoritative modes only', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-stale-current-autopilot-with-inactive-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-stale-autopilot-inactive';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      const currentAutopilotPath = join(stateDir, 'current-autopilot.json');
      const currentAutopilot = {
        active: true,
        current_phase: 'complete',
        session_id: sessionId,
        tmux_pane_id: '%43',
      };
      await writeFile(currentAutopilotPath, JSON.stringify(currentAutopilot, null, 2));
      await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({
        active: false,
        mode: 'deep-interview',
        current_phase: 'cleared',
      }, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');

      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /deep-interview: inactive \(phase: cleared\)/);
      assert.match(statusResult.stdout, /autopilot: STALE \(phase: complete\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
      assert.deepEqual(JSON.parse(await readFile(currentAutopilotPath, 'utf-8')), currentAutopilot);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers authoritative active autopilot over stale current-autopilot in status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-active-autopilot-precedence-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-active-autopilot';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(stateDir, 'current-autopilot.json'), JSON.stringify({
        active: true,
        current_phase: 'complete',
        session_id: 'stale-session',
        tmux_pane_id: '%99',
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ralplan',
      }, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');

      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: ACTIVE \(phase: ralplan\)/);
      assert.doesNotMatch(statusResult.stdout, /STALE/);
      assert.doesNotMatch(statusResult.stdout, /phase: complete/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores unreportable current-autopilot in status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-unreportable-current-autopilot-'));
    try {
      const authorityTransport = await establishCommittedAuthority(wd, 'sess-unreportable-autopilot');

      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'current-autopilot.json'), JSON.stringify({ active: true }, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');

      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /No active modes\./);
      assert.doesNotMatch(statusResult.stdout, /STALE/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports durable failed Ultragoal artifacts without advertising a cancellable active mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-failed-ultragoal-'));
    try {
      const authorityTransport = await establishCommittedAuthority(wd, 'sess-failed-ultragoal');

      const ultragoalDir = join(wd, '.omx', 'ultragoal');
      await mkdir(ultragoalDir, { recursive: true });
      await writeFile(join(ultragoalDir, 'goals.json'), JSON.stringify({
        version: 1,
        activeGoalId: 'G001-failed',
        goals: [
          {
            id: 'G001-failed',
            title: 'Failed story',
            objective: 'Preserve failed evidence for retry.',
            status: 'failed',
          },
        ],
      }, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /ultragoal: FAILED \(phase: failed\)/);
      assert.doesNotMatch(statusResult.stdout, /ultragoal: ACTIVE \(phase: failed\)/);

      const cancelResult = runOmxWithEnv(wd, authorityTransport, 'cancel');

      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /No active modes to cancel\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves active Ultragoal mode status when durable failed artifacts coexist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-active-ultragoal-failed-artifact-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-active-ultragoal-failed-artifact';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ultragoalDir = join(wd, '.omx', 'ultragoal');
      await mkdir(sessionDir, { recursive: true });
      await mkdir(ultragoalDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'ultragoal-state.json'), JSON.stringify({
        active: true,
        mode: 'ultragoal',
        current_phase: 'executing',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(ultragoalDir, 'goals.json'), JSON.stringify({
        version: 1,
        activeGoalId: 'G001-failed',
        goals: [
          {
            id: 'G001-failed',
            title: 'Failed story',
            objective: 'Preserve failed evidence for retry.',
            status: 'failed',
          },
        ],
      }, null, 2));

      const statusResult = runOmxWithEnv(wd, authorityTransport, 'status');

      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /ultragoal: ACTIVE \(phase: executing\)/);
      assert.doesNotMatch(statusResult.stdout, /ultragoal: FAILED \(phase: failed\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels linked ultrawork when Ralph is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-link-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-link';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));

      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        linked_ultrawork: true,
      }));
      await writeFile(join(sessionDir, 'ultrawork-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
      }));

      const cancelResult = runOmxWithEnv(wd, authorityTransport, 'cancel');

      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralph/);
      assert.match(cancelResult.stdout, /Cancelled: ultrawork/);

      const ralph = JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, false);
      assert.equal(ralph.current_phase, 'cancelled');
      assert.ok(typeof ralph.completed_at === 'string');

      const ultrawork = JSON.parse(await readFile(join(sessionDir, 'ultrawork-state.json'), 'utf-8'));
      assert.equal(ultrawork.active, false);
      assert.equal(ultrawork.current_phase, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not mutate unrelated sessions when cancelling current session mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cross-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const authorityTransport = await establishCommittedAuthority(wd, 'sessA');

      const sessionA = join(stateDir, 'sessions', 'sessA');
      const sessionB = join(stateDir, 'sessions', 'sessB');
      await mkdir(sessionA, { recursive: true });
      await mkdir(sessionB, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sessA' }));

      await writeFile(join(sessionA, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
      }));
      await writeFile(join(sessionB, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
      }));

      const cancelResult = runOmxWithEnv(wd, authorityTransport, 'cancel');

      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralph/);

      const aState = JSON.parse(await readFile(join(sessionA, 'ralph-state.json'), 'utf-8'));
      const bState = JSON.parse(await readFile(join(sessionB, 'ralph-state.json'), 'utf-8'));
      assert.equal(aState.active, false);
      assert.equal(aState.current_phase, 'cancelled');
      assert.equal(bState.active, true);
      assert.equal(bState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('clears current-session autopilot and skill mirrors even when canonical root is inactive', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-clear-stale-autopilot-mirror-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-stale-autopilot-mirror';
      const authorityTransport = await establishCommittedAuthority(wd, sessionId);
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify({
        active: false,
        mode: 'autopilot',
        current_phase: 'cancelled',
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: '',
        phase: 'cancelled',
        active_skills: [],
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ultragoal',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'ultragoal',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
      }, null, 2));
      await writeFile(join(sessionDir, 'native-stop-state.json'), JSON.stringify({
        sessions: { [sessionId]: { last_signature: 'autopilot-stop|stale' } },
      }, null, 2));

      const clearAutopilot = runOmxWithEnv(wd, authorityTransport, 'state', 'clear', '--input', `{"mode":"autopilot","session_id":"${sessionId}"}`, '--json');
      assert.equal(clearAutopilot.status, 0, clearAutopilot.stderr || clearAutopilot.stdout);
      const clearSkill = runOmxWithEnv(wd, authorityTransport, 'state', 'clear', '--input', `{"mode":"skill-active","session_id":"${sessionId}"}`, '--json');
      assert.equal(clearSkill.status, 0, clearSkill.stderr || clearSkill.stdout);
      const cancelForce = runOmxWithEnv(wd, authorityTransport, 'cancel', '--force');
      assert.equal(cancelForce.status, 0, cancelForce.stderr || cancelForce.stdout);

      const autopilot = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, 'cleared');
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);
      const nativeStop = JSON.parse(await readFile(join(sessionDir, 'native-stop-state.json'), 'utf-8'));
      assert.deepEqual(nativeStop.sessions, {});
      const listResult = runOmxWithEnv(wd, authorityTransport, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
