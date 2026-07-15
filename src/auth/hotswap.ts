import { spawn } from "child_process";
import { dirname } from "path";
import { homedir } from "os";
import {
  buildPlatformCommandSpec,
  classifySpawnError,
} from "../utils/platform-command.js";
import { readAuthConfig } from "./config.js";
import { isQuotaError } from "./quota-detector.js";
import { redactAuthSecrets } from "./redact.js";
import { buildRotationPlan, nextSlotAfter } from "./rotation.js";
import { findLatestRolloutSession } from "./sessions.js";
import {
  listSlots,
  markSlotQuota,
  readAuthMetadata,
  useSlot,
} from "./storage.js";
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  mintStateAuthorityTransportCapability,
  readWorkspaceAuthorityAnchor,
  resolveStateAuthority,
  stateAuthorityTransportCapabilityForChild,
  validateStateAuthorityTransportCapability,
  withStateAuthorityTransaction,
  StateAuthorityError,
  type ResolvedStateAuthorityContext,
} from "../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../state/transport-env.js";

export interface PreparedHotswapCodexHome {
  codexHomeOverride?: string;
  sqliteHomeOverride?: string;
  projectLocalCodexHomeForCleanup?: string;
  runtimeCodexHomeForCleanup?: string;
}

export interface HotswapLifecycle {
  prepareCodexHomeForLaunch: (
    cwd: string,
    sessionId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<PreparedHotswapCodexHome>;
  preLaunch: (
    cwd: string,
    sessionId: string,
    notifyTempContract: unknown,
    codexHomeOverride: string | undefined,
    enableNotifyFallbackAuthority: boolean,
    worktreeDirty: boolean,
    authority: Readonly<ResolvedStateAuthorityContext>,
  ) => Promise<void>;

  postLaunch: (
    cwd: string,
    sessionId: string,
    codexHomeOverride: string | undefined,
    enableNotifyFallbackAuthority: boolean,
    projectLocalCodexHomeForCleanup: string | undefined,
    authority: Readonly<ResolvedStateAuthorityContext>,
  ) => Promise<void>;
  cleanupRuntimeCodexHome: (
    runtimeCodexHome: string | undefined,
    projectCodexHome: string | undefined,
    authority: Readonly<ResolvedStateAuthorityContext>,
  ) => Promise<void>;
  normalizeCodexLaunchArgs: (args: string[]) => string[];
  injectModelInstructionsBypassArgs: (
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    defaultFilePath?: string,
  ) => string[];
  sessionModelInstructionsPath: (cwd: string, sessionId: string) => string;

  resolveNotifyTempContract: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    contract: unknown;
    passthroughArgs: string[];
  };
}

export interface HotswapOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  argv: string[];
  sessionId?: string;

  lifecycle: HotswapLifecycle;
  authority: Readonly<ResolvedStateAuthorityContext>;
}

export interface CodexRunResult {
  status: number;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export function stripHotswapArg(args: string[]): string[] {
  return args.filter((arg) => arg !== "--hotswap");
}

function isAuthInvalidationError(stderr: string | undefined): boolean {
  return /token_invalidated|refresh_token_invalidated|authentication token has been invalidated/i.test(
    stderr || "",
  );
}

interface StartedCodexRun {
  completion: Promise<CodexRunResult>;
}

function startCodexDirect(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): StartedCodexRun {
  const spec = buildPlatformCommandSpec("codex", args, process.platform, env);
  const completion = new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env,
      stdio: ["inherit", "inherit", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = redactAuthSecrets(chunk.toString("utf-8"));
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const kind = classifySpawnError(error);
      if (kind === "missing") {
        reject(
          new Error("failed to launch codex: executable not found in PATH"),
        );
      } else if (kind === "blocked") {
        reject(
          new Error(
            `failed to launch codex: executable is blocked (${error.code || "blocked"})`,
          ),
        );
      } else {
        reject(error);
      }
    });
    child.on("close", (status, signal) => {
      resolve({
        status: typeof status === "number" ? status : 1,
        signal,
        stderr,
      });
    });
  });
  return { completion };
}

export function buildResumeArgsWithPreservedFlags(
  originalArgs: string[],
  sessionId: string,
): string[] {
  const preserved: string[] = [];
  for (let index = 0; index < originalArgs.length; index++) {
    const arg = originalArgs[index];
    if (arg === "--") break;
    if (
      arg === "-c" ||
      arg === "--config" ||
      arg === "--model" ||
      arg === "-m"
    ) {
      preserved.push(arg);
      const value = originalArgs[index + 1];
      if (value && !value.startsWith("-")) {
        preserved.push(value);
        index += 1;
      }
      continue;
    }
    if (
      arg.startsWith("--config=") ||
      arg.startsWith("--model=") ||
      arg === "--dangerously-bypass-approvals-and-sandbox"
    ) {
      preserved.push(arg);
    }
  }
  return ["resume", sessionId, ...preserved];
}

function codexHomeFromAuthPath(authPath: string): string {
  return dirname(authPath);
}

function hotswapSessionId(): string {
  return `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertHotswapAuthority(
  authority: Readonly<ResolvedStateAuthorityContext> | undefined,
): asserts authority is Readonly<ResolvedStateAuthorityContext> & {
  session_binding: NonNullable<
    ResolvedStateAuthorityContext["session_binding"]
  >;
} {
  const binding = authority?.session_binding;
  if (
    !authority ||
    !binding ||
    authority.generation.status !== "committed" ||
    binding.lifecycle !== "active" ||
    !Object.isFrozen(authority) ||
    !Object.isFrozen(authority.workspace_identity) ||
    !Object.isFrozen(authority.generation) ||
    !Object.isFrozen(authority.generation.workspace_identity) ||
    !Object.isFrozen(authority.generation.root_identity) ||
    !Object.isFrozen(authority.generation.root_capability) ||
    !Object.isFrozen(binding) ||
    !Object.isFrozen(binding.aliases) ||
    !Object.isFrozen(binding.aliases.current_session_aliases) ||
    !Object.isFrozen(binding.aliases.previous_session_aliases) ||
    !Object.isFrozen(binding.aliases.owner_session_aliases) ||
    !authority.authority_path ||
    !authority.generation.authority_id ||
    !authority.generation.generation_id ||
    !authority.workspace_identity.digest
  ) {
    throw new Error(
      "OMX auth hotswap requires an immutable committed state authority before auth, runtime-home, or spawn effects.",
    );
  }
}

function hotswapAuthorityMatchesCommittedContext(
  authority: Readonly<ResolvedStateAuthorityContext>,
  committed: ResolvedStateAuthorityContext,
): boolean {
  const binding = authority.session_binding;
  const committedBinding = committed.session_binding;
  return Boolean(
    binding &&
      committedBinding &&
      authority.authority_path === committed.authority_path &&
      authority.anchor_path === committed.anchor_path &&
      authority.canonical_state_root === committed.canonical_state_root &&
      authority.workspace_identity.digest ===
        committed.workspace_identity.digest &&
      JSON.stringify(authority.generation) ===
        JSON.stringify(committed.generation) &&
      binding.authority_id === committedBinding.authority_id &&
      binding.generation_id === committedBinding.generation_id &&
      binding.binding_id === committedBinding.binding_id &&
      binding.binding_revision === committedBinding.binding_revision &&
      JSON.stringify(binding) === JSON.stringify(committedBinding) &&
      binding.lifecycle === "active",
  );
}

function freezeResolvedHotswapAuthority(
  context: ResolvedStateAuthorityContext,
): Readonly<ResolvedStateAuthorityContext> {
  Object.freeze(context.workspace_identity);
  Object.freeze(context.generation.workspace_identity);
  Object.freeze(context.generation.root_identity);
  Object.freeze(context.generation.root_capability);
  Object.freeze(context.generation);
  if (context.session_binding) {
    Object.freeze(context.session_binding.aliases.current_session_aliases);
    Object.freeze(context.session_binding.aliases.previous_session_aliases);
    Object.freeze(context.session_binding.aliases.owner_session_aliases);
    Object.freeze(context.session_binding.aliases);
    Object.freeze(context.session_binding);
  }
  return Object.freeze(context);
}

interface HotswapAuthorityPin {
  authorityPath: string;
  anchorPath: string;
  authorityId: string;
  generationId: string;
  canonicalStateRoot: string;
  workspaceIdentityDigest: string;
  workspaceIdentityCanonicalPath: string;
  workspaceIdentity: string;
  rootIdentity: string;
  bindingId: string;
  bindingRevision: number;
  canonicalSessionId: string;

}

async function pinHotswapAuthority(
  authority: Readonly<ResolvedStateAuthorityContext> & {
    session_binding: NonNullable<
      ResolvedStateAuthorityContext["session_binding"]
    >;
  },
): Promise<HotswapAuthorityPin> {
  const anchor = await readWorkspaceAuthorityAnchor(
    authority.workspace_identity,
  );
  const lease = anchor?.active_lease;
  if (
    !anchor ||
    anchor.active_generation_id !== authority.generation.generation_id ||
    !lease ||
    lease.generation_id !== authority.generation.generation_id ||
    lease.binding_id !== authority.session_binding.binding_id ||
    !lease.launch_id
  ) {
    throw new Error(
      "OMX auth hotswap could not pin the active authority lease; refusing auth, runtime-home, and spawn effects.",
    );
  }
  return Object.freeze({
    authorityPath: authority.authority_path,
    anchorPath: authority.anchor_path,
    authorityId: authority.generation.authority_id,
    generationId: authority.generation.generation_id,
    canonicalStateRoot: authority.canonical_state_root,
    workspaceIdentityDigest: authority.workspace_identity.digest,
    workspaceIdentityCanonicalPath: authority.workspace_identity.canonical_path,
    workspaceIdentity: JSON.stringify(authority.workspace_identity),
    rootIdentity: JSON.stringify(authority.generation.root_identity),
    bindingId: authority.session_binding.binding_id,
    bindingRevision: authority.session_binding.binding_revision,
    canonicalSessionId: authority.session_binding.canonical_session_id,

  });
}

function hotswapCurrentAuthorityMatchesPin(
  pin: Readonly<HotswapAuthorityPin>,
  current: Readonly<ResolvedStateAuthorityContext> & {
    session_binding: NonNullable<
      ResolvedStateAuthorityContext["session_binding"]
    >;
  },
): boolean {
  const binding = current.session_binding;
  const aliases = binding.aliases;
  return (
    current.authority_path === pin.authorityPath &&
    current.anchor_path === pin.anchorPath &&
    current.canonical_state_root === pin.canonicalStateRoot &&
    current.generation.canonical_state_root === pin.canonicalStateRoot &&
    current.generation.authority_id === pin.authorityId &&
    current.generation.generation_id === pin.generationId &&
    current.workspace_identity.digest === pin.workspaceIdentityDigest &&
    current.workspace_identity.canonical_path ===
      pin.workspaceIdentityCanonicalPath &&
    JSON.stringify(current.workspace_identity) === pin.workspaceIdentity &&
    JSON.stringify(current.generation.root_identity) === pin.rootIdentity &&
    binding.authority_id === pin.authorityId &&
    binding.generation_id === pin.generationId &&
    binding.binding_id === pin.bindingId &&
    binding.binding_revision >= pin.bindingRevision &&
    binding.lifecycle === "active" &&
    (binding.canonical_session_id === pin.canonicalSessionId ||
      aliases.current_session_aliases.includes(pin.canonicalSessionId) ||
      aliases.previous_session_aliases.includes(pin.canonicalSessionId) ||
      aliases.owner_session_aliases.includes(pin.canonicalSessionId))
    );
}

async function resolveCurrentHotswapAuthority(
  pin: Readonly<HotswapAuthorityPin>,
  cwd: string,
): Promise<Readonly<ResolvedStateAuthorityContext>> {
  const resolution = await resolveStateAuthority({
    startup_cwd: pin.workspaceIdentityCanonicalPath,
    observed_cwd: cwd,
    session_id: pin.canonicalSessionId,
  });
  if (!resolution.context || !resolution.can_mutate) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      "OMX auth hotswap cannot refresh the committed state authority after pre-launch; refusing credential mutation, cleanup, and Codex spawn.",
    );
  }
  const current = freezeResolvedHotswapAuthority(resolution.context);
  assertHotswapAuthority(current);
  const anchor = await readWorkspaceAuthorityAnchor(current.workspace_identity);
  const lease = anchor?.active_lease;
  if (
    !hotswapCurrentAuthorityMatchesPin(pin, current) ||
    !anchor ||
    anchor.active_generation_id !== pin.generationId ||
    !lease ||
    lease.generation_id !== pin.generationId ||
    lease.binding_id !== pin.bindingId
  ) {
    throw new StateAuthorityError(
      AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict,
      "OMX auth hotswap authority changed outside the original immutable authority context; refusing credential mutation, cleanup, and Codex spawn.",
    );
  }
  return current;
}

async function buildValidatedHotswapTransportEnv(
  authority: Readonly<ResolvedStateAuthorityContext>,
  env: NodeJS.ProcessEnv,
  capability = stateAuthorityTransportCapabilityForChild(authority),
): Promise<NodeJS.ProcessEnv> {
  await validateStateAuthorityTransportCapability(authority, capability);
  return buildStateAuthorityTransportEnv(authority, env);
}

async function withPinnedHotswapAuthorityTransaction<T>(
  _authority: Readonly<ResolvedStateAuthorityContext>,
  pin: Readonly<HotswapAuthorityPin>,
  cwd: string,
  callback: (authority: Readonly<ResolvedStateAuthorityContext>) => Promise<T>,
): Promise<T> {
  const current = await resolveCurrentHotswapAuthority(pin, cwd);
  return await withStateAuthorityTransaction(current, async () =>
    await callback(await resolveCurrentHotswapAuthority(pin, cwd)),
  );

}

async function resolveCommittedHotswapAuthority(
  authority: Readonly<ResolvedStateAuthorityContext> | undefined,
  cwd: string,
): Promise<Readonly<ResolvedStateAuthorityContext>> {
  assertHotswapAuthority(authority);
  const resolution = await resolveStateAuthority({
    startup_cwd: authority.workspace_identity.canonical_path,
    observed_cwd: cwd,
    session_id: authority.session_binding.canonical_session_id,
  });
  if (
    !resolution.context ||
    !resolution.can_mutate ||
    !hotswapAuthorityMatchesCommittedContext(authority, resolution.context)
  ) {
    throw new Error(
      "OMX auth hotswap authority does not match the immutable committed state authority; refusing auth, runtime-home, and spawn effects.",
    );
  }
  return authority;
}

interface InitialHotswapTransportCapability {
  capability: string;
  action: "reused" | "rotated";
}

async function getOrRotateInitialHotswapTransportCapability(
  authority: Readonly<ResolvedStateAuthorityContext>,
): Promise<InitialHotswapTransportCapability> {
  try {
    const capability = stateAuthorityTransportCapabilityForChild(authority);
    await validateStateAuthorityTransportCapability(authority, capability);
    return { capability, action: "reused" };
  } catch (error) {
    if (
      !(error instanceof StateAuthorityError) ||
      error.code !== AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityExpired
    ) {
      throw error;
    }
    const minted = await mintStateAuthorityTransportCapability(authority);
    await validateStateAuthorityTransportCapability(authority, minted.capability);
    return { capability: minted.capability, action: "rotated" };
  }
}

function redactedHotswapCleanupFailure(
  stage: "post-launch" | "runtime-home",
  error: unknown,
): Error {
  return new Error(
    `OMX auth hotswap ${stage} cleanup failed: ${redactAuthSecrets(error)}`,
  );
}

function isHotswapAuthorityPinViolation(error: unknown): boolean {
  return (
    error instanceof StateAuthorityError &&
    error.code === AUTHORITY_DIAGNOSTIC_CODES.anchorRevisionConflict
  );
}


export async function runAuthHotswap(options: HotswapOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const authority = await resolveCommittedHotswapAuthority(
    options.authority,
    cwd,
  );
  assertHotswapAuthority(authority);
  const authorityPin = await pinHotswapAuthority(authority);
  const initialTransport =
    await getOrRotateInitialHotswapTransportCapability(authority);
  if (initialTransport.action === "rotated") {
    process.stderr.write(
      "[omx auth] state-authority transport capability expired; rotating before launch.\n",
    );
  }
  const env = options.env ?? process.env;
  const preLaunchAuthority = await resolveCurrentHotswapAuthority(
    authorityPin,
    cwd,
  );
  const preLaunchAuthorityEnv = await buildValidatedHotswapTransportEnv(
    preLaunchAuthority,
    env,
    initialTransport.capability,
  );
  const home = options.home ?? homedir();
  const lifecycle = options.lifecycle;
  const rawArgs = stripHotswapArg(options.argv);
  const notifyTempResult = lifecycle.resolveNotifyTempContract(
    rawArgs,
    preLaunchAuthorityEnv,
  );
  const normalizedArgs = lifecycle.normalizeCodexLaunchArgs(
    notifyTempResult.passthroughArgs.filter(
      (arg) => arg !== "--direct" && arg !== "--tmux",
    ),
  );
  const sessionId = options.sessionId ?? hotswapSessionId();

  const config = await readAuthConfig(cwd, home);
  const slots = await listSlots(home);
  if (slots.length === 0) {
    process.stderr.write(
      "[omx auth] no slots configured; run `omx auth add <slot>` first.\n",
    );
    return 1;
  }

  let prepared: PreparedHotswapCodexHome | undefined;
  let preLaunchStarted = false;
  try {
    const preparedCodexHome = await withPinnedHotswapAuthorityTransaction(
      authority,
      authorityPin,
      cwd,
      async (preparedAuthority) => {
        const preparedAuthorityEnv = await buildValidatedHotswapTransportEnv(
          preparedAuthority,
          env,
        );
        return await lifecycle.prepareCodexHomeForLaunch(
          cwd,
          sessionId,
          preparedAuthorityEnv,
        );
      },
    );
    prepared = preparedCodexHome;

    const childCodexHome =
      preparedCodexHome.codexHomeOverride ||
      (env.CODEX_HOME && env.CODEX_HOME.trim()) ||
      `${home}/.codex`;
  const liveAuthPath = `${childCodexHome}/auth.json`;
  const metadata = await readAuthMetadata(home);
  const plan = buildRotationPlan(slots, config, metadata.currentSlot);
  let currentSlot = plan.order[0];
  if (!currentSlot) {
      process.stderr.write(
        "[omx auth] no slots configured; run `omx auth add <slot>` first.\n",
      );
    return 1;
  }

  const exhausted = new Set<string>();
  let resumeArgs: string[] | null = null;
    const preLaunchAuthority = await resolveCurrentHotswapAuthority(
      authorityPin,
      cwd,
    );

    await lifecycle.preLaunch(
      cwd,
      sessionId,
      notifyTempResult.contract,
      preparedCodexHome.codexHomeOverride,
      true,
      false,
      preLaunchAuthority,
    );
    preLaunchStarted = true;
    await resolveCurrentHotswapAuthority(authorityPin, cwd);
    await withPinnedHotswapAuthorityTransaction(
      authority,
      authorityPin,
      cwd,
      async () => {
        await useSlot(currentSlot, liveAuthPath, home);
      },
    );

    for (let attempt = 0; attempt < plan.order.length; attempt++) {
      const started = await withPinnedHotswapAuthorityTransaction(
        authority,
        authorityPin,
        cwd,
        async (attemptAuthority) => {
          const authorityEnv = await buildValidatedHotswapTransportEnv(
            attemptAuthority,
            env,
          );
          const childEnv: NodeJS.ProcessEnv = {
            ...authorityEnv,
            ...(preparedCodexHome.codexHomeOverride
              ? { CODEX_HOME: preparedCodexHome.codexHomeOverride }
              : {}),
            ...(preparedCodexHome.sqliteHomeOverride
              ? { CODEX_SQLITE_HOME: preparedCodexHome.sqliteHomeOverride }
              : {}),
      };
      const attemptArgs = lifecycle.injectModelInstructionsBypassArgs(
        cwd,
        resumeArgs ?? normalizedArgs,
            childEnv,
        lifecycle.sessionModelInstructionsPath(cwd, sessionId),
      );
      process.stderr.write(`[omx auth] using slot ${currentSlot}\n`);
          return startCodexDirect(cwd, attemptArgs, childEnv);
        },
      );
      const result = await started.completion;
      if (result.status === 0) return 0;
      const authInvalid = isAuthInvalidationError(result.stderr);
      const quota = isQuotaError(
        { status: result.status, signal: result.signal, stderr: result.stderr },
        config,
      );
      if (!quota && !authInvalid) {
        return result.status || 1;
      }

      if (quota) {
        await withPinnedHotswapAuthorityTransaction(
          authority,
          authorityPin,
          cwd,
          async () => {
            await markSlotQuota(currentSlot, home);
          },
        );
      }
      exhausted.add(currentSlot);
      if (plan.mode === "manual") {
        const reason = authInvalid ? "token invalidated" : "quota detected";
        process.stderr.write(
          `[omx auth] ${reason} for slot ${currentSlot}; rotation=manual, run \`omx auth use <slot>\` or \`omx auth add ${currentSlot} --device-auth\`.\n`,
        );
        return 1;
      }

      const next = nextSlotAfter(plan.order, currentSlot, exhausted);
      if (!next) {
        process.stderr.write(
          `[omx auth] all slots exhausted or invalid: ${[...exhausted].join(", ")}\n`,
        );
        return 1;
      }
      if (authInvalid) {
        process.stderr.write(
          `[omx auth] token invalidated for slot ${currentSlot}; rotating to slot ${next}. Refresh it later with \`omx auth add ${currentSlot} --device-auth\`.\n`,
        );
        currentSlot = next;
        await withPinnedHotswapAuthorityTransaction(
          authority,
          authorityPin,
          cwd,
          async () => {
        await useSlot(currentSlot, liveAuthPath, home);
          },
        );
        continue;
      }
      const latest = await findLatestRolloutSession(
        codexHomeFromAuthPath(liveAuthPath),
        home,
      );
      if (!latest) {
        process.stderr.write(
          "[omx auth] quota detected but no Codex rollout session was found to resume.\n",
        );
        return 1;
      }
      currentSlot = next;
      await withPinnedHotswapAuthorityTransaction(
        authority,
        authorityPin,
        cwd,
        async () => {
      await useSlot(currentSlot, liveAuthPath, home);
        },
      );
      resumeArgs = buildResumeArgsWithPreservedFlags(normalizedArgs, latest.id);
      process.stderr.write(
        `[omx auth] quota detected; rotating to slot ${currentSlot} and resuming ${latest.id}\n`,
      );
    }

    process.stderr.write(
      `[omx auth] all slots exhausted: ${plan.order.join(", ")}\n`,
    );
    return 1;
  } catch (err) {
    process.stderr.write(`[omx auth] ${redactAuthSecrets(err)}\n`);
    return 1;
  } finally {
    const cleanupFailures: Error[] = [];
    if (preLaunchStarted && prepared) {
      let postLaunchAuthority: Readonly<ResolvedStateAuthorityContext> | undefined;
      try {
        postLaunchAuthority = await resolveCurrentHotswapAuthority(authorityPin, cwd);
      } catch (err) {
        if (!isHotswapAuthorityPinViolation(err)) {
          const failure = redactedHotswapCleanupFailure("post-launch", err);
          cleanupFailures.push(failure);
          process.stderr.write(`[omx auth] ${failure.message}\n`);
        }
      }
      if (postLaunchAuthority) {
        try {
          await lifecycle.postLaunch(
            cwd,
            sessionId,
            prepared.codexHomeOverride,
            true,
            prepared.projectLocalCodexHomeForCleanup,
            postLaunchAuthority,
          );
          await resolveCurrentHotswapAuthority(authorityPin, cwd);
        } catch (err) {
          const failure = redactedHotswapCleanupFailure("post-launch", err);
          cleanupFailures.push(failure);
          process.stderr.write(`[omx auth] ${failure.message}\n`);
        }
      }
    }
    let cleanupAuthority: Readonly<ResolvedStateAuthorityContext> | undefined;
    try {
      cleanupAuthority = await resolveCurrentHotswapAuthority(authorityPin, cwd);
    } catch (err) {
      if (!isHotswapAuthorityPinViolation(err)) {
        const failure = redactedHotswapCleanupFailure("runtime-home", err);
        cleanupFailures.push(failure);
        process.stderr.write(`[omx auth] ${failure.message}\n`);
      }
    }
    if (cleanupAuthority) {
      try {
        await withStateAuthorityTransaction(cleanupAuthority, async () => {
          const currentCleanupAuthority = await resolveCurrentHotswapAuthority(
            authorityPin,
            cwd,
          );
          await lifecycle.cleanupRuntimeCodexHome(
            prepared?.runtimeCodexHomeForCleanup,
            prepared?.projectLocalCodexHomeForCleanup,
            currentCleanupAuthority,
          );
        });
      } catch (err) {
        if (!isHotswapAuthorityPinViolation(err)) {
          const failure = redactedHotswapCleanupFailure("runtime-home", err);
          cleanupFailures.push(failure);
          process.stderr.write(`[omx auth] ${failure.message}\n`);
        }
      }
    }
    if (cleanupFailures.length === 1) {
      throw cleanupFailures[0];
    }
    if (cleanupFailures.length > 1) {
      throw new AggregateError(
        cleanupFailures,
        "OMX auth hotswap cleanup failed",
      );
    }
  }
}
