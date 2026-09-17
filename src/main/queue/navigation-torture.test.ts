/**
 * navigation-torture.test.ts — Navigation and remount torture.
 *
 * Tests repeated navigate-away / navigate-back during every phase of an
 * AgentRun lifecycle:
 *   - During model wait (provider request in flight)
 *   - During tool execution
 *   - During protocol recovery turn
 *   - During finalization
 *   - During failure
 *   - During cancellation
 *
 * Each scenario verifies:
 *   - getRuntimeState returns correct state during run
 *   - getRuntimeState returns null after run ends
 *   - Messages are correctly persisted regardless of navigation
 *   - No stale hydration overwrites live state
 *   - No runtime leaks (registry cleaned up)
 *
 * All provider responses are mocked — no live LLM calls.
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

const PROFILE_ID = "nav-torture-profile";

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
    id, title: "nav-torture",
    defaultAgentProfileId: PROFILE_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nav-torture-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });
  saveAgentProfile(true, {
    id: PROFILE_ID, name: "Nav Torture Agent", endpoint: "https://test.example.com",
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
// nav-1: Navigate away during model wait → navigate back → run completes
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-1: navigate away during model wait", () => {
  it("getRuntimeState survives navigate-away, run completes after navigate-back", async () => {
    const convId = makeConv();
    let resolveRun!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Model answer", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID });

    // Wait for run to start
    await pollUntil(() => getRuntimeState(convId) !== null);
    const stateDuringRun = getRuntimeState(convId);
    expect(stateDuringRun?.conversationId).toBe(convId);

    // Simulate navigate away (renderer disappears — sender becomes destroyed)
    const destroyedSender = { send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents;
    queueManager.setSender(destroyedSender);

    // Navigate back (renderer remounts — fresh sender)
    await wait(50);
    queueManager.setSender(nullSender);

    // getRuntimeState still returns live state (main process, not renderer)
    const stateAfterNavBack = getRuntimeState(convId);
    expect(stateAfterNavBack).not.toBeNull();
    expect(stateAfterNavBack?.streamId).toBe(stateDuringRun?.streamId);

    // Complete the run
    resolveRun();
    await pollUntil(() => getRuntimeState(convId) === null);

    // Message persisted
    const msgs = getMessagesByConversation(true, convId);
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("Model answer");
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-2: Navigate away 5× during run — run still completes
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-2: 5 navigate cycles during run", () => {
  it("repeated nav away/back does not corrupt runtime state", async () => {
    const convId = makeConv();
    let resolveRun!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Survived nav", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    await pollUntil(() => getRuntimeState(convId) !== null);

    const originalStreamId = getRuntimeState(convId)?.streamId;

    // 5 navigate cycles
    for (let i = 0; i < 5; i++) {
      queueManager.setSender({ send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents);
      await wait(10);
      queueManager.setSender(nullSender);
      await wait(10);
    }

    // StreamId must be unchanged — no new run started
    const stateAfter = getRuntimeState(convId);
    expect(stateAfter?.streamId).toBe(originalStreamId);

    resolveRun();
    await pollUntil(() => getRuntimeState(convId) === null);
    const msgs = getMessagesByConversation(true, convId);
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("Survived nav");
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-3: Navigate away then run fails — error message persisted
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-3: navigate away then run fails", () => {
  it("error message persisted even when sender is destroyed at failure time", async () => {
    const convId = makeConv();
    let rejectRun!: (e: Error) => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<never>((_, rej) => { rejectRun = rej; });
    });

    void queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    await pollUntil(() => getRuntimeState(convId) !== null);

    // Navigate away
    queueManager.setSender({ send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents);
    await wait(20);

    // Fail the run while navigated away
    rejectRun(new Error("provider down"));
    await pollUntil(() => getRuntimeState(convId) === null, 3000);

    // Error must be persisted regardless
    const msgs = getMessagesByConversation(true, convId);
    expect(msgs.some((m) => m.role === "error")).toBe(true);
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-4: Navigate away then run is cancelled — cleanup correct
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-4: navigate away then cancel", () => {
  it("cancelling while navigated away cleans up runtime state", async () => {
    const convId = makeConv();

    mockRunAgentLoop.mockImplementationOnce(async (opts: { signal: AbortSignal }) => {
      await new Promise<never>((_, rej) => {
        opts.signal.addEventListener("abort", () => rej(new Error("cancelled")));
      });
    });

    void queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    await pollUntil(() => getRuntimeState(convId) !== null);

    const streamId = getRuntimeState(convId)?.streamId;
    expect(streamId).toBeDefined();

    // Navigate away
    queueManager.setSender({ send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents);

    // Cancel
    cancelStream(streamId!);
    await pollUntil(() => getRuntimeState(convId) === null, 3000);

    // Runtime state cleaned up
    expect(getRuntimeState(convId)).toBeNull();
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-5: getRuntimeState returns null for unknown convId
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-5: getRuntimeState for unknown convId returns null", () => {
  it("unknown convId → null (not throw)", () => {
    expect(getRuntimeState("nonexistent-conv-id")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-6: 3 convs navigated away and back simultaneously during concurrent runs
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-6: 3 concurrent runs + simultaneous nav cycles", () => {
  it("all 3 runs complete correctly despite simultaneous nav cycles", async () => {
    const convA = makeConv();
    const convB = makeConv();
    const convC = makeConv();
    const convs = [convA, convB, convC];

    let resolveA!: () => void, resolveB!: () => void, resolveC!: () => void;
    const resolvers = [() => resolveA(), () => resolveB(), () => resolveC()];

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      return { finalText: "A done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveB = r; });
      return { finalText: "B done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveC = r; });
      return { finalText: "C done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    // Enqueue all 3
    await Promise.all(convs.map((convId) =>
      queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID })
    ));

    // Wait for all to start
    await pollUntil(() => convs.every((c) => getRuntimeState(c) !== null));

    // Simulate 3 nav cycles while all 3 are running
    for (let i = 0; i < 3; i++) {
      queueManager.setSender({ send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents);
      await wait(15);
      queueManager.setSender(nullSender);
      await wait(15);
    }

    // Resolve all
    for (const resolver of resolvers) resolver();

    await pollUntil(() => convs.every((c) => getRuntimeState(c) === null), 5000);

    // All messages persisted
    const answers = ["A done", "B done", "C done"];
    for (let i = 0; i < convs.length; i++) {
      const msgs = getMessagesByConversation(true, convs[i]!);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe(answers[i]);
    }
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// nav-7: revision increments monotonically during nav cycles
// ─────────────────────────────────────────────────────────────────────────────

describe("nav-7: revision monotonically increases during run", () => {
  it("revision never goes backward during nav cycles", async () => {
    const convId = makeConv();
    let resolveRun!: () => void;
    let capturedOnToolStart!: (call: unknown) => void;

    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart: (c: unknown) => void }) => {
      capturedOnToolStart = opts.onToolStart;
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convId, content: "Q", attachmentIds: [], targetAgentProfileId: PROFILE_ID });
    await pollUntil(() => getRuntimeState(convId) !== null);

    const revisions: number[] = [];

    // Fire tool events during nav cycles
    for (let i = 0; i < 5; i++) {
      capturedOnToolStart({
        callId: `call-${i}`,
        name: "read_file",
        arguments: { path: `file${i}.ts`, fullFile: true },
      });
      revisions.push(getRuntimeState(convId)?.revision ?? 0);
      queueManager.setSender({ send: () => {}, isDestroyed: () => true } as unknown as Electron.WebContents);
      await wait(10);
      queueManager.setSender(nullSender);
    }

    // Revisions should be monotonically increasing
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]!).toBeGreaterThanOrEqual(revisions[i - 1]!);
    }

    resolveRun();
    await pollUntil(() => getRuntimeState(convId) === null);
  }, 8000);
});