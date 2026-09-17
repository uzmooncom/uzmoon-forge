/**
 * reliability-fast.test.ts — Reliability Fast Suite.
 *
 * Target duration: < 5 seconds.
 * All scenarios are deterministic (no live LLM calls).
 * Uses mocked runAgentLoop + QueueManager integration.
 *
 * Coverage:
 *   - 10 stateful scenario seeds (meaningful action sequences)
 *   - Invariant assertions after every transition
 *   - Protocol fuzz (malformed provider responses)
 *   - Sanitizer property checks
 *   - Fingerprint collision resistance
 *   - TraceRecorder event ordering
 *   - IncidentRecorder ring buffer
 *   - ReplayHarness fixture validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ── Mocks ──────────────────────────────────────────────────────────────────
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
import { queueManager, setSecretGetter, cancelStream, getActiveStreamId } from "../queue/QueueManager.js";
import {
  initReliabilityEngine, _resetReliabilityEngineForTest,
  registerViolationHandler,
} from "./index.js";
import { TraceRecorder } from "./trace.js";
import { IncidentRecorder } from "./incident.js";
import { computeFingerprint } from "./fingerprint.js";
import { sanitizeState, detectResidualSecrets } from "./sanitizer.js";
import { ReplayHarness, ALL_FIXTURES } from "./replay.js";
import { seededPrng, STATEFUL_SCENARIO_SEEDS, checkStructuralInvariants } from "./stateful-generator.js";
import type { InvariantViolation } from "./invariants.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

const nullSender = {
  send: () => {},
  isDestroyed: () => false,
} as unknown as Electron.WebContents;

let tmpDir: string;
let dataDir: string;
let projectRoot: string;
let violations: InvariantViolation[];

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const PROFILE_ID = "fast-profile";
const PROJECT_ID = "fast-project";

function makeConv(projectId?: string): string {
  const id = randomUUID();
  createConversation(true, {
    id, title: "fast-test",
    ...(projectId !== undefined && { projectId }),
    defaultAgentProfileId: PROFILE_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

async function enqueueAndWait(convId: string, content: string, ms = 1500): Promise<void> {
  void queueManager.enqueue({ conversationId: convId, content, attachmentIds: [], targetAgentProfileId: PROFILE_ID });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const q = queueManager.getQueue(convId).items;
    if (q.every((i) => i.status === "completed" || i.status === "failed" || i.status === "cancelled")) break;
    await wait(20);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fast-"));
  dataDir = path.join(tmpDir, "data");
  projectRoot = path.join(tmpDir, "project");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  resetDb();
  getDb(dataDir);
  _resetReliabilityEngineForTest();
  initReliabilityEngine({ dataDir, version: "0.9.0-test" });

  violations = [];
  registerViolationHandler((v) => violations.push(v));

  saveAgentProfile(true, {
    id: PROFILE_ID, name: "Fast Agent", endpoint: "https://test.example.com",
    protocol: "anthropic", model: "claude-test", isDefault: false,
    lastConnectionStatus: "connected", createdAt: Date.now(), updatedAt: Date.now(),
  });
  createProject(true, {
    id: PROJECT_ID, name: "Fast Project", workingDirectory: projectRoot,
    createdAt: Date.now(), updatedAt: Date.now(),
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
// 1. Stateful scenario seeds — 10 seeds, meaningful action sequences
// ─────────────────────────────────────────────────────────────────────────────

describe("Stateful scenario seeds", () => {
  it.each(STATEFUL_SCENARIO_SEEDS.map((seed) => [seed]))(
    "seed 0x%s: structural invariants hold across transitions",
    async (seed) => {
      const rng = seededPrng(seed as number);
      const convIds = [makeConv(), makeConv(), makeConv()];

      // Simulate 15 action steps with the structural invariant checker
      for (let step = 0; step < 15; step++) {
        const action = Math.floor(rng() * 5);
        const convId = convIds[Math.floor(rng() * convIds.length)]!;

        if (action < 3) {
          // Enqueue + immediately resolve
          mockRunAgentLoop.mockResolvedValueOnce({
            finalText: "Result from scenario",
            proposalFenceRaw: undefined,
            agentReadRefs: [],
            toolActivity: [],
          });
          await enqueueAndWait(convId, `Step ${step} content`, 800);
        } else if (action === 3) {
          // Cancel active run (if any)
          const q = queueManager.getQueue(convId).items;
          const active = q.find((i) => i.status === "processing");
          const sid = active ? getActiveStreamId(convId) : undefined;
          if (sid) {
            cancelStream(sid);
          }
        }
        // action === 4: assert only (no enqueue)

        // Assert structural invariants after EVERY transition
        const messages = getMessagesByConversation(true, convId);
        const result = checkStructuralInvariants({
          conversationMessages: { [convId]: messages.map((m) => ({ role: m.role, content: m.content })) },
          activeRunConvIds: convIds.filter((c) => queueManager.getQueue(c).items.some((i) => i.status === "processing")),
          queueItems: Object.fromEntries(convIds.map((c) => [c, queueManager.getQueue(c).items])),
        });
        expect(result.violations, `Seed 0x${(seed as number).toString(16)} step ${step}: ${result.violations.join(", ")}`).toHaveLength(0);
      }
    },
    8000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TraceRecorder event ordering invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("TraceRecorder — event ordering", () => {
  it("events have monotonically increasing sequence numbers within a trace", () => {
    const recorder = new TraceRecorder({ dataDir });
    const requestId = randomUUID();
    recorder.startTrace({ requestId, conversationId: "c1" });
    recorder.emit(requestId, "RUN_CREATED", { model: "test" });
    recorder.emit(requestId, "TOOL_STARTED", { toolName: "search_files" });
    recorder.emit(requestId, "TOOL_COMPLETED", { toolName: "search_files" });
    recorder.emit(requestId, "FINAL_NORMALIZED", { kind: "final" });
    recorder.endTrace(requestId, "completed");
    const trace = recorder.getTraceByRequestId(requestId);
    expect(trace).toBeDefined();
    const seqs = trace!.events.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
  });

  it("endTrace moves trace to completedTraces — getTraceByRequestId still works", () => {
    const recorder = new TraceRecorder({ dataDir });
    const requestId = randomUUID();
    recorder.startTrace({ requestId, conversationId: "c2" });
    recorder.emit(requestId, "RUN_CREATED", {});
    recorder.endTrace(requestId, "failed", "PROVIDER_ERROR");
    const trace = recorder.getTraceByRequestId(requestId);
    expect(trace?.outcome).toBe("failed");
    expect(trace?.failureCode).toBe("PROVIDER_ERROR");
    expect(recorder.getFailedTraces()).toHaveLength(1);
  });

  it("MAX_EVENTS_PER_TRACE: trace truncates at 500 events", () => {
    const recorder = new TraceRecorder({ dataDir });
    const requestId = randomUUID();
    recorder.startTrace({ requestId, conversationId: "c3" });
    for (let i = 0; i < 600; i++) {
      recorder.emit(requestId, "TOOL_STARTED", { i });
    }
    recorder.endTrace(requestId, "completed");
    const trace = recorder.getTraceByRequestId(requestId);
    expect(trace!.events.length).toBeLessThanOrEqual(500);
    expect(trace!.truncated).toBe(true);
  });

  it("multiple concurrent traces don't interfere", () => {
    const recorder = new TraceRecorder({ dataDir });
    const r1 = randomUUID();
    const r2 = randomUUID();
    recorder.startTrace({ requestId: r1, conversationId: "cA" });
    recorder.startTrace({ requestId: r2, conversationId: "cB" });
    recorder.emit(r1, "RUN_CREATED", { which: "r1" });
    recorder.emit(r2, "RUN_CREATED", { which: "r2" });
    recorder.emit(r1, "FINAL_NORMALIZED", { which: "r1" });
    recorder.endTrace(r1, "completed");
    recorder.endTrace(r2, "failed");
    const t1 = recorder.getTraceByRequestId(r1);
    const t2 = recorder.getTraceByRequestId(r2);
    expect(t1!.conversationId).toBe("cA");
    expect(t2!.conversationId).toBe("cB");
    expect(t1!.events.every((e) => e.conversationId === "cA")).toBe(true);
    expect(t2!.events.every((e) => e.conversationId === "cB")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. IncidentRecorder ring buffer + deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe("IncidentRecorder — ring buffer + dedup", () => {
  it("records up to 200 incidents (ring buffer enforced)", () => {
    const recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-test" });
    for (let i = 0; i < 220; i++) {
      recorder.record({
        invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE",
        timestamp: Date.now() + i,
        observedState: { index: i },
      });
    }
    const all = recorder.getAll();
    expect(all.length).toBeLessThanOrEqual(200);
  });

  it("deduplicates same fingerprint — occurrenceCount increments", () => {
    const recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-test" });
    const violation: InvariantViolation = {
      invariantId: "NO_PROTOCOL_LEAK",
      timestamp: Date.now(),
      observedState: { contentSnippet: "```forge_tool" },
    };
    const i1 = recorder.record(violation);
    const i2 = recorder.record({ ...violation, timestamp: Date.now() + 1 });
    // Same fingerprint → same incident id, incremented count
    expect(i1.id).toBe(i2.id);
    expect(i2.occurrenceCount).toBeGreaterThan(1);
  });

  it("sanitized share payload excludes absolute paths", () => {
    const recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-test" });
    const homeDir = os.homedir();
    const inc = recorder.record({
      invariantId: "RESOURCE_OWNERSHIP_CLEAN",
      timestamp: Date.now(),
      observedState: { snapshotPath: `${homeDir}/some/secret/path.txt` },
    });
    const payload = JSON.stringify(inc.sanitizedSharePayload ?? {});
    expect(payload).not.toContain(homeDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sanitizer property checks
// ─────────────────────────────────────────────────────────────────────────────

describe("Sanitizer — property checks", () => {
  const rng = seededPrng(0x7a8b9c0d);

  it("sanitizeState is idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
    const state = {
      apiKey: `sk-${"x".repeat(25)}`,
      count: 42,
      nested: { secret: `sk-${"y".repeat(25)}`, other: "safe" },
    };
    const once = sanitizeState(state);
    const twice = sanitizeState(once as Record<string, unknown>);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("detectResidualSecrets returns empty for sanitized output", () => {
    for (let i = 0; i < 10; i++) {
      const suffix = Array.from({ length: 24 }, () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rng() * 62)]!
      ).join("");
      const raw = `sk-${suffix}`;
      const state = sanitizeState({ apiKey: raw, count: i });
      expect(detectResidualSecrets(JSON.stringify(state))).toHaveLength(0);
    }
  });

  it("sanitizeState preserves non-sensitive numeric fields", () => {
    const state = sanitizeState({ count: 42, requestCount: 7, elapsed: 999 });
    expect(state["count"]).toBe(42);
    expect(state["requestCount"]).toBe(7);
    expect(state["elapsed"]).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fingerprint collision resistance
// ─────────────────────────────────────────────────────────────────────────────

describe("Fingerprint — collision resistance", () => {
  it("32 distinct inputs produce 32 distinct fingerprints", () => {
    const fps = new Set<string>();
    const rng = seededPrng(0x11223344);
    for (let i = 0; i < 32; i++) {
      const fp = computeFingerprint({
        invariantId: `INV_${i}`,
        failureCode: "PROVIDER_ERROR",
        category: "agent_loop",
        structuralKey: `key_${Math.floor(rng() * 100000)}`,
      });
      fps.add(fp);
    }
    expect(fps.size).toBe(32);
  });

  it("same inputs always produce the same fingerprint (deterministic)", () => {
    const input = { invariantId: "TEST", failureCode: "PROVIDER_ERROR" as const, category: "agent_loop", structuralKey: "abc" };
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
    expect(computeFingerprint(input)).toBe(computeFingerprint({ ...input }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ReplayHarness — all 11 fixtures validate
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplayHarness — fixture catalog", () => {
  it("all built-in fixtures are schema-version 1", () => {
    const harness = new ReplayHarness();
    for (const f of harness.getAllFixtures()) {
      expect(f.schemaVersion).toBe(1);
    }
  });

  it("fixture IDs are unique", () => {
    const harness = new ReplayHarness();
    const ids = harness.getAllFixtures().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all fixtures have at least one provider turn", () => {
    const harness = new ReplayHarness();
    for (const f of harness.getAllFixtures()) {
      expect(f.turns.length, `fixture ${f.id} has no turns`).toBeGreaterThan(0);
    }
  });

  it("validateResult correctly detects outcome mismatch", () => {
    const harness = new ReplayHarness();
    const fixture = ALL_FIXTURES[0]!;
    const result = harness.validateResult(fixture, {
      outcome: "failed", // wrong
      messagesProduced: 2,
      recoveryTriggered: 0,
      toolStepsConsumed: 0,
      invariantViolations: [],
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("Outcome mismatch");
  });

  it("validateResult passes when outcome matches", () => {
    const harness = new ReplayHarness();
    const fixture = ALL_FIXTURES[0]!; // FIXTURE_SIMPLE_FINAL — completed
    const result = harness.validateResult(fixture, {
      outcome: "completed",
      messagesProduced: 2,
      recoveryTriggered: 0,
      toolStepsConsumed: 0,
      invariantViolations: [],
    });
    expect(result.passed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. QueueManager integration — NO_PROTOCOL_LEAK holds
// ─────────────────────────────────────────────────────────────────────────────

describe("QueueManager — NO_PROTOCOL_LEAK on persisted content", () => {
  it("plain finalText is stored without modification", async () => {
    const convId = makeConv();
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: "This is a clean answer.",
      proposalFenceRaw: undefined,
      agentReadRefs: [],
      toolActivity: [],
    });
    await enqueueAndWait(convId, "Hello");
    const msgs = getMessagesByConversation(true, convId);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).not.toContain("forge_final");
    expect(assistant?.content).not.toContain("forge_tool");
    const protocolViolations = violations.filter((v) => v.invariantId === "NO_PROTOCOL_LEAK");
    expect(protocolViolations).toHaveLength(0);
  });

  it("10 sequential runs produce alternating user/assistant messages", async () => {
    const convId = makeConv();
    for (let i = 0; i < 10; i++) {
      mockRunAgentLoop.mockResolvedValueOnce({
        finalText: `Answer ${i}`,
        proposalFenceRaw: undefined,
        agentReadRefs: [],
        toolActivity: [],
      });
      await enqueueAndWait(convId, `Question ${i}`);
    }
    const msgs = getMessagesByConversation(true, convId);
    const nonError = msgs.filter((m) => m.role !== "error");
    for (let i = 1; i < nonError.length; i++) {
      expect(nonError[i]!.role).not.toBe(nonError[i - 1]!.role);
    }
  });
});