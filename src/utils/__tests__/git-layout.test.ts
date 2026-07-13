import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  findCanonicalGitLayout,
  resolveWorkspaceIdentity,
} from '../git-layout.js';

async function initRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'omx-git-layout-'));
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository, stdio: 'ignore' });
  await writeFile(join(repository, 'README.md'), 'fixture\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });
  return repository;
}

function siblingWorktreePath(repository: string, name: string): string {
  return join(repository, '..', `${basename(repository)}-${name}`);
}

describe('canonical Git layout identity', () => {
  it('uses linked-worktree roots as distinct identities while retaining shared common-dir lineage', async () => {
    const repository = await initRepository();
    const worktree = siblingWorktreePath(repository, 'linked');
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'fixture/linked', worktree, 'HEAD'], {
        cwd: repository,
        stdio: 'ignore',
      });

      const main = findCanonicalGitLayout(repository);
      const linked = findCanonicalGitLayout(worktree);
      assert.ok(main);
      assert.ok(linked);
      assert.notEqual(main.worktreeRoot, linked.worktreeRoot);
      assert.equal(main.commonDir, linked.commonDir);

      const mainIdentity = resolveWorkspaceIdentity(repository);
      const linkedIdentity = resolveWorkspaceIdentity(worktree);
      assert.equal(mainIdentity.kind, 'git-worktree');
      assert.equal(linkedIdentity.kind, 'git-worktree');
      assert.notEqual(mainIdentity.digest, linkedIdentity.digest);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('canonicalizes a symlinked cwd without changing the worktree identity', async () => {
    const repository = await initRepository();
    const aliasParent = await mkdtemp(join(tmpdir(), 'omx-git-layout-alias-'));
    const alias = join(aliasParent, 'repository-alias');
    try {
      await mkdir(join(repository, 'nested'), { recursive: true });
      await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');

      const direct = resolveWorkspaceIdentity(join(repository, 'nested'));
      const throughAlias = resolveWorkspaceIdentity(join(alias, 'nested'));
      assert.equal(direct.kind, 'git-worktree');
      assert.deepEqual(throughAlias, direct);
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('rejects malformed .git file pointers instead of treating them as a workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omx-git-layout-malformed-'));
    try {
      await writeFile(join(directory, '.git'), 'not a gitdir pointer\n', 'utf-8');
      assert.throws(() => findCanonicalGitLayout(directory), /malformed \.git file/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the canonical startup cwd for a non-Git workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omx-git-layout-non-git-'));
    try {
      const identity = resolveWorkspaceIdentity(directory);
      assert.equal(identity.kind, 'startup-cwd');
      assert.equal(identity.canonical_path, await realpath(directory));
      assert.equal(identity.digest.length, 64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
