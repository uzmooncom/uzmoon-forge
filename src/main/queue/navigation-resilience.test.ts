/**
 * navigation-resilience.test.ts — V0.8 regression tests.
 *
 * Verifies that:
 *   1.  getRuntimeState() returns live entry while run is active, null after
 *   2.  activeRunRegistry cleaned up after successful run
 *   3.  activeRunRegistry cleaned up after cancelled run
 *   4.  activeRunRegistry cleaned up after failed (AgentLoopError) run
 *   5.  Queue count accurate — processing item NOT counted as "queued"
 *   6.  Queue count after completion — processing entry removed, count = waiting only
 *   7.  No duplicate enqueue — enqueue is idempotent for distinct messages
 *   8.  Tool activity accumulates in registry during run
 *   9.  exploredCount increments on read_file tool calls
 *   10. Runtime state revision increments on each tool event
 *   11. Final response persists to DB while renderer absent (no sender)
 *   12. Stop (cancel) binds to hydrated requestId — correct run cancelled
 *   13. Concurrent conversations maintain independent runtime entries
 *   14. Queue startup reconciliation: "processing" → "paused" on restart
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
  classifyError: vi.fn(() => ({ status: "unknown", message: "mock error" })),
  testConnection: vi.fn(() => Promise.resolve({ status: "connected" })),
}));

import { runAgentLoop, AgentLoopError } from "../agent-client/agent-loop.js";
import {
  getDb,
  resetDb,
  createConversation,
  saveAgentProfile,
  createProject,
  getConvQueue,
  getMessagesByConversation,
} from "../database/db.js";
import { evictIndex } from "../project-files/service.js";
import {
  queueManager,
  setSecretGetter,
  cancelStream,
  getActiveStreamId,
  getRuntimeState,
} from "./QueueManager.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

// ── Fixture constants ──────────────────────────────────────────────────────

const PROFILE_ID = "profile-nav-test";
const PROJECT_ID = "project-nav-test";
const CONV_A = "conv-nav-A";
const CONV_B = "conv-nav-B";

let tmpDir: string;
let projectRoot: string;
let dataDir: string;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Null sender — simulates renderer unmounted
const nullSender = {
  send: () => {},
  isDestroyed: () => false,
} as unknown as Electron.WebContents;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nav-test-"));
  projectRoot = path.join(tmpDir, "project");
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  resetDb();
  getDb(dataDir);

  saveAgentProfile(true, {
    id: PROFILE_ID,
    name: "Nav Agent",
    endpoint: "https://test.example.com",
    protocol: "anthropic",
    model: "claude-test",
    isDefault: true,
    lastConnectionStatus: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  createProject(true, {
    id: PROJECT_ID,
    name: "Nav Project",
    workingDirectory: projectRoot,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  createConversation(true, {
    id: CONV_A,
    title: "Nav Conv A",
    projectId: PROJECT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  createConversation(true, {
    id: CONV_B,
    title: "Nav Conv B",
    projectId: PROJECT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  setSecretGetter(() => "test-api-key");
  mockRunAgentLoop.mockReset();
  queueManager.setSender(nullSender);
});

afterEach(() => {
  evictIndex(PROJECT_ID);
  resetDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 1. getRuntimeState returns live entry while active, null after ──────────

describe("Req 1: getRuntimeState — live while active, null after", () => {
  it("returns non-null during run, null after run completes", async () => {
    let resolveRun!: () => void;
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Done.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Hello",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });

    // Give processItem time to start the run
    await wait(100);

    const liveState = getRuntimeState(CONV_A);
    expect(liveState).not.toBeNull();
    expect(liveState!.conversationId).toBe(CONV_A);
    expect(liveState!.streamId).toBeDefined();
    expect(liveState!.requestId).toBeDefined();
    expect(liveState!.agentProfileId).toBe(PROFILE_ID);

    // Unblock the run
    resolveRun();
    await wait(200);

    const afterState = getRuntimeState(CONV_A);
    expect(afterState).toBeNull();
  });
});

// ── 2. Registry cleaned up after successful run ──────────────────────────────

describe("Req 2: activeRunRegistry cleaned up after success", () => {
  it("no runtime state entry after successful run", async () => {
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "Done.", stepCount: 1, agentReadRefs: [], toolActivity: [],
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Hello",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(300);

    expect(getRuntimeState(CONV_A)).toBeNull();
  });
});

// ── 3. Registry cleaned up after cancelled run ───────────────────────────────

describe("Req 3: activeRunRegistry cleaned up after cancel", () => {
  it("no runtime state entry after run is cancelled", async () => {
    let resolveRun!: () => void;
    mockRunAgentLoop.mockImplementationOnce(async (opts: { signal: { aborted: boolean } }) => {
      await new Promise<void>((r) => { resolveRun = r; });
      if (opts.signal.aborted) throw new AgentLoopError("CANCELLED", "cancelled");
      return { finalText: "Done.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Hello",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(100);

    const streamId = getActiveStreamId(CONV_A);
    expect(streamId).toBeDefined();

    if (streamId) cancelStream(streamId);
    resolveRun();
    await wait(200);

    expect(getRuntimeState(CONV_A)).toBeNull();
  });
});

// ── 4. Registry cleaned up after AgentLoopError failure ──────────────────────

describe("Req 4: activeRunRegistry cleaned up after failure", () => {
  it("no runtime state entry after AgentLoopError(PROVIDER_ERROR)", async () => {
    mockRunAgentLoop.mockRejectedValueOnce(
      new AgentLoopError("PROVIDER_ERROR", "API timeout")
    );

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Hello",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(300);

    expect(getRuntimeState(CONV_A)).toBeNull();
  });
});

// ── 5. Queue count — processing item NOT counted as "queued" ─────────────────

describe("Req 5: Queue count — processing item excluded from queued count", () => {
  it("1 active + 1 waiting → getConvQueue shows 1 processing + 1 queued", async () => {
    let resolveA!: () => void;
    mockRunAgentLoop
      .mockImplementationOnce(async () => {
        // A hangs so B stays queued
        await new Promise<void>((r) => { resolveA = r; });
        return { finalText: "Done A.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
      })
      .mockResolvedValueOnce({ finalText: "Done B.", stepCount: 1, agentReadRefs: [], toolActivity: [] });

    // Enqueue A first, then B
    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Message A",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Message B",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(150);

    const q = getConvQueue(true, CONV_A);
    const processingItems = q.items.filter((i) => i.status === "processing");
    const queuedItems = q.items.filter((i) => i.status === "queued");

    // Exactly 1 active, 1 waiting
    expect(processingItems).toHaveLength(1);
    expect(queuedItems).toHaveLength(1);
    // The queued count shown to user should be queuedItems.length = 1, NOT 2
    expect(queuedItems[0]!.content).toBe("Message B");

    resolveA();
    await wait(300);
  });
});

// ── 6. Queue count after completion ──────────────────────────────────────────

describe("Req 6: Queue count after completion", () => {
  it("both items completed — no processing/queued items remain", async () => {
    mockRunAgentLoop
      .mockResolvedValueOnce({ finalText: "Done A.", stepCount: 1, agentReadRefs: [], toolActivity: [] })
      .mockResolvedValueOnce({ finalText: "Done B.", stepCount: 1, agentReadRefs: [], toolActivity: [] });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Message A",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Message B",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(500);

    const q = getConvQueue(true, CONV_A);
    const active = q.items.filter((i) => i.status === "processing" || i.status === "queued");
    expect(active).toHaveLength(0);
  });
});

// ── 7. No duplicate enqueue ────────────────────────────────────────────────

describe("Req 7: No duplicate enqueue", () => {
  it("calling enqueue twice with distinct content creates exactly 2 queue items and 2 user messages", async () => {
    mockRunAgentLoop
      .mockResolvedValueOnce({ finalText: "A.", stepCount: 1, agentReadRefs: [], toolActivity: [] })
      .mockResolvedValueOnce({ finalText: "B.", stepCount: 1, agentReadRefs: [], toolActivity: [] });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "First",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Second",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(500);

    const msgs = getMessagesByConversation(true, CONV_A);
    const userMsgs = msgs.filter((m) => m.role === "user");
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // Exactly 2 user + 2 assistant — no duplicates
    expect(userMsgs).toHaveLength(2);
    expect(assistantMsgs).toHaveLength(2);
    expect(userMsgs.map((m) => m.content)).toContain("First");
    expect(userMsgs.map((m) => m.content)).toContain("Second");
  });
});

// ── 8. Tool activity accumulates in registry ──────────────────────────────

describe("Req 8: Tool activity accumulates in registry during run", () => {
  it("toolActivity array grows as onToolStart fires", async () => {
    let resolveRun!: () => void;
    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart?: (call: unknown) => void }) => {
      // Fire 3 tool starts
      for (let i = 0; i < 3; i++) {
        opts.onToolStart?.({ callId: randomUUID(), name: "search_files", arguments: { query: `test-${i}`, projectRoot } });
        await wait(10);
      }
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Done.", stepCount: 3, agentReadRefs: [], toolActivity: [] };
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Search",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(200);

    const state = getRuntimeState(CONV_A);
    expect(state).not.toBeNull();
    expect(state!.toolActivity.length).toBe(3);
    expect(state!.toolActivity.every((t) => t.name === "search_files")).toBe(true);

    resolveRun();
    await wait(200);
  });
});

// ── 9. exploredCount increments on read_file ──────────────────────────────

describe("Req 9: exploredCount increments on read_file tool calls", () => {
  it("exploredCount reflects number of read_file calls seen", async () => {
    let resolveRun!: () => void;
    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart?: (call: unknown) => void; onToolEnd?: (call: unknown, result: unknown, ms: number) => void }) => {
      const callId1 = randomUUID();
      const callId2 = randomUUID();
      opts.onToolStart?.({ callId: callId1, name: "read_file", arguments: { relativePath: "src/a.ts" } });
      opts.onToolEnd?.({ callId: callId1, name: "read_file", arguments: {} }, { callId: callId1, toolName: "read_file", ok: true, data: "content" }, 50);
      opts.onToolStart?.({ callId: callId2, name: "read_file", arguments: { relativePath: "src/b.ts" } });
      opts.onToolEnd?.({ callId: callId2, name: "read_file", arguments: {} }, { callId: callId2, toolName: "read_file", ok: true, data: "content" }, 50);
      await wait(20);
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Done.", stepCount: 2, agentReadRefs: [], toolActivity: [] };
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Read files",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(200);

    const state = getRuntimeState(CONV_A);
    expect(state).not.toBeNull();
    expect(state!.exploredCount).toBe(2);

    resolveRun();
    await wait(200);
  });
});

// ── 10. Revision increments on tool events ────────────────────────────────

describe("Req 10: Runtime state revision increments on each tool event", () => {
  it("revision starts at 1, increments on each tool start/end", async () => {
    let resolveRun!: () => void;
    const revisions: number[] = [];

    mockRunAgentLoop.mockImplementationOnce(async (opts: { onToolStart?: (call: unknown) => void; onToolEnd?: (call: unknown, result: unknown, ms: number) => void }) => {
      // Capture revision after each tool event
      const callId = randomUUID();
      opts.onToolStart?.({ callId, name: "search_files", arguments: { query: "test" } });
      revisions.push(getRuntimeState(CONV_A)?.revision ?? -1);
      opts.onToolEnd?.({ callId, name: "search_files", arguments: {} }, { callId, toolName: "search_files", ok: true }, 30);
      revisions.push(getRuntimeState(CONV_A)?.revision ?? -1);
      await new Promise<void>((r) => { resolveRun = r; });
      return { finalText: "Done.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Search",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(200);

    // revision after onToolStart should be > initial (1), and after onToolEnd > that
    expect(revisions.length).toBe(2);
    expect(revisions[0]).toBeGreaterThan(1); // incremented by onToolStart
    expect(revisions[1]).toBeGreaterThan(revisions[0]!); // incremented by onToolEnd

    resolveRun();
    await wait(200);
  });
});

// ── 11. Final response persists while renderer absent ─────────────────────

describe("Req 11: Final response persists to DB while renderer absent", () => {
  it("assistant message in DB even when sender isDestroyed returns true", async () => {
    // Simulate renderer being unmounted (sender destroyed)
    queueManager.setSender({
      send: () => {},
      isDestroyed: () => true, // renderer gone
    } as unknown as Electron.WebContents);

    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "The answer is 42.",
      stepCount: 1,
      agentReadRefs: [],
      toolActivity: [],
    });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "What is the answer?",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(400);

    // Restore sender
    queueManager.setSender(nullSender);

    const msgs = getMessagesByConversation(true, CONV_A);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!.content).toContain("The answer is 42.");

    // Runtime state must be cleaned up
    expect(getRuntimeState(CONV_A)).toBeNull();
  });
});

// ── 12. Stop after return — correct requestId cancelled ──────────────────

describe("Req 12: Stop binds to exact streamId — correct run cancelled", () => {
  it("cancelling streamId A does not affect a subsequent run on same conv", async () => {
    // Run A starts and we capture its streamId
    let resolveA!: () => void;
    mockRunAgentLoop
      .mockImplementationOnce(async (opts: { signal: { aborted: boolean } }) => {
        await new Promise<void>((r) => { resolveA = r; });
        if (opts.signal.aborted) throw new AgentLoopError("CANCELLED", "cancelled");
        return { finalText: "Done A.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
      })
      .mockResolvedValueOnce({ finalText: "Done B.", stepCount: 1, agentReadRefs: [], toolActivity: [] });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Run A",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(100);

    const streamIdA = getActiveStreamId(CONV_A);
    expect(streamIdA).toBeDefined();

    // Cancel and unblock A
    if (streamIdA) cancelStream(streamIdA);
    resolveA();
    await wait(200);

    // Queue was paused after cancel — resume it
    await queueManager.resume(CONV_A);

    // Enqueue B
    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "Run B",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(300);

    // A was cancelled — B completed normally
    const msgs = getMessagesByConversation(true, CONV_A);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    // B's assistant message should be present
    expect(assistantMsgs.some((m) => m.content.includes("Done B."))).toBe(true);

    // Attempt to cancel A's old streamId again — must be a no-op (not crash)
    if (streamIdA) {
      expect(() => cancelStream(streamIdA)).not.toThrow();
    }
  });
});

// ── 13. Concurrent conversations maintain independent runtime entries ──────

describe("Req 13: Concurrent conversations — independent runtime entries", () => {
  it("A and B have separate runtime state entries simultaneously", async () => {
    let resolveA!: () => void;
    let resolveB!: () => void;

    mockRunAgentLoop
      .mockImplementationOnce(async () => {
        await new Promise<void>((r) => { resolveA = r; });
        return { finalText: "Done A.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((r) => { resolveB = r; });
        return { finalText: "Done B.", stepCount: 1, agentReadRefs: [], toolActivity: [] };
      });

    await queueManager.enqueue({
      conversationId: CONV_A,
      content: "A",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await queueManager.enqueue({
      conversationId: CONV_B,
      content: "B",
      attachmentIds: [],
      targetAgentProfileId: PROFILE_ID,
      projectId: PROJECT_ID,
    });
    await wait(150);

    const stateA = getRuntimeState(CONV_A);
    const stateB = getRuntimeState(CONV_B);

    expect(stateA).not.toBeNull();
    expect(stateB).not.toBeNull();
    expect(stateA!.streamId).not.toBe(stateB!.streamId);
    expect(stateA!.requestId).not.toBe(stateB!.requestId);
    expect(stateA!.conversationId).toBe(CONV_A);
    expect(stateB!.conversationId).toBe(CONV_B);

    resolveA();
    resolveB();
    await wait(300);

    expect(getRuntimeState(CONV_A)).toBeNull();
    expect(getRuntimeState(CONV_B)).toBeNull();
  });
});

// ── 14. Startup reconciliation: "processing" → "paused" ──────────────────

describe("Req 14: Queue startup reconciliation", () => {
  it("processing items from previous session become paused on getDb() call", () => {
    // Simulate a "processing" item left over from a crash
    // by directly writing to the store before getDb normalises it.
    // We achieve this by manipulating what resetDb + getDb(dataDir) loads.
    // The db.ts load() already converts "processing" → "paused" on startup.
    // We verify this by writing forge.json manually then reloading.

    const forgeJson = path.join(dataDir, "forge.json");
    const crashedState = {
      version: 1,
      conversations: [
        {
          id: CONV_A,
          title: "Crashed conv",
          projectId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          archived: false,
        },
      ],
      messagesByConv: {},
      queues: {
        [CONV_A]: {
          paused: false,
          items: [
            {
              id: "crashed-item-1",
              conversationId: CONV_A,
              messageId: "msg-1",
              content: "In-flight request",
              attachmentIds: [],
              status: "processing", // was running when app crashed
              createdAt: Date.now(),
              startedAt: Date.now(),
              attemptCount: 1,
              targetAgentProfileId: PROFILE_ID,
            },
          ],
        },
      },
      agentProfiles: {},
      agentConfig: null,
      appState: { onboardingComplete: true, agentConfigId: null },
      projects: {},
      attachments: {},
      snapshots: {},
      requestLedgers: {},
      editProposals: {},
      appliedEdits: {},
      writeJournal: [],
    };
    fs.writeFileSync(forgeJson, JSON.stringify(crashedState), "utf8");

    // Reload db — this runs load() which normalises "processing" → "paused"
    resetDb();
    getDb(dataDir);

    const q = getConvQueue(true, CONV_A);
    const item = q.items.find((i) => i.id === "crashed-item-1");
    expect(item).toBeDefined();
    expect(item!.status).toBe("paused");
    expect(q.paused).toBe(true);
  });
});