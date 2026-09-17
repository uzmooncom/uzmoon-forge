/**
 * trace.test.ts — TraceRecorder tests.
 * Uses the actual TraceRecorder API:
 *   - startTrace({ requestId, conversationId, projectId? }) → traceId
 *   - emit(requestId, kind, meta, opts?) — indexed by requestId
 *   - endTrace(requestId, outcome, failureCode?) → AgentRunTrace | null
 *   - getTraceByRequestId(requestId) → AgentRunTrace | undefined
 *   - getTraceById(traceId) → AgentRunTrace | undefined
 *   - getCompletedTraces() → AgentRunTrace[]
 *   - getFailedTraces() → AgentRunTrace[]
 *   - clear()
 */

import { describe, it, expect, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { TraceRecorder } from "./trace.js";

const TMP_DIR = path.join(os.tmpdir(), `forge-trace-test-${Date.now()}`);

function makeTracer() {
  return new TraceRecorder({ dataDir: TMP_DIR });
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  try {
    const dir = path.join(TMP_DIR, "traces");
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch { /* ignore */ }
});

describe("TraceRecorder — startTrace", () => {
  it("creates a new active trace and returns traceId", () => {
    const tracer = makeTracer();
    const traceId = tracer.startTrace({
      requestId: "req-001",
      conversationId: "conv-001",
    });
    expect(typeof traceId).toBe("string");
    expect(traceId.length).toBeGreaterThan(0);
  });

  it("allows multiple concurrent active traces for different requests", () => {
    const tracer = makeTracer();
    const id1 = tracer.startTrace({ requestId: "req-001", conversationId: "c1" });
    const id2 = tracer.startTrace({ requestId: "req-002", conversationId: "c2" });
    expect(id1).not.toBe(id2);
  });

  it("getTraceByRequestId returns active trace", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    const trace = tracer.getTraceByRequestId("req-001");
    expect(trace).toBeDefined();
    expect(trace!.requestId).toBe("req-001");
    expect(trace!.outcome).toBe("in_progress");
  });
});

describe("TraceRecorder — emit", () => {
  it("records events for an active trace (by requestId)", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.emit("req-001", "RUN_CREATED", { model: "claude-3.5" });
    tracer.emit("req-001", "TOOL_STARTED", { name: "read_file", callId: "c1" });
    tracer.emit("req-001", "TOOL_COMPLETED", { callId: "c1", ok: true });

    const trace = tracer.getTraceByRequestId("req-001");
    expect(trace).toBeDefined();
    expect(trace!.events.length).toBe(3);
    expect(trace!.events[0]!.kind).toBe("RUN_CREATED");
    expect(trace!.events[1]!.kind).toBe("TOOL_STARTED");
    expect(trace!.events[2]!.kind).toBe("TOOL_COMPLETED");
  });

  it("does not throw for unknown requestId (silently ignores)", () => {
    const tracer = makeTracer();
    expect(() => tracer.emit("nonexistent-request", "RUN_CREATED", {})).not.toThrow();
  });

  it("records event timestamps", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    const before = Date.now();
    tracer.emit("req-001", "RUN_CREATED", {});
    const after = Date.now();
    const trace = tracer.getTraceByRequestId("req-001");
    const ts = trace!.events[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("caps events at MAX_EVENTS_PER_TRACE and sets truncated=true", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    // Emit 510 events — should cap at 500
    for (let i = 0; i < 510; i++) {
      tracer.emit("req-001", "TOOL_STARTED", { i });
    }
    const trace = tracer.getTraceByRequestId("req-001");
    expect(trace!.events.length).toBeLessThanOrEqual(500);
    expect(trace!.truncated).toBe(true);
  });

  it("sanitizes sk- prefixed keys when nested inside an object value", () => {
    // sanitizeState calls sanitizeValue per field value — nested object keys
    // matching SENSITIVE_KEYS are redacted
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    // Use a nested object so SENSITIVE_KEYS check applies
    tracer.emit("req-001", "RUN_CREATED", { credentials: { apiKey: "sk-secret-key" }, model: "gpt-4o" });
    const trace = tracer.getTraceByRequestId("req-001");
    const metaStr = JSON.stringify(trace!.events[0]!.meta);
    expect(metaStr).not.toContain("sk-secret-key");
  });

  it("redacts Bearer tokens in string values via sanitizeString", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.emit("req-001", "RUN_CREATED", { authHeader: "Bearer sk-abc123def456ghi789" });
    const trace = tracer.getTraceByRequestId("req-001");
    const metaStr = JSON.stringify(trace!.events[0]!.meta);
    expect(metaStr).not.toContain("Bearer sk-abc123def456ghi789");
  });
});

describe("TraceRecorder — endTrace", () => {
  it("moves trace from active to completed", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.emit("req-001", "RUN_CREATED", {});
    const result = tracer.endTrace("req-001", "completed");

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("completed");
    // After endTrace: getTraceByRequestId searches completed traces too
    const lookup = tracer.getTraceByRequestId("req-001");
    expect(lookup).toBeDefined();
    expect(lookup!.outcome).toBe("completed");
    // Confirm it is in getCompletedTraces
    expect(tracer.getCompletedTraces().some((t) => t.requestId === "req-001")).toBe(true);
  });

  it("sets endedAt on endTrace", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    const before = Date.now();
    const result = tracer.endTrace("req-001", "failed", "PROVIDER_ERROR");
    const after = Date.now();

    expect(result!.endedAt).toBeGreaterThanOrEqual(before);
    expect(result!.endedAt!).toBeLessThanOrEqual(after);
  });

  it("records failure code on failed outcome", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.endTrace("req-001", "failed", "PROTOCOL_RECOVERY_EXHAUSTED");
    const completed = tracer.getCompletedTraces();
    expect(completed.length).toBe(1);
    expect(completed[0]!.outcome).toBe("failed");
    expect(completed[0]!.failureCode).toBe("PROTOCOL_RECOVERY_EXHAUSTED");
  });

  it("returns null for unknown requestId on endTrace", () => {
    const tracer = makeTracer();
    const result = tracer.endTrace("nonexistent", "completed");
    expect(result).toBeNull();
  });
});

describe("TraceRecorder — completed traces ring buffer", () => {
  it("caps completed traces at MAX_STORED_TRACES", () => {
    const tracer = makeTracer();
    for (let i = 0; i < 55; i++) {
      tracer.startTrace({ requestId: `req-${i}`, conversationId: `conv-${i}` });
      tracer.endTrace(`req-${i}`, "completed");
    }
    const all = tracer.getCompletedTraces();
    expect(all.length).toBeLessThanOrEqual(50);
  });

  it("evicts oldest completed traces when buffer full", () => {
    const tracer = makeTracer();
    // First trace
    tracer.startTrace({ requestId: "req-first", conversationId: "conv-first" });
    tracer.endTrace("req-first", "completed");
    const firstTraceId = tracer.getCompletedTraces()[0]!.traceId;

    // Push 50 more to fill and evict
    for (let i = 0; i < 50; i++) {
      tracer.startTrace({ requestId: `req-fill-${i}`, conversationId: `conv-${i}` });
      tracer.endTrace(`req-fill-${i}`, "completed");
    }

    // firstId should be evicted
    const stillPresent = tracer.getCompletedTraces().some((t) => t.traceId === firstTraceId);
    expect(stillPresent).toBe(false);
  });
});

describe("TraceRecorder — accessors", () => {
  it("getTraceByRequestId returns undefined for nonexistent", () => {
    const tracer = makeTracer();
    expect(tracer.getTraceByRequestId("xyz")).toBeUndefined();
  });

  it("getTraceById returns undefined for nonexistent", () => {
    const tracer = makeTracer();
    expect(tracer.getTraceById("xyz")).toBeUndefined();
  });

  it("getCompletedTraces returns empty array initially", () => {
    const tracer = makeTracer();
    expect(tracer.getCompletedTraces()).toHaveLength(0);
  });

  it("getTraceById works for an active trace", () => {
    const tracer = makeTracer();
    const traceId = tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    const trace = tracer.getTraceById(traceId);
    expect(trace).toBeDefined();
    expect(trace!.traceId).toBe(traceId);
  });

  it("getFailedTraces returns only failed traces", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-a", conversationId: "conv-a" });
    tracer.endTrace("req-a", "failed", "PROVIDER_ERROR");
    tracer.startTrace({ requestId: "req-b", conversationId: "conv-b" });
    tracer.endTrace("req-b", "completed");
    const failed = tracer.getFailedTraces();
    expect(failed.length).toBe(1);
    expect(failed[0]!.outcome).toBe("failed");
  });
});

describe("TraceRecorder — clear()", () => {
  it("empties completed traces", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.endTrace("req-001", "completed");
    tracer.clear();
    expect(tracer.getCompletedTraces()).toHaveLength(0);
  });
});

describe("TraceRecorder — eventCount field", () => {
  it("eventCount matches events.length", () => {
    const tracer = makeTracer();
    tracer.startTrace({ requestId: "req-001", conversationId: "conv-001" });
    tracer.emit("req-001", "RUN_CREATED", {});
    tracer.emit("req-001", "TOOL_STARTED", { name: "read_file" });
    const trace = tracer.getTraceByRequestId("req-001");
    expect(trace!.eventCount).toBe(trace!.events.length);
    expect(trace!.eventCount).toBe(2);
  });
});