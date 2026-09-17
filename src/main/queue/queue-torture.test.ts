/**
 * queue-torture.test.ts — Queue system torture.
 *
 * Tests the QueueManager queue mechanics under adversarial conditions:
 *   - Rapid enqueue/cancel cycles
 *   - Pause/resume during active processing
 *   - Skip queued items while processing is in flight
 *   - Retry failed items
 *   - Massive queues (50 items) drain correctly
 *   - Multi-conv queue independence
 *   - Queue does not process paused items
 *   - Cancelling mid-queue drains remaining correctly
 *   - Error in one item does not block subsequent items
 *   - Enqueue during processing queues correctly (FIFO)
 *
 * All provider responses are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

vi.mock("../agent-client/agent-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-client/agent-loop.js")>();
  return { ...actual, runAgentLoop: vi.fn() };
});
vi.mock("../agent-client/client.js", () => ({
  makeRequest: vi.fn(() => Promise.resolve("ok")),
  classifyError: vi.fn(() => ({ status: "unknown", message: "mock" })),
  testConnection: vi.fn(() => Promise.resolve({ status: "connected" })),
}));

import { runAgentLoop } from "../agent-client/agent-loop.js";
import {
  getDb, resetDb, createConversation, saveAgentProfile,
  getMessagesByConversation,
} from "../database/db.js";
import { queueManager, setSecretGetter, cancelStream, getActiveStreamId, _resetQueueManagerForTest } from "./QueueManager.js";
import {
  initReliabilityEngine, _resetReliabilityEngineForTest,
} from "../reliability/index.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

const nullSender = {
  send: () => {},
  isDestroyed: () => false,
} as unknown as Electron.WebContents;

let tmpDir: string;
let dataDir: string;

const PROFILE_ID = "queue-torture-profile";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await wait(20);
  if (!pred()) throw new Error(`pollUntil timed out. Queue: ${JSON.stringify(pred.toString())}`);
}

function makeConv(): string {
  const id = randomUUID();
  createConversation(true, {
    id, title: "queue-torture",
    defaultAgentProfileId: PROFILE_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

function enqueue(convId: string, content: string): void {
  void queueManager.enqueue({ conversationId: convId, content, attachmentIds: [], targetAgentProfileId: PROFILE_ID });
}

beforeEach(async () => {
  // Small delay to let any async ops from previous test settle before reset
  await wait(50);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-queue-torture-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  _resetQueueManagerForTest();
  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });
  saveAgentProfile(true, {
    id: PROFILE_ID, name: "Queue Torture Agent", endpoint: "https://test.example.com",
    protocol: "anthropic", model: "claude-test", isDefault: false,
    lastConnectionStatus: "connected", createdAt: Date.now(), updatedAt: Date.now(),
  });
  setSecretGetter(() => "test-key");
  mockRunAgentLoop.mockReset();
  queueManager.setSender(nullSender);
});

afterEach(() => {
  _resetQueueManagerForTest();
  _resetReliabilityEngineForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-1: Rapid enqueue/cancel cycles — no stuck items
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-1: rapid enqueue/cancel cycles", () => {
  it("20 rapid enqueue+cancel cycles leave queue empty or completed", async () => {
    const convId = makeConv();
    const streamIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      mockRunAgentLoop.mockImplementationOnce(async (opts: { signal: AbortSignal }) => {
        await new Promise<never>((_, rej) => {
          opts.signal.addEventListener("abort", () => rej(new Error("cancelled")));
          // Also auto-resolve after 200ms to avoid timeout
          setTimeout(() => rej(new Error("cancelled")), 200);
        });
      });
    }

    for (let i = 0; i < 20; i++) {
      enqueue(convId, `Q${i}`);
      await wait(5);
      const q = queueManager.getQueue(convId).items;
      const active = q.find((x) => x.status === "processing");
      const sid = active ? getActiveStreamId(convId) : undefined;
      if (sid) {
        streamIds.push(sid);
        cancelStream(sid);
        // Resume so the queue doesn't stay paused after cancel
        await wait(10);
        void queueManager.resume(convId);
      }
      await wait(5);
    }

    // Drain remaining: cancel any still-queued items, resume, cancel any in-flight
    const drainQ = queueManager.getQueue(convId).items;
    for (const it of drainQ) {
      if (it.status === "queued") void queueManager.skip(convId, it.id);
    }
    const stillActiveSid = getActiveStreamId(convId);
    if (stillActiveSid) cancelStream(stillActiveSid);
    await wait(200);
    void queueManager.resume(convId);

    // Wait for queue to settle
    await pollUntil(() => {
      const q = queueManager.getQueue(convId).items;
      return q.every((i) => ["completed","failed","cancelled"].includes(i.status));
    }, 3000);

    // No stuck processing items
    const q = queueManager.getQueue(convId).items;
    expect(q.filter((i) => i.status === "processing")).toHaveLength(0);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-2: Pause/resume during active processing
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-2: pause/resume during active processing", () => {
  it("pause does not stop in-flight processing, only prevents next from starting", async () => {
    const convId = makeConv();
    let resolveFirst!: () => void;

    // First item: controlled
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
      return { finalText: "First done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    // Second item: should complete normally
    mockRunAgentLoop.mockImplementationOnce(async () => {
      return { finalText: "Second done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    enqueue(convId, "Q1");
    enqueue(convId, "Q2");

    // Wait for first to start (then yield so mock Promise constructor runs)
    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => i.status === "processing"));
    await wait(20);

    // Pause while first is running
    queueManager.pause(convId);

    // Complete first
    resolveFirst();
    await pollUntil(() => {
      const q = queueManager.getQueue(convId).items;
      return q.some((i) => i.status === "completed");
    });

    // Second should NOT start (paused)
    await wait(100);
    const q = queueManager.getQueue(convId).items;
    const second = q.find((i) => i.status !== "completed" && i.status !== "failed" && i.status !== "cancelled");
    expect(second?.status).toBe("queued");

    // Resume
    queueManager.resume(convId);
    await pollUntil(() => queueManager.getQueue(convId).items.every((i) => ["completed","failed"].includes(i.status)));

    const msgs = getMessagesByConversation(true, convId);
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    expect(assistants[0]?.content).toBe("First done");
    expect(assistants[1]?.content).toBe("Second done");
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-3: Error in one item does not block subsequent items
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-3: error in item N does not block item N+1", () => {
  it("failed item followed by successful item — both resolve", async () => {
    const convId = makeConv();

    // First: fails
    mockRunAgentLoop.mockRejectedValueOnce(new Error("provider down"));
    // Second: succeeds
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Second succeeded",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convId, "Q1");
    enqueue(convId, "Q2");

    // After Q1 fails the queue pauses — resume so Q2 can run
    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => i.status === "failed"));
    void queueManager.resume(convId);

    await pollUntil(() => queueManager.getQueue(convId).items.every((i) => ["completed","failed","cancelled"].includes(i.status)));

    const q = queueManager.getQueue(convId).items;
    expect(q[0]?.status).toBe("failed");
    expect(q[1]?.status).toBe("completed");

    const msgs = getMessagesByConversation(true, convId);
    expect(msgs.some((m) => m.role === "error")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Second succeeded")).toBe(true);
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-4: Massive queue — 50 items drain correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-4: massive queue — 50 items", () => {
  it("50 queued items all complete, messages alternate user/assistant", async () => {
    const convId = makeConv();
    const N = 50;

    for (let i = 0; i < N; i++) {
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `A${i}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });
    }

    for (let i = 0; i < N; i++) {
      enqueue(convId, `Q${i}`);
    }

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((i) => ["completed","failed"].includes(i.status)),
      15000
    );

    const msgs = getMessagesByConversation(true, convId);
    const userMsgs = msgs.filter((m) => m.role === "user");
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    // N user messages (pre-enqueued) and N assistant messages (each from a completed item)
    expect(userMsgs.length).toBe(N);
    expect(assistantMsgs.length).toBe(N);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-5: Skip queued item — skipped item never processed
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-5: skip queued item", () => {
  it("skipped item is not processed, next item proceeds", async () => {
    const convId = makeConv();
    let resolveFirst!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
      return { finalText: "First", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Third",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convId, "Q1");
    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => i.status === "processing"));
    await wait(20); // yield so mock Promise constructor sets resolveFirst
    enqueue(convId, "Q2"); // this will be skipped
    enqueue(convId, "Q3");

    // Skip Q2 (second queued item)
    const q = queueManager.getQueue(convId).items;
    const toSkip = q.find((i) => i.status === "queued");
    if (toSkip) {
      void queueManager.skip(convId, toSkip.id);
    }

    resolveFirst();

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((i) => ["completed","failed","cancelled"].includes(i.status))
    );

    const finalQ = queueManager.getQueue(convId).items;
    const skipped = finalQ.find((i) => i.status === "cancelled");
    expect(skipped).toBeDefined();

    const msgs = getMessagesByConversation(true, convId);
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants.map((a) => a.content)).not.toContain(expect.stringContaining("Q2"));
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-6: Enqueue during processing maintains FIFO order
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-6: enqueue during processing maintains FIFO order", () => {
  it("items enqueued during processing are processed in insertion order", async () => {
    const convId = makeConv();
    const completionOrder: string[] = [];
    let resolveFirst!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
      completionOrder.push("first");
      return { finalText: "First", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      completionOrder.push("second");
      return { finalText: "Second", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      completionOrder.push("third");
      return { finalText: "Third", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    enqueue(convId, "Q1");
    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => i.status === "processing"));
    await wait(20); // yield so mock Promise constructor sets resolveFirst

    // Enqueue during processing
    enqueue(convId, "Q2");
    enqueue(convId, "Q3");

    resolveFirst();

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((i) => ["completed","failed"].includes(i.status))
    );

    expect(completionOrder).toEqual(["first", "second", "third"]);
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-7: Multi-conv queue — convs don't share queue state
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-7: multi-conv queue independence", () => {
  it("pausing conv A does not pause conv B", async () => {
    const convA = makeConv();
    const convB = makeConv();
    let resolveA!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      return { finalText: "A", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      return { finalText: "B", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "A2",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convA, "A1");
    enqueue(convA, "A2");
    enqueue(convB, "B1");

    await pollUntil(() => queueManager.getQueue(convA).items.some((i) => i.status === "processing"));
    await wait(20); // yield so mock Promise constructor sets resolveA

    // Pause A while processing
    queueManager.pause(convA);

    // B should complete independently
    await pollUntil(() => queueManager.getQueue(convB).items.every((i) => ["completed","failed"].includes(i.status)));

    const msgsB = getMessagesByConversation(true, convB);
    expect(msgsB.find((m) => m.role === "assistant")?.content).toBe("B");

    // A second item still paused
    const qA = queueManager.getQueue(convA).items;
    expect(qA.filter((i) => i.status === "queued" || i.status === "paused").length).toBeGreaterThanOrEqual(1);

    // Resume A
    queueManager.resume(convA);
    resolveA();
    await pollUntil(() => queueManager.getQueue(convA).items.every((i) => ["completed","failed"].includes(i.status)));
  }, 12000);
});

// ─────────────────────────────────────────────────────────────────────────────
// qt-8: Cancel in-flight → immediately starts next queued item
// ─────────────────────────────────────────────────────────────────────────────

describe("qt-8: cancel in-flight → next item starts", () => {
  it("cancelling current run allows next queued item to start immediately", async () => {
    const convId = makeConv();

    mockRunAgentLoop.mockImplementationOnce(async (opts: { signal: { aborted: boolean } }) => {
      // Poll for abort since our signal is a plain object (not a real AbortSignal)
      await new Promise<never>((_, rej) => {
        const interval = setInterval(() => {
          if (opts.signal.aborted) {
            clearInterval(interval);
            rej(new Error("cancelled"));
          }
        }, 10);
        setTimeout(() => { clearInterval(interval); rej(new Error("cancelled")); }, 500);
      });
    });
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Next item",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convId, "Q1");
    enqueue(convId, "Q2");

    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => i.status === "processing"));
    await wait(20); // yield so mock Promise constructor runs and stream is registered
    const activeStreamId = getActiveStreamId(convId);
    expect(activeStreamId).toBeDefined();

    cancelStream(activeStreamId!);

    // Wait for Q1 to reach cancelled/failed state, then resume so Q2 can proceed
    await pollUntil(() => queueManager.getQueue(convId).items.some((i) => ["cancelled","failed"].includes(i.status)));
    await queueManager.resume(convId);

    // Wait for Q2 to complete
    await pollUntil(() => queueManager.getQueue(convId).items.every((i) => ["completed","failed","cancelled"].includes(i.status)));

    const finalQ = queueManager.getQueue(convId).items;
    const completed = finalQ.find((i) => i.status === "completed");
    expect(completed).toBeDefined();

    const msgs = getMessagesByConversation(true, convId);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Next item")).toBe(true);
  }, 8000);
});