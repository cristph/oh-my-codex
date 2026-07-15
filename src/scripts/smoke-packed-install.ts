import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import TOML from '@iarna/toml';
import { isManagedCodexHookCommand, planManagedCodexHooksRemoval } from '../config/codex-hooks.js';
import {
  spawnPlatformCommand,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';

import {
  ensureReusableNodeModules,
} from '../utils/repo-deps.js';


export {
  hasUsableNodeModules,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
} from '../utils/repo-deps.js';

export const PACKED_INSTALL_SMOKE_CORE_COMMANDS = [
  ['--help'],
  ['version'],
  ['api', '--help'],
  ['sparkshell', '--help'],
] as const;

export const MANAGED_CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

export const PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS = MANAGED_CODEX_HOOK_EVENTS;

export type ManagedCodexHookEvent = typeof MANAGED_CODEX_HOOK_EVENTS[number];

export const CODEX_APP_SERVER_TIMEOUTS = {
  versionProbeMs: 2_000,
  initializeMs: 15_000,
  requestMs: 10_000,
  shutdownMs: 5_000,
} as const;

const CODEX_TRUST_STATUSES = new Set([
  'managed',
  'untrusted',
  'trusted',
  'modified',
]);

const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
  preToolUse: 'PreToolUse',
  permissionRequest: 'PermissionRequest',
  postToolUse: 'PostToolUse',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  sessionStart: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  stop: 'Stop',
};

const PINNED_CODEX_VERSION = '0.142.5';
const PINNED_CODEX_VERSION_OUTPUT = `codex-cli ${PINNED_CODEX_VERSION}`;
const CODEX_APP_SERVER_MAX_STDOUT_FRAME_LENGTH = 1_048_576;

type JsonRecord = Record<string, unknown>;

type JsonRpcEnvelope = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type JsonRpcRequestEnvelope = JsonRpcEnvelope & {
  id: number;
  method: string;
};


type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

export interface CodexHookMetadata {
  event: ManagedCodexHookEvent | string;
  command: string;
  sourcePath: string;
  key: string;
  currentHash: string;
  displayOrder: number;
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
}

export interface CodexHooksListEntry {
  cwd: string;
  hooks: CodexHookMetadata[];
  warnings: unknown[];
  errors: unknown[];
}

export class CodexExecutableNotFoundError extends Error {
  constructor() {
    super('codex executable was not found');
    this.name = 'CodexExecutableNotFoundError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return value instanceof Error
    && isRecord(value)
    && value.code === code;
}

function compactDiagnostic(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function protocolError(message: string, stderr = ''): Error {
  return new Error(`${message}${stderr.trim() ? `\nCodex stderr:\n${compactDiagnostic(stderr)}` : ''}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex hooks/list response is missing ${label}`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Codex response has malformed ${label}`);
  return value;
}

function hasExactPinnedCodexVersionStdout(stdout: string): boolean {
  return stdout === PINNED_CODEX_VERSION_OUTPUT
    || stdout === `${PINNED_CODEX_VERSION_OUTPUT}\n`
    || stdout === `${PINNED_CODEX_VERSION_OUTPUT}\r\n`;
}

function hasOnlyBenignCodexVersionStderr(stderr: string): boolean {
  const diagnostics = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return diagnostics.every((line) => /^(?:warning|note): /i.test(line));
}

function formatVersionProbeOutput(stdout: string, stderr: string): string {
  return [
    `stdout=${JSON.stringify(compactDiagnostic(stdout))}`,
    ...(stderr.length === 0 ? [] : [`stderr=${JSON.stringify(compactDiagnostic(stderr))}`]),
  ].join(' ');
}

const CODEX_VERSION_PROBE_CANDIDATE_BUDGET = 32;
const CODEX_VERSION_PROBE_DEADLINE_MS = 5_000;

type CodexCandidateInspection =
  | { kind: 'absent' }
  | { kind: 'present' }
  | { kind: 'dangling' }
  | { kind: 'uninspectable'; error: Error };

function inspectCodexCandidate(executable: string): CodexCandidateInspection {
  try {
    lstatSync(executable);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return { kind: 'absent' };
    return {
      kind: 'uninspectable',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  try {
    statSync(executable);
    return { kind: 'present' };
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return { kind: 'dangling' };
    return {
      kind: 'uninspectable',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function versionProbeDeadlineError(): Error {
  return new Error(
    `Codex version resolution exceeded the ${CODEX_VERSION_PROBE_DEADLINE_MS}ms global deadline`,
  );
}

export interface CodexCommandSpawnSeam {
  platform?: NodeJS.Platform;
  spawnSyncImpl?: typeof spawnSync;
  spawnImpl?: typeof spawn;
}

function* streamPathEntries(pathValue: string, deadline: number, platform: NodeJS.Platform): Iterable<string> {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  let start = 0;
  for (let index = 0; index < pathValue.length; index += 1) {
    if ((index & 0x3ff) === 0 && Date.now() >= deadline) throw versionProbeDeadlineError();
    if (pathValue[index] !== pathDelimiter) continue;
    yield pathValue.slice(start, index);
    start = index + 1;
  }
  if (Date.now() >= deadline) throw versionProbeDeadlineError();
  yield pathValue.slice(start);
}

function codexCandidatePaths(pathEntry: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [join(pathEntry, 'codex')];
  const pathext = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...pathext.map((extension) => join(pathEntry, `codex${extension}`)), join(pathEntry, 'codex')])];
}

function resolvePinnedCodexExecutable(
  cwd: string,
  env: NodeJS.ProcessEnv,
  seam: CodexCommandSpawnSeam = {},
): { executable: string; version: string } {
  const platform = seam.platform ?? process.platform;
  const deadline = Date.now() + CODEX_VERSION_PROBE_DEADLINE_MS;
  const pathValue = env.PATH ?? env.Path ?? '';
  const observed: string[] = [];
  const seenPathEntries = new Set<string>();

  for (const entry of streamPathEntries(pathValue, deadline, platform)) {
    if (Date.now() >= deadline) throw versionProbeDeadlineError();
    const pathEntry = resolve(cwd, entry || '.');
    if (seenPathEntries.has(pathEntry)) continue;
    if (seenPathEntries.size === CODEX_VERSION_PROBE_CANDIDATE_BUDGET) {
      throw new Error(
        `Codex version resolution exceeded the ${CODEX_VERSION_PROBE_CANDIDATE_BUDGET}-candidate PATH budget`,
      );
    }
    seenPathEntries.add(pathEntry);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw versionProbeDeadlineError();

    let pathEntryState = inspectCodexCandidate(pathEntry);
    if (pathEntryState.kind === 'absent') {
      pathEntryState = inspectCodexCandidate(pathEntry);
      if (pathEntryState.kind === 'absent') continue;
    }
    if (pathEntryState.kind === 'dangling') {
      observed.push(`${pathEntry}: PATH entry exists but its target is unavailable (dangling or changed during probe)`);
      continue;
    }
    if (pathEntryState.kind === 'uninspectable') {
      observed.push(`${pathEntry}: PATH entry cannot be inspected (${pathEntryState.error.message})`);
      continue;
    }

    let selected: { executable: string; before: CodexCandidateInspection } | null = null;
    for (const executable of codexCandidatePaths(pathEntry, env, platform)) {
      if (Date.now() >= deadline) throw versionProbeDeadlineError();
      let before = inspectCodexCandidate(executable);
      if (before.kind === 'absent') {
        before = inspectCodexCandidate(executable);
        if (before.kind === 'absent') continue;
      }
      selected = { executable, before };
      break;
    }
    if (!selected) continue;

    const { executable, before } = selected;
    if (before.kind === 'dangling') {
      observed.push(`${executable}: candidate exists but its target is unavailable (dangling or changed during probe)`);
      continue;
    }
    if (before.kind === 'uninspectable') {
      observed.push(`${executable}: candidate cannot be inspected (${before.error.message})`);
      continue;
    }

    const { result } = spawnPlatformCommandSync(executable, ['--version'], {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: Math.max(1, Math.min(CODEX_APP_SERVER_TIMEOUTS.versionProbeMs, remainingMs)),
      killSignal: 'SIGKILL',
    }, platform, env, undefined, seam.spawnSyncImpl ?? spawnSync);
    if (Date.now() >= deadline) throw versionProbeDeadlineError();
    if (isNodeErrorWithCode(result.error, 'ENOENT')) {
      const after = inspectCodexCandidate(executable);
      observed.push(
        `${executable}: launch returned ENOENT after an existing candidate was observed (${after.kind})`,
      );
      continue;
    }
    if (isNodeErrorWithCode(result.error, 'ETIMEDOUT')) {
      observed.push(`${executable}: version probe timed out after ${CODEX_APP_SERVER_TIMEOUTS.versionProbeMs}ms and was force-terminated`);
      continue;
    }
    if (result.error) {
      observed.push(`${executable}: version probe failed (${result.error.message})`);
      continue;
    }
    if (result.status !== 0) {
      observed.push(`${executable}: exit ${String(result.status)}`);
      continue;
    }

    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (hasExactPinnedCodexVersionStdout(stdout) && hasOnlyBenignCodexVersionStderr(stderr)) {
      return { executable, version: PINNED_CODEX_VERSION_OUTPUT };
    }
    observed.push(`${executable}: ${formatVersionProbeOutput(stdout, stderr)}`);
  }

  if (Date.now() >= deadline) throw versionProbeDeadlineError();
  if (observed.length === 0) throw new CodexExecutableNotFoundError();
  throw new Error(
    `Unsupported installed Codex version for the ${PINNED_CODEX_VERSION} boundary:\n${observed.join('\n')}`,
  );
}


/**
 * Newline-delimited JSON-RPC client for the installed Codex app-server boundary.
 * It accepts no protocol fallback: malformed messages, request errors, unexpected
 * exits, and cleanup failures are test failures.
 */
export class CodexAppServer {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
  private stderr = '';
  private stdoutBuffer = '';
  private failure: Error | null = null;
  private closing = false;
  private spawned = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closePromise = new Promise((resolveClose) => {
      child.once('close', (code, signal) => {
        const exit = { code, signal };
        this.flushStdoutDecoder();
        if (this.stdoutBuffer.length > 0) {
          this.fail(protocolError(
            `codex app-server closed with unterminated JSON-RPC stdout: ${JSON.stringify(compactDiagnostic(this.stdoutBuffer))}`,
            this.stderr,
          ));
        }
        if (!this.closing) {
          this.fail(protocolError(
            `codex app-server exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
            this.stderr,
          ));
        }
        resolveClose(exit);
      });
    });

    child.once('spawn', () => {
      this.spawned = true;
    });
    child.once('error', (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = compactDiagnostic(this.stderr + chunk);
    });
  }


  static async start(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    commandSeam?: CodexCommandSpawnSeam;
  }): Promise<CodexAppServer> {
    const seam = options.commandSeam;
    const platform = seam?.platform ?? process.platform;
    const { executable } = resolvePinnedCodexExecutable(options.cwd, options.env, seam);
    const { child } = spawnPlatformCommand(executable, ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    }, platform, options.env, undefined, seam?.spawnImpl ?? spawn);

    const server = new CodexAppServer(child as ChildProcessWithoutNullStreams);
    try {
      await server.waitForStartup();
    } catch (error) {
      try {
        await server.close();
      } catch {
        // Preserve the startup failure as the primary diagnostic.
      }
      throw error;
    }
    return server;
  }

  private async waitForStartup(): Promise<void> {
    const started = new Promise<void>((resolveStarted, rejectStarted) => {
      if (this.spawned) {
        resolveStarted();
        return;
      }
      this.child.once('spawn', resolveStarted);
      this.child.once('error', rejectStarted);
    });
    await this.withTimeout(started, CODEX_APP_SERVER_TIMEOUTS.initializeMs, 'codex app-server did not start');
  }

  private onStdout(chunk: Buffer): void {
    let decoded: string;
    try {
      decoded = this.stdoutDecoder.decode(chunk, { stream: true });
    } catch {
      this.fail(protocolError('codex app-server emitted invalid UTF-8 stdout', this.stderr));
      return;
    }
    this.onStdoutText(decoded);
  }

  private flushStdoutDecoder(): void {
    try {
      const decoded = this.stdoutDecoder.decode();
      if (decoded) this.onStdoutText(decoded);
    } catch {
      this.fail(protocolError('codex app-server emitted invalid UTF-8 stdout', this.stderr));
    }
  }

  private onStdoutText(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      const frameLength = Buffer.byteLength(
        newline < 0 ? this.stdoutBuffer : this.stdoutBuffer.slice(0, newline),
        'utf-8',
      );
      if (frameLength > CODEX_APP_SERVER_MAX_STDOUT_FRAME_LENGTH) {
        this.fail(protocolError('codex app-server emitted an oversized JSON-RPC stdout frame', this.stderr));
        return;
      }
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let envelope: unknown;
      try {
        envelope = JSON.parse(line);
      } catch {
        this.fail(protocolError(`codex app-server emitted malformed JSON-RPC stdout: ${line}`, this.stderr));
        return;
      }
      if (!isRecord(envelope)) {
        this.fail(protocolError('codex app-server emitted a non-object JSON-RPC envelope', this.stderr));
        return;
      }
      this.onEnvelope(envelope);
    }
  }

  private isMethodBearingNotification(envelope: JsonRecord): boolean {
    return !Object.hasOwn(envelope, 'id')
      && typeof envelope.method === 'string'
      && envelope.method.trim().length > 0
      && !Object.hasOwn(envelope, 'result')
      && !Object.hasOwn(envelope, 'error');
  }

  private validateResponseEnvelope(envelope: JsonRecord): string | null {
    if (Object.hasOwn(envelope, 'method') || Object.hasOwn(envelope, 'params')) {
      return 'codex app-server response mixed request or notification fields with an id';
    }
    const hasResult = Object.hasOwn(envelope, 'result');
    const hasError = Object.hasOwn(envelope, 'error');
    if (hasResult === hasError) {
      return 'codex app-server response must contain exactly one of result or error';
    }
    if (hasError) {
      const error = envelope.error;
      if (!isRecord(error)
        || typeof error.code !== 'number'
        || !Number.isFinite(error.code)
        || typeof error.message !== 'string') {
        return 'codex app-server response has malformed JSON-RPC error';
      }
    }
    return null;
  }

  private onEnvelope(envelope: JsonRecord): void {
    if (!Object.hasOwn(envelope, 'id')) {
      if (!this.isMethodBearingNotification(envelope)) {
        this.fail(protocolError('codex app-server emitted an invalid idless JSON-RPC envelope', this.stderr));
      }
      return;
    }
    if (typeof envelope.id !== 'number') {
      this.fail(protocolError('codex app-server response had a non-numeric id', this.stderr));
      return;
    }
    const validationError = this.validateResponseEnvelope(envelope);
    if (validationError) {
      this.fail(protocolError(validationError, this.stderr));
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      this.fail(protocolError(`codex app-server returned an unexpected response id ${envelope.id}`, this.stderr));
      return;
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timeout);
    if (Object.hasOwn(envelope, 'error')) {
      pending.reject(protocolError(
        `codex app-server ${pending.method} returned JSON-RPC error ${JSON.stringify(envelope.error)}`,
        this.stderr,
      ));
      return;
    }
    pending.resolve(envelope.result);
  }


  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(protocolError(message, this.stderr)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      );
    });
  }

  async request<T = unknown>(envelope: Required<Pick<JsonRpcEnvelope, 'id' | 'method'>> & JsonRpcEnvelope, timeoutMs: number): Promise<T> {
    if (this.failure) throw this.failure;
    if (!Number.isInteger(envelope.id) || envelope.id <= 0 || !envelope.method) {
      throw new Error('Codex JSON-RPC request requires a positive numeric id and method');
    }
    if (this.pending.has(envelope.id)) {
      throw new Error(`duplicate Codex JSON-RPC request id ${envelope.id}`);
    }
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(envelope.id);
        rejectResponse(protocolError(
          `codex app-server ${envelope.method} request ${envelope.id} timed out after ${timeoutMs}ms`,
          this.stderr,
        ));
      }, timeoutMs);
      this.pending.set(envelope.id, {
        method: envelope.method,
        resolve: resolveResponse,
        reject: rejectResponse,
        timeout,
      });
    });
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf-8', (error) => {
      if (error) this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    return await response as T;
  }

  notify(envelope: Omit<JsonRpcEnvelope, 'id'>): void {
    if (this.failure) throw this.failure;
    if (!envelope.method) throw new Error('Codex JSON-RPC notification requires a method');
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf-8', (error) => {
      if (error) this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await this.withTimeout(
        this.closePromise,
        CODEX_APP_SERVER_TIMEOUTS.shutdownMs,
        'codex app-server did not exit after stdin closed',
      );
    } catch (error) {
      this.child.kill('SIGKILL');
      try {
        await this.withTimeout(
          this.closePromise,
          CODEX_APP_SERVER_TIMEOUTS.shutdownMs,
          'codex app-server did not exit after SIGKILL',
        );
      } catch {
        // Preserve the original graceful-cleanup failure, which has better diagnostics.
      }
      throw error;
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw protocolError(
        `codex app-server exited abnormally during cleanup (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        this.stderr,
      );
    }
    if (this.failure) throw this.failure;
  }
}

export function createCodexInitializeEnvelope(clientName: string): JsonRpcRequestEnvelope {
  return {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: clientName, version: '1.0.0' },
      capabilities: null,
    },
  };
}

export const CODEX_INITIALIZED_ENVELOPE: JsonRpcEnvelope = { method: 'initialized' };

export function createCodexHooksListEnvelope(projectCwd: string): JsonRpcRequestEnvelope {
  return {
    id: 2,
    method: 'hooks/list',
    params: { cwds: [projectCwd] },
  };
}

export function createCodexBatchWriteEnvelope(trustByKey: Record<string, string>): JsonRpcRequestEnvelope {
  return {
    id: 3,
    method: 'config/batchWrite',
    params: {
      edits: [{
        keyPath: 'hooks.state',
        value: Object.fromEntries(
          Object.entries(trustByKey).map(([key, currentHash]) => [key, { trusted_hash: currentHash }]),
        ),
        mergeStrategy: 'upsert',
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  };
}

export async function initializeCodexAppServer(server: CodexAppServer, clientName: string): Promise<void> {
  await server.request(createCodexInitializeEnvelope(clientName), CODEX_APP_SERVER_TIMEOUTS.initializeMs);
  server.notify(CODEX_INITIALIZED_ENVELOPE);
}

export async function listCodexHooks(
  server: CodexAppServer,
  projectCwd: string,
  hooksPath: string,
): Promise<CodexHooksListEntry> {
  const result = await server.request<unknown>(
    createCodexHooksListEnvelope(projectCwd),
    CODEX_APP_SERVER_TIMEOUTS.requestMs,
  );
  return parseCodexHooksListResult(result, projectCwd, hooksPath);
}

export function parseCodexHooksListResult(
  result: unknown,
  projectCwd: string,
  hooksPath: string,
): CodexHooksListEntry {
  const resultRecord = requireRecord(result, 'hooks/list result');
  if (!Array.isArray(resultRecord.data) || resultRecord.data.length !== 1) {
    throw new Error('Codex hooks/list response must contain exactly one data entry');
  }
  const entry = requireRecord(resultRecord.data[0], 'hooks/list data entry');
  if (entry.cwd !== projectCwd) {
    throw new Error(`Codex hooks/list response cwd mismatch: expected ${projectCwd}, got ${String(entry.cwd)}`);
  }
  if (!Array.isArray(entry.hooks) || !Array.isArray(entry.warnings) || !Array.isArray(entry.errors)) {
    throw new Error('Codex hooks/list response must contain hooks, warnings, and errors arrays');
  }
  if (entry.warnings.length !== 0 || entry.errors.length !== 0) {
    throw new Error(`Codex hooks/list reported warnings/errors: ${JSON.stringify({ warnings: entry.warnings, errors: entry.errors })}`);
  }

  const hooks = entry.hooks.map((value, index) => {
    const hook = requireRecord(value, `hooks/list hook ${index}`);
    const rawEvent = requireString(hook.eventName, `hooks[${index}].eventName`);
    const event = CODEX_EVENT_LABELS[rawEvent] ?? rawEvent;
    const command = requireString(hook.command, `hooks[${index}].command`);
    const enabled = hook.enabled === undefined ? true : hook.enabled;
    if (enabled !== true) {
      throw new Error(`Codex hooks/list hook ${index} is not an enabled command handler`);
    }
    const sourcePath = requireString(hook.sourcePath, `hooks[${index}].sourcePath`);
    const key = requireString(hook.key, `hooks[${index}].key`);
    const currentHash = requireString(hook.currentHash, `hooks[${index}].currentHash`);
    const displayOrder = hook.displayOrder;
    if (typeof displayOrder !== 'number' || !Number.isSafeInteger(displayOrder) || displayOrder < 0) {
      throw new Error(`Codex hooks/list response has invalid hooks[${index}].displayOrder`);
    }
    const trustStatus = requireString(hook.trustStatus, `hooks[${index}].trustStatus`);
    if (!CODEX_TRUST_STATUSES.has(trustStatus)) {
      throw new Error(`Codex hooks/list response has unsupported trustStatus ${trustStatus}`);
    }


    if (sourcePath !== hooksPath) {
      throw new Error(`Codex hooks/list sourcePath mismatch: expected ${hooksPath}, got ${sourcePath}`);
    }
    return {
      event,
      command,
      sourcePath,
      key,
      currentHash,
      displayOrder,
      trustStatus: trustStatus as CodexHookMetadata['trustStatus'],
    };
  });

  return {
    cwd: projectCwd,
    hooks,
    warnings: entry.warnings,
    errors: entry.errors,
  };
}



export function managedCodexHooksByEvent(hooks: readonly CodexHookMetadata[]): Record<ManagedCodexHookEvent, CodexHookMetadata> {
  const result = {} as Record<ManagedCodexHookEvent, CodexHookMetadata>;
  for (const event of MANAGED_CODEX_HOOK_EVENTS) {
    const matching = hooks.filter((hook) => hook.event === event && isManagedCodexHookCommand(hook.command));
    if (matching.length !== 1) {
      throw new Error(`Expected exactly one OMX ${event} hook from Codex, received ${matching.length}`);
    }
    result[event] = matching[0]!;
  }
  return result;
}

export function generatedHookTrustState(configToml: string): Record<string, string> {
  const parsed = TOML.parse(configToml) as { hooks?: { state?: Record<string, unknown> } };
  const state = parsed.hooks?.state;
  if (!isRecord(state)) throw new Error('setup config.toml is missing hooks.state');
  const trust = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(state)) {
    if (!isRecord(value)) {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: expected an object`);
    }
    const entryKeys = Object.keys(value);
    if (entryKeys.length !== 1 || entryKeys[0] !== 'trusted_hash') {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: expected only trusted_hash`);
    }
    if (typeof value.trusted_hash !== 'string' || value.trusted_hash.trim().length === 0) {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: trusted_hash must be non-empty`);
    }
    trust[key] = value.trusted_hash;
  }
  return trust;
}

export function managedTrustByKey(hooks: readonly CodexHookMetadata[]): Record<string, string> {
  return Object.fromEntries(
    Object.values(managedCodexHooksByEvent(hooks)).map((hook) => [hook.key, hook.currentHash]),
  );
}

export function assertGeneratedTrustMatchesCodex(
  generatedTrust: Record<string, string>,
  hooks: readonly CodexHookMetadata[],
): void {
  const expected = managedTrustByKey(hooks);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(generatedTrust).sort();
  if (actualKeys.length !== MANAGED_CODEX_HOOK_EVENTS.length
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(
      `Generated trust must contain exactly the ${MANAGED_CODEX_HOOK_EVENTS.length} current OMX hooks with no stale keys`,
    );
  }
  for (const [key, currentHash] of Object.entries(expected)) {
    if (generatedTrust[key] !== currentHash) {
      throw new Error(`Generated hook trust does not equal Codex hooks/list metadata for ${key}`);
    }
  }
}

export async function approveManagedHooksInCodex(
  server: CodexAppServer,
  hooks: readonly CodexHookMetadata[],
  expectedConfigPath: string,
): Promise<void> {
  const result = await server.request<unknown>(
    createCodexBatchWriteEnvelope(managedTrustByKey(hooks)),
    CODEX_APP_SERVER_TIMEOUTS.requestMs,
  );
  assertCodexBatchWriteResult(result, expectedConfigPath);
}

export function assertCodexBatchWriteResult(result: unknown, expectedConfigPath: string): void {
  const response = requireRecord(result, 'config/batchWrite result');
  if (response.filePath !== expectedConfigPath) {
    throw new Error(
      `Codex config/batchWrite wrote ${String(response.filePath)}, expected isolated user config ${expectedConfigPath}`,
    );
  }
  if (response.status !== 'ok' && response.status !== 'okOverridden') {
    throw new Error(`Codex config/batchWrite returned unsupported status ${String(response.status)}`);
  }
  if (!Object.hasOwn(response, 'version')) {
    throw new Error('Codex config/batchWrite result is missing version');
  }
}

export function hookMetadataSnapshot(hooks: readonly CodexHookMetadata[]): Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> {
  return hooks
    .map(({ event, command, key, currentHash, displayOrder, trustStatus }) => ({
      event,
      command,
      key,
      currentHash,
      displayOrder,
      trustStatus,
    }))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export function appendForeignHookGroups(
  hooksContent: string,
  marker: string,
  options: { appendGroups: boolean },
): string {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const hooks = parsed.hooks as Record<string, unknown>;
  const foreignCommand = (event: string, suffix = '') =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(`${marker}-${event}${suffix}.js`)}`;
  const foreignGroup = (event: string) => ({
    ...(event === 'PreToolUse' ? { matcher: 'Bash' } : {}),
    foreign_group_metadata: {
      marker,
      nested: { keep: ['foreign', event], depth: { value: 7 } },
    },
    hooks: [{
      type: 'command',
      command: foreignCommand(event),
      statusMessage: `${marker} ${event}`,
      foreign_handler_metadata: { marker, event, values: [1, { two: true }] },
    }],
  });
  for (const event of ['PreToolUse', 'PostToolUse'] as const) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`hooks.${event} is not an array`);
    }
    const entries = (existing ?? []) as unknown[];
    if (options.appendGroups) {
      entries.push(foreignGroup(event));
    } else {
      const group = entries.find((entry): entry is JsonRecord => isRecord(entry)
        && Array.isArray(entry.hooks)
        && entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(marker)));
      if (!group) {
        throw new Error(`missing pre-seeded foreign ${event} group`);
      }
      const groupHooks = group.hooks;
      if (!Array.isArray(groupHooks)) {
        throw new Error(`missing pre-seeded foreign ${event} handler array`);
      }
      groupHooks.push({
        type: 'command',
        command: foreignCommand(event, '-inserted'),
        statusMessage: `${marker} inserted ${event}`,
        foreign_handler_metadata: { marker, inserted: true, nested: { event } },
      });
    }
    hooks[event] = entries;
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

export function appendDisplayOrderStableForeignHookGroups(
  hooksContent: string,
  marker: string,
  options: { appendGroups: boolean },
): string {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const hooks = parsed.hooks as Record<string, unknown>;
  const event = 'PreToolUse';
  const existing = hooks[event];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`hooks.${event} is not an array`);
  }
  const entries = (existing ?? []) as unknown[];
  const foreignCommand = (groupLabel: string, suffix = '') =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(`${marker}-${event}-${groupLabel}${suffix}.js`)}`;
  if (options.appendGroups) {
    for (const groupLabel of ['first', 'second']) {
      entries.push({
        ...(groupLabel === 'first' ? { matcher: 'Bash' } : {}),
        foreign_group_metadata: {
          marker,
          groupLabel,
          nested: { keep: ['foreign', event, groupLabel], depth: { value: 7 } },
        },
        hooks: [{
          type: 'command',
          command: foreignCommand(groupLabel),
          statusMessage: `${marker} ${event} ${groupLabel}`,
          foreign_handler_metadata: { marker, event, groupLabel, values: [1, { two: true }] },
        }],
      });
    }
  } else {
    const groupLabel = 'second';
    const group = entries.find((entry): entry is JsonRecord => isRecord(entry)
      && Array.isArray(entry.hooks)
      && entry.hooks.some((hook) => isRecord(hook)
        && hook.command === foreignCommand(groupLabel)));
    if (!group || !Array.isArray(group.hooks)) {
      throw new Error(`missing pre-seeded foreign ${event} ${groupLabel} group`);
    }
    for (const insertionLabel of ['one', 'two']) {
      group.hooks.push({
        type: 'command',
        command: foreignCommand(groupLabel, `-${insertionLabel}-inserted`),
        statusMessage: `${marker} inserted ${event} ${insertionLabel}`,
        foreign_handler_metadata: { marker, inserted: true, insertionLabel, nested: { event } },
      });
    }
  }
  hooks[event] = entries;
  return JSON.stringify(parsed, null, 2) + '\n';
}


export function foreignHookGroupSnapshot(hooksContent: string, marker: string): unknown[] {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const result: unknown[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, groupIndex) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return;
      entry.hooks.forEach((hook, handlerIndex) => {
        if (isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(marker)) {
          result.push({ event, groupIndex, handlerIndex, group: structuredClone(entry), handler: structuredClone(hook) });
        }
      });
    });
  }
  return result;
}

export function assertForeignHookGroupsPreserved(
  expected: unknown[],
  actualContent: string,
  marker: string,
): void {
  const actual = foreignHookGroupSnapshot(actualContent, marker);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Foreign hook groups or metadata changed: ${JSON.stringify({ expected, actual })}`);
  }
}


export function probeCodexVersion(
  cwd: string,
  env: NodeJS.ProcessEnv,
  seam?: CodexCommandSpawnSeam,
): string {
  return resolvePinnedCodexExecutable(cwd, env, seam).version;
}

function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'Release smoke validates installed CLI boot, native-hook dispatch, and the isolated setup/rerun/uninstall lifecycle; Codex trust checks run when the pinned CLI is present.',
  ].join('\n');
}

interface EnsureRepoDepsOptions {
  gitRunner?: typeof spawnSync;
  install?: (cwd: string) => void;
  log?: (message: string) => void;
}

interface EnsureRepoDepsResult {
  strategy: string;
  nodeModulesPath: string;
  sourceNodeModulesPath?: string;
}

function formatCommandFailure(cmd: string, args: string[], result: { stdout?: string; stderr?: string }): string {
  return [
    `Command failed: ${cmd} ${args.join(' ')}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function ensureRepoDependencies(repoRoot: string, options: EnsureRepoDepsOptions = {}): EnsureRepoDepsResult {
  const {
    gitRunner = spawnSync,
    install = (cwd: string) => {
      const result = spawnSync('npm', ['ci'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure('npm', ['ci'], result));
      }
    },
    log = () => {},
  } = options;

  const reusable = ensureReusableNodeModules(repoRoot, { gitRunner });
  if (reusable.strategy === 'existing') {
    return reusable;
  }
  if (reusable.strategy === 'symlink') {
    log(`[smoke:packed-install] Reusing node_modules from ${reusable.sourceNodeModulesPath}`);
    return reusable;
  }

  log('[smoke:packed-install] Installing repo dependencies with npm ci');
  install(repoRoot);
  return {
    strategy: 'installed',
    nodeModulesPath: join(repoRoot, 'node_modules'),
  };
}

function parseArgs(argv: string[]): void {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
}

function run(cmd: string, args: readonly string[], options: Record<string, unknown> = {}): ReturnType<typeof spawnSync> {
  const result = spawnSync(cmd, [...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(cmd, [...args], result));
  }
  return result;
}

function npmBinName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function resolveGlobalNodeModules(prefixDir: string): string {
  const result = run('npm', ['root', '-g', '--prefix', prefixDir], { cwd: prefixDir });
  const root = String(result.stdout || '').trim();
  if (!root) throw new Error('npm root -g did not return a node_modules directory');
  return root;
}

export function validateHookStdout(eventName: string, stdout: string): void {
  if (eventName === 'PostCompact') {
    if (stdout.length === 0) return;
    throw new Error('native hook PostCompact must emit empty stdout');
  }
  const trimmed = stdout.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `native hook ${eventName} emitted invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`native hook ${eventName} emitted a non-object JSON stdout payload`);
  }
}

export function buildNativeHookSmokePayload(
  eventName: typeof PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS[number],
  smokeCwd: string,
): Record<string, unknown> {
  const base = {
    hook_event_name: eventName,
    session_id: `packed-install-smoke-${eventName}`,
    cwd: smokeCwd,
  };
  switch (eventName) {
    case 'SessionStart':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
      };
    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
      };
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
        tool_response: {
          exit_code: 0,
          stdout: 'packed install smoke\n',
          stderr: '',
        },
      };
    case 'UserPromptSubmit':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
        prompt: 'packed install native hook smoke test',
      };
    case 'PreCompact':
    case 'PostCompact':
    case 'Stop':
      return base;
  }
}

function smokeInstalledNativeHookDist(prefixDir: string): void {
  const globalNodeModules = resolveGlobalNodeModules(prefixDir);
  const packageRoot = join(globalNodeModules, 'oh-my-codex');
  const hookScript = join(packageRoot, 'dist', 'scripts', 'codex-native-hook.js');
  const smokeCwd = mkdtempSync(join(tmpdir(), 'omx-packed-hook-smoke-'));
  try {
    for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
      const payload = buildNativeHookSmokePayload(eventName, smokeCwd);
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: {
          ...process.env,
          OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
          OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root'),
          OMX_SESSION_ID: `packed-install-smoke-${eventName}`,
          OMX_SOURCE_CWD: smokeCwd,
          OMX_STARTUP_CWD: smokeCwd,
        },
        input: JSON.stringify(payload),
      });
      validateHookStdout(eventName, result.stdout as string);
    }
  } finally {
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isolatedSmokeEnv(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  for (const key of [
    'OMX_SESSION_ID',
    'OMX_RUN_ID',
    'OMX_ROOT',
    'OMX_STATE_ROOT',
    'OMX_ACTIVE_SESSION_PID',
    'CODEX_SESSION_ID',
    'TMUX',
    'TMUX_PANE',
  ]) {
    delete env[key];
  }
  return env;
}

function trustedProjectConfig(projectDir: string): string {
  const escapedProjectDir = projectDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[projects."${escapedProjectDir}"]\ntrust_level = "trusted"\n`;
}


function rawManagedHookCount(hooksContent: string): number {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  return Object.values(parsed.hooks).flatMap((entries) => Array.isArray(entries) ? entries : [])
    .flatMap((entry) => isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [])
    .filter((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && isManagedCodexHookCommand(hook.command)).length;
}

function assertNoEmptyManagedEventGroups(hooksContent: string): void {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  for (const event of MANAGED_CODEX_HOOK_EVENTS) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, groupIndex) => {
      if (isRecord(entry) && (!Array.isArray(entry.hooks) || entry.hooks.length === 0)) {
        throw new Error(`packed uninstall left an empty ${event} group at coordinate ${groupIndex}`);
      }
    });
  }
}

function assertNoSetupOwnedTrustKeys(configToml: string, setupTrust: Record<string, string>): void {
  const parsed = TOML.parse(configToml) as { hooks?: { state?: Record<string, unknown> } };
  const state = parsed.hooks?.state;
  if (!isRecord(state)) return;
  const retained = Object.keys(setupTrust).filter((key) => Object.hasOwn(state, key));
  if (retained.length > 0) {
    throw new Error(`packed uninstall retained setup-owned OMX hook trust keys: ${retained.join(', ')}`);
  }
}

function assertNativeHooksEnabledForForeignGroups(configToml: string): void {
  const parsed = TOML.parse(configToml) as { features?: Record<string, unknown> };
  const features = parsed.features;
  if (!isRecord(features) || (features.hooks !== true && features.codex_hooks !== true)) {
    throw new Error('packed uninstall disabled native hooks despite preserved foreign hook groups');
  }
}

function assertNoUninstallTransactionArtifacts(codexDir: string): void {
  const artifacts = readdirSync(codexDir).filter((entry) => entry.includes('.omx-uninstall-'));
  if (artifacts.length > 0) {
    throw new Error(`unsafe packed uninstall left replacement, staged, or tombstone paths: ${artifacts.join(', ')}`);
  }
}

function preToolUseGroupIndices(hooksContent: string, marker: string): {
  foreignIndices: number[];
  managedIndices: number[];
} {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const entries = parsed.hooks.PreToolUse;
  if (!Array.isArray(entries)) throw new Error('hooks.PreToolUse is missing');
  const foreignIndices: number[] = [];
  const managedIndices: number[] = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return;
    if (entry.hooks.some((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && hook.command.includes(marker))) {
      foreignIndices.push(index);
    }
    if (entry.hooks.some((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && isManagedCodexHookCommand(hook.command))) {
      managedIndices.push(index);
    }
  });
  return { foreignIndices, managedIndices };
}

function assertManagedHooksAppendAfterForeign(hooksContent: string, marker: string): void {
  const { foreignIndices, managedIndices } = preToolUseGroupIndices(hooksContent, marker);
  if (
    foreignIndices.length !== 2 ||
    managedIndices.length !== 1 ||
    managedIndices[0]! <= Math.max(...foreignIndices)
  ) {
    throw new Error('packed first install did not append the OMX PreToolUse group after both foreign groups');
  }
}

function assertManagedHooksRemainBeforeForeign(hooksContent: string, marker: string): void {
  const { foreignIndices, managedIndices } = preToolUseGroupIndices(hooksContent, marker);
  if (
    foreignIndices.length !== 2 ||
    managedIndices.length !== 1 ||
    managedIndices[0]! >= Math.min(...foreignIndices)
  ) {
    throw new Error('packed setup rerun reordered the managed-first PreToolUse topology');
  }
}



function assertTrustedManagedHooks(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    if (hook.trustStatus !== 'trusted') {
      throw new Error(`Codex did not trust OMX ${event}; received ${hook.trustStatus}`);
    }
  }
}

function assertManagedHooksNotAlreadyTrusted(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    if (hook.trustStatus === 'trusted') {
      throw new Error(`setup-generated project trust unexpectedly pre-approved OMX ${event}`);
    }
  }
}
function preseededForeignHookMetadata(
  hooks: readonly CodexHookMetadata[],
  marker: string,
): Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> {
  return hookMetadataSnapshot(
    hooks.filter((hook) => hook.command.includes(marker) && !hook.command.includes('-inserted.js')),
  );
}

function assertPreseededForeignHookEvidence(
  expected: readonly Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>[],
  actualHooks: readonly CodexHookMetadata[],
  codexUserConfig: string,
  marker: string,
  phase: string,
): void {
  const actual = preseededForeignHookMetadata(actualHooks, marker);
  if (actual.length !== 2) {
    throw new Error(`Codex ${phase} did not report exactly two pre-seeded foreign hooks; received ${actual.length}`);
  }
  if (!sameJson(actual, expected)) {
    const changes = expected.flatMap((expectedHook, index) =>
      Object.entries(expectedHook).flatMap(([field, expectedValue]) => {
        const actualValue = actual[index]?.[field as keyof typeof expectedHook];
        return actualValue === expectedValue
          ? []
          : [`${expectedHook.event}.${field}: ${JSON.stringify(expectedValue)} -> ${JSON.stringify(actualValue)}`];
      }));
    throw new Error(
      `Codex ${phase} changed pre-seeded foreign hook key, hash, coordinate, or display order: ${changes.join('; ')}`,
    );
  }
  if (actual.some((hook) => hook.trustStatus !== 'trusted')) {
    throw new Error(`Codex ${phase} did not retain trusted status for every pre-seeded foreign hook`);
  }
  const trust = generatedHookTrustState(codexUserConfig);
  for (const hook of actual) {
    if (trust[hook.key] !== hook.currentHash) {
      throw new Error(`Codex ${phase} did not retain the foreign trust entry for ${hook.key}`);
    }
  }
}

async function observeInstalledCodexHooks(
  projectDir: string,
  hooksPath: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexHooksListEntry> {
  const server = await CodexAppServer.start({ cwd: projectDir, env });
  try {
    await initializeCodexAppServer(server, 'omx-packed-install-smoke');
    return await listCodexHooks(server, projectDir, hooksPath);
  } finally {
    await server.close();
  }
}

export interface PackedHookTrustLifecycleResult {
  codexVersion: string | null;
}

/**
 * Exercise setup and removal against the installed package. The deterministic
 * filesystem lifecycle always runs; the installed-Codex trust leg is skipped
 * only when the `codex` executable is absent.
 */
export async function smokePackedHookTrustLifecycle(
  omxPath: string,
): Promise<PackedHookTrustLifecycleResult> {
  const lifecycleRoot = mkdtempSync(join(tmpdir(), 'omx-packed-hook-trust-'));
  const projectDir = resolve(lifecycleRoot, 'project');
  const home = join(lifecycleRoot, 'home');
  const codexHome = join(lifecycleRoot, 'codex-home');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const configPath = join(projectDir, '.codex', 'config.toml');
  const marker = 'omx-packed-foreign';
  const agentsPath = join(projectDir, 'AGENTS.md');
  const foreignAgentsContent = '# User project instructions\n\nPreserve this packed lifecycle guidance.\n';
  const env = isolatedSmokeEnv(home, codexHome);

  try {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), trustedProjectConfig(projectDir), 'utf-8');
    writeFileSync(agentsPath, foreignAgentsContent, 'utf-8');

    // Pre-seed foreign groups so uninstall may safely remove OMX's appended suffix.
    writeFileSync(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true }),
      'utf-8',
    );
    const preSetupForeignSnapshot = foreignHookGroupSnapshot(readFileSync(hooksPath, 'utf-8'), marker);
    if (preSetupForeignSnapshot.length !== 2) {
      throw new Error(`expected two pre-seeded foreign hook coordinates, received ${preSetupForeignSnapshot.length}`);
    }

    let codexVersion: string | null;
    try {
      codexVersion = probeCodexVersion(projectDir, env);
    } catch (error) {
      if (!(error instanceof CodexExecutableNotFoundError)) throw error;
      codexVersion = null;
    }

    const codexUserConfigPath = join(codexHome, 'config.toml');
    let approvedPreSetupForeignMetadata: Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> | null = null;
    if (codexVersion !== null) {
      const server = await CodexAppServer.start({ cwd: projectDir, env });
      try {
        await initializeCodexAppServer(server, 'omx-packed-install-smoke');
        const preSetupCodexHooks = await listCodexHooks(server, projectDir, hooksPath);
        const preSetupForeignHooks = preSetupCodexHooks.hooks.filter((hook) =>
          hook.command.includes(marker) && !hook.command.includes('-inserted.js'));
        if (preSetupForeignHooks.length !== 2) {
          throw new Error(`Codex hooks/list did not report exactly two pre-seeded foreign hooks; received ${preSetupForeignHooks.length}`);
        }
        if (preSetupForeignHooks.some((hook) => hook.trustStatus === 'trusted')) {
          throw new Error('isolated Codex approval state unexpectedly pre-approved a foreign hook before setup');
        }
        const approval = await server.request<unknown>(
          createCodexBatchWriteEnvelope(Object.fromEntries(
            preSetupForeignHooks.map((hook) => [hook.key, hook.currentHash]),
          )),
          CODEX_APP_SERVER_TIMEOUTS.requestMs,
        );
        assertCodexBatchWriteResult(approval, codexUserConfigPath);
      } finally {
        await server.close();
      }
      const approved = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      approvedPreSetupForeignMetadata = preseededForeignHookMetadata(approved.hooks, marker);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata,
        approved.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'pre-setup approval',
      );
    }

    const setupResult = run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error(
        `packed setup --merge-agents did not preserve pre-existing user AGENTS.md guidance; stdout=${JSON.stringify(String(setupResult.stdout || ''))} stderr=${JSON.stringify(String(setupResult.stderr || ''))}`,
      );
    }

    const initialHooksContent = readFileSync(hooksPath, 'utf-8');
    assertForeignHookGroupsPreserved(preSetupForeignSnapshot, initialHooksContent, marker);
    if (rawManagedHookCount(initialHooksContent) !== MANAGED_CODEX_HOOK_EVENTS.length) {
      throw new Error('packed setup did not install exactly seven managed native hooks');
    }
    assertManagedHooksAppendAfterForeign(initialHooksContent, marker);
    const generatedTrust = generatedHookTrustState(readFileSync(configPath, 'utf-8'));

    let postForeignCodexHooks: CodexHookMetadata[] | null = null;
    if (codexVersion !== null) {
      const server = await CodexAppServer.start({ cwd: projectDir, env });
      try {
        await initializeCodexAppServer(server, 'omx-packed-install-smoke');
        const initialCodexHooks = await listCodexHooks(server, projectDir, hooksPath);
        assertGeneratedTrustMatchesCodex(generatedTrust, initialCodexHooks.hooks);
        assertManagedHooksNotAlreadyTrusted(initialCodexHooks.hooks);
        await approveManagedHooksInCodex(server, initialCodexHooks.hooks, codexUserConfigPath);
      } finally {
        await server.close();
      }
      const afterSetup = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterSetup.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterSetup.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'setup',
      );
    }

    writeFileSync(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups(readFileSync(hooksPath, 'utf-8'), marker, { appendGroups: false }),
      'utf-8',
    );
    const postForeignHooksContent = readFileSync(hooksPath, 'utf-8');
    const postForeignConfigContent = readFileSync(configPath, 'utf-8');

    const foreignSnapshot = foreignHookGroupSnapshot(postForeignHooksContent, marker);
    if (foreignSnapshot.length !== 4) {
      throw new Error(`expected four foreign hook coordinates after insertion, received ${foreignSnapshot.length}`);
    }
    if (codexVersion !== null) {
      const inspected = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(inspected.hooks);
      postForeignCodexHooks = inspected.hooks;
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        inspected.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'foreign insertion before setup rerun',
      );
    }

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    const afterRerunHooksContent = readFileSync(hooksPath, 'utf-8');
    if (afterRerunHooksContent !== postForeignHooksContent) {
      throw new Error('packed setup rerun changed hooks.json after foreign insertion');
    }
    if (readFileSync(configPath, 'utf-8') !== postForeignConfigContent) {
      throw new Error('packed setup rerun changed config.toml after foreign insertion');
    }

    assertForeignHookGroupsPreserved(foreignSnapshot, afterRerunHooksContent, marker);
    if (postForeignCodexHooks !== null) {
      const afterRerun = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterRerun.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterRerun.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'setup rerun',
      );
      if (!sameJson(hookMetadataSnapshot(afterRerun.hooks), hookMetadataSnapshot(postForeignCodexHooks))) {
        throw new Error('packed setup rerun changed Codex hook metadata or display order');
      }
    }

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    const afterNoopHooksContent = readFileSync(hooksPath, 'utf-8');
    if (afterNoopHooksContent !== postForeignHooksContent) {
      throw new Error('third packed setup was not a hooks.json byte no-op');
    }
    if (readFileSync(configPath, 'utf-8') !== postForeignConfigContent) {
      throw new Error('third packed setup was not a config.toml byte no-op');
    }
    assertForeignHookGroupsPreserved(foreignSnapshot, afterNoopHooksContent, marker);
    if (postForeignCodexHooks !== null) {
      const afterNoop = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterNoop.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterNoop.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'third setup',
      );
      if (!sameJson(hookMetadataSnapshot(afterNoop.hooks), hookMetadataSnapshot(postForeignCodexHooks))) {
        throw new Error('third packed setup changed Codex hook metadata or display order');
      }
    }
    run(omxPath, ['doctor', '--verbose'], { cwd: projectDir, env });
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error('packed doctor lifecycle did not preserve pre-existing user AGENTS.md guidance');
    }

    run(omxPath, ['uninstall'], { cwd: projectDir, env });
    const afterUninstallHooksContent = readFileSync(hooksPath, 'utf-8');
    if (rawManagedHookCount(afterUninstallHooksContent) !== 0) {
      throw new Error('packed uninstall retained an OMX-managed native hook');
    }
    assertNoEmptyManagedEventGroups(afterUninstallHooksContent);
    assertForeignHookGroupsPreserved(foreignSnapshot, afterUninstallHooksContent, marker);
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error('packed uninstall removed pre-existing user AGENTS.md guidance');
    }
    const afterUninstallConfig = readFileSync(configPath, 'utf-8');
    assertNoSetupOwnedTrustKeys(afterUninstallConfig, generatedTrust);
    assertNativeHooksEnabledForForeignGroups(afterUninstallConfig);
    if (postForeignCodexHooks !== null) {
      const afterUninstall = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      const foreignIdentity = (hooks: readonly CodexHookMetadata[]) =>
        hookMetadataSnapshot(hooks.filter((hook) => hook.command.includes(marker)));
      const foreignBefore = foreignIdentity(postForeignCodexHooks);
      const foreignAfter = foreignIdentity(afterUninstall.hooks);
      if (!sameJson(foreignAfter, foreignBefore)) {
        throw new Error('packed uninstall changed foreign Codex hook metadata or display order');
      }
    }

    const managedFirstProjectDir = resolve(lifecycleRoot, 'managed-first-project');
    const managedFirstHooksPath = join(managedFirstProjectDir, '.codex', 'hooks.json');
    const managedFirstConfigPath = join(managedFirstProjectDir, '.codex', 'config.toml');
    const managedFirstMarker = 'omx-packed-managed-first-foreign';
    mkdirSync(join(managedFirstProjectDir, '.codex'), { recursive: true });
    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: managedFirstProjectDir,
      env,
    });
    writeFileSync(
      managedFirstHooksPath,
      appendDisplayOrderStableForeignHookGroups(
        readFileSync(managedFirstHooksPath, 'utf-8'),
        managedFirstMarker,
        { appendGroups: true },
      ),
      'utf-8',
    );
    const managedFirstBeforeRerunHooks = readFileSync(managedFirstHooksPath, 'utf-8');
    const managedFirstBeforeRerunConfig = readFileSync(managedFirstConfigPath, 'utf-8');
    const managedFirstForeignSnapshot = foreignHookGroupSnapshot(managedFirstBeforeRerunHooks, managedFirstMarker);
    if (managedFirstForeignSnapshot.length !== 2) {
      throw new Error('packed managed-first fixture did not append both foreign hook groups');
    }
    assertManagedHooksRemainBeforeForeign(managedFirstBeforeRerunHooks, managedFirstMarker);

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: managedFirstProjectDir,
      env,
    });
    if (readFileSync(managedFirstHooksPath, 'utf-8') !== managedFirstBeforeRerunHooks) {
      throw new Error('packed setup rerun reordered managed-first foreign hook groups');
    }
    if (readFileSync(managedFirstConfigPath, 'utf-8') !== managedFirstBeforeRerunConfig) {
      throw new Error('packed setup rerun changed managed-first config.toml');
    }
    assertForeignHookGroupsPreserved(
      managedFirstForeignSnapshot,
      readFileSync(managedFirstHooksPath, 'utf-8'),
      managedFirstMarker,
    );
    const managedFirstBeforeUninstallHooksBytes = readFileSync(managedFirstHooksPath);
    const managedFirstBeforeUninstallConfigBytes = readFileSync(managedFirstConfigPath);

    const expectedUnsafeManagedRemovalDiagnostic =
      'Removing OMX hooks would shift a foreign coordinate or discard opaque metadata.';
    const unsafeRemoval = planManagedCodexHooksRemoval(managedFirstBeforeRerunHooks, managedFirstHooksPath);
    if (
      unsafeRemoval.ok ||
      unsafeRemoval.error.code !== 'unsafe_managed_removal' ||
      unsafeRemoval.error.message !== expectedUnsafeManagedRemovalDiagnostic
    ) {
      throw new Error('packed managed-first fixture did not return the exact unsafe_managed_removal diagnostic');
    }
    const failedUninstall = spawnSync(omxPath, ['uninstall'], {
      cwd: managedFirstProjectDir,
      env,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (failedUninstall.error) throw failedUninstall.error;
    if (failedUninstall.status !== 1) {
      throw new Error(
        `packed unsafe uninstall exited ${String(failedUninstall.status)}, expected 1\nstdout:\n${failedUninstall.stdout || ''}\nstderr:\n${failedUninstall.stderr || ''}`,
      );
    }
    if (failedUninstall.stderr !== `Error: ${expectedUnsafeManagedRemovalDiagnostic}\n`) {
      throw new Error(`packed unsafe uninstall returned an unexpected diagnostic: ${failedUninstall.stderr || ''}`);
    }
    if (!readFileSync(managedFirstHooksPath).equals(managedFirstBeforeUninstallHooksBytes)) {
      throw new Error('unsafe packed uninstall changed raw hooks.json bytes');
    }
    if (!readFileSync(managedFirstConfigPath).equals(managedFirstBeforeUninstallConfigBytes)) {
      throw new Error('unsafe packed uninstall changed raw config.toml bytes');
    }
    assertNoUninstallTransactionArtifacts(join(managedFirstProjectDir, '.codex'));

    return { codexVersion };
  } finally {
    rmSync(lifecycleRoot, { recursive: true, force: true });
  }
}

export function parseNpmPackJsonOutput(stdout: string): Array<{ filename: string }> {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) {
    throw new Error(`npm pack did not return JSON output: ${stdout.trim()}`);
  }
  return JSON.parse(jsonText) as Array<{ filename: string }>;
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  mkdirSync(prefixDir, { recursive: true });

  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = parseNpmPackJsonOutput(pack.stdout as string);
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    for (const argv of PACKED_INSTALL_SMOKE_CORE_COMMANDS) {
      run(omxPath, argv, { cwd: repoRoot });
    }
    smokeInstalledNativeHookDist(prefixDir);
    const lifecycle = await smokePackedHookTrustLifecycle(omxPath);
    console.log(
      lifecycle.codexVersion !== null
        ? `packed install smoke: installed Codex 0.142.5 lifecycle passed (${lifecycle.codexVersion})`
        : 'packed install smoke: Codex executable absent; installed-Codex trust leg skipped after deterministic lifecycle',
    );

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
