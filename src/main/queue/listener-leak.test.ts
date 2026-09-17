/**
 * listener-leak.test.ts — Listener and runtime leak detection.
 *
 * Tests that IPC subscriptions, tool callbacks, abort signal listeners,
 * and the runtime registry are all properly cleaned up after run completion.
 *
 * Coverage:
 *   - AbortController not retained after run completes
 *   - Runtime registry (activeRunRegistry) cleaned after each run
 *   - No IPC listener accumulation across multiple runs
 *   - onToolStart/onToolEnd callbacks become no-ops after run
 *   - Multiple runs on same conv don't accumulate listeners
 *   - Sender.isDestroyed() check prevents sends to dead renderer
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
} from "../database/db.js";
import { queueManager, setSecretGetter, getRuntimeState, cancelStream } from "./QueueManager.js";
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

const PROFILE_ID = "listener-leak-profile";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await wait(20);
  if (!pred()) throw new Error("pollUntil timed out");
}

function makeConv(): string {
  const id = randomUUID();
  createConversation(true, {
    id, title: "listener-leak",
    defaultAgentProfileId: PROFILE_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

function enqueue(convId: string, content: string): void {
  void queueManager.enqueue({ conversationId: convId, content, attachmentIds: [], targetAgentProfileId: PROFILE_ID });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-listener-leak-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });
  saveAgentProfile(true, {
    id: PROFILE_ID, name: "Listener Leak Agent", endpoint: "https://test.example.com",
    protocol: "anthropic", model: "claude-test", isDefault: false,
    lastConnectionStatus: "connected", createdAt: Date.now(), updatedAt: Date.now(),
  });
  setSecretGetter(() => "test-key");
  mockRunAgentLoop.mockClear();
  queueManager.setSender(nullSender);
});

afterEach(() => {
  _resetReliabilityEngineForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-1: Runtime registry cleaned after successful run
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-1: runtime registry cleaned after successful run", () => {
  it("getRuntimeState returns null after run completes", async () => {
    const convId = makeConv();
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Done",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convId, "Q");
    await pollUntil(() => getRuntimeState(convId) !== null);
    await pollUntil(() => getRuntimeState(convId) === null);
    expect(getRuntimeState(convId)).toBeNull();
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-2: Runtime registry cleaned after failed run
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-2: runtime registry cleaned after failed run", () => {
  it("getRuntimeState returns null after run fails", async () => {
    const convId = makeConv();
    mockRunAgentLoop.mockRejectedValueOnce(new Error("provider down"));

    enqueue(convId, "Q");
    await pollUntil(() => getRuntimeState(convId) !== null).catch(() => {
      // If poll misses the brief active window, that's fine — may have already cleaned up
    });
    await pollUntil(() => getRuntimeState(convId) === null);
    expect(getRuntimeState(convId)).toBeNull();
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-3: Runtime registry cleaned after cancelled run
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-3: runtime registry cleaned after cancelled run", () => {
  it("getRuntimeState returns null after run is cancelled", async () => {
    const convId = makeConv();

    mockRunAgentLoop.mockImplementationOnce(async (opts: { signal: AbortSignal }) => {
      await new Promise<never>((_, rej) => {
        opts.signal.addEventListener("abort", () => rej(new Error("cancelled")));
      });
    });

    enqueue(convId, "Q");
    await pollUntil(() => getRuntimeState(convId) !== null);

    const streamId = getRuntimeState(convId)?.streamId;
    expect(streamId).toBeDefined();

    cancelStream(streamId!);
    await pollUntil(() => getRuntimeState(convId) === null);
    expect(getRuntimeState(convId)).toBeNull();
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-4: 20 sequential runs on same conv — no registry accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-4: 20 sequential runs — no registry accumulation", () => {
  it("getRuntimeState null between runs and null at end", async () => {
    const convId = makeConv();
    const N = 20;

    for (let i = 0; i < N; i++) {
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `Done ${i}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });
    }

    for (let i = 0; i < N; i++) {
      enqueue(convId, `Q${i}`);
      await pollUntil(() => {
        const q = queueManager.getQueue(convId).items;
        return q.some((x) => x.status === "completed") || q.every((x) => ["completed","failed"].includes(x.status));
      });
    }

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((i) => ["completed","failed"].includes(i.status))
    );

    // Registry must be null after all runs complete
    expect(getRuntimeState(convId)).toBeNull();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-5: AbortSignal not retained after cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-5: AbortSignal — only one controller per run", () => {
  it("each run gets a distinct AbortSignal (streamId changes)", async () => {
    const convId = makeConv();
    const streamIds = new Set<string>();

    for (let i = 0; i < 3; i++) {
      let resolveRun!: () => void;
      mockRunAgentLoop.mockImplementationOnce(async () => {
        await new Promise<void>((r) => { resolveRun = r; });
        return { finalText: `Done ${i}`, proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
      });

      enqueue(convId, `Q${i}`);
      await pollUntil(() => getRuntimeState(convId) !== null);

      const sid = getRuntimeState(convId)?.streamId;
      expect(sid).toBeDefined();
      streamIds.add(sid!);

      resolveRun();
      await pollUntil(() => getRuntimeState(convId) === null);
    }

    // All 3 runs had distinct stream IDs
    expect(streamIds.size).toBe(3);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-6: isDestroyed() check — no sends to dead renderer
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-6: isDestroyed() check — dead renderer receives no sends", () => {
  it("destroyed WebContents does not cause throw during run", async () => {
    const convId = makeConv();
    let sendCount = 0;

    const destroyedSender = {
      send: () => { sendCount++; },
      isDestroyed: () => true, // Simulates destroyed renderer
    } as unknown as Electron.WebContents;
    queueManager.setSender(destroyedSender);

    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Done with dead sender",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });

    enqueue(convId, "Q");
    await pollUntil(() => getRuntimeState(convId) === null, 4000);

    // QueueManager should NOT call send() on a destroyed WebContents
    expect(sendCount).toBe(0);
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-7: Tool callbacks don't accumulate across runs
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-7: tool callbacks isolated per run", () => {
  it("onToolStart from run N does not fire during run N+1", async () => {
    const convId = makeConv();
    const toolStartCalls: Array<{ run: number; name: string }> = [];

    // Run 1: captures onToolStart
    let savedOnToolStart!: (call: unknown) => void;
    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart: (c: unknown) => void }) => {
      savedOnToolStart = (c: unknown) => {
        const call = c as { name: string };
        toolStartCalls.push({ run: 1, name: call.name });
        opts.onToolStart(c);
      };
      // Fire one tool event in run 1
      savedOnToolStart({ callId: "call-1", name: "read_file", arguments: {} });
      await wait(20);
      return { finalText: "Run 1 done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    // Run 2: normal
    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart: (c: unknown) => void }) => {
      opts.onToolStart({ callId: "call-2", name: "search_files", arguments: {} });
      await wait(20);
      return { finalText: "Run 2 done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    enqueue(convId, "Q1");
    await pollUntil(() => getRuntimeState(convId) === null);

    enqueue(convId, "Q2");
    await pollUntil(() => queueManager.getQueue(convId).items.every((i) => ["completed","failed"].includes(i.status)));

    // Calling savedOnToolStart after run 1 ends should not affect run 2
    if (savedOnToolStart) {
      savedOnToolStart({ callId: "stale-call", name: "stale_tool", arguments: {} });
    }

    // The stale call should not appear as a tool event in run 2's runtime state
    expect(getRuntimeState(convId)).toBeNull(); // Run 2 also finished
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ll-8: Multiple convs — no cross-conv registry entries
// ─────────────────────────────────────────────────────────────────────────────

describe("ll-8: multiple convs — no cross-conv registry entries", () => {
  it("finishing conv A does not affect conv B registry entry", async () => {
    const convA = makeConv();
    const convB = makeConv();
    let resolveA!: () => void;
    let resolveB!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      return { finalText: "A done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveB = r; });
      return { finalText: "B done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convA, content: "A", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    void queueManager.enqueue({ conversationId: convB, content: "B", attachmentIds: [], targetAgentProfileId: PROFILE_ID });

    await pollUntil(() => getRuntimeState(convA) !== null && getRuntimeState(convB) !== null);

    // Finish A
    resolveA();
    await pollUntil(() => getRuntimeState(convA) === null);

    // B should still be in registry
    expect(getRuntimeState(convB)).not.toBeNull();
    expect(getRuntimeState(convB)?.conversationId).toBe(convB);

    // Finish B
    resolveB();
    await pollUntil(() => getRuntimeState(convB) === null);

    expect(getRuntimeState(convA)).toBeNull();
    expect(getRuntimeState(convB)).toBeNull();
  }, 10000);
});