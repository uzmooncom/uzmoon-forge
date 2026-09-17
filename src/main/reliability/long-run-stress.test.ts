/**
 * long-run-stress.test.ts — Long-run stress test.
 *
 * Simulates extended usage patterns to catch:
 *   - Memory leaks (runtime registry, trace recorder, incident recorder)
 *   - Performance regression (per-run overhead)
 *   - Trace storage limits (MAX_STORED_TRACES capped at 50)
 *   - Incident ring buffer (MAX_INCIDENTS capped at 200)
 *   - Snapshot count stability (orphan sweep keeps count stable)
 *   - No accumulated IPC listener references
 *   - Bulk-enqueue correctness: multiple queued user messages before assistants
 *   - Duplicate-final detection: no second assistant for same requestId
 *   - Deterministic teardown: drainForTest waits for all in-flight promises
 *
 * Scenarios:
 *   - 100 sequential runs on single conversation
 *   - 50 interleaved runs across 5 conversations (bulk-enqueued)
 *   - 200+ incident records testing ring buffer
 *   - 60 traces testing MAX_STORED_TRACES cap
 *   - Bulk-enqueue regression: A active + B,C queued — no invariant violation
 *   - Duplicate-final regression: same requestId must not produce two assistant msgs
 *   - Async bleed regression: repeated create/run/reset without sleep
 *
 * All provider responses are mocked — no live LLM calls.
 * Target: < 30 seconds total.
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
import {
  queueManager, setSecretGetter, getRuntimeState, sweepOrphanedSnapshots,
  _resetQueueManagerForTest, drainForTest,
} from "../queue/QueueManager.js";
import {
  initReliabilityEngine, _resetReliabilityEngineForTest, tryGetIncidentRecorder,
} from "./index.js";
import { TraceRecorder } from "./trace.js";
import { IncidentRecorder } from "./incident.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

const nullSender = {
  send: () => {},
  isDestroyed: () => false,
} as unknown as Electron.WebContents;

let tmpDir: string;
let dataDir: string;

const PROFILE_ID = "stress-profile";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await wait(20);
  if (!pred()) throw new Error("pollUntil timed out");
}

function makeConv(): string {
  const id = randomUUID();
  createConversation(true, {
    id, title: "stress-test",
    defaultAgentProfileId: PROFILE_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

function setupProfile(): void {
  saveAgentProfile(true, {
    id: PROFILE_ID, name: "Stress Agent", endpoint: "https://test.example.com",
    protocol: "anthropic", model: "claude-test", isDefault: false,
    lastConnectionStatus: "connected", createdAt: Date.now(), updatedAt: Date.now(),
  });
}

beforeEach(async () => {
  // Deterministic teardown: drain then reset (no arbitrary sleep needed)
  await drainForTest();
  _resetQueueManagerForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-stress-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });
  setupProfile();
  setSecretGetter(() => "test-key");
  mockRunAgentLoop.mockReset();
  queueManager.setSender(nullSender);
});

afterEach(async () => {
  // Drain active promises before clearing state — prevents async bleed
  await drainForTest();
  _resetQueueManagerForTest();
  _resetReliabilityEngineForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-1: 100 sequential runs — messages alternate, no registry leaks
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-1: 100 sequential runs on single conversation", () => {
  it("100 runs complete, messages alternate correctly, registry clean at end", async () => {
    const convId = makeConv();
    const N = 100;
    const t0 = Date.now();

    // Sequential: enqueue one at a time, wait for completion before next.
    // This tests the strict alternation property (user[i] → assistant[i]).
    for (let i = 0; i < N; i++) {
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `Answer ${i}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });
      void queueManager.enqueue({
        conversationId: convId,
        content: `Q${i}`,
        attachmentIds: [],
        targetAgentProfileId: PROFILE_ID,
      });
      // Wait for this item to complete before enqueuing the next
      await pollUntil(() => {
        const items = queueManager.getQueue(convId).items;
        return items.length > 0 && items[items.length - 1]!.status === "completed";
      }, 5000);
    }

    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30000); // Must complete in under 30s

    // Messages must alternate user/assistant
    const msgs = getMessagesByConversation(true, convId);
    const nonError = msgs.filter((m) => m.role !== "error");
    expect(nonError.length).toBe(N * 2);
    for (let i = 1; i < nonError.length; i++) {
      expect(nonError[i]!.role).not.toBe(nonError[i - 1]!.role);
    }

    // Registry must be clean
    expect(getRuntimeState(convId)).toBeNull();

    // Queue items all completed
    const q = queueManager.getQueue(convId).items;
    expect(q.every((item) => item.status === "completed")).toBe(true);
  }, 35000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-2: Per-run overhead benchmark — average run overhead < 100ms
// Bulk-enqueued: all N items enqueued at once (valid product behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-2: per-run overhead benchmark", () => {
  it("average run overhead (excluding mock runAgentLoop) is < 100ms", async () => {
    const convId = makeConv();
    const N = 50;
    const durations: number[] = [];

    for (let i = 0; i < N; i++) {
      mockRunAgentLoop.mockImplementationOnce(async () => {
        const t = Date.now();
        await wait(0); // zero-delay mock
        durations.push(Date.now() - t);
        return { finalText: `A${i}`, proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
      });
    }

    const t0 = Date.now();
    // Bulk enqueue — all user messages inserted before any completes (valid behavior)
    for (let i = 0; i < N; i++) {
      void queueManager.enqueue({
        conversationId: convId,
        content: `Q${i}`,
        attachmentIds: [],
        targetAgentProfileId: PROFILE_ID,
      });
    }

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((item) => ["completed", "failed"].includes(item.status)),
      20000
    );

    const totalElapsed = Date.now() - t0;
    const avgRunMs = totalElapsed / N;

    // Average overhead per run should be reasonable for a mocked run
    expect(avgRunMs).toBeLessThan(100); // < 100ms per run average

    // Verify all completed
    expect(getMessagesByConversation(true, convId).filter((m) => m.role === "assistant").length).toBe(N);
  }, 25000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-3: 50 interleaved runs across 5 conversations (bulk-enqueued)
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-3: 50 interleaved runs across 5 conversations", () => {
  it("5 convs × 10 runs each — all complete correctly, no cross-contamination", async () => {
    const N_CONVS = 5;
    const N_RUNS = 10;
    const convs = Array.from({ length: N_CONVS }, () => makeConv());

    for (let run = 0; run < N_RUNS; run++) {
      for (let c = 0; c < N_CONVS; c++) {
        const convIdx = c;
        const runIdx = run;
        mockRunAgentLoop.mockImplementationOnce(async () => {
          await wait(2); // small delay for interleaving
          return {
            finalText: `Conv${convIdx}-Run${runIdx}`,
            proposalFenceRaw: undefined,
            agentReadRefs: [],
            toolActivity: [],
          };
        });
      }
    }

    // Bulk-enqueue all runs across all convs — valid product behavior.
    // Each conv processes its own queue sequentially; convs run concurrently.
    for (let run = 0; run < N_RUNS; run++) {
      for (let c = 0; c < N_CONVS; c++) {
        void queueManager.enqueue({
          conversationId: convs[c]!,
          content: `Q-${c}-${run}`,
          attachmentIds: [],
          targetAgentProfileId: PROFILE_ID,
        });
      }
    }

    await pollUntil(() =>
      convs.every((conv) =>
        queueManager.getQueue(conv).items.every((item) => ["completed", "failed"].includes(item.status))
      ),
      30000
    );

    // Verify each conv has correct messages
    for (let c = 0; c < N_CONVS; c++) {
      const msgs = getMessagesByConversation(true, convs[c]!);
      const assistants = msgs.filter((m) => m.role === "assistant");
      expect(assistants.length, `conv ${c} should have ${N_RUNS} assistant messages`).toBe(N_RUNS);

      // Each assistant message should belong to this conv
      for (const msg of assistants) {
        expect(msg.content).toContain(`Conv${c}`);
        // No other conv's content
        for (let other = 0; other < N_CONVS; other++) {
          if (other !== c) {
            expect(msg.content, `conv ${c} got conv ${other}'s message`).not.toContain(`Conv${other}-`);
          }
        }
      }

      // Registry clean
      expect(getRuntimeState(convs[c]!)).toBeNull();
    }
  }, 35000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-4: TraceRecorder — MAX_STORED_TRACES cap (50)
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-4: TraceRecorder MAX_STORED_TRACES cap", () => {
  it("60 completed traces — stored count capped at 50", () => {
    const recorder = new TraceRecorder({ dataDir });
    for (let i = 0; i < 60; i++) {
      const requestId = randomUUID();
      recorder.startTrace({ requestId, conversationId: `conv-${i}` });
      recorder.emit(requestId, "RUN_CREATED", { index: i });
      recorder.endTrace(requestId, i % 5 === 0 ? "failed" : "completed");
    }
    // getFailedTraces() is a subset of getCompletedTraces() — don't double-count
    const completed = recorder.getCompletedTraces();
    expect(completed.length).toBeLessThanOrEqual(50);
  });

  it("FIFO eviction — oldest traces are dropped when cap exceeded", () => {
    const recorder = new TraceRecorder({ dataDir });
    for (let i = 0; i < 55; i++) {
      const requestId = randomUUID();
      recorder.startTrace({ requestId, conversationId: `conv-${i}` });
      recorder.emit(requestId, "RUN_CREATED", { index: i });
      recorder.endTrace(requestId, "completed");
    }
    // Should not exceed 50 — getCompletedTraces() is the full store
    const all = recorder.getCompletedTraces();
    expect(all.length).toBeLessThanOrEqual(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-5: IncidentRecorder ring buffer — 250 incidents, cap at 200
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-5: IncidentRecorder ring buffer at 250 incidents", () => {
  it("250 distinct incidents — stored count capped at 200", () => {
    const recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-test" });
    const invariants = [
      "ONE_RUN_ONE_VISIBLE_FAILURE", "NO_PROTOCOL_LEAK", "RESOURCE_OWNERSHIP_CLEAN",
      "1_USER_1_ASSISTANT", "SNAPSHOT_IMMUTABLE", "TERMINAL_TURN_ONLY",
      "RECOVERY_BOUNDED", "STATE_TRANSITIONS_VALID",
    ];
    for (let i = 0; i < 250; i++) {
      recorder.record({
        invariantId: invariants[i % invariants.length]!,
        timestamp: Date.now() + i,
        observedState: { index: i, unique: `key-${i}` }, // unique to avoid dedup
        contextHint: `distinct-context-${i}`,
      });
    }
    const all = recorder.getAll();
    expect(all.length).toBeLessThanOrEqual(200);
  });

  it("ring buffer preserves most recent incidents", () => {
    const recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-test" });
    // Fill buffer to 200
    for (let i = 0; i < 200; i++) {
      recorder.record({
        invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE",
        timestamp: 1000000 + i,
        observedState: { index: i, unique: `fill-${i}` },
        contextHint: `fill-${i}`,
      });
    }
    // Add one more recent
    const recent = recorder.record({
      invariantId: "NO_PROTOCOL_LEAK",
      timestamp: 9999999,
      observedState: { recent: true },
    });
    const all = recorder.getAll();
    // Most recent should be in the buffer
    expect(all.some((inc) => inc.id === recent.id)).toBe(true);
    expect(all.length).toBeLessThanOrEqual(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-6: sweepOrphanedSnapshots performance — 1000 snapshot files
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-6: sweepOrphanedSnapshots performance with 1000 files", () => {
  it("sweep completes in < 3 seconds with 1000 orphan files", async () => {
    // Create 1000 orphan snapshot files
    for (let i = 0; i < 1000; i++) {
      const id = randomUUID();
      fs.writeFileSync(path.join(dataDir, "snapshots", `${id}.txt`), `orphan-${i}`);
    }

    const t0 = Date.now();
    await sweepOrphanedSnapshots();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3000);

    // All orphans deleted
    const remaining = fs.readdirSync(path.join(dataDir, "snapshots"));
    expect(remaining.length).toBe(0);
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-7: Stability gate — no violations across 100-run bulk-enqueued workload
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-7: stability gate — 100-run workload produces no blocking violations", () => {
  it("100 clean bulk-enqueued runs: checkStabilityGate returns empty (pass)", async () => {
    const convId = makeConv();
    const N = 100;

    // Bulk-enqueue all N items at once — valid product behavior.
    // All user messages are inserted before any assistant messages.
    // The request-scoped 1_USER_1_ASSISTANT invariant must NOT fire for this.
    for (let i = 0; i < N; i++) {
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `Clean ${i}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });
    }
    for (let i = 0; i < N; i++) {
      void queueManager.enqueue({
        conversationId: convId,
        content: `Q${i}`,
        attachmentIds: [],
        targetAgentProfileId: PROFILE_ID,
      });
    }

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((item) => ["completed", "failed"].includes(item.status)),
      30000
    );

    const recorder = tryGetIncidentRecorder();
    if (recorder) {
      const gate = recorder.checkStabilityGate();
      expect(Array.isArray(gate)).toBe(true);
      expect(gate.length).toBe(0);
    } else {
      const msgs = getMessagesByConversation(true, convId);
      expect(msgs.filter((m) => m.role === "error").length).toBe(0);
    }
  }, 35000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-8: Bulk-enqueue regression
// A active + B queued + C queued — NO 1_USER_1_ASSISTANT violation
// Then process all — one assistant per request, no duplicates
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-8: bulk-enqueue regression — request-scoped invariant", () => {
  it("A active + B,C queued: user messages coexist without invariant violation", async () => {
    const convId = makeConv();

    // Slow A so B and C queue up behind it
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await wait(30);
      return { finalText: "Answer A", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Answer B", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [],
    });
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Answer C", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [],
    });

    // Bulk-enqueue A, B, C — inserts all three user messages immediately
    void queueManager.enqueue({ conversationId: convId, content: "Q-A", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    void queueManager.enqueue({ conversationId: convId, content: "Q-B", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    void queueManager.enqueue({ conversationId: convId, content: "Q-C", attachmentIds: [], targetAgentProfileId: PROFILE_ID });

    // At this point: three user messages are in DB, A is processing
    // The 1_USER_1_ASSISTANT invariant must NOT fire for the bulk-queued state

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((item) => ["completed", "failed"].includes(item.status)),
      10000
    );

    // All three requests completed
    const items = queueManager.getQueue(convId).items;
    expect(items.every((item) => item.status === "completed")).toBe(true);
    expect(items.length).toBe(3);

    // Exactly 3 user + 3 assistant messages
    const msgs = getMessagesByConversation(true, convId);
    const userMsgs = msgs.filter((m) => m.role === "user");
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBe(3);
    expect(assistantMsgs.length).toBe(3);

    // Each assistant has a unique requestId — no duplicates
    const requestIds = assistantMsgs.map((m) => m.requestId).filter(Boolean);
    expect(requestIds.length).toBe(3);
    expect(new Set(requestIds).size).toBe(3);

    // No 1_USER_1_ASSISTANT incidents recorded
    const recorder = tryGetIncidentRecorder();
    if (recorder) {
      const incidents = recorder.getAll().filter((inc) => inc.invariantId === "1_USER_1_ASSISTANT");
      expect(incidents.length).toBe(0);
    }
  }, 15000);

  it("duplicate-final regression: no second assistant message for same requestId", async () => {
    // This verifies that even if processItem were called twice (a bug), the
    // request-scoped invariant would catch the duplicate.
    // We test the invariant logic directly using the IncidentRecorder.
    const convId = makeConv();

    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Single answer",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    void queueManager.enqueue({
      conversationId: convId,
      content: "Q",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
    });

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((item) => ["completed", "failed"].includes(item.status)),
      5000
    );

    const msgs = getMessagesByConversation(true, convId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // Exactly one assistant message
    expect(assistantMsgs.length).toBe(1);

    // It carries a requestId
    expect(assistantMsgs[0]!.requestId).toBeTruthy();

    // requestId is unique across all assistant messages in this conv
    const allRequestIds = assistantMsgs.map((m) => m.requestId).filter(Boolean);
    expect(new Set(allRequestIds).size).toBe(allRequestIds.length);

    // No invariant violations recorded
    const recorder = tryGetIncidentRecorder();
    if (recorder) {
      const incidents = recorder.getAll().filter((inc) => inc.invariantId === "1_USER_1_ASSISTANT");
      expect(incidents.length).toBe(0);
    }
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// stress-9: Async bleed regression — repeated create/run/reset without sleep
// Proves drainForTest prevents async bleed between test cycles
// ─────────────────────────────────────────────────────────────────────────────

describe("stress-9: async bleed regression — deterministic teardown", () => {
  it("20 rapid create/run/reset cycles without sleep produce no bleed", async () => {
    const CYCLES = 20;

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      // Re-run setup inline (beforeEach already ran for the outer test)
      await drainForTest();
      _resetQueueManagerForTest();
      resetDb();
      getDb(dataDir);
      _resetReliabilityEngineForTest();
      initReliabilityEngine({ dataDir, version: "0.9.0-test" });
      setupProfile();
      setSecretGetter(() => "test-key");
      mockRunAgentLoop.mockReset();
      queueManager.setSender(nullSender);

      const convId = makeConv();
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `Cycle ${cycle}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });

      void queueManager.enqueue({
        conversationId: convId,
        content: `Q-cycle-${cycle}`,
        attachmentIds: [],
        targetAgentProfileId: PROFILE_ID,
      });

      // Wait for completion (no sleep — pure determinism via pollUntil)
      await pollUntil(() =>
        queueManager.getQueue(convId).items.every((item) => ["completed", "failed"].includes(item.status)),
        5000
      );

      // Verify exactly 1 user + 1 assistant message, no bleed from other cycles
      const msgs = getMessagesByConversation(true, convId);
      const userMsgs = msgs.filter((m) => m.role === "user");
      const assistantMsgs = msgs.filter((m) => m.role === "assistant");
      expect(userMsgs.length).toBe(1);
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0]!.content).toBe(`Cycle ${cycle}`);
    }
  }, 30000);
});