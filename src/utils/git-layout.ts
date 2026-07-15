import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface GitLayout {
  gitDir: string;
  commonDir: string;
  worktreeRoot: string;
}

export interface CanonicalGitLayout extends GitLayout {
  startupCwd: string;
}

export interface GitWorktreeWorkspaceIdentity {
  schema_version: 1;
  kind: 'git-worktree';
  canonical_path: string;
  git_dir: string;
  git_common_dir: string;
  digest: string;
}

export interface StartupCwdWorkspaceIdentity {
  schema_version: 1;
  kind: 'startup-cwd';
  canonical_path: string;
  digest: string;
}

export type WorkspaceIdentity = GitWorktreeWorkspaceIdentity | StartupCwdWorkspaceIdentity;

function assertPathInput(path: string, label: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  if (path.includes('\0')) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
  return resolve(path);
}

function canonicalizeExistingPath(path: string, label: string): string {
  const resolved = assertPathInput(path, label);
  try {
    return typeof realpathSync.native === 'function'
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot canonicalize ${label} "${resolved}": ${detail}`);
  }
}

function readTrimmedFile(path: string, strict = false): string | null {
  try {
    const value = readFileSync(path, 'utf-8').trim();
    if (!value) {
      if (strict) throw new Error(`empty Git metadata file at ${path}`);
      return null;
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (strict) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read Git metadata file at ${path}: ${detail}`);
    }
    return null;
  }
}

function resolveGitDirPointer(path: string, strict = false): string | null {
  const raw = readTrimmedFile(path);
  if (!raw) {
    if (strict) throw new Error(`malformed .git file at ${path}: expected a gitdir pointer`);
    return null;
  }

  const match = raw.match(/^gitdir:\s*(.+)$/i);
  const value = match?.[1]?.trim();
  if (!value || value.includes('\0') || raw.split(/\r?\n/).filter(Boolean).length !== 1) {
    if (strict) throw new Error(`malformed .git file at ${path}: expected exactly one gitdir pointer`);
    return null;
  }

  return resolve(dirname(path), value);
}

function resolveGitCommonDir(gitDir: string, strict = false): string {
  const commonDir = readTrimmedFile(join(gitDir, 'commondir'), strict);
  if (!commonDir) return gitDir;
  if (commonDir.includes('\0') || commonDir.split(/\r?\n/).filter(Boolean).length !== 1) {
    if (strict) throw new Error(`malformed commondir file in ${gitDir}`);
    return gitDir;
  }
  return resolve(gitDir, commonDir);
}

export function findGitLayout(startCwd: string): GitLayout | null {
  let dir = assertPathInput(startCwd, 'startCwd');

  for (;;) {
    const candidate = join(dir, '.git');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) {
        return {
          gitDir: candidate,
          commonDir: resolveGitCommonDir(candidate),
          worktreeRoot: dir,
        };
      }
      if (stat.isFile()) {
        const gitDir = resolveGitDirPointer(candidate);
        if (gitDir) {
          return {
            gitDir,
            commonDir: resolveGitCommonDir(gitDir),
            worktreeRoot: dir,
          };
        }
      }
    } catch { /* not found, walk up */ }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findCanonicalGitLayout(startCwd: string): CanonicalGitLayout | null {
  const startupCwd = canonicalizeExistingPath(startCwd, 'startupCwd');
  let dir = startupCwd;

  for (;;) {
    const gitMarker = join(dir, '.git');
    try {
      const markerStat = statSync(gitMarker);
      if (markerStat.isDirectory()) {
        const gitDir = canonicalizeExistingPath(gitMarker, 'Git directory');
        return {
          startupCwd,
          worktreeRoot: canonicalizeExistingPath(dir, 'Git worktree root'),
          gitDir,
          commonDir: canonicalizeExistingPath(resolveGitCommonDir(gitDir, true), 'Git common directory'),
        };
      }
      if (markerStat.isFile()) {
        const rawGitDir = resolveGitDirPointer(gitMarker, true)!;
        const gitDir = canonicalizeExistingPath(rawGitDir, 'Git directory');
        return {
          startupCwd,
          worktreeRoot: canonicalizeExistingPath(dir, 'Git worktree root'),
          gitDir,
          commonDir: canonicalizeExistingPath(resolveGitCommonDir(gitDir, true), 'Git common directory'),
        };
      }
      throw new Error(`malformed .git marker at ${gitMarker}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspaceIdentityDigest(value: Omit<WorkspaceIdentity, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolveWorkspaceIdentity(startupCwd: string): WorkspaceIdentity {
  const canonicalLayout = findCanonicalGitLayout(startupCwd);
  if (canonicalLayout) {
    const value = {
      schema_version: 1 as const,
      kind: 'git-worktree' as const,
      canonical_path: canonicalLayout.worktreeRoot,
      git_dir: canonicalLayout.gitDir,
      git_common_dir: canonicalLayout.commonDir,
    };
    return { ...value, digest: workspaceIdentityDigest(value) };
  }

  const value = {
    schema_version: 1 as const,
    kind: 'startup-cwd' as const,
    canonical_path: canonicalizeExistingPath(startupCwd, 'startupCwd'),
  };
  return { ...value, digest: workspaceIdentityDigest(value) };
}

export function readGitLayoutFile(baseDir: string, ...parts: string[]): string | null {
  return readTrimmedFile(join(baseDir, ...parts));
}
