import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'fs';

import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import {
  resolveCanonicalTeamStateRoot,
  resolveWorkerNotifyTeamStateRoot,
  resolveWorkerNotifyTeamStateRootPath,
  resolveWorkerTeamStateRoot,
  resolveWorkerTeamStateRootPath,
} from '../state-root.js';
import {
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
  resolveWorkspaceIdentity,
  stateAuthorityPaths,
} from '../../state/authority.js';

import { resolveTeamStateDirForWorker } from '../../scripts/notify-hook/team-worker.js';

describe('state-root', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omx/state', () => {
    const project = resolve('/tmp/demo/project');
    assert.equal(
      resolveCanonicalTeamStateRoot(project, {}),
      join(project, '.omx', 'state'),
    );
  });

  it('does not treat public root overrides as canonical team authority', () => {
    const project = resolve('/tmp/demo/project');
    assert.equal(
      resolveCanonicalTeamStateRoot(project, {
        OMX_TEAM_STATE_ROOT: '/tmp/shared/team-state',
        OMX_ROOT: '/tmp/omx-box',
        OMX_STATE_ROOT: '/tmp/another-box',
      }),
      join(project, '.omx', 'state'),
    );
  });

  async function authenticatedTransport(
    authority: Awaited<ReturnType<typeof initializeStateAuthority>>,
  ): Promise<NodeJS.ProcessEnv> {
    const minted = await mintStateAuthorityTransportCapability(authority);
    return {
      OMX_STARTUP_CWD: authority.workspace_identity.canonical_path,
      OMX_STATE_AUTHORITY_PATH: authority.authority_path,
      OMX_STATE_AUTHORITY_ID: authority.generation.authority_id,
      OMX_STATE_AUTHORITY_GENERATION_ID: authority.generation.generation_id,
      OMX_STATE_AUTHORITY_WORKSPACE_DIGEST: authority.workspace_identity.digest,
      OMX_STATE_AUTHORITY_CAPABILITY: minted.capability,
    };
  }

  it('fails closed for every missing persisted authority transport field or opaque bearer', async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'omx-team-root-missing-bearer-'),
    );
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-missing-bearer',
        session_binding: {
          canonical_session_id: 'team-root-missing-bearer-session',
        },
      });
      const transport = await authenticatedTransport(authority);
      for (const missingKey of [
        'OMX_STATE_AUTHORITY_PATH',
        'OMX_STATE_AUTHORITY_ID',
        'OMX_STATE_AUTHORITY_GENERATION_ID',
        'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
        'OMX_STATE_AUTHORITY_CAPABILITY',
      ]) {
        const incomplete = { ...transport };
        delete incomplete[missingKey];
      assert.throws(
          () => resolveCanonicalTeamStateRoot(workspace, incomplete),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'authority_generation_missing',
      );
      }
      assert.throws(
        () =>
          resolveCanonicalTeamStateRoot(workspace, {
          ...transport,
            OMX_STATE_AUTHORITY_CAPABILITY:
              'forged-opaque-bearer-that-does-not-match-the-anchor',
        }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_transport_capability_invalid',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects copied full authority transport from an unrelated team workspace', async () => {
    const source = await mkdtemp(join(tmpdir(), 'omx-team-root-source-'));
    const unrelated = await mkdtemp(join(tmpdir(), 'omx-team-root-unrelated-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: source,
        observed_cwd: source,
        launch_id: 'team-root-copied-transport',
        session_binding: {
          canonical_session_id: 'team-root-copied-transport-session',
        },
      });
      const transport = await authenticatedTransport(authority);
      assert.throws(
        () => resolveCanonicalTeamStateRoot(unrelated, transport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_observed_cwd_outside_workspace',
      );
    } finally {
      await Promise.all([
        rm(source, { recursive: true, force: true }),
        rm(unrelated, { recursive: true, force: true }),
      ]);
    }
  });

  it('accepts nested paths and canonical aliases but rejects linked worktrees', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-team-root-linked-'));
    const linkedWorkspace = `${workspace}-linked`;
    const workspaceAlias = `${workspace}-alias`;
    try {
      execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'team-root@example.com'], {
        cwd: workspace,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'Team Root'], {
        cwd: workspace,
        stdio: 'ignore',
      });
      await writeFile(join(workspace, 'README.md'), 'fixture\n', 'utf8');
      execFileSync('git', ['add', 'README.md'], {
        cwd: workspace,
        stdio: 'ignore',
      });
      execFileSync('git', ['commit', '-m', 'fixture'], {
        cwd: workspace,
        stdio: 'ignore',
      });
      await mkdir(join(workspace, 'nested'), { recursive: true });
      await symlink(
        workspace,
        workspaceAlias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      execFileSync(
        'git',
        ['worktree', 'add', '-b', 'team-root-linked', linkedWorkspace, 'HEAD'],
        {
          cwd: workspace,
          stdio: 'ignore',
        },
      );
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-linked-transport',
        session_binding: {
          canonical_session_id: 'team-root-linked-transport-session',
        },
      });
      const transport = await authenticatedTransport(authority);
      for (const observedCwd of [
        join(workspace, 'nested'),
        join(workspaceAlias, 'nested'),
      ]) {
        assert.equal(
          resolveCanonicalTeamStateRoot(observedCwd, transport),
          authority.canonical_state_root,
        );
      }
      assert.throws(
        () => resolveCanonicalTeamStateRoot(linkedWorkspace, transport),
        (error: unknown) =>
          error instanceof Error
          && 'code' in error
          && error.code === 'authority_observed_cwd_outside_workspace',
      );
    } finally {
      await Promise.all([
        rm(workspaceAlias, { recursive: true, force: true }),
        rm(linkedWorkspace, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  });

  it('rejects stale tuple fields, revoked capabilities, and expired opaque transport capability', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-team-root-stale-'));
    const expiredWorkspace = await mkdtemp(
      join(tmpdir(), 'omx-team-root-expired-'),
    );
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-stale-transport',
        session_binding: {
          canonical_session_id: 'team-root-stale-transport-session',
        },
      });
      const staleTransport = await authenticatedTransport(authority);
      staleTransport.OMX_STATE_AUTHORITY_GENERATION_ID = 'stale-generation';
      assert.throws(
        () => resolveCanonicalTeamStateRoot(workspace, staleTransport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_anchor_revision_conflict',
      );

      const revokedTransport = await authenticatedTransport(authority);
      const anchorPath = stateAuthorityPaths(
        resolveWorkspaceIdentity(workspace),
      ).anchor_path;
      const anchor = JSON.parse(await readFile(anchorPath, 'utf8')) as {
        transport_capability?: Record<string, unknown>;
      };
      if (!anchor.transport_capability)
        throw new Error('expected an active transport capability');
      anchor.transport_capability = {
        ...anchor.transport_capability,
        status: 'revoked',
        revoked_at: new Date().toISOString(),
      };
      await writeFile(anchorPath, JSON.stringify(anchor), 'utf8');
      assert.throws(
        () => resolveCanonicalTeamStateRoot(workspace, revokedTransport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_transport_capability_invalid',
      );
      const expiredAuthority = await initializeStateAuthority({
        startup_cwd: expiredWorkspace,
        observed_cwd: expiredWorkspace,
        launch_id: 'team-root-expired-transport',
        session_binding: {
          canonical_session_id: 'team-root-expired-transport-session',
        },
      });
      const expired = await mintStateAuthorityTransportCapability(
        expiredAuthority,
        {
        now: new Date(Date.now() - 1_000),
        ttl_ms: 1,
        },
      );
      assert.throws(
        () =>
          resolveCanonicalTeamStateRoot(expiredWorkspace, {
          OMX_STARTUP_CWD: expiredAuthority.workspace_identity.canonical_path,
          OMX_STATE_AUTHORITY_PATH: expiredAuthority.authority_path,
          OMX_STATE_AUTHORITY_ID: expiredAuthority.generation.authority_id,
            OMX_STATE_AUTHORITY_GENERATION_ID:
              expiredAuthority.generation.generation_id,
            OMX_STATE_AUTHORITY_WORKSPACE_DIGEST:
              expiredAuthority.workspace_identity.digest,
          OMX_STATE_AUTHORITY_CAPABILITY: expired.capability,
        }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_transport_capability_expired',
      );
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(expiredWorkspace, { recursive: true, force: true }),
      ]);
    }
  });

  it('rejects stale copied anchor transport when its bootstrap parent is replaced by a symlink', async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'omx-team-root-symlink-anchor-'),
    );
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-symlink-anchor',
        session_binding: {
          canonical_session_id: 'team-root-symlink-anchor-session',
        },
      });
      const staleTransport = await authenticatedTransport(authority);
      const anchorPath = stateAuthorityPaths(
        resolveWorkspaceIdentity(workspace),
      ).anchor_path;
      const staleAnchor = await readFile(anchorPath, 'utf8');
      await mintStateAuthorityTransportCapability(authority);

      const bootstrapDirectory = join(workspace, '.omx', 'bootstrap');
      const copiedBootstrapDirectory = join(
        workspace,
        '.omx',
        'copied-bootstrap',
      );
      const currentBootstrapDirectory = join(
        workspace,
        '.omx',
        'current-bootstrap',
      );
      await mkdir(copiedBootstrapDirectory, { recursive: true });
      await writeFile(
        join(copiedBootstrapDirectory, basename(anchorPath)),
        staleAnchor,
        'utf8',
      );
      await rename(bootstrapDirectory, currentBootstrapDirectory);
      await symlink(
        copiedBootstrapDirectory,
        bootstrapDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      assert.throws(
        () => resolveCanonicalTeamStateRoot(workspace, staleTransport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_anchor_malformed' &&
          /unsafe component: .*\.omx[/\\]bootstrap/.test(error.message),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a byte-identical binding replacement during synchronous transport validation', async () => {
    const workspace = await realpath(await mkdtemp(
      join(tmpdir(), 'omx-team-root-byte-identical-replacement-'),
    ));
    const replacementPath = join(workspace, 'replacement-binding.json');
    const originalJsonParse = JSON.parse;
    let replaced = false;
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-byte-identical-replacement',
        session_binding: {
          canonical_session_id: 'team-root-byte-identical-replacement-session',
        },
      });
      const transport = await authenticatedTransport(authority);
      const bindingId = authority.session_binding?.binding_id;
      assert.ok(bindingId);
      const bindingPath = join(
        authority.canonical_state_root,
        'authority',
        'generations',
        authority.generation.generation_id,
        'bindings',
        `${bindingId}.json`,
      );

      JSON.parse = ((
        text: string,
        reviver?: (this: unknown, key: string, value: unknown) => unknown,
      ) => {
        const parsed = originalJsonParse(text, reviver);
        if (
          !replaced &&
          text.includes('"binding_id"') &&
          text.includes('"canonical_session_id"')
        ) {
          writeFileSync(replacementPath, text, 'utf8');
          renameSync(replacementPath, bindingPath);
          replaced = true;
        }
        return parsed;
      }) as typeof JSON.parse;

      assert.throws(
        () => resolveCanonicalTeamStateRoot(workspace, transport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_session_binding_conflict',
      );
      assert.equal(replaced, true);
    } finally {
      JSON.parse = originalJsonParse;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects conflicting ambient aliases after synchronous bearer authentication', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-team-root-conflict-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'team-root-conflicting-alias',
        session_binding: {
          canonical_session_id: 'team-root-conflicting-alias-session',
        },
      });
      const transport = await authenticatedTransport(authority);
      transport.OMX_TEAM_STATE_ROOT = join(workspace, 'foreign-state');
      assert.throws(
        () => resolveCanonicalTeamStateRoot(workspace, transport),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'authority_workspace_mismatch',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  async function writeTeamMetadata(
    stateRoot: string,
    teamName: string,
    filename: 'config.json' | 'manifest.v2.json',
    workers: Array<{ name: string }>,
    extra: Record<string, unknown> = {},
  ) {
    const teamDir = join(stateRoot, 'team', teamName);
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      join(teamDir, filename),
      JSON.stringify(
        {
      name: teamName,
      workers,
      ...extra,
        },
        null,
        2,
      ),
    );
  }

  async function writeIdentity(
    stateRoot: string,
    teamName: string,
    workerName: string,
    worktreePath: string,
    teamStateRoot: string = stateRoot,
  ) {
    const workerDir = join(stateRoot, 'team', teamName, 'workers', workerName);
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, 'identity.json'),
      JSON.stringify(
        {
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: ['1'],
      worktree_path: worktreePath,
      team_state_root: teamStateRoot,
        },
        null,
        2,
      ),
    );
  }

  it('resolves worker root from OMX_TEAM_STATE_ROOT only when identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-env-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    assert.equal(
      await resolveWorkerTeamStateRootPath(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
        OMX_TEAM_STATE_ROOT: stateRoot,
        },
      ),
      stateRoot,
    );

    const rejected = await resolveWorkerTeamStateRootPath(
      worktree,
      { teamName: 'team-a', workerName: 'worker-2' },
      {
      OMX_TEAM_STATE_ROOT: stateRoot,
      },
    );
    assert.equal(rejected, null);
  });

  it('denies raw-root-only workers once their leader has a committed authority', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'omx-state-root-raw-authority-denial-'),
    );
    const leader = join(root, 'leader');
    const worker = join(root, 'worker');
    try {
      await Promise.all([
        mkdir(leader, { recursive: true }),
        mkdir(worker, { recursive: true }),
      ]);
      const authority = await initializeStateAuthority({
        startup_cwd: leader,
        observed_cwd: leader,
        launch_id: 'team-root-raw-authority-denial',
        session_binding: {
          canonical_session_id: 'team-root-raw-authority-denial-session',
        },
      });
      await writeIdentity(
        authority.canonical_state_root,
        'team-a',
        'worker-1',
        worker,
      );

      const resolved = await resolveWorkerTeamStateRoot(
        worker,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
          OMX_TEAM_LEADER_CWD: leader,
          OMX_TEAM_STATE_ROOT: authority.canonical_state_root,
        },
      );
      assert.equal(resolved.ok, false);
      assert.equal(resolved.reason, 'authority_generation_missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('denies bearerless explicit roots that retain authority protocol evidence without a leader hint', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'omx-state-root-explicit-protocol-evidence-'),
    );
    try {
      for (const kind of [
        'anchor',
        'generation',
        'journal',
        'tombstone',
      ] as const) {
        const workspace = join(root, kind);
        const stateRoot = join(workspace, '.omx', 'state');
        const worktree = join(workspace, 'worker');
        await mkdir(worktree, { recursive: true });
        await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);
        if (kind === 'anchor') {
          await mkdir(join(workspace, '.omx', 'bootstrap'), {
            recursive: true,
          });
          await writeFile(
            join(workspace, '.omx', 'bootstrap', 'state-authority-anchor.json'),
            '{}',
          );
        } else if (kind === 'generation') {
          await mkdir(
            join(stateRoot, 'authority', 'generations', 'retained-generation'),
            { recursive: true },
          );
        } else if (kind === 'journal') {
          await mkdir(
            join(stateRoot, 'authority', 'journals', 'retained-journal'),
            { recursive: true },
          );
        } else {
          await mkdir(join(stateRoot, 'authority'), { recursive: true });
          await writeFile(
            join(stateRoot, 'authority', 'state-authority-tombstones.jsonl'),
            '{}\n',
          );
        }

        const resolved = await resolveWorkerTeamStateRoot(
          worktree,
          { teamName: 'team-a', workerName: 'worker-1' },
          {
            OMX_TEAM_STATE_ROOT: stateRoot,
          },
        );
        assert.equal(resolved.ok, false, kind);
        assert.equal(resolved.reason, 'authority_generation_missing', kind);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves from leader cwd state root when worker identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-leader-'));
    const leader = join(root, 'leader');
    const worktree = join(root, 'worker');
    const stateRoot = join(leader, '.omx', 'state');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {
      OMX_TEAM_LEADER_CWD: leader,
      },
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'leader_cwd');
  });

  it('allows cwd .omx/state only when identity exists and worktree path matches cwd', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'omx-state-root-cwd-'));
    const stateRoot = join(worktree, '.omx', 'state');
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {},
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'cwd');
  });

  it('resolves non-git worker notify root from identity metadata without probing local cwd state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-'));
    const leader = join(root, 'leader');
    const leaderHintRoot = join(leader, '.omx', 'state');
    const canonicalStateRoot = join(root, 'canonical-state');
    const worktree = join(root, 'worker');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(
      leaderHintRoot,
      'team-a',
      'worker-1',
      worktree,
      canonicalStateRoot,
    );
    await writeIdentity(canonicalStateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerNotifyTeamStateRoot(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {
      OMX_TEAM_LEADER_CWD: leader,
      },
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, canonicalStateRoot);
    assert.equal(resolved.source, 'identity_metadata');
  });

  it('rejects non-git worker notify roots backed only by worker or team markers', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'omx-state-root-notify-markers-'),
    );
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });
    try {
      const workerDirectoryStateRoot = join(root, 'worker-directory-state');
      await mkdir(
        join(workerDirectoryStateRoot, 'team', 'team-a', 'workers', 'worker-1'),
        { recursive: true },
      );
      const workerDirResolved = await resolveWorkerNotifyTeamStateRoot(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        { OMX_TEAM_STATE_ROOT: workerDirectoryStateRoot },
      );
      assert.deepEqual(workerDirResolved, {
        ok: false,
        stateRoot: null,
        source: 'env',
        reason: 'missing_or_invalid_identity',
        identityPath: join(
          workerDirectoryStateRoot,
          'team',
          'team-a',
          'workers',
          'worker-1',
          'identity.json',
        ),
      });

      const configStateRoot = join(root, 'config-state');
      await writeTeamMetadata(configStateRoot, 'team-a', 'config.json', [
        { name: 'worker-2' },
      ]);
      const configResolved = await resolveWorkerNotifyTeamStateRoot(
        worktree,
        { teamName: 'team-a', workerName: 'worker-2' },
        { OMX_TEAM_STATE_ROOT: configStateRoot },
      );
      assert.deepEqual(configResolved, {
        ok: false,
        stateRoot: null,
        source: 'env',
        reason: 'missing_or_invalid_identity',
        identityPath: join(
          configStateRoot,
          'team',
          'team-a',
          'workers',
          'worker-2',
          'identity.json',
        ),
      });

      const manifestStateRoot = join(root, 'manifest-state');
      await writeTeamMetadata(manifestStateRoot, 'team-a', 'manifest.v2.json', [
        { name: 'worker-3' },
      ]);
      const manifestResolved = await resolveWorkerNotifyTeamStateRoot(
        worktree,
        { teamName: 'team-a', workerName: 'worker-3' },
        { OMX_TEAM_STATE_ROOT: manifestStateRoot },
      );
      assert.deepEqual(manifestResolved, {
        ok: false,
        stateRoot: null,
        source: 'env',
        reason: 'missing_or_invalid_identity',
        identityPath: join(
          manifestStateRoot,
          'team',
          'team-a',
          'workers',
          'worker-3',
          'identity.json',
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-git worker notify roots without a matching canonical marker', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'omx-state-root-notify-reject-markers-'),
    );
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(stateRoot, { recursive: true });
    await mkdir(worktree, { recursive: true });

    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
        OMX_TEAM_STATE_ROOT: stateRoot,
        },
      ),
      null,
    );

    const wrongTeamRoot = join(root, 'wrong-team');
    await writeTeamMetadata(
      wrongTeamRoot,
      'team-a',
      'config.json',
      [{ name: 'worker-1' }],
      { name: 'other-team' },
    );
    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
        OMX_TEAM_STATE_ROOT: wrongTeamRoot,
        },
      ),
      null,
    );

    const missingWorkerRoot = join(root, 'missing-worker');
    await writeTeamMetadata(missingWorkerRoot, 'team-a', 'config.json', [
      { name: 'worker-2' },
    ]);
    await writeTeamMetadata(missingWorkerRoot, 'team-a', 'manifest.v2.json', [
      { name: 'worker-3' },
    ]);
    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
        OMX_TEAM_STATE_ROOT: missingWorkerRoot,
        },
      ),
      null,
    );
  });

  it('does not guess cwd .omx/state for non-git worker notify resolution', async () => {
    const worktree = await mkdtemp(
      join(tmpdir(), 'omx-state-root-notify-no-cwd-'),
    );
    const stateRoot = join(worktree, '.omx', 'state');
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const notifyResolved = await resolveWorkerNotifyTeamStateRootPath(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {},
    );
    assert.equal(notifyResolved, null);

    const postToolUseResolved = await resolveWorkerTeamStateRootPath(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {},
    );
    assert.equal(postToolUseResolved, stateRoot);
  });

  it('notify-hook worker state resolution reuses the non-git resolver', async () => {
    const previousStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const previousLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      delete process.env.OMX_TEAM_LEADER_CWD;
      const worktree = await mkdtemp(
        join(tmpdir(), 'omx-state-root-notify-reuse-'),
      );
      const stateRoot = join(worktree, '.omx', 'state');
      await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

      assert.equal(
        await resolveTeamStateDirForWorker(worktree, {
          teamName: 'team-a',
          workerName: 'worker-1',
        }),
        null,
      );
    } finally {
      if (typeof previousStateRoot === 'string')
        process.env.OMX_TEAM_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof previousLeaderCwd === 'string')
        process.env.OMX_TEAM_LEADER_CWD = previousLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
    }
  });

  it('rejects missing identity, ambiguous root, and worktree mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-reject-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worker');
    const otherWorktree = join(root, 'other-worker');
    await mkdir(worktree, { recursive: true });
    await mkdir(otherWorktree, { recursive: true });

    assert.equal(
      await resolveWorkerTeamStateRootPath(
        worktree,
        { teamName: 'team-a', workerName: 'worker-1' },
        {
        OMX_TEAM_STATE_ROOT: stateRoot,
        },
      ),
      null,
    );

    await writeIdentity(stateRoot, 'team-a', 'worker-1', otherWorktree);
    const mismatch = await resolveWorkerTeamStateRoot(
      worktree,
      { teamName: 'team-a', workerName: 'worker-1' },
      {
      OMX_TEAM_STATE_ROOT: stateRoot,
      },
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'identity_worktree_mismatch');
  });
  it('uses a validated authority root for nested workers and rejects conflicting or replaced roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-authority-'));
    const leader = join(root, 'leader');
    const workerCwd = join(leader, 'worker');
    const nestedWorkerCwd = join(workerCwd, 'nested');
    const localWorkerStateRoot = join(workerCwd, '.omx', 'state');
    try {
      await Promise.all([
        mkdir(leader, { recursive: true }),
        mkdir(nestedWorkerCwd, { recursive: true }),
      ]);
      const authority = await initializeStateAuthority({
        startup_cwd: leader,
        observed_cwd: leader,
        launch_id: 'team-root-test',
        session_binding: { canonical_session_id: 'session-team-root' },
      });
      await writeIdentity(
        authority.canonical_state_root,
        'team-a',
        'worker-1',
        workerCwd,
      );
      await writeIdentity(
        localWorkerStateRoot,
        'team-a',
        'worker-1',
        workerCwd,
      );
      const transport = await authenticatedTransport(authority);

      const nested = await resolveWorkerTeamStateRoot(
        nestedWorkerCwd,
        { teamName: 'team-a', workerName: 'worker-1' },
        transport,
      );
      assert.equal(nested.ok, true);
      assert.equal(nested.source, 'authority');
      assert.equal(nested.stateRoot, authority.canonical_state_root);

      const conflict = await resolveWorkerTeamStateRoot(
        nestedWorkerCwd,
        { teamName: 'team-a', workerName: 'worker-1' },
        { ...transport, OMX_TEAM_STATE_ROOT: localWorkerStateRoot },
      );
      assert.equal(conflict.ok, false);
      assert.equal(conflict.reason, 'authority_env_root_conflict');

      await rm(join(authority.canonical_state_root, 'team'), {
        recursive: true,
        force: true,
      });
      const deniedLocalFallback = await resolveWorkerTeamStateRoot(
        nestedWorkerCwd,
        { teamName: 'team-a', workerName: 'worker-1' },
        transport,
      );
      assert.equal(deniedLocalFallback.ok, false);
      assert.equal(deniedLocalFallback.stateRoot, null);
      assert.equal(deniedLocalFallback.source, 'authority');

      await rm(authority.canonical_state_root, {
        recursive: true,
        force: true,
      });
      await mkdir(authority.canonical_state_root, { recursive: true });
      const replaced = await resolveWorkerTeamStateRoot(
        nestedWorkerCwd,
        { teamName: 'team-a', workerName: 'worker-1' },
        transport,
      );
      assert.deepEqual(replaced, {
        ok: false,
        stateRoot: null,
        source: null,
        reason: 'authority_generation_malformed',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
