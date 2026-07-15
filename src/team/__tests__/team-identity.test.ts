import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEAM_NAME_SAFE_PATTERN } from '../contracts.js';
import { buildInternalTeamName, resolveTeamIdentityScope, resolveTeamNameForCurrentContext, TeamLookupAmbiguityError } from '../team-identity.js';
import { initTeamState } from '../state.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const longDisplay = 'this-is-a-very-long-team-display-name-that-would-overflow';

async function writePhase(cwd: string, teamName: string, currentPhase: string, updatedAt: string): Promise<void> {
  await writeFile(join(cwd, '.omx', 'state', 'team', teamName, 'phase.json'), JSON.stringify({
    current_phase: currentPhase,
    max_fix_attempts: 3,
    current_fix_attempt: 0,
    transitions: [],
    updated_at: updatedAt,
  }, null, 2));
}

describe('team identity', () => {
  it('builds stable valid internal names for same display and distinct sessions', () => {
    const a = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const b = buildInternalTeamName(longDisplay, { sessionId: 'session-b', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const a2 = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const runA = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-a', source: 'run-id' });
    const runB = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-b', source: 'run-id' });

    assert.notEqual(a, b);
    assert.notEqual(runA, runB);
    assert.equal(a, a2);
    assert.equal(a.length <= 30, true);
    assert.match(a, TEAM_NAME_SAFE_PATTERN);
  });

  it('does not use cwd session.json as the identity source when env is absent', () => {
    const scope = resolveTeamIdentityScope({ TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%42' });
    assert.equal(scope.source, 'tmux-pane');
    assert.equal(scope.paneId, '%42');
  });

  it('keeps ambient root combinations out of canonical persistence and lookup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-canonical-'));
    const foreignTeamStateRoot = await mkdtemp(join(tmpdir(), 'omx-team-identity-foreign-team-'));
    const foreignOmxRoot = await mkdtemp(join(tmpdir(), 'omx-team-identity-foreign-root-'));
    const foreignStateRoot = await mkdtemp(join(tmpdir(), 'omx-team-identity-foreign-state-'));
    const previous = {
      teamStateRoot: process.env.OMX_TEAM_STATE_ROOT,
      root: process.env.OMX_ROOT,
      stateRoot: process.env.OMX_STATE_ROOT,
    };
    const teamName = 'shared-demo-aaaaaaaa';
    try {
      process.env.OMX_TEAM_STATE_ROOT = foreignTeamStateRoot;
      process.env.OMX_ROOT = foreignOmxRoot;
      process.env.OMX_STATE_ROOT = foreignStateRoot;
      await initTeamState(teamName, 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-shared' }, {
        display_name: 'shared-demo', requested_name: 'shared-demo', identity_source: 'env-session',
      });

      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'config.json')), true);
      assert.equal(
        resolveTeamNameForCurrentContext('shared-demo', cwd, {
          OMX_SESSION_ID: 'session-shared',
          OMX_TEAM_STATE_ROOT: foreignTeamStateRoot,
          OMX_ROOT: foreignOmxRoot,
          OMX_STATE_ROOT: foreignStateRoot,
        }),
        teamName,
      );
      for (const root of [
        foreignTeamStateRoot,
        join(foreignOmxRoot, '.omx', 'state'),
        join(foreignStateRoot, '.omx', 'state'),
      ]) {
        assert.equal(existsSync(join(root, 'team', teamName)), false);
      }
    } finally {
      if (typeof previous.teamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previous.teamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof previous.root === 'string') process.env.OMX_ROOT = previous.root;
      else delete process.env.OMX_ROOT;
      if (typeof previous.stateRoot === 'string') process.env.OMX_STATE_ROOT = previous.stateRoot;
      else delete process.env.OMX_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(foreignTeamStateRoot, { recursive: true, force: true });
      await rm(foreignOmxRoot, { recursive: true, force: true });
      await rm(foreignStateRoot, { recursive: true, force: true });
    }
  });

  it('uses authenticated worker authority for canonical lookup and isolates conflicting ambient roots', async () => {
    const leaderCwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-authority-'));
    const workerCwd = join(leaderCwd, 'worker');
    const foreignRoot = await mkdtemp(join(tmpdir(), 'omx-team-identity-authority-foreign-'));
    const teamName = 'worker-demo-aaaaaaaa';
    try {
      await mkdir(workerCwd, { recursive: true });
      const authority = await initializeStateAuthority({
        startup_cwd: leaderCwd,
        observed_cwd: leaderCwd,
        launch_id: 'team-identity-worker-authority',
        session_binding: { canonical_session_id: 'session-worker-authority' },
      });
      await mintStateAuthorityTransportCapability(authority);
      await initTeamState(teamName, 'task', 'executor', 1, leaderCwd, undefined, {
        OMX_SESSION_ID: 'session-worker-authority',
      }, {
        display_name: 'worker-demo', requested_name: 'worker-demo', identity_source: 'env-session',
      });

      const transport = buildStateAuthorityTransportEnv(authority, {
        OMX_SESSION_ID: 'session-worker-authority',
      });
      assert.equal(resolveTeamNameForCurrentContext('worker-demo', workerCwd, transport), teamName);
      for (const [name, value] of [
        ['OMX_TEAM_STATE_ROOT', foreignRoot],
        ['OMX_ROOT', foreignRoot],
        ['OMX_STATE_ROOT', foreignRoot],
      ]) {
        assert.throws(
          () => resolveTeamNameForCurrentContext('worker-demo', workerCwd, { ...transport, [name]: value }),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'authority_workspace_mismatch',
        );
      }
      assert.equal(existsSync(join(foreignRoot, 'team', teamName)), false);
    } finally {
      await rm(leaderCwd, { recursive: true, force: true });
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });



  it('prefers active display-name candidates over retained terminal states', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-active-'));
    try {
      await initTeamState('demo-active', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-active' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-terminal', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-terminal' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-terminal', 'complete', '2026-01-01T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('prefers active display-name candidates over an exact retained terminal directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-exact-terminal-'));
    try {
      await initTeamState('demo', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-terminal' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-active' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo', 'complete', '2026-01-01T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-aaaaaaaa');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses current leader identity to break active display-name ties', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-current-'));
    try {
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-a' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-bbbbbbbb', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-b' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-b' }), 'demo-bbbbbbbb');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses current leader identity before latest retained terminal state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-terminal-current-'));
    try {
      await initTeamState('demo-old-current', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-current' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-new-other', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-other' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-old-current', 'failed', '2026-01-01T00:00:00.000Z');
      await writePhase(cwd, 'demo-new-other', 'complete', '2026-01-02T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-current' }), 'demo-old-current');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a retained terminal session binding instead of selecting another active team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-terminal-pane-'));
    try {
      await initTeamState('demo-terminal-current', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-current' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-active-other', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-other' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-terminal-current', 'complete', '2026-01-01T00:00:00.000Z');

      assert.equal(
        resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-current' }),
        'demo-terminal-current',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves the latest retained terminal display-name state only when unambiguous', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-latest-terminal-'));
    try {
      await initTeamState('demo-old', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-old' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-new', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-new' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-old', 'failed', '2026-01-01T00:00:00.000Z');
      await writePhase(cwd, 'demo-new', 'complete', '2026-01-03T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-new');

      await writePhase(cwd, 'demo-old', 'failed', '2026-01-03T00:00:00.000Z');
      assert.throws(() => resolveTeamNameForCurrentContext('demo', cwd, {}), TeamLookupAmbiguityError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });



  it('sanitizes unsafe lookup input instead of returning raw path-like names', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-unsafe-'));
    try {
      assert.equal(resolveTeamNameForCurrentContext('../../victim', cwd, {}), 'victim');
      assert.equal(resolveTeamNameForCurrentContext('Demo Team', cwd, {}), 'demo-team');
      assert.throws(() => resolveTeamNameForCurrentContext('---', cwd, {}), /invalid_team_name/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves display names to the current session candidate and fails closed on ambiguity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-'));
    try {
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-a' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-bbbbbbbb', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-b' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-a' }), 'demo-aaaaaaaa');
      assert.equal(resolveTeamNameForCurrentContext('demo-bbbbbbbb', cwd, {}), 'demo-bbbbbbbb');
      assert.throws(() => resolveTeamNameForCurrentContext('demo', cwd, {}), TeamLookupAmbiguityError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
