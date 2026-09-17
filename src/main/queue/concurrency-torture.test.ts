/**
 * concurrency-torture.test.ts — Dedicated concurrency torture.
 *
 * Tests:
 *   - Multiple conversations running simultaneously
 *   - Multiple projects, multiple agent profiles
 *   - Interleaved IPC events from concurrent runs
 *   - Independent Stop per conversation (does not affect other runs)
 *   - Independent queues per conversation (per-conv FIFO)
 *   - No cross-run contamination (messages, ledgers, runtime state)
 *   - Queue serialization per conversation
 *   - Runtime state registry cleanup after all runs
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
  getDb, resetDb, createConversation, saveAgentProfile, createProject,
  getMessagesByConversation,
} from "../database/db.js";
import { queueManager, setSecretGetter, getRuntimeState, cancelStream, getActiveStreamId } from "./QueueManager.js";
import { evictIndex } from "../project-files/service.js";
import {
  initReliabilityEngine, _resetReliabilityEngineForTest, registerViolationHandler,
} from "../reliability/index.js";
import type { InvariantViolation } from "../reliability/invariants.js";
import { seededPrng } from "../reliability/stateful-generator.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

const nullSender = {
  send: () => {},
  isDestroyed: () => false,
} as unknown as Electron.WebContents;

let tmpDir: string;
let dataDir: string;
let violations: InvariantViolation[];

const PROFILES = ["profile-A", "profile-B", "profile-C"] as const;
const PROJECTS = ["project-X", "project-Y"] as const;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await wait(30);
  if (!pred()) throw new Error("pollUntil timed out");
}

function makeProfileId(i: number): string {
  return PROFILES[i % PROFILES.length]!;
}

function makeProjectRoot(id: string): string {
  return path.join(tmpDir, id);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-concurrency-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });

  for (const proj of PROJECTS) {
    fs.mkdirSync(makeProjectRoot(proj), { recursive: true });
  }

  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });

  violations = [];
  registerViolationHandler((v) => violations.push(v));

  for (const profileId of PROFILES) {
    saveAgentProfile(true, {
      id: profileId, name: profileId, endpoint: "https://test.example.com",
      protocol: "anthropic", model: "claude-test", isDefault: false,
      lastConnectionStatus: "connected", createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  for (const projId of PROJECTS) {
    createProject(true, {
      id: projId, name: projId, workingDirectory: makeProjectRoot(projId),
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  }

  setSecretGetter(() => "test-key");
  mockRunAgentLoop.mockClear();
  queueManager.setSender(nullSender);
});

afterEach(() => {
  _resetReliabilityEngineForTest();
  for (const proj of PROJECTS) evictIndex(proj);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create conversation with profile
// ─────────────────────────────────────────────────────────────────────────────

function makeConv(opts: { profileId: string; projectId?: string }): string {
  const id = randomUUID();
  createConversation(true, {
    id, title: "concurrency-test",
    ...(opts.projectId !== undefined && { projectId: opts.projectId }),
    defaultAgentProfileId: opts.profileId,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 4 concurrent conversations — independent queues, no cross-contamination
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-1: 4 conversations run in parallel without cross-contamination", () => {
  it("each conv gets its own messages — no bleed across convs", async () => {
    const convs = [
      makeConv({ profileId: "profile-A", projectId: "project-X" }),
      makeConv({ profileId: "profile-B", projectId: "project-Y" }),
      makeConv({ profileId: "profile-C" }),
      makeConv({ profileId: "profile-A" }),
    ];

    const answers = ["Answer for A", "Answer for B", "Answer for C", "Answer for D"];

    // Each conv gets a controlled mock that delays and returns a unique answer
    for (let i = 0; i < 4; i++) {
      const answer = answers[i]!;
      mockRunAgentLoop.mockImplementationOnce(async () => {
        await wait(20 + i * 10); // staggered completions
        return { finalText: answer, proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
      });
    }

    // Enqueue all 4 simultaneously
    const enqueues = convs.map((convId, i) =>
      queueManager.enqueue({
        conversationId: convId,
        content: `Question ${i}`,
        attachmentIds: [],
        targetAgentProfileId: makeProfileId(i),
      })
    );
    await Promise.all(enqueues);

    // Wait for all to complete
    await pollUntil(() =>
      convs.every((c) => queueManager.getQueue(c).items.every((i) => i.status === "completed" || i.status === "failed"))
    );

    // Each conversation must have exactly its own answer
    for (let i = 0; i < 4; i++) {
      const msgs = getMessagesByConversation(true, convs[i]!);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant?.content, `conv ${i} got wrong answer`).toBe(answers[i]);
      // No other conv's answer should appear
      for (let j = 0; j < 4; j++) {
        if (j !== i) {
          expect(assistant?.content).not.toContain(answers[j]);
        }
      }
    }
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Stop one conversation — other continues unaffected
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-2: Stop conv A does not affect conv B", () => {
  it("cancelling A's stream leaves B's stream running", async () => {
    const convA = makeConv({ profileId: "profile-A" });
    const convB = makeConv({ profileId: "profile-B" });

    let resolveB!: () => void;
    let streamIdA: string | undefined;

    // A: controlled (will be cancelled)
    mockRunAgentLoop.mockImplementationOnce(async (_opts: { signal: { aborted: boolean } }) => {
      await new Promise<void>((_res, rej) => {
        const interval = setInterval(() => {
          if (_opts.signal.aborted) { clearInterval(interval); rej(new Error("cancelled")); }
        }, 10);
      });
      return { finalText: "should not reach", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    // B: waits until we resolve it
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveB = r; });
      return { finalText: "B completed successfully", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convA, content: "A question", attachmentIds: [], targetAgentProfileId: "profile-A" });
    void queueManager.enqueue({ conversationId: convB, content: "B question", attachmentIds: [], targetAgentProfileId: "profile-B" });

    // Wait for both to start processing
    await pollUntil(() => {
      const qa = queueManager.getQueue(convA).items;
      const qb = queueManager.getQueue(convB).items;
      const sid = getActiveStreamId(convA);
      if (sid) streamIdA = sid;
      return !!(qa.find((i) => i.status === "processing") && qb.find((i) => i.status === "processing") && streamIdA);
    });

    // Cancel A
    expect(streamIdA).toBeDefined();
    cancelStream(streamIdA!);

    // A should complete (cancelled/failed)
    await pollUntil(() => {
      const qa = queueManager.getQueue(convA).items;
      return qa.every((i) => i.status === "cancelled" || i.status === "failed" || i.status === "completed");
    });

    // B should still be processing
    const qb = queueManager.getQueue(convB).items;
    expect(qb.some((i) => i.status === "processing")).toBe(true);

    // Resolve B
    resolveB();

    await pollUntil(() => {
      const qb2 = queueManager.getQueue(convB).items;
      return qb2.every((i) => i.status === "completed" || i.status === "failed");
    });

    const msgsB = getMessagesByConversation(true, convB);
    const assistantB = msgsB.find((m) => m.role === "assistant");
    expect(assistantB?.content).toBe("B completed successfully");
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Multi-project isolation — conversations in different projects don't share state
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-3: multi-project isolation", () => {
  it("runtime state entries are independent per conversation", async () => {
    const convX = makeConv({ profileId: "profile-A", projectId: "project-X" });
    const convY = makeConv({ profileId: "profile-B", projectId: "project-Y" });

    let resolveX!: () => void;
    let resolveY!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveX = r; });
      return { finalText: "X done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveY = r; });
      return { finalText: "Y done", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convX, content: "X Q", attachmentIds: [], targetAgentProfileId: "profile-A" });
    void queueManager.enqueue({ conversationId: convY, content: "Y Q", attachmentIds: [], targetAgentProfileId: "profile-B" });

    await pollUntil(() => {
      const qx = queueManager.getQueue(convX).items;
      const qy = queueManager.getQueue(convY).items;
      return !!(qx.find((i) => i.status === "processing") && qy.find((i) => i.status === "processing"));
    });

    const stateX = getRuntimeState(convX);
    const stateY = getRuntimeState(convY);
    expect(stateX).not.toBeNull();
    expect(stateY).not.toBeNull();
    // Runtime states must be separate objects
    expect(stateX?.streamId).not.toBe(stateY?.streamId);
    expect(stateX?.conversationId).toBe(convX);
    expect(stateY?.conversationId).toBe(convY);

    resolveX();
    resolveY();
    await pollUntil(() =>
      queueManager.getQueue(convX).items.every((i) => ["completed","failed"].includes(i.status)) &&
      queueManager.getQueue(convY).items.every((i) => ["completed","failed"].includes(i.status))
    );

    // After completion, runtime state should be null
    expect(getRuntimeState(convX)).toBeNull();
    expect(getRuntimeState(convY)).toBeNull();
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Interleaved tool events — streamId filter enforced
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-4: interleaved tool events — streamId isolation", () => {
  it("IPC tool events carry distinct streamIds for concurrent runs", async () => {
    const convA = makeConv({ profileId: "profile-A" });
    const convB = makeConv({ profileId: "profile-B" });

    const sentStreamIds: string[] = [];
    const captureSender = {
      send: (_ch: string, payload: Record<string, unknown>) => {
        if (payload && typeof payload["streamId"] === "string") {
          sentStreamIds.push(payload["streamId"] as string);
        }
      },
      isDestroyed: () => false,
    } as unknown as Electron.WebContents;
    queueManager.setSender(captureSender);

    let resolveA!: () => void;
    let resolveB!: () => void;

    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      return { finalText: "A", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });
    mockRunAgentLoop.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { resolveB = r; });
      return { finalText: "B", proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
    });

    void queueManager.enqueue({ conversationId: convA, content: "A", attachmentIds: [], targetAgentProfileId: "profile-A" });
    void queueManager.enqueue({ conversationId: convB, content: "B", attachmentIds: [], targetAgentProfileId: "profile-B" });

    await pollUntil(() => {
      const qa = queueManager.getQueue(convA).items;
      const qb = queueManager.getQueue(convB).items;
      return !!(qa.find((i) => i.status === "processing") && qb.find((i) => i.status === "processing"));
    });

    const stateA = getRuntimeState(convA);
    const stateB = getRuntimeState(convB);
    expect(stateA?.streamId).toBeDefined();
    expect(stateB?.streamId).toBeDefined();
    expect(stateA?.streamId).not.toBe(stateB?.streamId);

    resolveA();
    resolveB();

    await pollUntil(() =>
      queueManager.getQueue(convA).items.every((i) => ["completed","failed"].includes(i.status)) &&
      queueManager.getQueue(convB).items.every((i) => ["completed","failed"].includes(i.status))
    );

    // All stream IDs that were sent via IPC should only be from either A or B (no unknown IDs)
    const validIds = new Set([stateA?.streamId, stateB?.streamId].filter(Boolean));
    const unknownIds = sentStreamIds.filter((sid) => sid && !validIds.has(sid));
    expect(unknownIds).toHaveLength(0);
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 8 concurrent conversations — randomized, seeded
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-5: 8 concurrent conversations (seeded random)", () => {
  it("seed 0xcafe1234: all convs complete, no cross-contamination", async () => {
    const rng = seededPrng(0xcafe1234);
    const numConvs = 8;
    const convs = Array.from({ length: numConvs }, (_, i) =>
      makeConv({ profileId: PROFILES[i % PROFILES.length]! })
    );
    const answers = convs.map((_, i) => `Unique answer for conv ${i} ${Math.floor(rng() * 99999)}`);

    for (let i = 0; i < numConvs; i++) {
      const answer = answers[i]!;
      const delay = 10 + Math.floor(rng() * 50);
      mockRunAgentLoop.mockImplementationOnce(async () => {
        await wait(delay);
        return { finalText: answer, proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
      });
    }

    await Promise.all(convs.map((convId, i) =>
      queueManager.enqueue({
        conversationId: convId,
        content: `Q${i}`,
        attachmentIds: [],
        targetAgentProfileId: PROFILES[i % PROFILES.length]!,
      })
    ));

    await pollUntil(() =>
      convs.every((c) => queueManager.getQueue(c).items.every((i) => ["completed","failed"].includes(i.status))),
      8000
    );

    for (let i = 0; i < numConvs; i++) {
      const msgs = getMessagesByConversation(true, convs[i]!);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant?.content, `conv ${i} wrong answer`).toBe(answers[i]);
    }

    // No invariant violations
    const crossRunViolations = violations.filter((v) =>
      v.invariantId.includes("CROSS_RUN") || v.invariantId.includes("PROTOCOL_LEAK")
    );
    expect(crossRunViolations).toHaveLength(0);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Queue serialization — per-conversation FIFO
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent-6: queue serialization — at most 1 processing item per conv", () => {
  it("3 queued items for same conv are serialized (not parallelized)", async () => {
    const convId = makeConv({ profileId: "profile-A" });
    const processingCounts: number[] = [];

    for (let i = 0; i < 3; i++) {
      const delay = 30;
      mockRunAgentLoop.mockImplementationOnce(async () => {
        const q = queueManager.getQueue(convId).items;
        const activeNow = q.filter((x) => x.status === "processing").length;
        processingCounts.push(activeNow);
        await wait(delay);
        return { finalText: `Item ${i}`, proposalFenceRaw: undefined, agentReadRefs: [], toolActivity: [] };
      });
    }

    // Enqueue all 3 before any complete
    for (let i = 0; i < 3; i++) {
      void queueManager.enqueue({
        conversationId: convId,
        content: `Q${i}`,
        attachmentIds: [],
        targetAgentProfileId: "profile-A",
      });
    }

    await pollUntil(() =>
      queueManager.getQueue(convId).items.every((i) => ["completed","failed","cancelled"].includes(i.status)),
      5000
    );

    // At no point should there be more than 1 processing item
    for (const count of processingCounts) {
      expect(count).toBeLessThanOrEqual(1);
    }
  }, 10000);
});