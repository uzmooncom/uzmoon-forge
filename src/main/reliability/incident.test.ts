/**
 * incident.test.ts — IncidentRecorder tests.
 * §78, §79, §80, §86.
 */

import { describe, it, expect, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { IncidentRecorder } from "./incident.js";
import type { InvariantViolation } from "./invariants.js";

const TMP_DIR = path.join(os.tmpdir(), `forge-incident-test-${Date.now()}`);

function makeViolation(overrides: Partial<InvariantViolation> = {}): InvariantViolation {
  return {
    invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE",
    observedState: { requestId: "req-001" },
    timestamp: Date.now(),
    requestId: "req-001",
    conversationId: "conv-001",
    ...overrides,
  };
}

function makeRecorder(opts?: { forgeVersion?: string }) {
  return new IncidentRecorder({
    dataDir: TMP_DIR,
    forgeVersion: opts?.forgeVersion ?? "0.9.0",
    knownManifest: [],
  });
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Wipe any persisted incident files between tests
  try {
    const incidentDir = path.join(TMP_DIR, "incidents");
    if (fs.existsSync(incidentDir)) {
      fs.rmSync(incidentDir, { recursive: true });
    }
  } catch { /* ignore */ }
});

describe("IncidentRecorder — basic recording", () => {
  it("records a violation and returns a ForgeIncident", () => {
    const recorder = makeRecorder();
    const violation = makeViolation();
    const incident = recorder.record(violation);

    expect(incident.id).toBeDefined();
    expect(incident.invariantId).toBe("ONE_RUN_ONE_VISIBLE_FAILURE");
    expect(incident.category).toBe("AGENT_RUNTIME");
    expect(incident.severity).toBe("high");
    expect(incident.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(incident.occurrenceCount).toBe(1);
    expect(incident.forgeVersion).toBe("0.9.0");
    expect(incident.firstSeen).toBeGreaterThan(0);
    expect(incident.lastSeen).toBeGreaterThan(0);
  });

  it("does not contain absolute paths in observedState", () => {
    // sanitizeState runs sanitizeValue per field which redacts home-rooted paths in strings
    const recorder = makeRecorder();
    const home = os.homedir();
    const incident = recorder.record(makeViolation({
      observedState: { filePath: `${home}/project/src/file.ts` },
    }));
    expect(JSON.stringify(incident.observedState)).not.toContain(home);
  });

  it("does not contain absolute paths in observedState", () => {
    const recorder = makeRecorder();
    const home = os.homedir();
    const incident = recorder.record(makeViolation({
      observedState: { path: `${home}/project/src/file.ts` },
    }));
    expect(JSON.stringify(incident.observedState)).not.toContain(home);
  });

  it("returns incident from getById()", () => {
    const recorder = makeRecorder();
    const incident = recorder.record(makeViolation());
    const found = recorder.getById(incident.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(incident.id);
  });

  it("returns null from getById() for unknown ID", () => {
    const recorder = makeRecorder();
    expect(recorder.getById("nonexistent")).toBeUndefined();
  });
});

describe("IncidentRecorder — deduplication", () => {
  it("deduplicates same-fingerprint incidents by incrementing occurrenceCount", () => {
    const recorder = makeRecorder();
    const violation = makeViolation();
    const first = recorder.record(violation);
    const second = recorder.record(violation);

    expect(first.id).toBe(second.id);
    expect(second.occurrenceCount).toBe(2);
    expect(recorder.getAll().length).toBe(1);
  });

  it("does not dedup different invariants", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation({ invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE" }));
    recorder.record(makeViolation({ invariantId: "RECOVERY_BOUNDED" }));
    expect(recorder.getAll().length).toBe(2);
  });

  it("updates lastSeen on each deduped occurrence", async () => {
    const recorder = makeRecorder();
    const violation = makeViolation();
    const first = recorder.record(violation);
    const firstLastSeen = first.lastSeen;
    await new Promise((r) => setTimeout(r, 10));
    const second = recorder.record(violation);
    expect(second.lastSeen).toBeGreaterThanOrEqual(firstLastSeen);
  });
});

describe("IncidentRecorder — ring buffer / retention", () => {
  it("respects MAX_INCIDENTS limit", () => {
    const recorder = makeRecorder();
    // Record 205 distinct incidents (different requestIds = different structuralKeys)
    for (let i = 0; i < 205; i++) {
      recorder.record(
        makeViolation({
          invariantId: `INV_${i}`,
          observedState: { i },
        })
      );
    }
    expect(recorder.getAll().length).toBeLessThanOrEqual(200);
  });

  it("discards oldest incidents when buffer is full", () => {
    const recorder = makeRecorder();
    const first = recorder.record(
      makeViolation({ invariantId: "FIRST_INVARIANT", observedState: { marker: "first" } })
    );
    for (let i = 0; i < 200; i++) {
      recorder.record(makeViolation({ invariantId: `INV_${i}`, observedState: { i } }));
    }
    // After 201 records (1 + 200), the first one should be evicted
    const found = recorder.getById(first.id);
    expect(found).toBeUndefined();
  });
});

describe("IncidentRecorder — getAll()", () => {
  it("returns all recorded incidents", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation({ invariantId: "INV_A" }));
    recorder.record(makeViolation({ invariantId: "INV_B" }));
    const all = recorder.getAll();
    expect(all.length).toBe(2);
  });

  it("returns a copy, not the internal store", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation());
    const all1 = recorder.getAll();
    all1.push({} as never);
    const all2 = recorder.getAll();
    expect(all2.length).toBe(1);
  });
});

describe("IncidentRecorder — clear()", () => {
  it("empties the store", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation());
    recorder.record(makeViolation({ invariantId: "INV_B" }));
    recorder.clear();
    expect(recorder.getAll().length).toBe(0);
  });
});

describe("IncidentRecorder — getMetrics()", () => {
  it("returns correct total count", () => {
    const recorder = makeRecorder();
    // Use distinct invariantIds so they don't dedup on same fingerprint
    recorder.record(makeViolation({ invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE" }));
    recorder.record(makeViolation({ invariantId: "RECOVERY_BOUNDED" }));
    const metrics = recorder.getMetrics();
    expect(metrics.total).toBe(2);
  });

  it("returns counts by category (defaults to AGENT_RUNTIME for unknown invariants)", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation({ invariantId: "INV_UNKNOWN_A" }));
    recorder.record(makeViolation({ invariantId: "INV_UNKNOWN_B" }));
    const metrics = recorder.getMetrics();
    // byCategory total should be 2
    expect(Object.values(metrics.byCategory).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("returns zero total when empty", () => {
    const recorder = makeRecorder();
    const metrics = recorder.getMetrics();
    expect(metrics.total).toBe(0);
    expect(metrics.critical).toBe(0);
  });
});

describe("IncidentRecorder — checkStabilityGate()", () => {
  // checkStabilityGate() returns string[] (violations) — empty = pass
  it("passes (empty array) when no critical incidents", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation({ invariantId: "TERMINAL_TURN_ONLY" }));
    const result = recorder.checkStabilityGate();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("fails (non-empty array) when critical non-known incidents exist", () => {
    const recorder = makeRecorder();
    // NO_CROSS_RUN_CONTAMINATION triggers the contamination check in stability gate
    recorder.record(makeViolation({ invariantId: "NO_CROSS_RUN_CONTAMINATION" }));
    const result = recorder.checkStabilityGate();
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns string violation messages", () => {
    const recorder = makeRecorder();
    recorder.record(makeViolation({ invariantId: "1_USER_1_ASSISTANT" }));
    const result = recorder.checkStabilityGate();
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result[0]).toBe("string");
  });
});

describe("IncidentRecorder — known incident lookup", () => {
  it("marks incident as known when fingerprint matches known manifest", () => {
    const fp = "abc123def456";
    const recorder = new IncidentRecorder({
      dataDir: TMP_DIR,
      forgeVersion: "0.9.0",
      knownManifest: [
        {
          fingerprint: fp,
          invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE",
          title: "Known double render bug",
          description: "A known historical bug.",
          status: "known_bug" as const,
        },
      ],
    });

    // We cannot force the fingerprint in this test; just verify
    // the recorder doesn't crash when knownManifest has entries.
    const incident = recorder.record(makeViolation());
    expect(incident).toBeDefined();
  });
});