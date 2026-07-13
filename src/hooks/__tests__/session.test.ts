import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendToLog,
  resetSessionMetrics,
  reconcileNativeSessionStart,
  resolveAuthenticatedTransportAuthority,
  setSessionFilesystemTestHooksForTests,
  sessionLifecycleFileHandleMustCloseBeforeEffect,
  sessionLifecycleFilesystemPrimitiveForPlatform,
  writeSessionStart,
  writeSessionEnd,
  readSessionState,
  readUsableSessionState,
  isSessionStale,
  type SessionState,
} from '../session.js';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  canonicalizeExistingAuthorityPath,
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
} from '../../state/authority.js';

interface SessionHistoryEntry {
  session_id: string;
  native_session_id?: string;
  started_at: string;
  ended_at: string;
  cwd: string;
  pid: number;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}


function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: 'sess-1',
    started_at: '2026-02-26T00:00:00.000Z',
    cwd: '/tmp/project',
    pid: 12345,
    ...overrides,
  };
}

describe('session lifecycle manager', () => {
  it('selects descriptor-relative lifecycle I/O only when the host exposes Linux no-follow primitives', () => {
    const linux = sessionLifecycleFilesystemPrimitiveForPlatform('linux');
    const linuxNoFollowAvailable = (
      typeof constants.O_NOFOLLOW === 'number'
      && typeof constants.O_DIRECTORY === 'number'
    );
    assert.equal(linux.descriptor_relative, linuxNoFollowAvailable);

    const darwin = sessionLifecycleFilesystemPrimitiveForPlatform('darwin');
    assert.equal(darwin.descriptor_relative, false);

    const windows = sessionLifecycleFilesystemPrimitiveForPlatform('win32');
    assert.equal(windows.descriptor_relative, false);
    assert.equal(windows.directory_open_flags, null);
    assert.equal(windows.file_open_flags, 0);

    assert.equal(sessionLifecycleFileHandleMustCloseBeforeEffect('rename', 'linux'), false);
    assert.equal(sessionLifecycleFileHandleMustCloseBeforeEffect('unlink', 'darwin'), false);
    assert.equal(sessionLifecycleFileHandleMustCloseBeforeEffect('rename', 'win32'), true);
    assert.equal(sessionLifecycleFileHandleMustCloseBeforeEffect('unlink', 'win32'), true);
  });
  it('resets session metrics files with zeroed counters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-'));
    try {
      await resetSessionMetrics(cwd);

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as {
        total_turns: number;
        session_turns: number;
      };
      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };

      assert.equal(metrics.total_turns, 0);
      assert.equal(metrics.session_turns, 0);
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes hud session metrics into the active session scope when session id is provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-scoped-'));
    try {
      await resetSessionMetrics(cwd, 'sess-scoped');

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'sessions', 'sess-scoped', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for replaced final and intermediate metrics or HUD write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-io-write-symlink-'));
    const attackerMetricsPath = join(cwd, 'attacker-metrics.json');
    const attackerHudDir = join(cwd, 'attacker-hud');
    try {
      await resetSessionMetrics(cwd, 'sess-hud-symlink');
      const metricsPath = join(cwd, '.omx', 'metrics.json');
      await writeFile(attackerMetricsPath, 'attacker metrics must survive', 'utf-8');
      await rm(metricsPath);
      await symlink(attackerMetricsPath, metricsPath);

      await assert.rejects(
        resetSessionMetrics(cwd, 'sess-hud-symlink'),
        (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      );
      assert.equal(await readFile(attackerMetricsPath, 'utf-8'), 'attacker metrics must survive');
      await rm(metricsPath);

      const sessionsPath = join(cwd, '.omx', 'state', 'sessions');
      await mkdir(attackerHudDir);
      await rm(sessionsPath, { recursive: true, force: true });
      await symlink(attackerHudDir, sessionsPath);
      await assert.rejects(
        resetSessionMetrics(cwd, 'sess-hud-symlink'),
        (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      );
      assert.equal(existsSync(join(attackerHudDir, 'sess-hud-symlink', 'hud-state.json')), false);
    } finally {
      setSessionFilesystemTestHooksForTests();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps previous metrics and log records intact when publication is interrupted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-io-torn-write-'));
    try {
      await resetSessionMetrics(cwd, 'sess-torn-log');
      const metricsPath = canonicalizeExistingAuthorityPath(join(cwd, '.omx', 'metrics.json'));
      const metricsBefore = await readFile(metricsPath, 'utf-8');
      setSessionFilesystemTestHooksForTests({
        beforeAtomicWriteRename(targetPath) {
          if (targetPath === metricsPath) throw new Error('simulated metrics publication interruption');
        },
      });
      await assert.rejects(resetSessionMetrics(cwd, 'sess-torn-log'), /simulated metrics publication interruption/);
      assert.equal(await readFile(metricsPath, 'utf-8'), metricsBefore);

      setSessionFilesystemTestHooksForTests();
      await writeSessionStart(cwd, 'sess-torn-log');
      const logPath = canonicalizeExistingAuthorityPath(join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`));
      const logBefore = await readFile(logPath, 'utf-8');
      setSessionFilesystemTestHooksForTests({
        beforeAtomicWriteRename(targetPath) {
          if (targetPath === logPath) throw new Error('simulated log publication interruption');
        },
      });
      await assert.rejects(appendToLog(cwd, { event: 'interrupted_log_append' }), /simulated log publication interruption/);
      assert.equal(await readFile(logPath, 'utf-8'), logBefore);
    } finally {
      setSessionFilesystemTestHooksForTests();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a replacement OMX parent before metrics, daily logs, or history publication', async () => {
    const publications = [
      {
        name: 'metrics',
        setup: (cwd: string) => resetSessionMetrics(cwd, 'sess-parent-metrics'),
        publish: (cwd: string) => resetSessionMetrics(cwd, 'sess-parent-metrics'),
        replacementTarget: ['metrics.json'],
      },
      {
        name: 'daily-log',
        setup: (cwd: string) => writeSessionStart(cwd, 'sess-parent-log'),
        publish: (cwd: string) => appendToLog(cwd, { event: 'replacement_parent_log' }),
        replacementTarget: ['logs', `omx-${todayIsoDate()}.jsonl`],
      },
      {
        name: 'history',
        setup: (cwd: string) => writeSessionStart(cwd, 'sess-parent-history'),
        publish: (cwd: string) => writeSessionEnd(cwd, 'sess-parent-history'),
        replacementTarget: ['logs', 'session-history.jsonl'],
      },
    ];

    for (const publication of publications) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-parent-${publication.name}-`));
      const displacedOmxRoot = join(cwd, '.omx-displaced');
      try {
        await publication.setup(cwd);
        const omxRoot = canonicalizeExistingAuthorityPath(join(cwd, '.omx'));
        setSessionFilesystemTestHooksForTests({
          async beforeCaptureParentOmxIdentity(capturedOmxRoot) {
            assert.equal(capturedOmxRoot, omxRoot);
            await rename(omxRoot, displacedOmxRoot);
            await mkdir(join(omxRoot, 'state'), { recursive: true });
          },
        });

        await assert.rejects(
          publication.publish(cwd),
          (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
        );
        assert.equal(existsSync(join(omxRoot, ...publication.replacementTarget)), false);
      } finally {
        setSessionFilesystemTestHooksForTests();
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects replaced session publication and history append targets without following them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-io-final-symlink-'));
    const attackerSessionPath = join(cwd, 'attacker-session.json');
    const attackerHistoryPath = join(cwd, 'attacker-history.jsonl');
    try {
      await resetSessionMetrics(cwd, 'sess-final-symlink');
      const stateRoot = canonicalizeExistingAuthorityPath(join(cwd, '.omx', 'state'));
      const sessionPath = join(stateRoot, 'session.json');
      await writeFile(attackerSessionPath, 'attacker session must survive', 'utf-8');
      setSessionFilesystemTestHooksForTests({
        async beforeAtomicWriteRename(targetPath) {
          if (targetPath === sessionPath) await symlink(attackerSessionPath, sessionPath);
        },
      });
      await assert.rejects(
        writeSessionStart(cwd, 'sess-final-symlink'),
        (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      );
      assert.equal(await readFile(attackerSessionPath, 'utf-8'), 'attacker session must survive');
      await rm(sessionPath);

      setSessionFilesystemTestHooksForTests();
      await writeSessionStart(cwd, 'sess-final-symlink');
      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      await writeFile(attackerHistoryPath, 'attacker history must survive', 'utf-8');
      await symlink(attackerHistoryPath, historyPath);
      await assert.rejects(
        writeSessionEnd(cwd, 'sess-final-symlink'),
        (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootSymlink,
      );
      assert.equal(await readFile(attackerHistoryPath, 'utf-8'), 'attacker history must survive');
    } finally {
      setSessionFilesystemTestHooksForTests();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects final session-pointer replacement at the durable delete boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-io-delete-replacement-'));
    const attackerPath = join(cwd, 'attacker-session-delete.json');
    try {
      await writeSessionStart(cwd, 'sess-delete-replacement');
      const sessionPath = canonicalizeExistingAuthorityPath(join(cwd, '.omx', 'state', 'session.json'));
      const movedSessionPath = join(cwd, 'moved-session.json');
      await writeFile(attackerPath, 'attacker delete target must survive', 'utf-8');
      setSessionFilesystemTestHooksForTests({
        async beforeDelete(targetPath) {
          if (targetPath !== sessionPath) return;
          await rename(sessionPath, movedSessionPath);
          await symlink(attackerPath, sessionPath);
        },
      });

      await assert.rejects(
        writeSessionEnd(cwd, 'sess-delete-replacement'),
        (error: unknown) => (error as { code?: string }).code === AUTHORITY_DIAGNOSTIC_CODES.rootFingerprintMismatch,
      );
      assert.equal(await readFile(attackerPath, 'utf-8'), 'attacker delete target must survive');
      assert.equal(existsSync(movedSessionPath), true);
    } finally {
      setSessionFilesystemTestHooksForTests();
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('treats symlinked cwd aliases as authoritative for the same session state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-cwd-alias-'));
    const aliasCwd = `${cwd}-alias`;
    try {
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeSessionStart(cwd, 'sess-alias');

      const usable = await readUsableSessionState(aliasCwd);
      assert.ok(usable);
      assert.equal(usable?.session_id, 'sess-alias');
      assert.equal(usable?.cwd, cwd);
    } finally {
      await rm(aliasCwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves an inherited bearer across a proven session alias revision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-transport-rotation-'));
    const keys = [
      'OMX_STATE_AUTHORITY_PATH',
      'OMX_STATE_AUTHORITY_ID',
      'OMX_STATE_AUTHORITY_GENERATION_ID',
      'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
      'OMX_STATE_AUTHORITY_CAPABILITY',
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      const authority = await initializeStateAuthority({
        startup_cwd: cwd,
        launch_id: 'session-transport-launch',
        session_binding: { canonical_session_id: 'session-transport' },
      });
      const minted = await mintStateAuthorityTransportCapability(authority);
      const inherited = {
        OMX_STATE_AUTHORITY_PATH: authority.authority_path,
        OMX_STATE_AUTHORITY_ID: authority.generation.authority_id,
        OMX_STATE_AUTHORITY_GENERATION_ID: authority.generation.generation_id,
        OMX_STATE_AUTHORITY_WORKSPACE_DIGEST: authority.workspace_identity.digest,
        OMX_STATE_AUTHORITY_CAPABILITY: minted.capability,
      };
      Object.assign(process.env, inherited);

      await writeSessionStart(cwd, 'session-transport', { nativeSessionId: 'codex-transport' });
      const preservedCapability = process.env.OMX_STATE_AUTHORITY_CAPABILITY;
      assert.equal(preservedCapability, minted.capability);
      const inheritedResolved = await resolveAuthenticatedTransportAuthority(cwd, inherited);
      assert.equal(inheritedResolved?.session_binding?.aliases.native_session_id, 'codex-transport');
      const resolved = await resolveAuthenticatedTransportAuthority(cwd, process.env);
      assert.equal(resolved?.session_binding?.aliases.native_session_id, 'codex-transport');
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes session start/end lifecycle artifacts and archives session history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lifecycle-'));
    const sessionId = 'sess-lifecycle-1';
    try {
      await writeSessionStart(cwd, sessionId);

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, sessionId);
      assert.equal(state.cwd, cwd);
      assert.equal(state.pid, process.pid);
      assert.equal(isSessionStale(state), false);

      const sessionPath = join(cwd, '.omx', 'state', 'session.json');
      assert.equal(existsSync(sessionPath), true);

      await writeSessionEnd(cwd, sessionId);

      assert.equal(existsSync(sessionPath), false);

      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      assert.equal(existsSync(historyPath), true);

      const historyLines = (await readFile(historyPath, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);

      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry;
      assert.equal(historyEntry.session_id, sessionId);
      assert.equal(historyEntry.cwd, cwd);
      assert.equal(typeof historyEntry.started_at, 'string');
      assert.equal(typeof historyEntry.ended_at, 'string');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      assert.equal(existsSync(dailyLogPath), true);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"event":"session_end"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not delete the current session pointer when ending a different session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-owner-'));
    try {
      await writeSessionStart(cwd, 'sess-current');
      const stateDir = join(cwd, '.omx', 'state');
      const sessionPath = join(stateDir, 'session.json');
      const rootHudPath = join(stateDir, 'hud-state.json');
      const currentHudPath = join(stateDir, 'sessions', 'sess-current', 'hud-state.json');
      const endingHudPath = join(stateDir, 'sessions', 'sess-ending', 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-ending'), { recursive: true });
      await writeFile(rootHudPath, JSON.stringify({ turn_count: 3 }), 'utf-8');
      await writeFile(currentHudPath, JSON.stringify({ turn_count: 2 }), 'utf-8');
      await writeFile(endingHudPath, JSON.stringify({ turn_count: 1 }), 'utf-8');

      await writeSessionEnd(cwd, 'sess-ending');

      const state = await readSessionState(cwd);
      assert.equal(state?.session_id, 'sess-current');
      assert.equal(existsSync(sessionPath), true);
      assert.equal(existsSync(currentHudPath), true);
      assert.equal(existsSync(rootHudPath), true);
      assert.equal(existsSync(endingHudPath), false);

      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);
      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry & {
        preserved_active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'sess-ending');
      assert.equal(historyEntry.started_at, 'unknown');
      assert.equal(historyEntry.preserved_active_session_id, 'sess-current');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes canonical and native session-scoped hud state on session end', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-hud-cleanup-'));
    const canonicalSessionId = 'omx-launch-hud';
    const nativeSessionId = 'codex-native-hud';
    try {
      await writeSessionStart(cwd, canonicalSessionId, { nativeSessionId });
      const stateDir = join(cwd, '.omx', 'state');
      const rootHudPath = join(stateDir, 'hud-state.json');
      const canonicalHudPath = join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json');
      const nativeHudPath = join(stateDir, 'sessions', nativeSessionId, 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', canonicalSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', nativeSessionId), { recursive: true });
      await writeFile(rootHudPath, JSON.stringify({ last_turn_at: 'root', turn_count: 1 }), 'utf-8');
      await writeFile(canonicalHudPath, JSON.stringify({ last_turn_at: 'canonical', turn_count: 2 }), 'utf-8');
      await writeFile(nativeHudPath, JSON.stringify({ last_turn_at: 'native', turn_count: 9 }), 'utf-8');

      await writeSessionEnd(cwd, canonicalSessionId);

      assert.equal(existsSync(rootHudPath), false);
      assert.equal(existsSync(canonicalHudPath), false);
      assert.equal(existsSync(nativeHudPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves canonical session id while reconciling native SessionStart metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-reconcile-'));
    try {
      await writeSessionStart(cwd, 'omx-launch-1');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-1', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-launch-1');
      assert.equal(reconciled.native_session_id, 'codex-native-1');
      assert.equal(reconciled.pid, 54321);
      assert.equal(reconciled.platform, 'win32');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-launch-1');
      assert.equal(persisted?.native_session_id, 'codex-native-1');
      assert.equal(persisted?.pid, 54321);

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start_reconciled"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-1"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('starts a fresh native session while retaining the owner OMX launch session when native SessionStart changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fresh-'));
    try {
      await writeSessionStart(cwd, 'omx-old-session', {
        nativeSessionId: 'codex-native-old',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-new');
      assert.equal(reconciled.native_session_id, 'codex-native-new');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-old');
      assert.equal(reconciled.owner_omx_session_id, 'omx-old-session');
      assert.match(reconciled.native_session_switched_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(reconciled.pid, 54321);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-new');
      assert.equal(persisted?.native_session_id, 'codex-native-new');
      assert.equal(persisted?.previous_native_session_id, 'codex-native-old');
      assert.equal(persisted?.owner_omx_session_id, 'omx-old-session');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"native_session_replaced"/);
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"previous_native_session_id":"codex-native-old"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-new"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves existing native and tmux bindings on same-session start updates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-preserve-'));
    try {
      await writeSessionStart(cwd, 'omx-launch-1', {
        nativeSessionId: 'codex-native-1',
        tmuxSessionName: 'omx-detached-demo',
      });

      const withPane = await writeSessionStart(cwd, 'omx-launch-1', {
        tmuxSessionName: 'omx-detached-demo',
        tmuxPaneId: '%42',
      });

      assert.equal(withPane.native_session_id, 'codex-native-1');
      assert.equal(withPane.tmux_session_name, 'omx-detached-demo');
      assert.equal(withPane.tmux_pane_id, '%42');

      const withoutPane = await writeSessionStart(cwd, 'omx-launch-1', {
        tmuxSessionName: 'omx-detached-demo',
      });

      assert.equal(withoutPane.native_session_id, 'codex-native-1');
      assert.equal(withoutPane.tmux_session_name, 'omx-detached-demo');
      assert.equal(withoutPane.tmux_pane_id, '%42');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets an owner OMX launch session end the fresh native session it spawned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-end-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: 54321,
        platform: 'win32',
      });

      await writeSessionEnd(cwd, 'omx-owner-session');

      assert.equal(await readSessionState(cwd), null);
      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);
      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry & {
        active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'omx-owner-session');
      assert.equal(historyEntry.native_session_id, 'codex-native-new');
      assert.equal(historyEntry.active_session_id, 'codex-native-new');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves owner OMX metadata when reconciling the same fresh native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-reconcile-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-new');
      assert.equal(reconciled.native_session_id, 'codex-native-new');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-old');
      assert.equal(reconciled.owner_omx_session_id, 'omx-owner-session');
      assert.equal(reconciled.pid, process.pid);

      await writeSessionEnd(cwd, 'omx-owner-session');
      assert.equal(await readSessionState(cwd), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('carries the owner OMX launch session across chained native SessionStart replacements', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-chain-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-a',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-b', {
        pid: process.pid,
        platform: 'win32',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-c', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-c');
      assert.equal(reconciled.native_session_id, 'codex-native-c');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-b');
      assert.equal(reconciled.owner_omx_session_id, 'omx-owner-session');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"session_id":"omx-owner-session"/);
      assert.match(dailyLog, /"active_session_id":"codex-native-b"/);
      assert.match(dailyLog, /"previous_native_session_id":"codex-native-b"/);
      assert.match(dailyLog, /"replaced_by_native_session_id":"codex-native-c"/);

      await writeSessionEnd(cwd, 'omx-owner-session');
      assert.equal(await readSessionState(cwd), null);
      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      const historyEntry = JSON.parse(historyLines.at(-1) ?? '{}') as SessionHistoryEntry & {
        active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'omx-owner-session');
      assert.equal(historyEntry.native_session_id, 'codex-native-c');
      assert.equal(historyEntry.active_session_id, 'codex-native-c');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects replacing a live non-OMX authority binding with a foreign native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-non-omx-fresh-'));
    try {
      await writeSessionStart(cwd, 'codex-native-old', {
        nativeSessionId: 'codex-native-old',
      });

      await assert.rejects(
        reconcileNativeSessionStart(cwd, 'codex-native-new', {
          pid: 54321,
          platform: 'win32',
        }),
        /requested launch session does not match a provably exited active authority binding/,
      );

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-old');
      assert.equal(persisted?.native_session_id, 'codex-native-old');
      assert.equal(persisted?.previous_native_session_id, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to a fresh canonical session when reconciling without authoritative launch state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fallback-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-fallback-1', {
        pid: 67890,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-fallback-1');
      assert.equal(reconciled.native_session_id, 'codex-fallback-1');
      assert.equal(reconciled.pid, 67890);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats invalid session JSON as absent state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-invalid-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, '{ not-json', 'utf-8');
      const state = await readSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its recorded cwd points at another worktree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-mismatched-cwd-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const state = await readUsableSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its PID identity is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-stale-pointer-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-stale-pointer',
        cwd,
        pid: 4242,
        pid_start_ticks: 11,
        pid_cmdline: 'node omx',
      }), 'utf-8');

      const state = await readUsableSessionState(cwd, {
        platform: 'linux',
        isPidAlive: () => true,
        readLinuxIdentity: () => ({ startTicks: 22, cmdline: 'node omx' }),
      });
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks dead PIDs as stale', () => {
    const impossiblePid = Number.MAX_SAFE_INTEGER;
    const stale = isSessionStale({
      session_id: 'sess-stale',
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      pid: impossiblePid,
    });
    assert.equal(stale, true);
  });
});

describe('isSessionStale', () => {
  it('returns false for a live Linux process when identity matches', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, false);
  });

  it('returns true for PID reuse on Linux when start ticks mismatch', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 222, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when identity metadata is missing', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when live identity cannot be read', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, true);
  });

  it('returns true when PID is not alive', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => false,
    });

    assert.equal(stale, true);
  });

  it('falls back to PID liveness on non-Linux platforms', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, false);
  });
});
