import { safeString } from './utils.js';
import { runProcess } from './process-runner.js';
import {
  buildCapturePaneArgv,
  buildPaneInModeArgv,
  buildPaneCurrentCommandArgv,
  buildSendKeysArgv,
  isPaneRunningShell,
  paneHasActiveTask,
  paneLooksReady,
} from '../tmux-hook-engine.js';
import { readExactPaneProof } from '../../team/exact-pane.js';

export const EXACT_PANE_UNAVAILABLE_REASON = 'exact_pane_unavailable';
const EXACT_PANE_ID_RE = /^%\d+$/;

function explicitPaneIdentity(value: any): { provided: boolean; paneId: string } {
  const paneId = safeString(value).trim();
  return { provided: paneId !== '', paneId: EXACT_PANE_ID_RE.test(paneId) ? paneId : '' };
}

export function normalizeExactPaneId(value: any): string {
  return explicitPaneIdentity(value).paneId;
}

function exactPaneBindingFailure(target: string, exactPaneId: any): any | null {
  const identity = explicitPaneIdentity(exactPaneId);
  const targetIsExactPane = EXACT_PANE_ID_RE.test(target);
  if (targetIsExactPane && !identity.provided) {
    return {
      ok: false,
      reason: EXACT_PANE_UNAVAILABLE_REASON,
      paneId: target,
      proof: { status: 'unavailable', paneId: target, reason: 'missing_exact_pane_id' },
    };
  }
  if (identity.provided && !identity.paneId) {
    return {
      ok: false,
      reason: EXACT_PANE_UNAVAILABLE_REASON,
      paneId: '',
      proof: { status: 'unavailable', paneId: safeString(exactPaneId).trim(), reason: 'invalid_pane_id' },
    };
  }
  if (identity.paneId && identity.paneId !== target) {
    return {
      ok: false,
      reason: EXACT_PANE_UNAVAILABLE_REASON,
      paneId: identity.paneId,
      proof: { status: 'unavailable', paneId: identity.paneId, reason: 'pane_target_mismatch' },
    };
  }
  return null;
}

export async function verifyExactPaneLive(exactPaneId: any, expectedPanePid?: number): Promise<any> {
  const identity = explicitPaneIdentity(exactPaneId);
  if (!identity.provided) return { ok: true, paneId: '', proof: null };
  if (!identity.paneId) {
    return {
      ok: false,
      reason: EXACT_PANE_UNAVAILABLE_REASON,
      paneId: '',
      proof: {
        status: 'unavailable',
        paneId: safeString(exactPaneId).trim(),
        reason: 'invalid_pane_id',
      },
    };
  }

  try {
    const proof = await readExactPaneProof(identity.paneId);
    if (proof.status === 'live' && proof.paneId === identity.paneId) {
      if (typeof expectedPanePid === 'number' && proof.pid !== expectedPanePid) {
        return {
          ok: false,
          reason: EXACT_PANE_UNAVAILABLE_REASON,
          paneId: identity.paneId,
          proof: { ...proof, status: 'unavailable', reason: 'pane_pid_changed', expectedPid: expectedPanePid },
        };
      }
      return { ok: true, paneId: identity.paneId, proof };
    }
    return { ok: false, reason: EXACT_PANE_UNAVAILABLE_REASON, paneId: identity.paneId, proof };
  } catch (error) {
    return {
      ok: false,
      reason: EXACT_PANE_UNAVAILABLE_REASON,
      paneId: identity.paneId,
      proof: {
        status: 'unavailable',
        paneId: identity.paneId,
        reason: 'query_failed',
        detail: error instanceof Error ? error.message : safeString(error),
      },
    };
  }
}

function exactPaneUnavailableResult(target: string, paneProof: any, extra: any = {}): any {
  return {
    ok: false,
    sent: false,
    reason: EXACT_PANE_UNAVAILABLE_REASON,
    paneTarget: target,
    exactPaneProof: paneProof.proof || null,
    ...extra,
  };
}

export const PANE_READINESS_UNVERIFIED_REASON = 'pane_readiness_unverified';
let nextTmuxBufferId = 0;

function buildSafePasteArgv(target: string, prompt: string): {
  bufferName: string;
  setBufferArgv: string[];
  showBufferArgv: string[];
  clearComposerArgv: string[];
  pasteBufferArgv: string[];
  deleteBufferArgv: string[];
} {
  nextTmuxBufferId += 1;
  const bufferName = `omx-pane-input-${process.pid}-${Date.now()}-${nextTmuxBufferId}`;
  return {
    bufferName,
    setBufferArgv: ['set-buffer', '-b', bufferName, '--', prompt],
    showBufferArgv: ['show-buffer', '-b', bufferName],
    clearComposerArgv: ['send-keys', '-t', target, 'C-u'],
    pasteBufferArgv: ['paste-buffer', '-t', target, '-b', bufferName, '-p', '-d'],
    deleteBufferArgv: ['delete-buffer', '-b', bufferName],
  };
}


export function mapPaneInjectionReadinessReason(reason: any): any {
  return reason === 'pane_running_shell' ? 'agent_not_running' : reason;
}

export async function evaluatePaneInjectionReadiness(paneTarget: any, {
  skipIfScrolling = false,
  captureLines = 80,
  requireRunningAgent = true,
  requireReady = true,
  requireIdle = true,
  requireObservableState = false,
  requireCaptureEvidence = undefined,
  exactPaneId = undefined,
} = {}): Promise<any> {
  const normalizedRequireObservableState = typeof requireCaptureEvidence === 'boolean' ? requireCaptureEvidence : requireObservableState;
  const target = safeString(paneTarget).trim();
  if (!target) {
    return {
      ok: false,
      sent: false,
      reason: 'missing_pane_target',
      paneTarget: '',
      paneCurrentCommand: '',
      paneCapture: '',
    };
  }
  const bindingFailure = exactPaneBindingFailure(target, exactPaneId);
  if (bindingFailure) return exactPaneUnavailableResult(target, bindingFailure);

  const exactPaneIdentity = safeString(exactPaneId).trim();
  const exactPaneIdentityProvided = explicitPaneIdentity(exactPaneId).provided;
  let exactPaneProof: any = null;
  let expectedPanePid: number | undefined;
  const verifyExplicitPane = async () => {
    const paneProof = await verifyExactPaneLive(exactPaneIdentity, expectedPanePid);
    exactPaneProof = paneProof.proof || null;
    if (paneProof.ok && typeof paneProof.proof?.pid === 'number') expectedPanePid ??= paneProof.proof.pid;
    return paneProof;
  };
  let paneCurrentCommand = '';
  let paneRunningShell = false;
  const buildReadinessResult = (ok: boolean, reason: string, paneCapture: string, readinessEvidence: string) => ({
    ok,
    sent: false,
    reason,
    paneTarget: target,
    paneCurrentCommand,
    paneCapture,
    readinessEvidence,
    exactPaneProof,
  });
  const exactPaneFailure = (paneProof: any, paneCapture = '') => exactPaneUnavailableResult(target, paneProof, {
    paneCurrentCommand,
    paneCapture,
    readinessEvidence: 'exact_pane_unavailable',
  });

  if (skipIfScrolling) {
    const paneProof = await verifyExplicitPane();
    if (!paneProof.ok) return exactPaneFailure(paneProof);
    try {
      const modeResult = await runProcess('tmux', buildPaneInModeArgv(target), 3000);
      if (safeString(modeResult.stdout).trim() === '1') {
        return {
          ok: false,
          sent: false,
          reason: 'scroll_active',
          paneTarget: target,
          paneCurrentCommand: '',
          paneCapture: '',
          exactPaneProof,
        };
      }
    } catch {
      // Non-fatal: continue with remaining preflight checks.
    }
  }

  {
    const paneProof = await verifyExplicitPane();
    if (!paneProof.ok) return exactPaneFailure(paneProof);
    try {
      const result = await runProcess('tmux', buildPaneCurrentCommandArgv(target), 3000);
      paneCurrentCommand = safeString(result.stdout).trim();
      paneRunningShell = requireRunningAgent && isPaneRunningShell(paneCurrentCommand);
    } catch {
      if (exactPaneIdentityProvided) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, '', 'command_failed');
      }
      paneCurrentCommand = '';
    }
  }

  {
    const paneProof = await verifyExplicitPane();
    if (!paneProof.ok) return exactPaneFailure(paneProof);
    try {
      const capture = await runProcess('tmux', buildCapturePaneArgv(target, captureLines), 3000);
      const paneCapture = safeString(capture.stdout);
      const hasCaptureEvidence = paneCapture.trim() !== '';
      if (hasCaptureEvidence) {
        const paneShowsLiveAgent = paneLooksReady(paneCapture) || paneHasActiveTask(paneCapture);
        if (paneRunningShell && !paneShowsLiveAgent) {
          return buildReadinessResult(false, 'pane_running_shell', paneCapture, 'captured');
        }
        if (requireIdle && paneHasActiveTask(paneCapture)) {
          return buildReadinessResult(false, 'pane_has_active_task', paneCapture, 'captured');
        }
        if (requireReady && !paneLooksReady(paneCapture)) {
          return buildReadinessResult(false, 'pane_not_ready', paneCapture, 'captured');
        }
        if (normalizedRequireObservableState && !paneShowsLiveAgent) {
          return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'captured_unverified');
        }
        if (requireObservableState && !paneShowsLiveAgent) {
          return {
            ok: false,
            sent: false,
            reason: 'pane_state_unverified',
            paneTarget: target,
            paneCurrentCommand,
            paneCapture,
            exactPaneProof,
          };
        }
      }
      if (paneRunningShell && !hasCaptureEvidence) {
        return {
          ok: false,
          sent: false,
          reason: 'pane_running_shell',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
          exactPaneProof,
        };
      }
      if (normalizedRequireObservableState && !hasCaptureEvidence && !paneCurrentCommand) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'capture_empty');
      }
      return buildReadinessResult(true, 'ok', paneCapture, hasCaptureEvidence ? 'captured' : (paneCurrentCommand ? 'command_only' : 'none'));
    } catch {
      if (exactPaneIdentityProvided) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, '', 'capture_failed');
      }
      if (paneRunningShell) {
        return buildReadinessResult(false, 'pane_running_shell', '', 'capture_failed');
      }
      if (normalizedRequireObservableState) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, '', 'capture_failed');
      }
      return buildReadinessResult(true, 'ok', '', paneCurrentCommand ? 'command_only' : 'none');
    }
  }
}

export async function sendPaneInput({
  paneTarget,
  prompt,
  submitKeyPresses = 2,
  submitDelayMs = 0,
  typePrompt = true,
  queueFirstSubmit = false,
  exactPaneId = undefined,
}: any): Promise<any> {
  const target = safeString(paneTarget).trim();
  if (!target) {
    return { ok: false, sent: false, reason: 'missing_pane_target', paneTarget: '' };
  }
  const bindingFailure = exactPaneBindingFailure(target, exactPaneId);
  if (bindingFailure) return exactPaneUnavailableResult(target, bindingFailure);

  const exactPaneIdentity = safeString(exactPaneId).trim();
  let exactPaneProof: any = null;
  let expectedPanePid: number | undefined;
  const verifyExplicitPane = async () => {
    const paneProof = await verifyExactPaneLive(exactPaneIdentity, expectedPanePid);
    exactPaneProof = paneProof.proof || null;
    if (paneProof.ok && typeof paneProof.proof?.pid === 'number') expectedPanePid ??= paneProof.proof.pid;
    return paneProof;
  };
  const initialProof = await verifyExplicitPane();
  if (!initialProof.ok) return exactPaneUnavailableResult(target, initialProof);

  const normalizedSubmitKeyPresses = Number.isFinite(submitKeyPresses)
    ? Math.max(0, Math.floor(submitKeyPresses))
    : 2;
  const literalPrompt = safeString(prompt);
  const submitArgv = normalizedSubmitKeyPresses === 0
    ? [] as string[][]
    : buildSendKeysArgv({
      paneTarget: target,
      prompt: literalPrompt,
      dryRun: false,
      submitKeyPresses: normalizedSubmitKeyPresses,
    })?.submitArgv;
  if (!submitArgv) {
    return { ok: false, sent: false, reason: 'send_failed', paneTarget: target, exactPaneProof };
  }
  const pasteArgv = buildSafePasteArgv(target, literalPrompt);
  const argv = {
    typeArgv: pasteArgv.pasteBufferArgv,
    submitArgv,
    bufferName: pasteArgv.bufferName,
    setBufferArgv: pasteArgv.setBufferArgv,
    showBufferArgv: pasteArgv.showBufferArgv,
    clearComposerArgv: pasteArgv.clearComposerArgv,
    pasteBufferArgv: pasteArgv.pasteBufferArgv,
    deleteBufferArgv: pasteArgv.deleteBufferArgv,
  };

  let bufferSet = false;
  try {
    if (typePrompt) {
      try {
        await runProcess('tmux', pasteArgv.setBufferArgv, 3000);
        bufferSet = true;
      } catch (error) {
        return {
          ok: false,
          sent: false,
          reason: 'buffer_set_failed',
          paneTarget: target,
          argv,
          exactPaneProof,
          error: error instanceof Error ? error.message : safeString(error),
        };
      }
      let verifiedBuffer;
      try {
        verifiedBuffer = await runProcess('tmux', pasteArgv.showBufferArgv, 3000);
      } catch (error) {
        return {
          ok: false,
          sent: false,
          reason: 'buffer_show_failed',
          paneTarget: target,
          argv,
          exactPaneProof,
          error: error instanceof Error ? error.message : safeString(error),
        };
      }
      if (verifiedBuffer.stdout !== literalPrompt) {
        return {
          ok: false,
          sent: false,
          reason: 'buffer_verify_failed',
          paneTarget: target,
          argv,
          exactPaneProof,
          expectedBytes: literalPrompt.length,
          actualBytes: verifiedBuffer.stdout.length,
        };
      }

      const clearProof = await verifyExplicitPane();
      if (!clearProof.ok) return exactPaneUnavailableResult(target, clearProof, { argv });
      try {
        await runProcess('tmux', pasteArgv.clearComposerArgv, 3000);
      } catch (error) {
        return {
          ok: false,
          sent: false,
          reason: 'buffer_paste_failed',
          paneTarget: target,
          argv,
          exactPaneProof,
          error: error instanceof Error ? error.message : safeString(error),
        };
      }

      const pasteProof = await verifyExplicitPane();
      if (!pasteProof.ok) return exactPaneUnavailableResult(target, pasteProof, { argv });
      try {
        await runProcess('tmux', pasteArgv.pasteBufferArgv, 3000);
      } catch (error) {
        return {
          ok: false,
          sent: false,
          reason: 'buffer_paste_failed',
          paneTarget: target,
          argv,
          exactPaneProof,
          error: error instanceof Error ? error.message : safeString(error),
        };
      }
    }
    if (queueFirstSubmit && argv.submitArgv.length > 0) {
      const queueProof = await verifyExplicitPane();
      if (!queueProof.ok) return exactPaneUnavailableResult(target, queueProof, { argv });
      await runProcess('tmux', ['send-keys', '-t', target, 'Tab'], 3000);
      if (submitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      }
    }
    for (const submit of argv.submitArgv) {
      if (submitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      }
      const submitProof = await verifyExplicitPane();
      if (!submitProof.ok) return exactPaneUnavailableResult(target, submitProof, { argv });
      await runProcess('tmux', submit, 3000);
    }
    return { ok: true, sent: true, reason: 'sent', paneTarget: target, argv, exactPaneProof };
  } catch (error) {
    return {
      ok: false,
      sent: false,
      reason: 'send_failed',
      paneTarget: target,
      argv,
      exactPaneProof,
      error: error instanceof Error ? error.message : safeString(error),
    };
  } finally {
    if (bufferSet) {
      await runProcess('tmux', pasteArgv.deleteBufferArgv, 3000).catch(() => {});
    }
  }
}

export async function queuePaneInput({
  paneTarget,
  prompt,
  submitDelayMs = 80,
  exactPaneId = undefined,
}: any): Promise<any> {
  const target = safeString(paneTarget).trim();
  const exactPaneIdentity = safeString(exactPaneId).trim();
  const bindingFailure = exactPaneBindingFailure(target, exactPaneId);
  if (bindingFailure) return exactPaneUnavailableResult(target, bindingFailure);
  const sendResult = await sendPaneInput({
    paneTarget,
    prompt,
    submitKeyPresses: 0,
    exactPaneId: exactPaneIdentity,
  });
  if (!sendResult.ok) return sendResult;

  let exactPaneProof = sendResult.exactPaneProof || null;
  let expectedPanePid = typeof sendResult.exactPaneProof?.pid === 'number' ? sendResult.exactPaneProof.pid : undefined;
  const verifyExplicitPane = async () => {
    const paneProof = await verifyExactPaneLive(exactPaneIdentity, expectedPanePid);
    exactPaneProof = paneProof.proof || null;
    if (paneProof.ok && typeof paneProof.proof?.pid === 'number') expectedPanePid ??= paneProof.proof.pid;
    return paneProof;
  };
  const submitArgv = [
    ['send-keys', '-t', target, 'Tab'],
    ['send-keys', '-t', target, 'C-m'],
  ];
  const firstSubmitProof = await verifyExplicitPane();
  if (!firstSubmitProof.ok) {
    return exactPaneUnavailableResult(target, firstSubmitProof, {
      argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
    });
  }
  try {
    await runProcess('tmux', submitArgv[0], 3000);
    if (submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    const secondSubmitProof = await verifyExplicitPane();
    if (!secondSubmitProof.ok) {
      return exactPaneUnavailableResult(target, secondSubmitProof, {
        argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
      });
    }
    await runProcess('tmux', submitArgv[1], 3000);
    return {
      ok: true,
      sent: true,
      reason: 'queued',
      paneTarget: target,
      argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
      exactPaneProof,
    };
  } catch (error) {
    return {
      ok: false,
      sent: false,
      reason: 'queue_failed',
      paneTarget: target,
      argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
      exactPaneProof,
      error: error instanceof Error ? error.message : safeString(error),
    };
  }
}

export async function checkPaneReadyForTeamSendKeys(paneTarget: any, exactPaneId: any): Promise<any> {
  return evaluatePaneInjectionReadiness(paneTarget, { exactPaneId });
}
