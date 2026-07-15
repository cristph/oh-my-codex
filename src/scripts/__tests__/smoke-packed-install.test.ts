// @ts-nocheck
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CODEX_APP_SERVER_TIMEOUTS,
  CodexAppServer,
  CodexExecutableNotFoundError,
  MANAGED_CODEX_HOOK_EVENTS,
  PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS,
  PACKED_INSTALL_SMOKE_CORE_COMMANDS,
  appendForeignHookGroups,
  appendDisplayOrderStableForeignHookGroups,
  buildNativeHookSmokePayload,
  createCodexBatchWriteEnvelope,
  createCodexHooksListEnvelope,
  createCodexInitializeEnvelope,
  foreignHookGroupSnapshot,
  generatedHookTrustState,
  hasUsableNodeModules,
  parseNpmPackJsonOutput,
  parseCodexHooksListResult,
  probeCodexVersion,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
  validateHookStdout,
  ensureRepoDependencies,
  assertCodexBatchWriteResult,
  assertGeneratedTrustMatchesCodex,
  managedCodexHooksByEvent,
} from '../smoke-packed-install.js';

function createFakeCodexAppServer(
  onRequest: (request: Record<string, unknown>, child: EventEmitter & Record<string, unknown>) => void,
): CodexAppServer {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on('data', (chunk: Buffer) => onRequest(JSON.parse(chunk.toString('utf-8')), child));
  child.stdin.on('finish', () => child.emit('close', 0, null));
  return new CodexAppServer(child as never);
}


test('packed install smoke retains narrow boot commands and adds the isolated lifecycle separately', () => {
  assert.deepEqual(PACKED_INSTALL_SMOKE_CORE_COMMANDS, [
    ['--help'],
    ['version'],
    ['api', '--help'],
    ['sparkshell', '--help'],
  ]);
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('api')),
    true,
  );
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('sparkshell')),
    true,
  );
});

test('packed lifecycle keeps the pinned newline-delimited Codex app-server envelopes literal', () => {
  assert.deepEqual(createCodexInitializeEnvelope('omx-hook-trust-regression'), {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'omx-hook-trust-regression', version: '1.0.0' },
      capabilities: null,
    },
  });
  assert.deepEqual(createCodexHooksListEnvelope('/tmp/project'), {
    id: 2,
    method: 'hooks/list',
    params: { cwds: ['/tmp/project'] },
  });
  assert.deepEqual(createCodexBatchWriteEnvelope({ first: 'sha256:first', second: 'sha256:second' }), {
    id: 3,
    method: 'config/batchWrite',
    params: {
      edits: [{
        keyPath: 'hooks.state',
        value: {
          first: { trusted_hash: 'sha256:first' },
          second: { trusted_hash: 'sha256:second' },
        },
        mergeStrategy: 'upsert',
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  });
  assert.deepEqual(CODEX_APP_SERVER_TIMEOUTS, {
    versionProbeMs: 2_000,
    initializeMs: 15_000,
    requestMs: 10_000,
    shutdownMs: 5_000,
  });
});
test('Codex app-server accepts method-bearing notifications but rejects invalid idless envelopes', async () => {
  const accepted = createFakeCodexAppServer((request, child) => {
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: 'fake' } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  });
  assert.deepEqual(await accepted.request({ id: 1, method: 'hooks/list' }, 100), { ok: true });
  await accepted.close();

  for (const envelope of [
    { result: { invalid: true } },
    { error: { code: -1, message: 'invalid' } },
    { unknown: true },
    { method: '   ' },
    { method: 'thread/started', result: { invalid: true } },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify(envelope)}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /invalid idless JSON-RPC envelope/,
    );
    await assert.rejects(server.close(), /invalid idless JSON-RPC envelope/);
  }
});

test('Codex app-server rejects id-bearing envelopes that mix response and request fields', async () => {
  for (const envelope of [
    { id: 1, method: 'thread/started', result: { invalid: true } },
    { id: 1, params: { thread: 'fake' }, result: { invalid: true } },
    { id: 1, method: 'thread/started', params: {}, error: { code: -1, message: 'invalid' } },
    { id: 1, result: { invalid: true }, error: { code: -1, message: 'invalid' } },
    { id: 1 },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify(envelope)}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /codex app-server response/,
    );
    await assert.rejects(server.close(), /codex app-server response/);
  }
});

test('Codex app-server validates JSON-RPC error response shapes', async () => {
  const valid = createFakeCodexAppServer((_request, child) => {
    child.stdout.write(`${JSON.stringify({
      id: 1,
      error: { code: -32600, message: 'invalid request', data: { source: 'fake' } },
    })}\n`);
  });
  await assert.rejects(valid.request({ id: 1, method: 'hooks/list' }, 100), /returned JSON-RPC error/);
  await valid.close();

  for (const error of [
    null,
    {},
    { code: '-32600', message: 'invalid request' },
    { code: -32600, message: null },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify({ id: 1, error })}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /malformed JSON-RPC error/,
    );
    await assert.rejects(server.close(), /malformed JSON-RPC error/);
  }
});

test('Codex app-server incrementally decodes split UTF-8 responses and rejects invalid byte sequences', async () => {
  const split = createFakeCodexAppServer((_request, child) => {
    child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
    child.stdout.write(Buffer.from([0xe2, 0x82]));
    child.stdout.write(Buffer.from([0xac]));
    child.stdout.write(Buffer.from('"}\n', 'utf-8'));
  });
  assert.equal(await split.request({ id: 1, method: 'hooks/list' }, 100), '€');
  await split.close();

  for (const writeInvalidResponse of [
    (child: EventEmitter & Record<string, unknown>) => {
      child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
      child.stdout.write(Buffer.from([0xff]));
      child.stdout.write(Buffer.from('"}\n', 'utf-8'));
    },
    (child: EventEmitter & Record<string, unknown>) => {
      child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
      child.stdout.write(Buffer.from([0xc3]));
    },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => writeInvalidResponse(child));
    const request = server.request({ id: 1, method: 'hooks/list' }, 100);
    await assert.rejects(
      Promise.all([request, server.close()]),
      /invalid UTF-8 stdout/,
    );
  }
});


test('Codex app-server rejects non-empty unterminated stdout when the server closes', async () => {
  const server = createFakeCodexAppServer((_request, child) => {
    child.stdout.write('{"id":1');
  });
  const request = server.request({ id: 1, method: 'hooks/list' }, 100);
  await assert.rejects(
    Promise.all([request, server.close()]),
    /unterminated JSON-RPC stdout/,
  );
});

test('packed lifecycle parses the pinned hooks/list eventName schema', () => {
  const project = '/tmp/project';
  const hooksPath = '/tmp/project/.codex/hooks.json';
  const parsed = parseCodexHooksListResult({
    data: [{
      cwd: project,
      hooks: [{
        eventName: 'preToolUse',
        command: 'node hook.js',
        sourcePath: hooksPath,
        key: `${hooksPath}:pre_tool_use:0:0`,
        currentHash: 'sha256:current',
        displayOrder: 0,
        trustStatus: 'trusted',
      }],
      warnings: [],
      errors: [],
    }],
  }, project, hooksPath);

  assert.equal(parsed.hooks[0]?.event, 'PreToolUse');
  assert.equal(parsed.hooks[0]?.trustStatus, 'trusted');
});

test('packed lifecycle normalizes omitted enabled handlers and rejects disabled or non-integer hook metadata', () => {
  const project = '/tmp/project';
  const hooksPath = '/tmp/project/.codex/hooks.json';
  const response = {
    data: [{
      cwd: project,
      hooks: [{
        eventName: 'preToolUse',
        command: 'node hook.js',
        sourcePath: hooksPath,
        key: `${hooksPath}:pre_tool_use:0:0`,
        currentHash: 'sha256:current',
        displayOrder: 0,
        trustStatus: 'trusted',
      }],
      warnings: [],
      errors: [],
    }],
  };
  assert.doesNotThrow(() => parseCodexHooksListResult(response, project, hooksPath));

  for (const update of [
    { enabled: false },
    { enabled: 'true' },
    { enabled: true, displayOrder: 0.5 },
    { enabled: true, displayOrder: -1 },
  ]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.data[0]!.hooks[0]!, update);
    assert.throws(
      () => parseCodexHooksListResult(invalid, project, hooksPath),
      /enabled command handler|invalid hooks\[0\]\.displayOrder/,
    );
  }
});


test('packed lifecycle requires exactly seven generated OMX trust keys and an isolated approval target', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  const trust = Object.fromEntries(hooks.map((hook) => [hook.key, hook.currentHash]));
  assert.doesNotThrow(() => assertGeneratedTrustMatchesCodex(trust, hooks));
  assert.throws(
    () => assertGeneratedTrustMatchesCodex({
      ...trust,
      '/tmp/project/.codex/hooks.json:foreign:0:0': 'sha256:foreign',
    }, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(Object.fromEntries(Object.entries(trust).slice(0, -1)), hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
  assert.doesNotThrow(() => assertCodexBatchWriteResult({
    filePath: '/tmp/isolated-codex-home/config.toml',
    status: 'ok',
    version: null,
  }, '/tmp/isolated-codex-home/config.toml'));
  assert.throws(
    () => assertCodexBatchWriteResult({
      filePath: '/home/user/.codex/config.toml',
      status: 'ok',
      version: null,
    }, '/tmp/isolated-codex-home/config.toml'),
    /expected isolated user config/,
  );
});

test('packed lifecycle fails closed on malformed project hooks.state entries and stale raw keys', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  const validConfig = [
    '[hooks.state]',
    ...hooks.map((hook) => `${JSON.stringify(hook.key)} = { trusted_hash = ${JSON.stringify(hook.currentHash)} }`),
  ].join('\n');

  const generatedTrust = generatedHookTrustState(validConfig);
  assert.doesNotThrow(() => assertGeneratedTrustMatchesCodex(generatedTrust, hooks));

  for (const malformedEntry of [
    'first = "sha256:first"',
    'first = {}',
    'first = { trusted_hash = "" }',
    'first = { trusted_hash = 1 }',
    'first = { trusted_hash = "sha256:first", extra = "unexpected" }',
  ]) {
    assert.throws(
      () => generatedHookTrustState(`[hooks.state]\n${malformedEntry}`),
      /invalid hooks\.state entry first/,
    );
  }

  const staleRawTrust = generatedHookTrustState(`${validConfig}\nforeign = { trusted_hash = "sha256:foreign" }`);
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(staleRawTrust, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );

  const protoRawTrust = generatedHookTrustState(
    `${validConfig}\n__proto__ = { trusted_hash = "sha256:proto" }`,
  );
  assert.equal(Object.hasOwn(protoRawTrust, '__proto__'), true);
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(protoRawTrust, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
});
test('packed lifecycle treats only the production command grammar as managed ownership', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  hooks[0]!.command = 'node /tmp/foreign-codex-native-hook.js';
  assert.throws(
    () => managedCodexHooksByEvent(hooks),
    /Expected exactly one OMX SessionStart hook from Codex, received 0/,
  );
});
test('packed lifecycle resolves Windows npm shims through safe command specs for version probes and app-server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-windows-shim-'));
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        queueMicrotask(() => child.emit('close', 0, null));
        return true;
      },
    });
    child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  try {
    for (const extension of ['.cmd', '.ps1']) {
      const bin = join(root, extension.slice(1));
      const codexPath = join(bin, `codex${extension}`);
      const powershellPath = join(bin, 'powershell.exe');
      await mkdir(bin, { recursive: true });
      await Promise.all([writeFile(codexPath, ''), writeFile(powershellPath, '')]);

      const versionSpawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      const appSpawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      const seam = {
        platform: 'win32' as const,
        spawnSyncImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
          versionSpawns.push({ command, args, options });
          return { status: 0, stdout: 'codex-cli 0.142.5\n', stderr: '', error: undefined };
        }) as never,
        spawnImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
          appSpawns.push({ command, args, options });
          return fakeChild();
        }) as never,
      };
      const env = { PATH: bin, PATHEXT: extension.toUpperCase() };

      assert.equal(probeCodexVersion(root, env, seam), 'codex-cli 0.142.5');
      const server = await CodexAppServer.start({ cwd: root, env, commandSeam: seam });
      await server.close();

      assert.equal(versionSpawns.length, 2);
      assert.deepEqual(versionSpawns.map(({ command, args, options }) => ({ command, args, options })),
        extension === '.cmd'
          ? [
            {
              command: 'cmd.exe',
              args: ['/d', '/s', '/c', `""${codexPath}" "--version""`],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            },
            {
              command: 'cmd.exe',
              args: ['/d', '/s', '/c', `""${codexPath}" "--version""`],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            },
          ]
          : [
            {
              command: powershellPath,
              args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, '--version'],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
              },
            },
            {
              command: powershellPath,
              args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, '--version'],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
              },
            },
          ],
      );
      assert.deepEqual(appSpawns, extension === '.cmd'
        ? [{
          command: 'cmd.exe',
          args: ['/d', '/s', '/c', `""${codexPath}" "app-server" "--stdio""`],
          options: { cwd: root, env, stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: true },
        }]
        : [{
          command: powershellPath,
          args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, 'app-server', '--stdio'],
          options: { cwd: root, env, stdio: 'pipe', windowsHide: true },
        }]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle bypasses an unrelated codex binary shadowing the pinned CLI', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-path-'));
  const shadowDir = join(root, 'shadow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([
      mkdir(shadowDir, { recursive: true }),
      mkdir(pinnedDir, { recursive: true }),
    ]);
    const shadow = join(shadowDir, 'codex');
    const pinned = join(pinnedDir, 'codex');
    await Promise.all([
      writeFile(shadow, '#!/bin/sh\necho "codex 0.2.3"\n'),
      writeFile(pinned, '#!/bin/sh\necho "codex-cli 0.142.5"\n'),
    ]);
    await Promise.all([chmod(shadow, 0o755), chmod(pinned, 0o755)]);

    assert.equal(
      probeCodexVersion(root, { PATH: `${shadowDir}${delimiter}${pinnedDir}` }),
      'codex-cli 0.142.5',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle deduplicates repeated PATH entries before enforcing the candidate budget', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-path-dedup-'));
  const shadowDir = join(root, 'shadow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([
      mkdir(shadowDir, { recursive: true }),
      mkdir(pinnedDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(shadowDir, 'codex'), '#!/bin/sh\necho "codex 0.2.3"\n'),
      writeFile(join(pinnedDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.142.5"\n'),
    ]);
    await Promise.all([
      chmod(join(shadowDir, 'codex'), 0o755),
      chmod(join(pinnedDir, 'codex'), 0o755),
    ]);

    assert.equal(
      probeCodexVersion(root, {
        PATH: [...Array.from({ length: 40 }, () => shadowDir), pinnedDir].join(delimiter),
      }),
      'codex-cli 0.142.5',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle accepts only the exact stable pinned Codex version output', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-version-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  const candidates = [
    { output: 'codex-cli 0.142.5', stderr: '', accepted: true },
    { output: 'codex-cli 0.142.5', stderr: 'warning: harmless test diagnostic', accepted: true },
    { output: 'codex-cli 0.142.5\nextra output', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5-beta', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5+meta', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5.1', stderr: '', accepted: false },
    { output: 'codex-cli v0.142.5', stderr: '', accepted: false },
    { output: 'codex-cli 0-142-5', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5', stderr: 'unexpected version probe error', accepted: false },
  ];
  try {
    await mkdir(candidateDir, { recursive: true });
    for (const candidate of candidates) {
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${candidate.output}'\n${candidate.stderr ? `printf '%s\\n' '${candidate.stderr}' >&2\n` : ''}`,
      );
      await chmod(executable, 0o755);
      if (candidate.accepted) {
        assert.equal(probeCodexVersion(root, { PATH: candidateDir }), 'codex-cli 0.142.5');
      } else {
        assert.throws(
          () => probeCodexVersion(root, { PATH: candidateDir }),
          /Unsupported installed Codex version for the 0\.142\.5 boundary/,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('packed lifecycle does not classify an installed Codex with a broken shebang as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-broken-shebang-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(executable, '#!/definitely-not-an-installed-interpreter\n');
    await chmod(executable, 0o755);
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDir }),
      /launch returned ENOENT after an existing candidate was observed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle does not classify a dangling Codex candidate as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-dangling-'));
  const candidateDir = join(root, 'candidate');
  try {
    await mkdir(candidateDir, { recursive: true });
    await symlink(join(root, 'missing-codex'), join(candidateDir, 'codex'));
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDir }),
      /candidate exists but its target is unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('packed lifecycle does not classify a dangling PATH entry as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-dangling-path-'));
  const danglingPathEntry = join(root, 'dangling-path-entry');
  try {
    await symlink(join(root, 'missing-path-entry'), danglingPathEntry);
    assert.throws(
      () => probeCodexVersion(root, { PATH: danglingPathEntry }),
      /PATH entry exists but its target is unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle bounds all slow Codex candidates with a global deadline', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-global-deadline-'));
  const slowDirs = ['slow-one', 'slow-two', 'slow-three'].map((name) => join(root, name));
  try {
    await Promise.all(slowDirs.map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(slowDirs.map(async (dir) => {
      const executable = join(dir, 'codex');
      await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 30\n');
      await chmod(executable, 0o755);
    }));
    const startedAt = Date.now();
    assert.throws(
      () => probeCodexVersion(root, { PATH: slowDirs.join(delimiter) }),
      /global deadline/,
    );
    assert.ok(Date.now() - startedAt < 6_500, 'the global version-resolution deadline must force termination');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle fails before probing the 33rd unique PATH candidate', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-candidate-budget-'));
  const candidateDirs = Array.from({ length: 33 }, (_value, index) => join(root, `candidate-${index}`));
  const thirtyThirdProbe = join(root, '33rd-candidate-was-probed');
  try {
    await Promise.all(candidateDirs.map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(candidateDirs.map(async (dir, index) => {
      const executable = join(dir, 'codex');
      await writeFile(
        executable,
        index === candidateDirs.length - 1
          ? `#!/bin/sh\n: > ${JSON.stringify(thirtyThirdProbe)}\nprintf '%s\\n' 'codex-cli 0.142.5'\n`
          : '#!/bin/sh\nexit 1\n',
      );
      await chmod(executable, 0o755);
    }));
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDirs.join(delimiter) }),
      /32-candidate PATH budget/,
    );
    await assert.rejects(access(thirtyThirdProbe));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle continues after a timed-out version probe candidate', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-timeout-'));
  const slowDir = join(root, 'slow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([mkdir(slowDir, { recursive: true }), mkdir(pinnedDir, { recursive: true })]);
    await Promise.all([
      writeFile(join(slowDir, 'codex'), '#!/bin/sh\nexec /bin/sleep 30\n'),
      writeFile(join(pinnedDir, 'codex'), '#!/bin/sh\nprintf \'%s\\n\' \'codex-cli 0.142.5\'\n'),
    ]);
    await Promise.all([chmod(join(slowDir, 'codex'), 0o755), chmod(join(pinnedDir, 'codex'), 0o755)]);

    const startedAt = Date.now();
    assert.equal(probeCodexVersion(root, { PATH: `${slowDir}${delimiter}${pinnedDir}` }), 'codex-cli 0.142.5');
    assert.ok(Date.now() - startedAt < 5_000, 'a timed-out candidate must not block later PATH candidates');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle fails instead of skipping when Codex disappears after start version validation', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-disappears-after-version-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(executable, [
      '#!/bin/sh',
      'state="${0}.version-count"',
      'if [ "$1" = "--version" ]; then',
      '  if [ -f "$state" ]; then /bin/rm -f "$0"; else : > "$state"; fi',
      '  printf \'%s\\n\' \'codex-cli 0.142.5\'',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'));
    await chmod(executable, 0o755);
    assert.equal(probeCodexVersion(root, { PATH: candidateDir }), 'codex-cli 0.142.5');

    await assert.rejects(
      CodexAppServer.start({ cwd: root, env: { PATH: candidateDir } }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error instanceof CodexExecutableNotFoundError, false);
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle preserves the true-absence Codex skip signal', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-absent-'));
  try {
    assert.throws(
      () => probeCodexVersion(root, { PATH: root }),
      CodexExecutableNotFoundError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle pre-seeds and preserves nested foreign group and handler coordinates', () => {
  const marker = 'packed-foreign-fixture';
  const seeded = appendForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true });
  const inserted = appendForeignHookGroups(seeded, marker, { appendGroups: false });
  const snapshot = foreignHookGroupSnapshot(inserted, marker);

  assert.equal(snapshot.length, 4);
  assert.deepEqual(
    snapshot.map((entry) => ({
      event: entry.event,
      groupIndex: entry.groupIndex,
      handlerIndex: entry.handlerIndex,
    })),
    [
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 1 },
      { event: 'PostToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PostToolUse', groupIndex: 0, handlerIndex: 1 },
    ],
  );
  assert.match(inserted, /foreign_group_metadata/);
  assert.match(inserted, /foreign_handler_metadata/);
});

test('display-order-stable foreign fixture preserves pre-approved group and handler coordinates', () => {
  const marker = 'packed-display-order-fixture';
  const seeded = appendDisplayOrderStableForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true });
  const inserted = appendDisplayOrderStableForeignHookGroups(seeded, marker, { appendGroups: false });
  const snapshot = foreignHookGroupSnapshot(inserted, marker);

  assert.deepEqual(
    snapshot.map((entry) => ({
      event: entry.event,
      groupIndex: entry.groupIndex,
      handlerIndex: entry.handlerIndex,
    })),
    [
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 1 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 2 },
    ],
  );
});

test('packed install smoke covers every installed native hook event with minimal payloads', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS, [
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'PreCompact',
    'PostCompact',
    'Stop',
  ]);

  for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
    const payload = buildNativeHookSmokePayload(eventName, '/tmp/omx-packed-hook-smoke');
    assert.equal(payload.hook_event_name, eventName);
    assert.equal(typeof payload.session_id, 'string');
    assert.equal(payload.cwd, '/tmp/omx-packed-hook-smoke');
  }
});

test('packed lifecycle and native hook smoke share the seven managed event names', () => {
  assert.deepEqual(MANAGED_CODEX_HOOK_EVENTS, PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS);
});

test('packed install native hook stdout validation enforces event output contracts', () => {
  assert.doesNotThrow(() => validateHookStdout('PostCompact', ''));
  assert.doesNotThrow(() => validateHookStdout('Stop', '{}\n'));
  assert.throws(
    () => validateHookStdout('PostCompact', '{}\n'),
    /PostCompact must emit empty stdout/,
  );
  for (const value of ['\n', ' ', ' \r\n']) {
    assert.throws(
      () => validateHookStdout('PostCompact', value),
      /PostCompact must emit empty stdout/,
    );
  }
  for (const value of ['null', '[]', '"text"', '1']) {
    assert.throws(
      () => validateHookStdout('Stop', value),
      /non-object JSON stdout payload/,
    );
  }
  assert.throws(
    () => validateHookStdout('UserPromptSubmit', '{not json'),
    /native hook UserPromptSubmit emitted invalid JSON stdout/,
  );
});

test('parseNpmPackJsonOutput ignores prepack logs before npm pack JSON', () => {
  const parsed = parseNpmPackJsonOutput([
    '[sync-plugin-mirror] synced 29 canonical skill directories and plugin metadata',
    '[',
    '  {',
    '    "filename": "oh-my-codex-0.15.0.tgz"',
    '  }',
    ']',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [{ filename: 'oh-my-codex-0.15.0.tgz' }]);
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }) as ReturnType<typeof import('node:child_process').spawnSync>);
  assert.equal(commonDir, '/tmp/primary/.git');
});

test('hasUsableNodeModules requires the packaged build dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-node-modules-'));
  try {
    const nodeModules = join(root, 'node_modules');
    await mkdir(join(nodeModules, 'typescript'), { recursive: true });
    await mkdir(join(nodeModules, '@iarna', 'toml'), { recursive: true });
    await mkdir(join(nodeModules, '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(nodeModules, 'zod'), { recursive: true });
    await writeFile(join(nodeModules, 'typescript', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(nodeModules, 'zod', 'package.json'), '{}');

    assert.equal(hasUsableNodeModules(root), true);

    await rm(join(nodeModules, 'zod', 'package.json'));
    assert.equal(hasUsableNodeModules(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveReusableNodeModulesSource reuses primary worktree node_modules when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-reuse-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const reusable = resolveReusableNodeModulesSource(worktreeRepo, () => ({
      status: 0,
      stdout: `${join(primaryRepo, '.git')}\n`,
      stderr: '',
    }) as ReturnType<typeof import('node:child_process').spawnSync>);

    assert.equal(reusable, join(primaryRepo, 'node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies symlinks a reusable primary worktree node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-symlink-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const events: string[] = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message: string) => events.push(message),
    });

    assert.equal(result.strategy, 'symlink');
    assert.equal(result.sourceNodeModulesPath, join(primaryRepo, 'node_modules'));
    assert.equal(events[0], `[smoke:packed-install] Reusing node_modules from ${join(primaryRepo, 'node_modules')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies falls back to npm ci when no reusable node_modules source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-install-node-modules-'));
  try {
    const installs: string[] = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: (cwd: string) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
