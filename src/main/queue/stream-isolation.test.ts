/**
 * stream-isolation.test.ts — Stream ID isolation for concurrent requests
 *
 * Verifies:
 * - Each enqueued item gets a unique streamId
 * - cancelStream for non-existent ID is a safe no-op
 * - getActiveStreamId returns null when idle and non-null during run
 * - getActiveStreamId returns null after run completes
 * - cancelStream aborts an in-progress run
 * - Two convs running concurrently have independent stream IDs
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
  cancelStream,
  getActiveStreamId,
  drainForTest,
  _resetQueueManagerForTest,
} from "./QueueManager.js";

const mockRunAgentLoop = vi.mocked(runAgentLoop);

const PROFILE_ID = "profile-stream-iso";

let tmpDir: string;
let dataDir: string;

function pollUntil(cond: () => boolean, maxMs = 3000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > maxMs) { reject(new Error("pollUntil timeout")); return; }
      setTimeout(check, intervalMs);
    };
    check();
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
      agentProfileId: "p",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-stream-iso-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  resetDb();
  getDb(dataDir);

  saveAgentProfile(true, {
    id: PROFILE_ID,
    name: "Stream ISO Agent",
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

function makeConv(id: string) {
  createConversation(true, {
    id,
    title: "Test conv",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultAgentProfileId: PROFILE_ID,
  });
}

async function enqueue(convId: string) {
  await queueManager.enqueue({
    conversationId: convId,
    content: "test",
    attachmentIds: [],
    targetAgentProfileId: PROFILE_ID,
  });
}

describe("Stream ID isolation", () => {
  // ── 1. Each item gets a unique streamId ───────────────────────────────────

  it("two sequential items in same conv get different streamIds", async () => {
    const streamIds: string[] = [];
    let itemsProcessed = 0;

    mockRunAgentLoop
      .mockImplementationOnce(async () => {
        const sid = getActiveStreamId("conv-iso-seq");
        if (sid) streamIds.push(sid);
        itemsProcessed++;
        return makeLoopResult();
      })
      .mockImplementationOnce(async () => {
        const sid = getActiveStreamId("conv-iso-seq");
        if (sid) streamIds.push(sid);
        itemsProcessed++;
        return makeLoopResult();
      });

    makeConv("conv-iso-seq");
    await enqueue("conv-iso-seq");
    await enqueue("conv-iso-seq");

    await pollUntil(() => itemsProcessed === 2);

    expect(streamIds).toHaveLength(2);
    expect(streamIds[0]).not.toBe(streamIds[1]);
    expect(streamIds[0]).toBeTruthy();
    expect(streamIds[1]).toBeTruthy();
  });

  // ── 2. cancelStream for non-existent ID is a safe no-op ──────────────────

  it("cancelStream('nonexistent') does not throw", () => {
    expect(() => cancelStream("nonexistent-stream-id-xyz")).not.toThrow();
  });

  // ── 3. getActiveStreamId returns null when idle ───────────────────────────

  it("getActiveStreamId returns null when no run is active for a conv", () => {
    makeConv("conv-idle-iso");
    const sid = getActiveStreamId("conv-idle-iso");
    expect(sid == null).toBe(true);
  });

  // ── 4. getActiveStreamId returns a non-null streamId during run ───────────

  it("getActiveStreamId returns a non-null streamId while run is active", async () => {
    let capturedId: string | undefined = undefined;
    let ran = false;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      capturedId = getActiveStreamId("conv-active-iso");
      ran = true;
      return makeLoopResult();
    });

    makeConv("conv-active-iso");
    await enqueue("conv-active-iso");

    await pollUntil(() => ran);

    expect(capturedId).not.toBeNull();
    expect(typeof capturedId).toBe("string");
  });

  // ── 5. getActiveStreamId returns null after run completes ────────────────

  it("getActiveStreamId returns null after run completes", async () => {
    let ran = false;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      ran = true;
      return makeLoopResult();
    });

    makeConv("conv-done-iso");
    await enqueue("conv-done-iso");

    await pollUntil(() => ran);
    await drainForTest();

    const sid = getActiveStreamId("conv-done-iso");
    expect(sid == null).toBe(true);
  });

  // ── 6. cancelStream cancels an in-progress run ───────────────────────────

  it("cancelStream aborts the active run via AbortSignal", async () => {
    let abortSignal: AbortSignal | undefined;
    let runStarted = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      abortSignal = opts.signal;
      runStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      if (opts.signal.aborted) throw new Error("cancelled");
      return makeLoopResult();
    });

    makeConv("conv-cancel-iso");
    await enqueue("conv-cancel-iso");

    await pollUntil(() => runStarted);

    const sid = getActiveStreamId("conv-cancel-iso");
    expect(sid).toBeTruthy();
    if (sid) cancelStream(sid);

    await pollUntil(() => abortSignal?.aborted === true);
    expect(abortSignal?.aborted).toBe(true);
  });

  // ── 7. Two different convs have independent active stream IDs ─────────────

  it("concurrent runs in different convs have independent stream IDs", async () => {
    const ids: Record<string, string | undefined> = {};
    let ranA = false;
    let ranB = false;

    mockRunAgentLoop
      .mockImplementationOnce(async () => {
        ids["A"] = getActiveStreamId("conv-a-iso");
        ranA = true;
        await new Promise<void>((r) => setTimeout(r, 30));
        return makeLoopResult();
      })
      .mockImplementationOnce(async () => {
        ids["B"] = getActiveStreamId("conv-b-iso");
        ranB = true;
        return makeLoopResult();
      });

    makeConv("conv-a-iso");
    makeConv("conv-b-iso");
    await enqueue("conv-a-iso");
    await enqueue("conv-b-iso");

    await pollUntil(() => ranA && ranB);

    if (ids["A"] && ids["B"]) {
      expect(ids["A"]).not.toBe(ids["B"]);
    }
    expect(ids["A"]).toBeTruthy();
    expect(ids["B"]).toBeTruthy();
  });
});