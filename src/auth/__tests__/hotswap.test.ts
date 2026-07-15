import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthHotswap, type HotswapLifecycle } from "../hotswap.js";
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
  stateAuthorityTransportCapabilityForChild,
  validateStateAuthorityTransportCapability,
} from "../../state/authority.js";

function sessionPointerAbort(cwd: string): Error {
  return Object.assign(new Error("selected pointer root is unavailable"), {
    name: "SessionPointerLaunchAbort",
    committed: false,
    cwd,
    code: "session_pointer_context_failure",
    operation: "pointer-context-resolve",
    attemptedRootSource: "cwd-default",
    reason: "selected pointer root is unavailable",
  });
}

function lifecycle(overrides: Partial<HotswapLifecycle> = {}): HotswapLifecycle {
  return {
    prepareCodexHomeForLaunch: async () => ({}),
    preLaunch: async () => {},
    postLaunch: async () => {},
    cleanupRuntimeCodexHome: async () => {},
    normalizeCodexLaunchArgs: (args) => args,
    injectModelInstructionsBypassArgs: (_cwd, args) => args,
    sessionModelInstructionsPath: (cwd, sessionId) => join(cwd, `${sessionId}.md`),
    resolveNotifyTempContract: (args) => ({
      contract: { active: false },
      passthroughArgs: args,
    }),
    ...overrides,
  };
}

async function committedHotswapAuthority(cwd: string, sessionId: string) {
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `${sessionId}-launch`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  Object.freeze(authority.workspace_identity);
  Object.freeze(authority.generation.workspace_identity);
  Object.freeze(authority.generation.root_identity);
  Object.freeze(authority.generation.root_capability);
  Object.freeze(authority.generation);
  if (authority.session_binding) {
    Object.freeze(authority.session_binding.aliases.current_session_aliases);
    Object.freeze(authority.session_binding.aliases.previous_session_aliases);
    Object.freeze(authority.session_binding.aliases.owner_session_aliases);
    Object.freeze(authority.session_binding.aliases);
    Object.freeze(authority.session_binding);
  }
  return Object.freeze(authority);
}

async function writeAuthSlot(home: string, slot = "first"): Promise<string> {
  const authDir = join(home, ".omx", "auth");
  const slotPath = join(authDir, `${slot}.json`);
  await mkdir(authDir, { recursive: true });
  await writeFile(slotPath, '{"access_token":"slot-secret"}\n');
  await writeFile(
    join(authDir, "slots.json"),
    JSON.stringify({
      version: 1,
      currentSlot: slot,
      slots: [{ slot, createdAt: "now", updatedAt: "now" }],
    }),
  );
  return slotPath;
}

async function writeSuccessfulCodex(cwd: string): Promise<string> {
  const binDir = join(cwd, "bin");
  const codexPath = join(binDir, "codex");
  await mkdir(binDir, { recursive: true });
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o755);
  return binDir;
}

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    writes,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

async function secureTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  await chmod(path, 0o700);
  return path;
}



describe("auth hotswap pointer abort lifecycle", () => {
  it("skips the initial slot mutation and postLaunch for a typed pointer abort", async () => {
    const cwd = await secureTempDir("omx-hotswap-pointer-abort-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const liveAuthPath = join(runtimeHome, "auth.json");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      await writeAuthSlot(home);
      await mkdir(runtimeHome, { recursive: true });
      await writeFile(liveAuthPath, '{"access_token":"live-sentinel"}\n');

      const status = await runAuthHotswap({
        cwd,
        home,
        env: { CODEX_HOME: runtimeHome },
        argv: [],
        authority: await committedHotswapAuthority(cwd, "hotswap-pointer-abort"),
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            throw sessionPointerAbort(cwd);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(postLaunchCalls, 0);
      assert.equal(cleanupCalls, 1);
      assert.equal(
        await readFile(liveAuthPath, "utf-8"),
        '{"access_token":"live-sentinel"}\n',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips postLaunch but runs runtime cleanup when ordinary preLaunch throws before slot mutation", async () => {
    const cwd = await secureTempDir("omx-hotswap-pre-launch-failure-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const liveAuthPath = join(runtimeHome, "auth.json");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      await writeAuthSlot(home);
      await mkdir(runtimeHome, { recursive: true });
      await writeFile(liveAuthPath, '{"access_token":"live-sentinel"}\n');

      const status = await runAuthHotswap({
        cwd,
        home,
        env: { CODEX_HOME: runtimeHome },
        argv: [],
        authority: await committedHotswapAuthority(cwd, "hotswap-pre-launch-failure"),
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            throw new Error("ordinary pre-launch failure");
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(postLaunchCalls, 0);
      assert.equal(cleanupCalls, 1);
      assert.equal(
        await readFile(liveAuthPath, "utf-8"),
        '{"access_token":"live-sentinel"}\n',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs postLaunch and runtime cleanup after a successful preLaunch then initial useSlot failure", async () => {
    const cwd = await secureTempDir("omx-hotswap-use-slot-failure-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      const slotPath = await writeAuthSlot(home);

      const status = await runAuthHotswap({
        cwd,
        home,
        env: { CODEX_HOME: runtimeHome },
        argv: [],
        authority: await committedHotswapAuthority(cwd, "hotswap-use-slot-failure"),
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            await rm(slotPath);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(postLaunchCalls, 1);
      assert.equal(cleanupCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs postLaunch and runtime cleanup after a later rotation useSlot failure", async () => {
    const cwd = await secureTempDir("omx-hotswap-rotation-use-slot-failure-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const binDir = join(cwd, "bin");
    const codexLog = join(cwd, "codex.log");
    const secondSlotPath = join(home, ".omx", "auth", "second.json");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      await writeAuthSlot(home);
      await writeFile(secondSlotPath, '{"access_token":"second-secret"}\n');
      await writeFile(
        join(home, ".omx", "auth", "slots.json"),
        JSON.stringify({
          version: 1,
          currentSlot: "first",
          slots: [
            { slot: "first", createdAt: "now", updatedAt: "now" },
            { slot: "second", createdAt: "now", updatedAt: "now" },
          ],
        }),
      );
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(binDir, "codex"),
        `#!/bin/sh\nprintf 'spawned\\n' >> ${JSON.stringify(codexLog)}\necho token_invalidated >&2\nexit 1\n`,
      );
      await chmod(join(binDir, "codex"), 0o755);

      const status = await runAuthHotswap({
        cwd,
        home,
        env: {
          CODEX_HOME: runtimeHome,
          PATH: `${binDir}:/usr/bin:/bin`,
        },
        argv: [],
        authority: await committedHotswapAuthority(cwd, "hotswap-rotation-failure"),
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            await rm(secondSlotPath);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(await readFile(codexLog, "utf-8"), "spawned\n");
      assert.equal(postLaunchCalls, 1);
      assert.equal(cleanupCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("auth hotswap cleanup failures", () => {
  it("fails closed after postLaunch cleanup fails and still runs runtime-home cleanup", async () => {
    const cwd = await secureTempDir("omx-hotswap-post-launch-cleanup-failure-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const stderr = captureStderr();
    const cleanupStages: string[] = [];
    try {
      await writeAuthSlot(home);
      const binDir = await writeSuccessfulCodex(cwd);
      const authority = await committedHotswapAuthority(
        cwd,
        "hotswap-post-launch-cleanup-failure",
      );

      await assert.rejects(
        () =>
          runAuthHotswap({
            cwd,
            home,
            env: { CODEX_HOME: runtimeHome, PATH: `${binDir}:/usr/bin:/bin` },
            argv: [],
            authority,
            lifecycle: lifecycle({
              prepareCodexHomeForLaunch: async () => ({
                codexHomeOverride: runtimeHome,
                runtimeCodexHomeForCleanup: runtimeHome,
              }),
              postLaunch: async () => {
                cleanupStages.push("post-launch");
                throw new Error("access_token=post-launch-cleanup-secret");
              },
              cleanupRuntimeCodexHome: async () => {
                cleanupStages.push("runtime-home");
              },
            }),
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /post-launch cleanup failed/);
          assert.match(error.message, /\[REDACTED\]/);
          assert.doesNotMatch(error.message, /post-launch-cleanup-secret/);
          return true;
        },
      );
      assert.deepEqual(cleanupStages, ["post-launch", "runtime-home"]);
      assert.match(stderr.writes.join(""), /\[REDACTED\]/);
      assert.doesNotMatch(stderr.writes.join(""), /post-launch-cleanup-secret/);
    } finally {
      stderr.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves both redacted cleanup failures after a successful Codex child", async () => {
    const cwd = await secureTempDir("omx-hotswap-aggregate-cleanup-failure-");
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const stderr = captureStderr();
    const cleanupStages: string[] = [];
    try {
      await writeAuthSlot(home);
      const binDir = await writeSuccessfulCodex(cwd);
      const authority = await committedHotswapAuthority(
        cwd,
        "hotswap-aggregate-cleanup-failure",
      );

      await assert.rejects(
        () =>
          runAuthHotswap({
            cwd,
            home,
            env: { CODEX_HOME: runtimeHome, PATH: `${binDir}:/usr/bin:/bin` },
            argv: [],
            authority,
            lifecycle: lifecycle({
              prepareCodexHomeForLaunch: async () => ({
                codexHomeOverride: runtimeHome,
                runtimeCodexHomeForCleanup: runtimeHome,
              }),
              postLaunch: async () => {
                cleanupStages.push("post-launch");
                throw new Error("access_token=post-launch-cleanup-secret");
              },
              cleanupRuntimeCodexHome: async () => {
                cleanupStages.push("runtime-home");
                throw new Error("Bearer runtime-home-cleanup-secret");
              },
            }),
          }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          for (const cleanupError of error.errors) {
            assert.match(String(cleanupError), /\[REDACTED\]/);
            assert.doesNotMatch(String(cleanupError), /post-launch-cleanup-secret/);
            assert.doesNotMatch(String(cleanupError), /runtime-home-cleanup-secret/);
          }
          return true;
        },
      );
      assert.deepEqual(cleanupStages, ["post-launch", "runtime-home"]);
      assert.match(stderr.writes.join(""), /\[REDACTED\]/);
      assert.doesNotMatch(stderr.writes.join(""), /post-launch-cleanup-secret/);
      assert.doesNotMatch(stderr.writes.join(""), /runtime-home-cleanup-secret/);
    } finally {
      stderr.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("auth hotswap initial transport capability", () => {
  it("reuses a valid initial capability for preLaunch transport", async () => {
    const cwd = await secureTempDir("omx-hotswap-transport-reuse-");
    const home = join(cwd, "home");
    try {
      await writeAuthSlot(home);
      const authority = await committedHotswapAuthority(cwd, "hotswap-transport-reuse");
      const initialCapability = stateAuthorityTransportCapabilityForChild(authority);
      let preparedCapability: string | undefined;

      const status = await runAuthHotswap({
        cwd,
        home,
        argv: [],
        authority,
        lifecycle: lifecycle({
          resolveNotifyTempContract: (args, env) => {
            preparedCapability = env.OMX_STATE_AUTHORITY_CAPABILITY;
            return { contract: { active: false }, passthroughArgs: args };
          },
          preLaunch: async () => {
            throw new Error("stop after initial transport preparation");
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(preparedCapability, initialCapability);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rotates an expired initial capability before preLaunch transport publication", async () => {
    const cwd = await secureTempDir("omx-hotswap-transport-rotate-");
    const home = join(cwd, "home");
    try {
      await writeAuthSlot(home);
      const authority = await committedHotswapAuthority(cwd, "hotswap-transport-rotate");
      const expired = await mintStateAuthorityTransportCapability(authority, {
        ttl_ms: 1,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      let preparedCapability: string | undefined;

      const status = await runAuthHotswap({
        cwd,
        home,
        argv: [],
        authority,
        lifecycle: lifecycle({
          resolveNotifyTempContract: (args, env) => {
            preparedCapability = env.OMX_STATE_AUTHORITY_CAPABILITY;
            return { contract: { active: false }, passthroughArgs: args };
          },
          preLaunch: async () => {
            throw new Error("stop after initial transport rotation");
          },
        }),
      });

      assert.equal(status, 1);
      assert.notEqual(preparedCapability, expired.capability);
      assert.ok(preparedCapability);
      await validateStateAuthorityTransportCapability(authority, preparedCapability);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed without lifecycle effects for a non-expiration transport validation error", async () => {
    const cwd = await secureTempDir("omx-hotswap-transport-invalid-");
    const home = join(cwd, "home");
    try {
      await writeAuthSlot(home);
      const authority = await committedHotswapAuthority(cwd, "hotswap-transport-invalid");
      const anchor = JSON.parse(await readFile(authority.anchor_path, "utf-8")) as {
        transport_capability?: { capability_digest: string };
      };
      if (!anchor.transport_capability) {
        throw new Error("test setup requires an active transport capability");
      }
      anchor.transport_capability.capability_digest = "f".repeat(64);
      await writeFile(authority.anchor_path, `${JSON.stringify(anchor, null, 2)}\n`);
      let lifecycleEffects = 0;

      await assert.rejects(
        () =>
          runAuthHotswap({
            cwd,
            home,
            argv: [],
            authority,
            lifecycle: lifecycle({
              prepareCodexHomeForLaunch: async () => {
                lifecycleEffects += 1;
                return {};
              },
              preLaunch: async () => {
                lifecycleEffects += 1;
              },
              cleanupRuntimeCodexHome: async () => {
                lifecycleEffects += 1;
              },
            }),
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === AUTHORITY_DIAGNOSTIC_CODES.transportCapabilityInvalid,
      );
      assert.equal(lifecycleEffects, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
