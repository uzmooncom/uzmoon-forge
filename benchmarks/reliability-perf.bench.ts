/**
 * benchmarks/reliability-perf.bench.ts
 *
 * Fingerprint, sanitizer, and incident recorder performance benchmarks.
 *
 * Run with:  pnpm vitest bench benchmarks/reliability-perf.bench.ts
 *
 * Measures:
 *   - computeFingerprint() throughput
 *   - buildDedupeKey() throughput
 *   - sanitizeString() for 1KB, 10KB, 100KB inputs
 *   - sanitizeState() for nested objects
 *   - IncidentRecorder.record() overhead (in-memory, disk mocked)
 *   - IncidentRecorder.getAll() for 200-item ring buffer
 *   - TraceRecorder.emit() per-event overhead
 *
 * Targets (CI green):
 *   - computeFingerprint(): < 5ms per call
 *   - sanitizeString(1KB): < 1ms per call
 *   - sanitizeString(100KB): < 10ms per call
 *   - IncidentRecorder.record(): < 5ms per call
 *   - TraceRecorder.emit(): < 1ms per event
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { computeFingerprint, buildDedupeKey } from "../src/main/reliability/fingerprint.js";
import { sanitizeString, sanitizeState } from "../src/main/reliability/sanitizer.js";
import { IncidentRecorder } from "../src/main/reliability/incident.js";
import { TraceRecorder } from "../src/main/reliability/trace.js";

let tmpDir: string;
let dataDir: string;
let recorder: IncidentRecorder;
let tracer: TraceRecorder;

const SAMPLE_STATE = {
  conversationId: "conv-abc123",
  requestId: "req-xyz789",
  model: "claude-test",
  toolName: "read_file",
  filePath: "/Users/user/project/src/index.ts",
  content: "const x = 1;",
  nested: {
    apiKey: "sk-live_key_secret_value_here_12345",
    normal: "fine value",
    deep: {
      path: "/Users/user/.ssh/id_rsa",
      ok: 42,
    },
  },
};

const STR_1KB = "a".repeat(1024);
const STR_10KB = "a".repeat(10240);
const STR_100KB = "a".repeat(102400);
const SECRET_FRAGMENT = "sk-" + "a".repeat(24);
const STR_WITH_SECRETS = `start ${SECRET_FRAGMENT} middle /Users/user/project/secret.ts end`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bench-rel-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
  recorder = new IncidentRecorder({ dataDir, forgeVersion: "0.9.0-bench" });
  tracer = new TraceRecorder({ dataDir });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("fingerprint performance", () => {
  bench(
    "computeFingerprint() — 12-hex SHA-256 truncated",
    () => {
      computeFingerprint({
        invariantId: "NO_PROTOCOL_LEAK",
        failureCode: "PROTOCOL_RECOVERY_EXHAUSTED",
        category: "protocol",
        structuralKey: "project-mode-naked-prose",
      });
    },
    { iterations: 1000, warmupIterations: 50 }
  );

  bench(
    "buildDedupeKey() — same input as computeFingerprint",
    () => {
      buildDedupeKey({
        invariantId: "1_USER_1_ASSISTANT",
        failureCode: "INVALID_STATE_TRANSITION",
        category: "protocol",
      });
    },
    { iterations: 1000, warmupIterations: 50 }
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizer performance", () => {
  bench(
    "sanitizeString() — 1KB clean input",
    () => {
      sanitizeString(STR_1KB);
    },
    { iterations: 5000, warmupIterations: 100 }
  );

  bench(
    "sanitizeString() — 10KB clean input",
    () => {
      sanitizeString(STR_10KB);
    },
    { iterations: 2000, warmupIterations: 50 }
  );

  bench(
    "sanitizeString() — 100KB clean input",
    () => {
      sanitizeString(STR_100KB);
    },
    { iterations: 200, warmupIterations: 10 }
  );

  bench(
    "sanitizeString() — 1KB with embedded secret + path",
    () => {
      sanitizeString(STR_WITH_SECRETS);
    },
    { iterations: 5000, warmupIterations: 100 }
  );

  bench(
    "sanitizeState() — nested object (5 keys, 2 levels deep)",
    () => {
      sanitizeState(SAMPLE_STATE);
    },
    { iterations: 2000, warmupIterations: 50 }
  );

  bench(
    "sanitizeState() — 50-key flat object",
    () => {
      const flat: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) flat[`key${i}`] = `value-${i}`;
      sanitizeState(flat);
    },
    { iterations: 500, warmupIterations: 20 }
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IncidentRecorder performance", () => {
  const invariants = [
    "ONE_RUN_ONE_VISIBLE_FAILURE",
    "NO_PROTOCOL_LEAK",
    "RESOURCE_OWNERSHIP_CLEAN",
    "1_USER_1_ASSISTANT",
    "SNAPSHOT_IMMUTABLE",
  ];
  let callCount = 0;

  bench(
    "IncidentRecorder.record() — first occurrence (new incident)",
    () => {
      callCount++;
      recorder.record({
        invariantId: invariants[callCount % invariants.length]!,
        timestamp: Date.now(),
        observedState: { index: callCount, uniqueKey: `bench-${callCount}-${randomUUID()}` },
      });
    },
    { iterations: 200, warmupIterations: 10 }
  );

  bench(
    "IncidentRecorder.record() — dedup path (same fingerprint)",
    () => {
      // Record same violation repeatedly — dedup increments occurrenceCount
      recorder.record({
        invariantId: "NO_PROTOCOL_LEAK",
        timestamp: Date.now(),
        observedState: { dedup: "constant" }, // same → dedup
      });
    },
    { iterations: 500, warmupIterations: 20 }
  );

  bench(
    "IncidentRecorder.getAll() — 200-item ring buffer scan",
    () => {
      recorder.getAll();
    },
    { iterations: 2000, warmupIterations: 100 }
  );

  bench(
    "IncidentRecorder.checkStabilityGate() — 200-item scan",
    () => {
      recorder.checkStabilityGate();
    },
    { iterations: 2000, warmupIterations: 100 }
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe("TraceRecorder performance", () => {
  bench(
    "TraceRecorder.emit() — single event on active trace",
    () => {
      const requestId = randomUUID();
      tracer.startTrace({ requestId, conversationId: "bench-conv" });
      tracer.emit(requestId, "TOOL_STARTED", { toolName: "read_file" });
      tracer.emit(requestId, "TOOL_COMPLETED", { toolName: "read_file", durationMs: 5 });
      tracer.emit(requestId, "FINAL_NORMALIZED", { kind: "final" });
      tracer.endTrace(requestId, "completed");
    },
    { iterations: 500, warmupIterations: 20 }
  );

  bench(
    "TraceRecorder.getCompletedTraces() — after 50 traces",
    () => {
      tracer.getCompletedTraces();
    },
    { iterations: 5000, warmupIterations: 100 }
  );
});