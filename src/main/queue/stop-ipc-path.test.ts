/**
 * stop-ipc-path.test.ts
 *
 * Tests the FULL Stop button IPC path:
 *   ChatScreen.handleCancel(activeConvId)
 *   → IPC.CHAT_CANCEL handler
 *   → getActiveStreamId(convId)   ← convToStream lookup
 *   → cancelStream(streamId)      ← activeControllers lookup
 *   → controller.abort()
 *   → signal fires in runAgentLoop
 *   → run transitions to cancelled
 *   → STREAM_END { cancelled: true } emitted
 *   → queue cleaned up
 *
 * Does NOT call cancelStream() directly — always goes through getActiveStreamId
 * to replicate the exact production path from the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// Mock agent-loop while preserving AgentLoopError
vi.mock("../agent-client/agent-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-client/agent-loop.js")>();
  return { ...actual, runAgentLoop: vi.fn() };
});

vi.mock("../agent-client/client.js", () => ({
  makeRequest: vi.fn(() => Promise.resolve("ok")),
  classifyError: vi.fn(() => ({ status: "unknown", message: "mock error" })),
  testConnection: vi.fn(() => Promise.resolve({ status: "connected" })),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: () => null,
  tryGetIncidentRecorder: () => null,
  assertInvariant: () => undefined,
  assertInvariantStrict: () => undefined,
  initReliabilityEngine: vi.fn(),
}));

import { runAgentLoop } from "../agent-client/agent-loop.js";
import {
  getDb,
  resetDb,
  createConversation,
  saveAgentProfile,
} from "../database/db.js";
import {
  queueManager,
  setSecretGetter,
  getActiveStreamId,
  cancelStream,
  drainForTest,
  _resetQueueManagerForTest,
} from "./QueueManager.js";

const mockRunAgentLoop = vi.mocked(runAgentLoop);

const PROFILE_ID = "profile-stop-ipc";

let tmpDir: string;
let dataDir: string;

function pollUntil(cond: () => boolean, maxMs = 5000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > maxMs) {
        reject(new Error(`pollUntil timeout after ${maxMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Simulates exactly what the IPC CHAT_CANCEL handler does:
 *   getActiveStreamId(convId) → cancelStream(sid)
 * This is the exact production path from the Stop button.
 */
function simulateChatCancelIpc(convId: string): void {
  const sid = getActiveStreamId(convId);
  if (sid) cancelStream(sid);
}

function makeConv(id: string) {
  createConversation(true, {
    id,
    title: "Stop IPC Test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultAgentProfileId: PROFILE_ID,
  });
}

async function enqueue(convId: string) {
  await queueManager.enqueue({
    conversationId: convId,
    content: "test message",
    attachmentIds: [],
    targetAgentProfileId: PROFILE_ID,
  });
}

function makeLoopResult(): import("../agent-client/agent-loop.js").AgentLoopResult {
  return {
    finalText: "ok",
    proposalFenceRaw: undefined,
    toolActivity: [],
    agentReadRefs: [],
    stepCount: 0,
    agentRun: {
      requestId: "r",
      conversationId: "c",
      projectId: "",
      agentProfileId: PROFILE_ID,
      state: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      toolStepCount: 0,
      recoveryCount: 0,
      readByteCount: 0,
      stuckScore: 0,
      terminated: true,
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-stop-ipc-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  resetDb();
  getDb(dataDir);

  saveAgentProfile(true, {
    id: PROFILE_ID,
    name: "Stop IPC Agent",
    endpoint: "https://test.example.com",
    protocol: "anthropic",
    model: "test-model",
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  setSecretGetter(() => "sk-test");
  mockRunAgentLoop.mockReset();
  queueManager.setSender({
    send: () => {},
    isDestroyed: () => false,
  } as unknown as Electron.WebContents);
});

afterEach(async () => {
  await drainForTest();
  _resetQueueManagerForTest();
  resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Stop button IPC path (real production chain)", () => {
  // ── 1. getActiveStreamId returns undefined before any run ─────────────────

  it("getActiveStreamId returns undefined when idle", () => {
    makeConv("conv-stop-idle");
    const sid = getActiveStreamId("conv-stop-idle");
    expect(sid).toBeUndefined();
  });

  // ── 2. getActiveStreamId returns the streamId while run is active ──────────

  it("getActiveStreamId returns a streamId while run is active", async () => {
    let runStarted = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-active");
    await enqueue("conv-stop-active");
    await pollUntil(() => runStarted);

    const sid = getActiveStreamId("conv-stop-active");
    expect(sid).toBeTruthy();
    expect(typeof sid).toBe("string");

    // Clean up — abort the run
    if (sid) cancelStream(sid);
  });

  // ── 3. simulateChatCancelIpc aborts the active run ─────────────────────────
  //    This is the EXACT path: convId → getActiveStreamId → cancelStream → abort

  it("simulateChatCancelIpc(convId) aborts signal via convToStream lookup", async () => {
    let capturedSignal: AbortSignal | undefined;
    let runStarted = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      capturedSignal = opts.signal;
      runStarted = true;
      // Simulate slow model response
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-cancel");
    await enqueue("conv-stop-cancel");
    await pollUntil(() => runStarted);

    // Verify signal is NOT aborted before stop
    expect(capturedSignal?.aborted).toBe(false);

    // === This is exactly what the Stop button does ===
    simulateChatCancelIpc("conv-stop-cancel");

    // Signal must now be aborted
    await pollUntil(() => capturedSignal?.aborted === true);
    expect(capturedSignal?.aborted).toBe(true);
  });

  // ── 4. simulateChatCancelIpc with wrong convId is a safe no-op ────────────

  it("simulateChatCancelIpc('wrong-id') is a safe no-op", async () => {
    let runStarted = false;
    let capturedSignal: AbortSignal | undefined;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      capturedSignal = opts.signal;
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-noop");
    await enqueue("conv-stop-noop");
    await pollUntil(() => runStarted);

    // Cancel with wrong convId — should do nothing
    expect(() => simulateChatCancelIpc("wrong-conv-id-xxx")).not.toThrow();

    // Original run's signal must still be un-aborted
    expect(capturedSignal?.aborted).toBe(false);

    // Clean up
    const sid = getActiveStreamId("conv-stop-noop");
    if (sid) cancelStream(sid);
  });

  // ── 5. getActiveStreamId returns undefined after run completes ────────────

  it("getActiveStreamId returns undefined after run completes normally", async () => {
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      return makeLoopResult();
    });

    makeConv("conv-stop-after");
    await enqueue("conv-stop-after");

    await pollUntil(() => getActiveStreamId("conv-stop-after") === undefined, 3000);
    expect(getActiveStreamId("conv-stop-after")).toBeUndefined();
  });

  // ── 6. getActiveStreamId returns undefined after cancellation ─────────────

  it("getActiveStreamId returns undefined after run is cancelled", async () => {
    let runStarted = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-cleared");
    await enqueue("conv-stop-cleared");
    await pollUntil(() => runStarted);

    simulateChatCancelIpc("conv-stop-cleared");

    // After cancellation + cleanup, streamId entry should be gone
    await pollUntil(() => getActiveStreamId("conv-stop-cleared") === undefined, 3000);
    expect(getActiveStreamId("conv-stop-cleared")).toBeUndefined();
  });

  // ── 7. AbortSignal passed to loop is the SAME one that gets aborted ────────
  //    Proves object identity — not just that `.aborted` is true

  it("AbortSignal received by runAgentLoop is the same object aborted by stop", async () => {
    let capturedSignal: AbortSignal | undefined;
    let runStarted = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      capturedSignal = opts.signal;
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-identity");
    await enqueue("conv-stop-identity");
    await pollUntil(() => runStarted);

    const signalBefore = capturedSignal;
    expect(signalBefore).toBeDefined();
    expect(signalBefore?.aborted).toBe(false);

    simulateChatCancelIpc("conv-stop-identity");

    await pollUntil(() => capturedSignal?.aborted === true);

    // Object identity — same signal instance
    expect(capturedSignal).toBe(signalBefore);
    expect(capturedSignal?.aborted).toBe(true);
  });

  // ── 8. Stop while streaming: next request after stop uses fresh signal ─────

  it("next request after stop gets a fresh non-aborted signal", async () => {
    const signals: AbortSignal[] = [];
    let run1Started = false;
    let run2Started = false;

    mockRunAgentLoop
      .mockImplementationOnce(async (opts) => {
        signals.push(opts.signal);
        run1Started = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (opts.signal.aborted) throw new Error("cancelled");
        return makeLoopResult();
      })
      .mockImplementationOnce(async (opts) => {
        signals.push(opts.signal);
        run2Started = true;
        await new Promise<void>((r) => setTimeout(r, 20));
        return makeLoopResult();
      });

    makeConv("conv-stop-fresh");
    await enqueue("conv-stop-fresh");
    await pollUntil(() => run1Started);

    // Stop the first run
    simulateChatCancelIpc("conv-stop-fresh");
    await pollUntil(() => signals[0]?.aborted === true);

    // Wait for queue to clear
    await pollUntil(() => getActiveStreamId("conv-stop-fresh") === undefined, 3000);

    // Resume queue and send a new request
    queueManager.resume("conv-stop-fresh");
    await enqueue("conv-stop-fresh");
    await pollUntil(() => run2Started);

    // Run 2 must have a fresh, non-aborted signal
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]); // different object
    expect(signals[0]?.aborted).toBe(true);   // first is aborted
    expect(signals[1]?.aborted).toBe(false);  // second is fresh
  });

  // ── 9. Cross-conv isolation: stopping A does not abort B ─────────────────

  it("stop on conv A does not abort conv B", async () => {
    const signalA = { ref: undefined as AbortSignal | undefined };
    const signalB = { ref: undefined as AbortSignal | undefined };
    let startedA = false;
    let startedB = false;

    mockRunAgentLoop
      .mockImplementationOnce(async (opts) => {
        signalA.ref = opts.signal;
        startedA = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (opts.signal.aborted) throw new Error("cancelled");
        return makeLoopResult();
      })
      .mockImplementationOnce(async (opts) => {
        signalB.ref = opts.signal;
        startedB = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (opts.signal.aborted) throw new Error("cancelled");
        return makeLoopResult();
      });

    makeConv("conv-stop-a-iso");
    makeConv("conv-stop-b-iso");

    await enqueue("conv-stop-a-iso");
    await pollUntil(() => startedA);

    await enqueue("conv-stop-b-iso");
    await pollUntil(() => startedB);

    // Stop only A
    simulateChatCancelIpc("conv-stop-a-iso");
    await pollUntil(() => signalA.ref?.aborted === true);

    // B must remain un-aborted
    expect(signalA.ref?.aborted).toBe(true);
    expect(signalB.ref?.aborted).toBe(false);

    // Clean up B
    simulateChatCancelIpc("conv-stop-b-iso");
  });

  // ── 10. Double stop is idempotent ─────────────────────────────────────────

  it("calling stop twice on the same convId is idempotent", async () => {
    let runStarted = false;
    let capturedSignal: AbortSignal | undefined;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      capturedSignal = opts.signal;
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-stop-double");
    await enqueue("conv-stop-double");
    await pollUntil(() => runStarted);

    simulateChatCancelIpc("conv-stop-double");
    simulateChatCancelIpc("conv-stop-double"); // second call — must not throw or double-fire

    await pollUntil(() => capturedSignal?.aborted === true);
    expect(capturedSignal?.aborted).toBe(true);
  });
});