import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'path';
import {
  teamRuntimeSessionPath,
  teamRuntimeTeamRoot,
  teamRuntimeTeamsRoot,
  teamStartupTimingPath,
} from '../runtime.js';

describe('team runtime boxed state path helpers', () => {
  it('keeps runtime-owned team paths under canonical workspace state despite ambient roots', () => {
    const previousRoot = process.env.OMX_ROOT;
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      const source = resolve('/tmp/source');
      process.env.OMX_ROOT = '/tmp/box';
      process.env.OMX_STATE_ROOT = '/tmp/explicit-state';
      process.env.OMX_TEAM_STATE_ROOT = '/tmp/explicit-team-state';

      assert.equal(teamRuntimeTeamsRoot(source), join(source, '.omx', 'state', 'team'));
      assert.equal(teamRuntimeTeamRoot('team-a', source), join(source, '.omx', 'state', 'team', 'team-a'));
      assert.equal(
        teamStartupTimingPath('team-a', source),
        join(source, '.omx', 'state', 'team', 'team-a', 'startup-timing.json'),
      );
      assert.equal(teamRuntimeSessionPath(source), join(source, '.omx', 'state', 'session.json'));

      assert.equal(teamRuntimeTeamsRoot(source), join(source, '.omx', 'state', 'team'));
      assert.equal(
        teamStartupTimingPath('team-a', source),
        join(source, '.omx', 'state', 'team', 'team-a', 'startup-timing.json'),
      );
    } finally {
      if (typeof previousRoot === 'string') process.env.OMX_ROOT = previousRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousStateRoot === 'string') process.env.OMX_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
    }
  });
});
