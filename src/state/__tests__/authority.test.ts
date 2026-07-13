import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';

import { spawn } from 'node:child_process';

import { existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';

import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTHORITY_DIAGNOSTIC_CODES,
  addAlternateRootBootstrapIntent,
  acquireWorkspaceAuthorityLock,
  appendStateAuthorityEvidence,
  atomicWriteAuthorityFile,
  captureRootFilesystemIdentity,
  canonicalizeExistingAuthorityPath,
  canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync,
  canonicalizeTrustedAuthorityWindowsDirectoryAliasComponentsSync,
  isRevalidatedSameDirectoryIdentity,

  consumeAlternateRootBootstrapIntent,
  createAlternateRootBootstrapIntent,
  createStateAuthorityJournal,
  createWorkspaceAuthorityAnchor,
  createStateAuthorityLockOwner,
  stateAuthorityTransportCapabilityForChild,
  heartbeatWorkspaceAuthorityLock,
  STATE_AUTHORITY_LOCK,
  STATE_AUTHORITY_LOCK_TOMBSTONE_FILE,
  stateAuthorityPaths,
  authorityJournalPath,
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
  readWorkspaceAuthorityAnchor,
  releaseWorkspaceAuthorityLock,

  resolveAuthorityChildPath,
  resolveStateAuthority,
  probeStateAuthorityFilesystemCapability,
  rolloverStateAuthorityToAlternateRoot,
  publishStateAuthorityLaunchTransport,
  readStateAuthorityJournal,
  resolveWorkspaceIdentity,
  transitionStateAuthorityJournal,
  validateAlternateRootBootstrapIntent,
  validateStateAuthority,
  validateStateAuthorityTransportCapability,
  validateCommittedStateAuthorityLaunchTransportPublication,
  validateCommittedStateAuthorityLaunchTransportJournal,
  stateAuthorityFilesystemPrimitiveForPlatform,

  type StateAuthorityFilesystemCapability,
  type StateAuthorityGeneration,
} from '../authority.js';
import { resolveAuthenticatedTransportAuthority } from '../../hooks/session.js';

function verifiedCapability(path: string): StateAuthorityFilesystemCapability {
  return {
    schema_version: 1,
    platform: process.platform,
    canonical_path: path,
    exclusive_create: 'verified',
    atomic_rename: 'verified',
    file_sync: 'verified',
    directory_sync: 'verified',
    no_follow_directories: 'verified',
    strong_root_identity: 'verified',
    probed_at: new Date(0).toISOString(),
  };
}

const issuer = {
  kind: 'first-party-launcher' as const,
  package_version: '0.20.2-test',
  package_digest: 'a'.repeat(64),
};

async function readRegularFileContentsRecursively(root: string): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      contents.push(...await readRegularFileContentsRecursively(path));
    } else if (entry.isFile()) {
      contents.push(await readFile(path, 'utf8'));
    }
  }
  return contents;
}

function inheritedTransportEnv(
  authority: Awaited<ReturnType<typeof initializeStateAuthority>>,
  capability?: string,
): NodeJS.ProcessEnv {
  return {
    OMX_STATE_AUTHORITY_PATH: authority.authority_path,
    OMX_STATE_AUTHORITY_ID: authority.generation.authority_id,
    OMX_STATE_AUTHORITY_GENERATION_ID: authority.generation.generation_id,
    OMX_STATE_AUTHORITY_WORKSPACE_DIGEST: authority.workspace_identity.digest,
    ...(capability ? { OMX_STATE_AUTHORITY_CAPABILITY: capability } : {}),
  };
}

async function acquireWorkspaceLockInChild(workspace: string): Promise<number> {
  const program = `
    const authority = await import(process.env.OMX_AUTHORITY_MODULE_URL);
    const workspaceIdentity = authority.resolveWorkspaceIdentity(process.env.OMX_AUTHORITY_WORKSPACE);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const lock = await authority.acquireWorkspaceAuthorityLock(workspaceIdentity, {
          fencing_token: 1,
          anchor_revision: 0,
        });
        await authority.releaseWorkspaceAuthorityLock(lock);
        process.stdout.write(String(lock.record.fencing_token));
        process.exit(0);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'authority_lock_held') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw error;
      }
    }
    throw new Error('timed out acquiring child workspace authority lock');
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
      env: {
        ...process.env,
        OMX_AUTHORITY_MODULE_URL: new URL('../authority.js', import.meta.url).href,
        OMX_AUTHORITY_WORKSPACE: workspace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child lock acquisition failed (${code}): ${stderr}`));
        return;
      }
      const fence = Number(stdout.trim());
      if (!Number.isSafeInteger(fence)) {
        reject(new Error(`child lock acquisition returned an invalid fence: ${stdout}`));
        return;
      }
      resolvePromise(fence);
    });
  });
}

describe('state authority foundation', () => {
  it('establishes one pristine deterministic authority before resolving nested cwd state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-pristine-'));
    try {
      const nested = join(workspace, 'nested');
      await mkdir(nested);
      const context = await initializeStateAuthority({
        startup_cwd: workspace,
        observed_cwd: workspace,
        launch_id: 'launch-pristine',
        session_binding: { canonical_session_id: 'session-pristine' },
      });
      assert.equal(
        context.canonical_state_root,
        canonicalizeExistingAuthorityPath(join(workspace, '.omx', 'state')),
      );
      assert.match(context.authority_path, /authority[\\/]generations[\\/]/);

      const resolved = await resolveStateAuthority({
        startup_cwd: workspace,
        observed_cwd: nested,
        session_id: 'session-pristine',
      });
      assert.equal(resolved.can_mutate, true);
      assert.equal(resolved.context?.canonical_state_root, context.canonical_state_root);
      assert.equal(
        resolved.context?.observed_cwd,
        canonicalizeExistingAuthorityPath(nested),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('requires an opaque post-commit transport bearer and never serializes it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-transport-secret-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'transport-secret-launch',
        session_binding: { canonical_session_id: 'transport-secret-session' },
      });
      assert.throws(
        () => stateAuthorityTransportCapabilityForChild(authority),
        /no live post-commit state-authority transport capability/,
      );

      const minted = await mintStateAuthorityTransportCapability(authority);
      const issuedAt = new Date(minted.metadata.issued_at).getTime();
      const expiresAt = new Date(minted.metadata.expires_at).getTime();
      assert.ok(expiresAt - issuedAt >= 24 * 60 * 60_000);
      await validateStateAuthorityTransportCapability(
        authority,
        minted.capability,
        new Date(issuedAt + 24 * 60 * 60_000),
      );
      await appendStateAuthorityEvidence(authority.generation, { kind: 'transport-secret-test' });
      const anchorPath = stateAuthorityPaths(authority.workspace_identity).anchor_path;
      const bindingPath = join(
        authority.canonical_state_root,
        'authority',
        'generations',
        authority.generation.generation_id,
        'bindings',
        `${authority.session_binding!.binding_id}.json`,
      );
      const serialized = await Promise.all([
        readFile(anchorPath, 'utf8'),
        readFile(authority.authority_path, 'utf8'),
        readFile(bindingPath, 'utf8'),
        readFile(join(authority.canonical_state_root, 'authority', '.state-authority-tombstones.jsonl'), 'utf8')
          .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error)),
        ...await readRegularFileContentsRecursively(join(workspace, '.omx')),
      ]);
      for (const payload of serialized) assert.equal(payload.includes(minted.capability), false);
      const anchor = await readWorkspaceAuthorityAnchor(authority.workspace_identity);
      assert.equal(anchor?.transport_capability?.capability_digest.length, 64);
      assert.equal(anchor?.transport_capability?.capability_digest, minted.metadata.capability_digest);

      await assert.rejects(
        resolveAuthenticatedTransportAuthority(workspace, inheritedTransportEnv(authority)),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.authorityMissing,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('authenticates a bearer only for nested paths and rejects copied transport in an unrelated workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-transport-workspace-a-'));
    const unrelated = await mkdtemp(join(tmpdir(), 'omx-authority-transport-workspace-b-'));
    try {
      const nested = join(workspace, 'nested');
      await mkdir(nested);
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'transport-workspace-launch',
        session_binding: { canonical_session_id: 'transport-workspace-session' },
      });
      const minted = await mintStateAuthorityTransportCapability(authority);
      const transport = inheritedTransportEnv(authority, minted.capability);
      const nestedResolution = await resolveAuthenticatedTransportAuthority(nested, transport);
      assert.equal(nestedResolution?.workspace_identity.digest, authority.workspace_identity.digest);
      await assert.rejects(
        resolveAuthenticatedTransportAuthority(unrelated, transport),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.observedCwdOutsideWorkspace,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(unrelated, { recursive: true, force: true });
    }
  });

  it('authenticates transport from canonical aliases but rejects foreign nested repositories and linked worktrees', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-transport-git-main-'));
    const linked = await mkdtemp(join(tmpdir(), 'omx-authority-transport-git-linked-'));
    const alias = `${workspace}-alias`;
    try {
      const gitDir = join(workspace, '.git');
      const linkedGitDir = join(gitDir, 'worktrees', 'linked');
      const foreignNestedRepository = join(workspace, 'nested-foreign');
      await mkdir(join(workspace, 'nested'), { recursive: true });
      await mkdir(linkedGitDir, { recursive: true });
      await mkdir(join(foreignNestedRepository, '.git'), { recursive: true });
      await writeFile(join(linked, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8');
      await writeFile(join(linkedGitDir, 'commondir'), '../..\n', 'utf8');
      await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'transport-linked-launch',
        session_binding: { canonical_session_id: 'transport-linked-session' },
      });
      const minted = await mintStateAuthorityTransportCapability(authority);
      const transport = inheritedTransportEnv(authority, minted.capability);
      for (const observedCwd of [join(workspace, 'nested'), join(alias, 'nested')]) {
        const resolved = await resolveAuthenticatedTransportAuthority(observedCwd, transport);
        assert.equal(resolved?.workspace_identity.digest, authority.workspace_identity.digest);
      }
      assert.notEqual(resolveWorkspaceIdentity(linked).digest, authority.workspace_identity.digest);
      for (const observedCwd of [foreignNestedRepository, linked]) {
        await assert.rejects(
          resolveAuthenticatedTransportAuthority(observedCwd, transport),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.observedCwdOutsideWorkspace,
        );
      }
    } finally {
      await Promise.all([
        rm(alias, { recursive: true, force: true }),
        rm(linked, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  });

  it('rejects expired and superseded transport bearers', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-transport-revocation-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'transport-revocation-launch',
        session_binding: { canonical_session_id: 'transport-revocation-session' },
      });
      const issuedAt = new Date('2030-01-01T00:00:00.000Z');
      const expired = await mintStateAuthorityTransportCapability(authority, { now: issuedAt, ttl_ms: 1 });
      await assert.rejects(
        validateStateAuthorityTransportCapability(authority, expired.capability, new Date(issuedAt.getTime() + 2)),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityExpired,
      );
      const current = await mintStateAuthorityTransportCapability(authority, { now: new Date(issuedAt.getTime() + 3), ttl_ms: 60_000 });
      await assert.rejects(
        validateStateAuthorityTransportCapability(authority, expired.capability, new Date(issuedAt.getTime() + 4)),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      );
      await validateStateAuthorityTransportCapability(authority, current.capability, new Date(issuedAt.getTime() + 4));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('revalidates cached child bearers against persisted metadata while preserving alias revisions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-child-capability-cache-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'child-capability-cache',
        session_binding: { canonical_session_id: 'child-capability-session' },
      });
      const minted = await mintStateAuthorityTransportCapability(authority);
      assert.equal(stateAuthorityTransportCapabilityForChild(authority), minted.capability);

      const aliased = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'child-capability-alias',
        session_binding: {
          canonical_session_id: 'child-capability-session',
          aliases: { current_session_aliases: ['child-capability-alias'] },
        },
      });
      assert.ok(aliased.session_binding!.binding_revision > minted.metadata.binding_revision);
      assert.equal(stateAuthorityTransportCapabilityForChild(aliased), minted.capability);

      const anchor = await readWorkspaceAuthorityAnchor(authority.workspace_identity);
      assert.ok(anchor?.transport_capability);
      await writeFile(authority.anchor_path, `${JSON.stringify({
        ...anchor!,
        transport_capability: {
          ...anchor!.transport_capability!,
          capability_digest: 'f'.repeat(64),
        },
      }, null, 2)}\n`);
      assert.throws(
        () => stateAuthorityTransportCapabilityForChild(aliased),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects foreign session reuse of an active authority generation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-foreign-session-'));
    try {
      await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'launch-owner',
        session_binding: { canonical_session_id: 'session-owner' },
      });
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'launch-foreign',
          session_binding: { canonical_session_id: 'session-foreign' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('migrates one workspace-bound legacy session and rejects ambiguous legacy evidence', async () => {
    const proven = await mkdtemp(join(tmpdir(), 'omx-authority-legacy-proven-'));
    const ambiguous = await mkdtemp(join(tmpdir(), 'omx-authority-legacy-ambiguous-'));
    try {
      await mkdir(join(proven, '.omx', 'state'), { recursive: true });
      await writeFile(join(proven, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: 'legacy-session',
        cwd: proven,
      }));
      await writeFile(join(proven, '.omx', 'state', 'ralplan-state.json'), '{"active":true}');
      const migrated = await initializeStateAuthority({
        startup_cwd: proven,
        launch_id: 'legacy-migration',
        session_binding: { canonical_session_id: 'legacy-session' },
      });
      assert.equal(
        migrated.canonical_state_root,
        canonicalizeExistingAuthorityPath(join(proven, '.omx', 'state')),
      );

      await mkdir(join(ambiguous, '.omx', 'state'), { recursive: true });
      await writeFile(join(ambiguous, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: 'legacy-session',
        cwd: join(ambiguous, 'foreign-workspace'),
      }));
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: ambiguous,
          launch_id: 'legacy-ambiguous',
          session_binding: { canonical_session_id: 'legacy-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven,
      );
    } finally {
      await rm(proven, { recursive: true, force: true });
      await rm(ambiguous, { recursive: true, force: true });
    }
  });
  it('rejects a caller-supplied alternate legacy candidate even when its session pointer names this workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-legacy-alternate-workspace-'));
    const alternate = await mkdtemp(join(tmpdir(), 'omx-authority-legacy-alternate-root-'));
    try {
      await writeFile(join(alternate, 'session.json'), JSON.stringify({
        session_id: 'alternate-legacy-session',
        cwd: workspace,
      }));
      await writeFile(join(alternate, 'ralplan-state.json'), '{"active":true}');
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'alternate-legacy-rejected',
          legacy_state_root_candidate: alternate,
          session_binding: { canonical_session_id: 'alternate-legacy-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.legacyAuthorityUnproven,
      );
      assert.equal(existsSync(stateAuthorityPaths(resolveWorkspaceIdentity(workspace)).anchor_path), false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(alternate, { recursive: true, force: true });
    }
  });


  it('rolls a committed launch into one fenced alternate authority generation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-alternate-rollover-'));
    const runRoot = await mkdtemp(join(tmpdir(), 'omx-authority-alternate-run-'));
    try {
      const initial = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'alternate-source-launch',
        session_binding: { canonical_session_id: 'alternate-session' },
      });
      const alternateStateRoot = join(runRoot, '.omx', 'state');
      const rolled = await rolloverStateAuthorityToAlternateRoot({
        context: initial,
        proposed_state_root: alternateStateRoot,
        creation_root: runRoot,
        launch_id: 'alternate-rollover-launch',
        consumer_kind: 'madmax',
        issuer: {
          kind: 'first-party-launcher',
          package_version: 'test',
          package_digest: 'a'.repeat(64),
        },
      });
      assert.equal(
        rolled.canonical_state_root,
        canonicalizeExistingAuthorityPath(alternateStateRoot),
      );
      assert.notEqual(rolled.generation.generation_id, initial.generation.generation_id);
      assert.equal(rolled.generation.prior_generation_id, initial.generation.generation_id);
      assert.equal(rolled.session_binding?.canonical_session_id, 'alternate-session');

      const resolved = await resolveStateAuthority({ startup_cwd: workspace, observed_cwd: workspace });
      assert.equal(resolved.can_mutate, true);
      assert.equal(
        resolved.context?.canonical_state_root,
        canonicalizeExistingAuthorityPath(alternateStateRoot),
      );
      const anchor = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
      assert.equal(anchor?.active_generation_id, rolled.generation.generation_id);
      assert.equal(anchor?.last_terminal?.generation_id, initial.generation.generation_id);
      assert.equal(anchor?.alternate_intents.at(-1)?.status, 'consumed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });
  it('rejects an alternate state root that is lexically outside its creation root before canonicalization', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-alternate-lexical-workspace-'));
    const runRoot = await mkdtemp(join(tmpdir(), 'omx-authority-alternate-lexical-run-'));
    const creationRoot = join(runRoot, 'creation');
    const outsideStateRoot = join(runRoot, 'outside', '.omx', 'state');
    try {
      await mkdir(creationRoot, { recursive: true });
      const initial = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'alternate-lexical-source',
        session_binding: { canonical_session_id: 'alternate-lexical-session' },
      });
      await assert.rejects(
        rolloverStateAuthorityToAlternateRoot({
          context: initial,
          proposed_state_root: outsideStateRoot,
          creation_root: creationRoot,
          launch_id: 'alternate-lexical-rollover',
          consumer_kind: 'madmax',
          issuer,
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.authorityPathEscapesRoot
          && /alternate state root escapes its creation root/.test(error.message),
      );
      assert.equal(existsSync(outsideStateRoot), false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('accepts only revalidated same-object directory identities', () => {
    const directory = (dev: number, ino: number, options: { symlink?: boolean; directory?: boolean } = {}) => ({
      dev,
      ino,
      isDirectory: () => options.directory ?? true,
      isSymbolicLink: () => options.symlink ?? false,
    });

    assert.equal(
      isRevalidatedSameDirectoryIdentity(directory(1, 2), directory(1, 2), directory(1, 2), directory(1, 2)),
      true,
    );
    assert.equal(
      isRevalidatedSameDirectoryIdentity(directory(1, 2), directory(1, 2), directory(1, 3), directory(1, 2)),
      false,
    );
    assert.equal(
      isRevalidatedSameDirectoryIdentity(directory(1, 2), directory(1, 2, { symlink: true }), directory(1, 2), directory(1, 2)),
      false,
    );
    assert.equal(
      isRevalidatedSameDirectoryIdentity(directory(1, 2), directory(1, 2), directory(1, 2), directory(1, 2, { directory: false })),
      false,
    );
  });

  it('revalidates native Win32 directory spellings and rejects junction components', { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-authority-win32-directory-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-authority-win32-outside-'));
    try {
      const lexicalSpelling = root.toUpperCase();
      assert.equal(
        canonicalizeTrustedAuthorityWindowsDirectoryAliasComponentsSync(lexicalSpelling),
        canonicalizeExistingAuthorityPath(lexicalSpelling),
      );

      const junction = join(root, 'junction');
      await symlink(outside, junction, 'junction');
      assert.equal(canonicalizeTrustedAuthorityWindowsDirectoryAliasComponentsSync(junction), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('revalidates only trusted Darwin root aliases and rejects arbitrary symlink components', { skip: process.platform !== 'darwin' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-authority-darwin-directory-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-authority-darwin-outside-'));
    try {
      const canonicalRoot = canonicalizeExistingAuthorityPath(root);
      const lexicalAlias = canonicalRoot.startsWith('/private/var/')
        ? canonicalRoot.replace(/^\/private\/var\//, '/var/')
        : canonicalRoot.startsWith('/private/tmp/')
          ? canonicalRoot.replace(/^\/private\/tmp\//, '/tmp/')
          : '';
      assert.notEqual(
        lexicalAlias,
        '',
        `expected macOS temporary directory under /private/var or /private/tmp: ${canonicalRoot}`,
      );
      assert.notEqual(lexicalAlias, canonicalRoot);
      assert.equal(canonicalizeExistingAuthorityPath(lexicalAlias), canonicalRoot);
      assert.equal(
        canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync(lexicalAlias),
        canonicalRoot,
      );
      assert.equal(
        canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync(canonicalRoot),
        canonicalRoot,
      );

      const symlinked = join(root, 'symlinked');
      await symlink(outside, symlinked, 'dir');
      assert.equal(canonicalizeTrustedAuthorityDarwinDirectoryAliasComponentsSync(symlinked), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('rejects a symlink child that escapes the canonical authority root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-authority-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-authority-outside-'));
    try {
      const escape = join(root, 'escape');
      await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(
        () => resolveAuthorityChildPath(root, 'escape', 'state'),
        /escapes its canonical root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when a generation root is replaced after its fingerprint is recorded', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-fingerprint-'));
    try {
      const stateRootPath = join(workspace, 'state-root');
      await mkdir(stateRootPath);
      const stateRoot = canonicalizeExistingAuthorityPath(stateRootPath);
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const rootIdentity = await captureRootFilesystemIdentity(stateRoot);
      const generation: StateAuthorityGeneration = {
        schema_version: 1,
        authority_protocol_version: 1,
        authority_id: 'authority-fingerprint',
        generation_id: 'generation-fingerprint',
        status: 'committed',
        canonical_state_root: stateRoot,
        canonical_omx_root: dirname(stateRoot),
        root_identity: rootIdentity,
        root_capability: verifiedCapability(stateRoot),
        workspace_identity: workspaceIdentity,
        workspace_identity_digest: workspaceIdentity.digest,
        creation_fence: 1,
        created_at: new Date(0).toISOString(),
        created_by_pid: process.pid,
      };

      await rm(stateRoot, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await mkdir(stateRoot);
      const validation = await validateStateAuthority(generation, {
        workspace_identity: workspaceIdentity,
      });
      assert.equal(validation.valid, false);
      assert.equal(validation.diagnostics[0]?.code, AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('consumes a fenced alternate intent once and denies replay or competing prepared intent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-intent-'));
    try {
      const alternateRoot = join(workspace, 'alternate-root');
      await mkdir(alternateRoot);
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const rootIdentity = await captureRootFilesystemIdentity(alternateRoot);
      const anchor = createWorkspaceAuthorityAnchor(workspaceIdentity, new Date(0));
      const intent = createAlternateRootBootstrapIntent({
        anchor,
        workspace_identity: workspaceIdentity,
        launch_id: 'launch-intent',
        issuer,
        owner_nonce: 'intent-owner-nonce',
        proposed_state_root: alternateRoot,
        proposed_root_identity: rootIdentity,
        proposed_root_capability: verifiedCapability(alternateRoot),
        intended_consumer_kind: 'boxed',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        now: new Date(),
      });
      const preparedAnchor = addAlternateRootBootstrapIntent(anchor, intent, new Date());
      const preparedIntent = preparedAnchor.alternate_intents.find((entry) => entry.intent_id === intent.intent_id)!;
      const validationInput = {
        anchor: preparedAnchor,
        workspace_identity: workspaceIdentity,
        launch_id: 'launch-intent',
        issuer,
        owner_nonce: 'intent-owner-nonce',
        fencing_token: preparedAnchor.fencing_token,
        expected_consumer_kind: 'boxed' as const,
        now: new Date(),
      };
      const wrongConsumer = validateAlternateRootBootstrapIntent(preparedIntent, {
        ...validationInput,
        expected_consumer_kind: 'team' as const,
      });
      assert.equal(wrongConsumer.valid, false);
      assert.equal(wrongConsumer.diagnostic?.code, AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch);
      const wrongIssuer = validateAlternateRootBootstrapIntent(preparedIntent, {
        ...validationInput,
        issuer: { ...issuer, package_digest: 'b'.repeat(64) },
      });
      assert.equal(wrongIssuer.valid, false);
      assert.equal(wrongIssuer.diagnostic?.code, AUTHORITY_DIAGNOSTIC_CODES.intentIssuerMismatch);
      const consumedAnchor = consumeAlternateRootBootstrapIntent(
        preparedAnchor,
        intent.intent_id,
        validationInput,
        'generation-intent',
        new Date(),
      );
      const replay = validateAlternateRootBootstrapIntent(
        consumedAnchor.alternate_intents[0],
        { ...validationInput, anchor: consumedAnchor, fencing_token: consumedAnchor.fencing_token },
      );
      assert.equal(replay.valid, false);
      assert.equal(replay.diagnostic?.code, AUTHORITY_DIAGNOSTIC_CODES.intentReplay);

      const competing = createAlternateRootBootstrapIntent({
        anchor: preparedAnchor,
        workspace_identity: workspaceIdentity,
        launch_id: 'launch-intent',
        issuer,
        owner_nonce: 'intent-owner-nonce',
        proposed_state_root: alternateRoot,
        proposed_root_identity: rootIdentity,
        proposed_root_capability: verifiedCapability(alternateRoot),
        intended_consumer_kind: 'team',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        now: new Date(),
      });
      assert.throws(
        () => addAlternateRootBootstrapIntent(preparedAnchor, competing, new Date()),
        /unresolved alternate root intent/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('allows heartbeat and release only for the lock owner nonce and fence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-lock-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 1,
        anchor_revision: 0,
      });
      try {
        await assert.rejects(
          heartbeatWorkspaceAuthorityLock({
            ...lock,
            record: { ...lock.record, owner_nonce: 'different-owner' },
          }),
          (error: unknown) => error instanceof Error && /owner does not match/.test(error.message),
        );
      } finally {
        await releaseWorkspaceAuthorityLock(lock);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('atomically replaces fully synced lock records for acquisition and heartbeat', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-atomic-lock-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 1,
        anchor_revision: 0,
      });
      const before = await lstat(paths.lock_path);
      const acquired = JSON.parse(await readFile(paths.lock_path, 'utf-8')) as { owner_nonce: string };
      assert.equal(acquired.owner_nonce, lock.record.owner_nonce);
      const refreshed = await heartbeatWorkspaceAuthorityLock(lock, new Date(Date.now() + 1_000));
      const after = await lstat(paths.lock_path);
      const heartbeated = JSON.parse(await readFile(paths.lock_path, 'utf-8')) as { owner_nonce: string; heartbeat_at: string };
      assert.notEqual(after.ino, before.ino);
      assert.equal(heartbeated.owner_nonce, lock.record.owner_nonce);
      assert.equal(heartbeated.heartbeat_at, refreshed.record.heartbeat_at);
      await releaseWorkspaceAuthorityLock(refreshed);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });


  it('permits only prepared -> applying -> committed journal transitions', () => {
    const journal = createStateAuthorityJournal({
      operation_id: 'operation-journal',
      kind: 'generation_establish',
      authority_id: 'authority-journal',
      generation_id: 'generation-journal',
      binding_revision: 1,
      workspace_identity_digest: 'b'.repeat(64),
      expected_anchor_revision: 0,
      fencing_token: 1,
      effects_digest: 'c'.repeat(64),
      now: new Date(0),
    });
    assert.throws(() => transitionStateAuthorityJournal(journal, 'committed'), /cannot transition/);
    const applying = transitionStateAuthorityJournal(journal, 'applying', { now: new Date(1) });
    const committed = transitionStateAuthorityJournal(applying, 'committed', { now: new Date(2) });
    assert.equal(committed.status, 'committed');
    assert.throws(() => transitionStateAuthorityJournal(committed, 'aborted'), /cannot transition/);
  });
  it('fails closed instead of establishing a pristine lineage when an anchor disappears after generation evidence exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-missing-anchor-evidence-'));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'missing-anchor-source',
        session_binding: { canonical_session_id: 'missing-anchor-session' },
      });
      await rm(authority.anchor_path);
      await rm(dirname(authority.anchor_path), { recursive: true, force: true });
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'missing-anchor-restart',
          session_binding: { canonical_session_id: 'missing-anchor-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.resumeEvidenceMissing,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('rejects ordinary and legacy state-root symlink components before establishment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-root-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-authority-root-symlink-outside-'));
    try {
      await mkdir(join(workspace, '.omx'), { recursive: true });
      await symlink(outside, join(workspace, '.omx', 'state'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'symlinked-ordinary-root',
          session_binding: { canonical_session_id: 'symlinked-root-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      );

      const intermediate = await mkdtemp(join(tmpdir(), 'omx-authority-intermediate-symlink-'));
      try {
        await symlink(outside, join(intermediate, '.omx'), process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(
          initializeStateAuthority({
            startup_cwd: intermediate,
            launch_id: 'symlinked-intermediate-root',
            session_binding: { canonical_session_id: 'symlinked-intermediate-session' },
          }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
        );
      } finally {
        await rm(intermediate, { recursive: true, force: true });
      }
      const legacyWorkspace = await mkdtemp(join(tmpdir(), 'omx-authority-legacy-symlink-'));
      try {
        await symlink(outside, join(legacyWorkspace, 'legacy-state'), process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(
          initializeStateAuthority({
            startup_cwd: legacyWorkspace,
            launch_id: 'symlinked-legacy-root',
            session_binding: { canonical_session_id: 'symlinked-legacy-session' },
            legacy_state_root_candidate: join(legacyWorkspace, 'legacy-state'),
          }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
        );
      } finally {
        await rm(legacyWorkspace, { recursive: true, force: true });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not accept a predictable launch ID as proof for a foreign active session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-spoofed-launch-'));
    try {
      await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'owner-launch',
        session_binding: { canonical_session_id: 'owner-session' },
      });
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'session-foreign-session',
          session_binding: { canonical_session_id: 'foreign-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed on active lease and generation cross-link corruption', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-cross-link-'));
    try {
      await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'cross-link-owner',
        session_binding: { canonical_session_id: 'cross-link-session' },
      });
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const anchor = await readWorkspaceAuthorityAnchor(workspaceIdentity);
      assert.ok(anchor?.active_lease);
      await writeFile(stateAuthorityPaths(workspaceIdentity).anchor_path, JSON.stringify({
        ...anchor,
        active_lease: { ...anchor.active_lease, generation_id: 'substituted-generation' },
      }));
      const resolution = await resolveStateAuthority({ startup_cwd: workspace });
      assert.equal(resolution.can_mutate, false);
      assert.equal(resolution.diagnostics.at(-1)?.code, AUTHORITY_DIAGNOSTIC_CODES.anchorMalformed);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('takes over only a proven stale lock and preserves fenced tombstone evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-stale-lock-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(paths.lock_path, `${JSON.stringify({
        schema_version: 1,
        owner_nonce: 'stale-owner-nonce',
        fencing_token: 2,
        anchor_revision: 1,
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
        heartbeat_at: new Date(0).toISOString(),
      })}\n`);
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 3,
        anchor_revision: 1,
      });
      try {
        const tombstones = await readFile(join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_TOMBSTONE_FILE), 'utf-8');
        assert.match(tombstones, /stale_lock_takeover/);
        assert.match(tombstones, /stale-owner-nonce/);
        assert.match(tombstones, /"stale_lock_snapshot"/);
        assert.match(tombstones, /"content_digest":"[a-f0-9]{64}"/);
      } finally {
        await releaseWorkspaceAuthorityLock(lock);
      }
      assert.equal(existsSync(paths.lock_path), false);
      const entries = await readdir(paths.bootstrap_directory);
      assert.ok(entries.some((entry) => entry.startsWith(`${STATE_AUTHORITY_LOCK}.stale-`)));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('persists a strictly increasing workspace lock fence through sequential, stale-takeover, and cross-process acquisition', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-lock-fences-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      const first = await acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 1, anchor_revision: 0 });
      await releaseWorkspaceAuthorityLock(first);
      const second = await acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 1, anchor_revision: 0 });
      await releaseWorkspaceAuthorityLock(second);
      assert.ok(second.record.fencing_token > first.record.fencing_token);

      const crashed = await acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 1, anchor_revision: 0 });
      await writeFile(paths.lock_path, `${JSON.stringify({
        ...crashed.record,
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
      })}\n`);
      const takeover = await acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 1, anchor_revision: 0 });
      await releaseWorkspaceAuthorityLock(takeover);
      assert.ok(takeover.record.fencing_token > crashed.record.fencing_token);

      const [childOne, childTwo] = await Promise.all([
        acquireWorkspaceLockInChild(workspace),
        acquireWorkspaceLockInChild(workspace),
      ]);
      assert.notEqual(childOne, childTwo);
      assert.ok(childOne > takeover.record.fencing_token);
      assert.ok(childTwo > takeover.record.fencing_token);
      const counter = JSON.parse(await readFile(paths.lock_fence_path, 'utf8')) as { last_fencing_token: number };
      assert.equal(counter.last_fencing_token, Math.max(childOne, childTwo));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('elects one stale-guard reclaimer before allowing a second contender', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-stale-guard-contenders-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      const guardPath = join(paths.bootstrap_directory, `${STATE_AUTHORITY_LOCK}.acquire`);
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(guardPath, `${JSON.stringify({
        schema_version: 1,
        kind: 'acquisition-guard',
        owner_nonce: 'stale-guard-owner',
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
      })}\n`);

      let contenderAttempted = false;
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 1,
        anchor_revision: 0,
        test_only_after_stale_guard_reclamation_claim: async () => {
          contenderAttempted = true;
          await assert.rejects(
            acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 2, anchor_revision: 0 }),
            (error: unknown) => error instanceof Error
              && 'code' in error
              && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockHeld,
          );
        },
      });
      try {
        assert.equal(contenderAttempted, true);
        assert.equal(existsSync(guardPath), false);
        assert.equal(existsSync(join(paths.bootstrap_directory, `${STATE_AUTHORITY_LOCK}.acquire.reclaim`)), false);
      } finally {
        await releaseWorkspaceAuthorityLock(lock);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('recovers a crashed retirement finisher into a usable guard', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-crashed-retirement-finisher-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      const guardPath = join(paths.bootstrap_directory, `${STATE_AUTHORITY_LOCK}.acquire`);
      const staleOwner = {
        host: hostname(),
        pid: 2147483001,
        process_started_at: 'linux:1',
        boot_id: 'stale-boot-id',
        command_digest: 'a'.repeat(64),
      };
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(guardPath, `${JSON.stringify({
        schema_version: 1,
        kind: 'acquisition-guard',
        owner_nonce: 'stale-guard-owner',
        owner: staleOwner,
        acquired_at: new Date(0).toISOString(),
      })}\n`);

      await assert.rejects(
        acquireWorkspaceAuthorityLock(workspaceIdentity, {
          fencing_token: 1,
          anchor_revision: 0,
          test_only_after_retirement_finisher_publication: () => {
            throw new Error('injected crash after retirement finisher publication');
          },
        }),
        /injected crash after retirement finisher publication/,
      );

      const entries = await readdir(paths.bootstrap_directory);
      const finisherName = entries.find((entry) => entry.startsWith(`.${STATE_AUTHORITY_LOCK}.acquire.retiring-`)
        && entry.endsWith('.finishing'));
      assert.ok(finisherName);
      const makeOwnerStale = async (path: string): Promise<void> => {
        const record = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
        await writeFile(path, `${JSON.stringify({ ...record, owner: staleOwner })}\n`);
      };
      await makeOwnerStale(join(paths.bootstrap_directory, finisherName));
      await makeOwnerStale(`${guardPath}.reclaim`);

      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 2, anchor_revision: 0 });
      try {
        assert.equal(existsSync(guardPath), false);
        const persisted = JSON.parse(await readFile(paths.lock_path, 'utf-8')) as { owner_nonce: string };
        assert.equal(persisted.owner_nonce, lock.record.owner_nonce);
      } finally {
        await releaseWorkspaceAuthorityLock(lock);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('does not delete a live guard that replaces a crashed retirement finisher target', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-crashed-guard-claim-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      const guardPath = join(paths.bootstrap_directory, `${STATE_AUTHORITY_LOCK}.acquire`);
      const claimPath = `${guardPath}.reclaim`;
      const guard = {
        schema_version: 1,
        kind: 'acquisition-guard',
        owner_nonce: 'stale-guard-owner',
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
      };
      const serializedGuard = `${JSON.stringify(guard)}\n`;
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(guardPath, serializedGuard);
      const guardIdentity = await lstat(guardPath);
      await writeFile(claimPath, `${JSON.stringify({
        schema_version: 1,
        kind: 'stale-guard-reclamation',
        claim_nonce: 'crashed-claim',
        owner: guard.owner,
        acquired_at: new Date(0).toISOString(),
        target_guard: {
          owner_nonce: guard.owner_nonce,
          device: String(guardIdentity.dev),
          inode: String(guardIdentity.ino),
          content_digest: createHash('sha256').update(serializedGuard).digest('hex'),
        },
      })}\n`);
      const guardRetirementPath = join(
        paths.bootstrap_directory,
        `.${STATE_AUTHORITY_LOCK}.acquire.retiring-${guardIdentity.dev}-${guardIdentity.ino}-${createHash('sha256').update(serializedGuard).digest('hex')}`,
      );
      await link(guardPath, guardRetirementPath);
      const guardRetirementIdentity = await lstat(guardRetirementPath);
      await writeFile(`${guardRetirementPath}.finishing`, `${JSON.stringify({
        schema_version: 1,
        kind: 'coordination-retirement-finisher',
        owner_nonce: 'crashed-finisher',
        owner: guard.owner,
        acquired_at: new Date(0).toISOString(),
        target: {
          device: String(guardRetirementIdentity.dev),
          inode: String(guardRetirementIdentity.ino),
          content_digest: createHash('sha256').update(serializedGuard).digest('hex'),
        },
      })}\n`);

      const replacementPath = join(paths.bootstrap_directory, 'live-guard-replacement');
      const liveGuard = {
        schema_version: 1,
        kind: 'acquisition-guard',
        owner_nonce: 'live-guard-replacement',
        owner: createStateAuthorityLockOwner(),
        acquired_at: new Date().toISOString(),
      };
      await writeFile(replacementPath, `${JSON.stringify(liveGuard)}\n`);
      await rename(replacementPath, guardPath);

      await assert.rejects(
        acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 1, anchor_revision: 0 }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockTakeoverUnproven,
      );
      const persisted = JSON.parse(await readFile(guardPath, 'utf-8')) as { owner_nonce: string };
      assert.equal(persisted.owner_nonce, liveGuard.owner_nonce);
      assert.equal(existsSync(claimPath), false);
      const entries = await readdir(paths.bootstrap_directory);
      assert.ok(entries.some((entry) => entry.startsWith(`.${STATE_AUTHORITY_LOCK}.acquire.reclaim.retiring-`)));
      assert.ok(entries.some((entry) => entry.startsWith(`.${STATE_AUTHORITY_LOCK}.acquire.retiring-`) && entry.endsWith('.finishing')));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('keeps a live contender out after the final stale-lock identity check', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-stale-lock-contender-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(paths.lock_path, `${JSON.stringify({
        schema_version: 1,
        owner_nonce: 'stale-owner-nonce',
        fencing_token: 2,
        anchor_revision: 1,
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
        heartbeat_at: new Date(0).toISOString(),
      })}\n`);

      let contenderAttempted = false;
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 4,
        anchor_revision: 1,
        test_only_after_final_stale_lock_identity_check: async () => {
          contenderAttempted = true;
          await assert.rejects(
            acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 3, anchor_revision: 1 }),
            (error: unknown) => error instanceof Error
              && 'code' in error
              && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockHeld,
          );
        },
      });
      try {
        assert.equal(contenderAttempted, true);
        const persisted = JSON.parse(await readFile(paths.lock_path, 'utf-8')) as { owner_nonce: string };
        assert.equal(persisted.owner_nonce, lock.record.owner_nonce);
        const tombstones = await readFile(join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_TOMBSTONE_FILE), 'utf-8');
        assert.match(tombstones, /stale-owner-nonce/);
      } finally {
        await releaseWorkspaceAuthorityLock(lock);
      }
      const entries = await readdir(paths.bootstrap_directory);
      assert.ok(entries.some((entry) => entry.startsWith(`${STATE_AUTHORITY_LOCK}.stale-2-`)));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not quarantine a live replacement after the stale-lock takeover seam', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-stale-lock-replacement-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(paths.lock_path, `${JSON.stringify({
        schema_version: 1,
        owner_nonce: 'stale-owner-nonce',
        fencing_token: 2,
        anchor_revision: 1,
        owner: {
          host: hostname(),
          pid: 2147483001,
          process_started_at: 'linux:1',
          boot_id: 'stale-boot-id',
          command_digest: 'a'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
        heartbeat_at: new Date(0).toISOString(),
      })}\n`);
      const live = {
        schema_version: 1,
        owner_nonce: 'replacement-live-owner',
        fencing_token: 99,
        anchor_revision: 1,
        owner: createStateAuthorityLockOwner(),
        acquired_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      };
      await assert.rejects(
        acquireWorkspaceAuthorityLock(workspaceIdentity, {
          fencing_token: 1,
          anchor_revision: 1,
          test_only_after_final_stale_lock_identity_check: async () => {
            const preservedStale = join(paths.bootstrap_directory, 'preserved-stale-lock');
            await rename(paths.lock_path, preservedStale);
            await writeFile(paths.lock_path, `${JSON.stringify(live)}\n`);
          },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockHeld,
      );
      const persisted = JSON.parse(await readFile(paths.lock_path, 'utf8')) as { owner_nonce: string };
      assert.equal(persisted.owner_nonce, live.owner_nonce);
      const entries = await readdir(paths.bootstrap_directory);
      assert.equal(entries.some((entry) => entry.startsWith(`${STATE_AUTHORITY_LOCK}.stale-`)), false);
      assert.equal(existsSync(join(paths.bootstrap_directory, STATE_AUTHORITY_LOCK_TOMBSTONE_FILE)), false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('keeps live and malformed locks fail-closed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-live-lock-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const live = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 1,
        anchor_revision: 0,
      });
      try {
        await assert.rejects(
          acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 2, anchor_revision: 0 }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockHeld,
        );
      } finally {
        await releaseWorkspaceAuthorityLock(live);
      }
      const paths = stateAuthorityPaths(workspaceIdentity);
      await writeFile(paths.lock_path, 'not-json\n');
      await assert.rejects(
        acquireWorkspaceAuthorityLock(workspaceIdentity, { fencing_token: 2, anchor_revision: 0 }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.lockHeld,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('treats a reused PID lock owner as stale only when its recorded identity mismatches', async () => {
    if (process.platform !== 'linux') return;
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-pid-reuse-'));
    try {
      const workspaceIdentity = resolveWorkspaceIdentity(workspace);
      const paths = stateAuthorityPaths(workspaceIdentity);
      await mkdir(paths.bootstrap_directory, { recursive: true });
      await writeFile(paths.lock_path, `${JSON.stringify({
        schema_version: 1,
        owner_nonce: 'reused-pid-owner',
        fencing_token: 1,
        anchor_revision: 0,
        owner: {
          host: hostname(),
          pid: process.pid,
          process_started_at: 'linux:0',
          boot_id: 'different-boot',
          command_digest: 'b'.repeat(64),
        },
        acquired_at: new Date(0).toISOString(),
        heartbeat_at: new Date(0).toISOString(),
      })}\n`);
      const lock = await acquireWorkspaceAuthorityLock(workspaceIdentity, {
        fencing_token: 2,
        anchor_revision: 0,
      });
      await releaseWorkspaceAuthorityLock(lock);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('recovers a valid unanchored pristine preparation journal before rejecting surviving protocol evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-pristine-prepared-recovery-'));
    try {
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'pristine-preparation-crash',
          session_binding: { canonical_session_id: 'pristine-preparation-session' },
          test_only_ordinary_rollover_fault_injection: 'after_prepared_journal',
        }),
        /injected ordinary generation rollover crash at after_prepared_journal/,
      );
      const generationsDirectory = join(workspace, '.omx', 'state', 'authority', 'generations');
      const [orphanGenerationId] = await readdir(generationsDirectory);
      assert.ok(orphanGenerationId);
      const journalDirectory = join(generationsDirectory, orphanGenerationId, 'journals');
      const [journalName] = await readdir(journalDirectory);
      assert.ok(journalName);
      const journalPath = join(journalDirectory, journalName);

      const recovered = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'pristine-preparation-recovered',
        session_binding: { canonical_session_id: 'pristine-preparation-session' },
      });
      assert.notEqual(recovered.generation.generation_id, orphanGenerationId);
      assert.equal((await readStateAuthorityJournal(journalPath)).status, 'aborted');
      assert.equal((await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace)))?.pending_operation, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed on a malformed unanchored pristine preparation journal', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-pristine-prepared-malformed-'));
    try {
      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'pristine-malformed-crash',
          session_binding: { canonical_session_id: 'pristine-malformed-session' },
          test_only_ordinary_rollover_fault_injection: 'after_prepared_journal',
        }),
        /injected ordinary generation rollover crash at after_prepared_journal/,
      );
      const generationsDirectory = join(workspace, '.omx', 'state', 'authority', 'generations');
      const [orphanGenerationId] = await readdir(generationsDirectory);
      assert.ok(orphanGenerationId);
      const journalDirectory = join(generationsDirectory, orphanGenerationId, 'journals');
      const [journalName] = await readdir(journalDirectory);
      assert.ok(journalName);
      await writeFile(join(journalDirectory, journalName), '{malformed journal');

      await assert.rejects(
        initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: 'pristine-malformed-retry',
          session_binding: { canonical_session_id: 'pristine-malformed-session' },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.journalMalformed,
      );
      assert.equal(await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace)), null);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('fails closed on foreign or ambiguous unanchored pristine preparation evidence', async () => {
    for (const evidence of ['foreign', 'ambiguous'] as const) {
      const workspace = await mkdtemp(join(tmpdir(), `omx-authority-pristine-prepared-${evidence}-`));
      try {
        await assert.rejects(
          initializeStateAuthority({
            startup_cwd: workspace,
            launch_id: `pristine-${evidence}-crash`,
            session_binding: { canonical_session_id: `pristine-${evidence}-session` },
            test_only_ordinary_rollover_fault_injection: 'after_prepared_journal',
          }),
          /injected ordinary generation rollover crash at after_prepared_journal/,
        );
        const generationsDirectory = join(workspace, '.omx', 'state', 'authority', 'generations');
        const [orphanGenerationId] = await readdir(generationsDirectory);
        assert.ok(orphanGenerationId);
        if (evidence === 'foreign') {
          const journalDirectory = join(generationsDirectory, orphanGenerationId, 'journals');
          const [journalName] = await readdir(journalDirectory);
          assert.ok(journalName);
          const journalPath = join(journalDirectory, journalName);
          const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
          await writeFile(journalPath, `${JSON.stringify({ ...journal, workspace_identity_digest: 'f'.repeat(64) })}\n`);
        } else {
          await mkdir(join(generationsDirectory, 'ambiguous-generation', 'bindings'), { recursive: true });
          await mkdir(join(generationsDirectory, 'ambiguous-generation', 'journals'), { recursive: true });
        }

        await assert.rejects(
          initializeStateAuthority({
            startup_cwd: workspace,
            launch_id: `pristine-${evidence}-retry`,
            session_binding: { canonical_session_id: `pristine-${evidence}-session` },
          }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === (evidence === 'foreign'
              ? AUTHORITY_DIAGNOSTIC_CODES.journalConflict
              : AUTHORITY_DIAGNOSTIC_CODES.intentAmbiguous),
        );
        assert.equal(await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace)), null);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });
  it('recovers every ordinary rollover crash boundary without terminalizing its source before target publication', async () => {
    const points = [
      'after_prepared_journal',
      'after_pending_anchor',
      'after_applying_journal',
      'after_target_generation',
      'after_target_binding',
      'after_switched_anchor',
      'after_terminal_binding',
      'after_committed_journal',
    ] as const;
    for (const point of points) {
      const workspace = await mkdtemp(join(tmpdir(), `omx-authority-ordinary-rollover-${point}-`));
      try {
        const initial = await initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: `ordinary-source-${point}`,
          session_binding: { canonical_session_id: 'ordinary-source-session' },
        });
        const initialAnchor = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
        if (!initialAnchor?.active_binding_locator) throw new Error('initial authority binding locator is missing');
        const initialBindingLocator = initialAnchor.active_binding_locator;
        const sourceGeneration = JSON.parse(await readFile(initial.authority_path, 'utf-8')) as StateAuthorityGeneration;
        await writeFile(initial.authority_path, `${JSON.stringify({
          ...sourceGeneration,
          created_by_pid: 2147483001,
          created_by_process_started_at: 'linux:1',
          created_by_boot_id: 'retired-owner',
          created_by_command_digest: 'a'.repeat(64),
        })}\n`);

        const replacement = {
          startup_cwd: workspace,
          launch_id: `ordinary-target-${point}`,
          session_binding: { canonical_session_id: 'ordinary-target-session' },
        };
        await assert.rejects(
          initializeStateAuthority({
            ...replacement,
            test_only_ordinary_rollover_fault_injection: point,
          }),
          new RegExp(`injected ordinary generation rollover crash at ${point}`),
        );

        const afterCrash = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
        const switched = ['after_switched_anchor', 'after_terminal_binding', 'after_committed_journal'].includes(point);
        assert.equal(afterCrash?.active_generation_id === initial.generation.generation_id, !switched);
        if (!switched) {
          const sourceBinding = JSON.parse(await readFile(initialBindingLocator, 'utf-8')) as { lifecycle: string };
          assert.equal(sourceBinding.lifecycle, 'active');
        }

        const recovered = await initializeStateAuthority(replacement);
        assert.equal(recovered.session_binding?.canonical_session_id, 'ordinary-target-session');
        const resolution = await resolveStateAuthority({ startup_cwd: workspace, session_id: 'ordinary-target-session' });
        assert.equal(resolution.can_mutate, true);
        const finalized = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
        assert.equal(finalized?.pending_operation, undefined);
        assert.notEqual(finalized?.active_generation_id, initial.generation.generation_id);
        const terminalSourceBinding = JSON.parse(await readFile(initialBindingLocator, 'utf-8')) as { lifecycle: string };
        assert.equal(terminalSourceBinding.lifecycle, 'terminal');
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });

  it('does not write outside a replaced root at the validation-to-open or pre-rename boundary', async () => {
    if (process.platform !== 'linux') return;
    for (const boundary of ['validation-to-open', 'pre-rename'] as const) {
      const workspace = await mkdtemp(join(tmpdir(), `omx-authority-write-replacement-${boundary}-`));
      const outside = await mkdtemp(join(tmpdir(), `omx-authority-write-outside-${boundary}-`));
      const root = join(workspace, 'authority-root');
      const moved = join(workspace, 'authority-root-moved');
      const target = join(root, 'anchor.json');
      try {
        await mkdir(root);
        const rootIdentity = await captureRootFilesystemIdentity(root);
        let seamReached = false;
        const replaceRoot = async (): Promise<void> => {
          seamReached = true;
          await rename(root, moved);
          await symlink(outside, root, 'dir');
        };
        await assert.rejects(
          atomicWriteAuthorityFile(target, 'authority write\n', {
            authority_root: root,
            expected_root_identity: rootIdentity,
            ...(boundary === 'validation-to-open'
              ? { test_only_after_validation_before_open: replaceRoot }
              : { test_only_before_rename: replaceRoot }),
          }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
        );
        assert.equal(seamReached, true);
        assert.equal(existsSync(join(outside, 'anchor.json')), false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });

  it('fails closed when the held authority temporary is source-swapped before publication', async () => {
    if (process.platform !== 'linux') return;
    const root = await mkdtemp(join(tmpdir(), 'omx-authority-temp-source-swap-'));
    const target = join(root, 'authority.json');
    const movedTemporary = join(root, 'held-temporary');
    try {
      await assert.rejects(
        atomicWriteAuthorityFile(target, 'held authority content\n', {
          authority_root: root,
          test_only_before_rename: async (temporaryPath) => {
            await rename(temporaryPath, movedTemporary);
            await writeFile(temporaryPath, 'replacement authority content\n');
          },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      );
      assert.equal(existsSync(target), false);
      assert.equal(await readFile(movedTemporary, 'utf8'), 'held authority content\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('selects revalidated path primitives when stable descriptor paths are unavailable', () => {
    const windows = stateAuthorityFilesystemPrimitiveForPlatform('win32');
    assert.equal(windows.descriptor_relative, false);
    assert.equal(windows.file_open_flags, 0);
    assert.equal(windows.directory_open_flags, null);

    const darwin = stateAuthorityFilesystemPrimitiveForPlatform('darwin');
    assert.equal(darwin.descriptor_relative, false);

    const linux = stateAuthorityFilesystemPrimitiveForPlatform('linux');
    assert.equal(linux.descriptor_relative, true);
  });

  it('reports a verified descriptor or revalidated-path mutation primitive only when usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-authority-capability-'));
    try {
      const capability = await probeStateAuthorityFilesystemCapability(root);
      if (process.platform === 'win32') {
        assert.equal(capability.no_follow_directories, 'unsupported');
        assert.equal(capability.revalidated_path_mutation, 'verified');
      }
      const target = join(root, 'authority.json');
      if (capability.no_follow_directories === 'verified' || capability.revalidated_path_mutation === 'verified') {
        await atomicWriteAuthorityFile(target, 'verified authority mutation primitive\n', {
          authority_root: root,
        });
        assert.equal(await readFile(target, 'utf-8'), 'verified authority mutation primitive\n');
      } else {
        await assert.rejects(
          atomicWriteAuthorityFile(target, 'must fail closed\n', { authority_root: root }),
          (error: unknown) => error instanceof Error
            && 'code' in error
            && error.code === AUTHORITY_DIAGNOSTIC_CODES.rootCapabilityWeak,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers every durable alternate-root rollover crash boundary without pre-journal alternate effects', async () => {
    const points = [
      'after_prepared_journal',
      'after_pending_anchor',
      'after_prepared_intent',
      'after_target_generation',
      'after_target_binding',
      'after_switched_anchor',
      'after_terminal_binding',
      'after_committed_journal',
    ] as const;
    for (const point of points) {
      const workspace = await mkdtemp(join(tmpdir(), `omx-authority-rollover-${point}-`));
      const runParent = await mkdtemp(join(tmpdir(), `omx-authority-rollover-run-${point}-`));
      const runRoot = join(runParent, 'run-root');
      try {
        const initial = await initializeStateAuthority({
          startup_cwd: workspace,
          launch_id: `source-${point}`,
          session_binding: { canonical_session_id: 'rollover-session' },
        });
        const alternateStateRoot = join(runRoot, '.omx', 'state');
        await assert.rejects(
          rolloverStateAuthorityToAlternateRoot({
            context: initial,
            proposed_state_root: alternateStateRoot,
            creation_root: runRoot,
            launch_id: `rollover-${point}`,
            consumer_kind: 'madmax',
            issuer,
            fault_injection: point,
          }),
          /injected alternate-root rollover crash/,
        );
        if (point === 'after_prepared_journal') {
          assert.equal(existsSync(alternateStateRoot), false);
          assert.equal(existsSync(runRoot), false);
          const journalDirectory = join(initial.canonical_state_root, 'authority', 'generations', initial.generation.generation_id, 'journals');
          assert.ok((await readdir(journalDirectory)).some((entry) => entry.endsWith('.json')));
        }
        if (point === 'after_prepared_intent') {
          assert.equal(existsSync(alternateStateRoot), false);
          assert.equal(existsSync(runRoot), false);
          const preparedAnchor = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
          assert.equal(preparedAnchor?.alternate_intents.at(-1)?.status, 'preparing');
        }

        const recovered = await resolveStateAuthority({ startup_cwd: workspace });
        assert.equal(recovered.can_mutate, true, `${point}: ${recovered.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')}`);
        const switched = point === 'after_switched_anchor'
          || point === 'after_terminal_binding'
          || point === 'after_committed_journal';
        assert.equal(
          recovered.context?.canonical_state_root,
          switched
            ? canonicalizeExistingAuthorityPath(alternateStateRoot)
            : initial.canonical_state_root,
        );
        const anchor = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
        assert.equal(anchor?.pending_operation, undefined);
        if (point === 'after_prepared_intent') {
          assert.equal(anchor?.alternate_intents.at(-1)?.status, 'aborted');
        }

      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(runParent, { recursive: true, force: true });
      }
    }
  });
  it('recovers a pending concurrent rollover observed only after preparation lock acquisition', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-rollover-preparation-race-'));
    const firstRoot = await mkdtemp(join(tmpdir(), 'omx-authority-rollover-preparation-first-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'omx-authority-rollover-preparation-second-'));
    try {
      const initial = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'rollover-preparation-source',
        session_binding: { canonical_session_id: 'rollover-preparation-session' },
      });
      let signalFirstPreparationLocked!: () => void;
      const firstPreparationLocked = new Promise<void>((resolve) => {
        signalFirstPreparationLocked = resolve;
      });
      let releaseFirstPreparation!: () => void;
      const firstPreparationReleased = new Promise<void>((resolve) => {
        releaseFirstPreparation = resolve;
      });
      let signalSecondPreflightComplete!: () => void;
      const secondPreflightComplete = new Promise<void>((resolve) => {
        signalSecondPreflightComplete = resolve;
      });
      let releaseSecondPreflight!: () => void;
      const secondPreflightReleased = new Promise<void>((resolve) => {
        releaseSecondPreflight = resolve;
      });

      const first = rolloverStateAuthorityToAlternateRoot({
        context: initial,
        proposed_state_root: join(firstRoot, '.omx', 'state'),
        creation_root: firstRoot,
        launch_id: 'rollover-preparation-first',
        consumer_kind: 'madmax',
        issuer,
        fault_injection: 'after_pending_anchor',
        test_only_after_preparation_lock_acquired: async () => {
          signalFirstPreparationLocked();
          await firstPreparationReleased;
        },
      });
      await firstPreparationLocked;

      const second = rolloverStateAuthorityToAlternateRoot({
        context: initial,
        proposed_state_root: join(secondRoot, '.omx', 'state'),
        creation_root: secondRoot,
        launch_id: 'rollover-preparation-second',
        consumer_kind: 'boxed',
        issuer,
        test_only_after_pending_recovery_before_preparation_lock: async () => {
          signalSecondPreflightComplete();
          await secondPreflightReleased;
        },
      });
      await secondPreflightComplete;
      releaseFirstPreparation();
      await assert.rejects(first, /injected alternate-root rollover crash at after_pending_anchor/);
      releaseSecondPreflight();

      const resolved = await second;
      assert.equal(
        resolved.canonical_state_root,
        canonicalizeExistingAuthorityPath(join(secondRoot, '.omx', 'state')),
      );
      const anchor = await readWorkspaceAuthorityAnchor(resolveWorkspaceIdentity(workspace));
      assert.equal(anchor?.pending_operation, undefined);
      assert.ok(anchor?.alternate_intents.every((intent) => intent.status !== 'prepared' && intent.status !== 'preparing'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('rejects alternate-root replacement while a prepared intent is restart-pending', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-rollover-replaced-'));
    const runRoot = await mkdtemp(join(tmpdir(), 'omx-authority-rollover-replaced-run-'));
    try {
      const initial = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'replacement-source',
        session_binding: { canonical_session_id: 'replacement-session' },
      });
      const alternateStateRoot = join(runRoot, '.omx', 'state');
      await assert.rejects(
        rolloverStateAuthorityToAlternateRoot({
          context: initial,
          proposed_state_root: alternateStateRoot,
          creation_root: runRoot,
          launch_id: 'replacement-rollover',
          consumer_kind: 'madmax',
          issuer,
          fault_injection: 'after_prepared_intent',
        }),
        /injected alternate-root rollover crash/,
      );
      await rm(alternateStateRoot, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await mkdir(alternateStateRoot, { recursive: true });
      const resolution = await resolveStateAuthority({ startup_cwd: workspace });
      assert.equal(resolution.can_mutate, false);
      assert.equal(resolution.diagnostics.at(-1)?.code, AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });
  it('replays every launch transport crash boundary before exposing a verified persistent effect', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-launch-transport-replay-'));
    try {
      const context = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'launch-transport-replay',
        session_binding: { canonical_session_id: 'launch-transport-replay-session' },
      });
      const faults = [
        'after_prepared_journal',
        'after_applying_journal',
        'after_committed_journal',
        'after_persistent_publication',
      ] as const;
      for (const fault of faults) {
        const effectPath = join(workspace, `${fault}.json`);
        const publish = async (test_only_fault_injection?: typeof fault) =>
          await publishStateAuthorityLaunchTransport({
            context,
            binding_key: `replay-${fault}`,
            effects: { effect: 'test-transport-replay', fault },
            prepare: async () => {
              await mkdir(join(workspace, 'transport-prepared'), { recursive: true });
            },
            publish: async (_context, publication) => {
              await writeFile(effectPath, `${JSON.stringify({
                operation_id: publication.operation_id,
                authority_id: publication.authority_id,
                generation_id: publication.generation_id,
                binding_id: publication.binding_id,
                fencing_token: publication.fencing_token,
              })}\n`);
              return publication;
            },
            verify: async (_context, publication) => {
              const persisted = JSON.parse(await readFile(effectPath, 'utf-8')) as { operation_id?: string };
              assert.equal(persisted.operation_id, publication.operation_id);
            },
            ...(test_only_fault_injection ? { test_only_fault_injection } : {}),
          });

        await assert.rejects(() => publish(fault), /injected launch transport crash/);
        if (fault === 'after_prepared_journal' || fault === 'after_applying_journal') {
          assert.equal(existsSync(effectPath), false);
        } else {
          assert.equal(existsSync(effectPath), true);
        }
        const journalDirectory = join(
          context.canonical_state_root,
          'authority',
          'generations',
          context.generation.generation_id,
          'journals',
        );
        const interruptedJournals = await Promise.all((await readdir(journalDirectory)).map(async (entry) =>
          await readStateAuthorityJournal(join(journalDirectory, entry))));
        const expectedInterruptedStatus = fault === 'after_committed_journal'
          ? 'committed'
          : fault === 'after_prepared_journal'
            ? 'prepared'
            : 'applying';
        assert.equal(interruptedJournals.some((entry) => entry.status === expectedInterruptedStatus), true);
        const publication = await publish();
        const journal = await readStateAuthorityJournal(authorityJournalPath(
          context.canonical_state_root,
          context.generation.generation_id,
          publication.operation_id,
        ));
        assert.equal(journal.status, 'committed');
        assert.equal((await readFile(effectPath, 'utf-8')).includes('CAPABILITY'), false);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects forged and stale launch transport authority tuples before reuse', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'omx-authority-launch-transport-forgery-'));
    try {
      const context = await initializeStateAuthority({
        startup_cwd: workspace,
        launch_id: 'launch-transport-forgery',
        session_binding: { canonical_session_id: 'launch-transport-forgery-session' },
      });
      const publication = await publishStateAuthorityLaunchTransport({
        context,
        binding_key: 'forgery-validation',
        effects: { effect: 'forgery-validation' },
        publish: async (_context, active) => active,
        verify: async () => {},
      });
      const journal = await readStateAuthorityJournal(authorityJournalPath(
        context.canonical_state_root,
        context.generation.generation_id,
        publication.operation_id,
      ));
      await validateCommittedStateAuthorityLaunchTransportJournal(context, {
        operation_id: publication.operation_id,
        effects_digest: journal.effects_digest,
      });
      await assert.rejects(
        validateCommittedStateAuthorityLaunchTransportJournal(context, {
          operation_id: publication.operation_id,
          effects_digest: 'f'.repeat(64),
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === AUTHORITY_DIAGNOSTIC_CODES.journalConflict,
      );
      await assert.rejects(
        () => validateCommittedStateAuthorityLaunchTransportPublication(context, {
          ...publication,
          root_identity: {
            ...publication.root_identity,
            canonical_path: join(workspace, 'forged-root'),
          },
        }),
        /authority tuple changed|root fingerprint/i,
      );
      await mintStateAuthorityTransportCapability(context);
      await assert.rejects(
        () => validateCommittedStateAuthorityLaunchTransportPublication(context, publication),
        /authority tuple changed/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

});
