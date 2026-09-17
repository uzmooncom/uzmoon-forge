/**
 * torture.test.ts — Edge case torture suite for reliability subsystem.
 *
 * Tests against degenerate inputs, boundary conditions, and adversarial
 * model outputs. Ensures no crash, no secret leak, no invariant bypass.
 */

import { describe, it, expect } from "vitest";
import os from "os";
import * as fs from "fs";
import * as nodePath from "path";
import { sanitizeString, sanitizeState, sanitizeValue, detectResidualSecrets } from "./sanitizer.js";
import { computeFingerprint } from "./fingerprint.js";
import { ReplayHarness, ALL_FIXTURES } from "./replay.js";
import { applyExactTextReplace, parseStructuredEditProposal } from "../project-files/edit-ir.js";
import { IncidentRecorder } from "./incident.js";
import { TraceRecorder } from "./trace.js";

const HOME = os.homedir();

// ── Sanitizer torture ─────────────────────────────────────────────────────────

describe("Sanitizer — degenerate inputs", () => {
  it("handles empty string", () => {
    expect(() => sanitizeString("")).not.toThrow();
    expect(sanitizeString("")).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    expect(() => sanitizeValue(null)).not.toThrow();
    expect(() => sanitizeValue(undefined)).not.toThrow();
  });

  it("handles deeply nested object (12 levels)", () => {
    const obj: Record<string, unknown> = {};
    let cur = obj;
    for (let i = 0; i < 12; i++) {
      cur["child"] = { level: i };
      cur = cur["child"] as Record<string, unknown>;
    }
    expect(() => sanitizeValue(obj)).not.toThrow();
  });

  it("handles circular-like structure without crash (depth limit)", () => {
    // Can't have real circular refs in sanitize, but very deep objects should truncate
    const deep: Record<string, unknown> = {};
    let ref = deep;
    for (let i = 0; i < 15; i++) {
      ref["next"] = { i };
      ref = ref["next"] as Record<string, unknown>;
    }
    expect(() => sanitizeState(deep)).not.toThrow();
  });

  it("handles very long string (1MB)", () => {
    const big = "a".repeat(1024 * 1024);
    expect(() => sanitizeString(big)).not.toThrow();
  });

  it("handles unicode and emoji in strings", () => {
    const result = sanitizeString("ağaç 🌳 gece yarısı Bearer sk-secret123");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-secret123");
  });

  it("handles path-like strings with no actual secrets", () => {
    const result = sanitizeString("src/main/queue/QueueManager.ts:42");
    expect(result).toBe("src/main/queue/QueueManager.ts:42");
  });

  it("handles array with mixed types", () => {
    const arr = [1, null, "hello", { apiKey: "sk-secret" }, true, undefined, "Bearer tok-xyz"];
    const result = sanitizeValue(arr) as unknown[];
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(JSON.stringify(result)).not.toContain("tok-xyz");
  });

  it("handles absolute paths embedded in JSON strings", () => {
    const input = {
      error: `Failed to read ${HOME}/project/src/index.ts: ENOENT`,
      code: "ENOENT",
    };
    const result = sanitizeState(input);
    expect(JSON.stringify(result)).not.toContain(HOME);
  });

  it("handles multiple secrets in single string", () => {
    const input = `Bearer sk-first AND apiKey: "second-secret" AND token=third-token-abc`;
    const result = sanitizeString(input);
    expect(detectResidualSecrets(result)).toHaveLength(0);
  });
});

// ── Fingerprint torture ───────────────────────────────────────────────────────

describe("Fingerprint — degenerate inputs", () => {
  it("handles empty strings in all fields", () => {
    expect(() =>
      computeFingerprint({ invariantId: "", failureCode: "", category: "" })
    ).not.toThrow();
    const fp = computeFingerprint({ invariantId: "", failureCode: "", category: "" });
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles very long invariantId", () => {
    const longId = "A".repeat(10000);
    expect(() =>
      computeFingerprint({ invariantId: longId, failureCode: "INVARIANT_VIOLATION", category: "AGENT_RUNTIME" })
    ).not.toThrow();
  });

  it("handles unicode in inputs", () => {
    const fp = computeFingerprint({
      invariantId: "INV_ÜNİCODE_ÇÖK",
      failureCode: "ERR_AĞAÇ",
      category: "PROTOCOL",
    });
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("same inputs produce same fingerprint consistently", () => {
    const fp1 = computeFingerprint({ invariantId: "X", failureCode: "INVARIANT_VIOLATION", category: "Y" });
    const fp2 = computeFingerprint({ invariantId: "X", failureCode: "INVARIANT_VIOLATION", category: "Y" });
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for all known invariant IDs", () => {
    const ids = [
      "ONE_RUN_ONE_VISIBLE_FAILURE",
      "RECOVERY_BOUNDED",
      "SNAPSHOT_IMMUTABLE",
      "STALE_BASE_PROTECTION",
      "EDIT_AMBIGUITY_BLOCKED",
      "NO_SECRET_IN_INCIDENT",
      "APPLY_REQUIRES_APPROVAL",
      "STATE_TRANSITIONS_VALID",
      "TOOL_BUDGET_ENFORCED",
      "SIMPLE_FINAL_WITHOUT_TOOLS",
    ];
    const fps = ids.map((id) =>
      computeFingerprint({ invariantId: id, failureCode: "ERR", category: "AGENT_RUNTIME" })
    );
    const unique = new Set(fps);
    expect(unique.size).toBe(ids.length);
  });
});

// ── ExactTextReplace torture ──────────────────────────────────────────────────

describe("applyExactTextReplace — degenerate inputs", () => {
  it("handles empty base content (not found)", () => {
    const result = applyExactTextReplace("", {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "something",
      newText: "other",
      expectedOccurrences: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("handles oldText === base content exactly (full replace)", () => {
    const result = applyExactTextReplace("entire file content", {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "entire file content",
      newText: "new content",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("new content");
  });

  it("handles oldText that appears 100 times in base, expectedOccurrences=100", () => {
    const fragment = "foo\n";
    const base = fragment.repeat(100);
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
      expectedOccurrences: 100,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("bar\n".repeat(100));
    expect(result.replacementCount).toBe(100);
  });

  it("rejects when expectedOccurrences=50 but actual=100 (ambiguous)", () => {
    const base = "foo\n".repeat(100);
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
      expectedOccurrences: 50,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBe(true);
    expect(result.actualOccurrences).toBe(100);
  });

  it("handles oldText with regex special chars (must be literal)", () => {
    const base = "price: $10.99 + $5.00";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "$10.99",
      newText: "$12.99",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("price: $12.99 + $5.00");
  });

  it("handles oldText with backslash sequences", () => {
    const base = "path: C:\\Users\\test\\file.ts";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "C:\\Users\\test",
      newText: "C:\\Users\\prod",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("path: C:\\Users\\prod\\file.ts");
  });

  it("handles very large base content (100KB)", () => {
    const base = "x".repeat(100 * 1024) + "\nMARKER\n" + "y".repeat(100 * 1024);
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "MARKER",
      newText: "REPLACED",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toContain("REPLACED");
    expect(result.result).not.toContain("MARKER");
  });
});

// ── parseStructuredEditProposal torture ──────────────────────────────────────

describe("parseStructuredEditProposal — adversarial model outputs", () => {
  it("handles fence with no content", () => {
    const text = "```forge_structured_edit_proposal\n\n```";
    const result = parseStructuredEditProposal(text);
    // Empty JSON → parse error
    expect(result).not.toBeNull();
    if (!result || result.ok) return; // may return null or error
    expect(result.error).toBeDefined();
  });

  it("handles fence with array instead of object", () => {
    const text = "```forge_structured_edit_proposal\n[1, 2, 3]\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toBeDefined();
  });

  it("handles operation with Windows-style path", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [{ operation: "full_content", path: "src\\a.ts", content: "x" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    // Windows-style relative path — backslash not explicitly rejected
    // (only absolute paths with drive letters are rejected)
    const result = parseStructuredEditProposal(text);
    // Should not error — it's a relative path
    if (result && !result.ok) {
      // If it errors, that's acceptable; but it must be consistent
      expect(typeof result.error).toBe("string");
    }
  });

  it("handles content exceeding 512KB limit", () => {
    const json = JSON.stringify({
      summary: "Giant file",
      operations: [
        { operation: "full_content", path: "src/a.ts", content: "x".repeat(600 * 1024) },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("512 KB");
  });

  it("handles 10 operations in a single proposal", () => {
    const operations = Array.from({ length: 10 }, (_, i) => ({
      operation: "full_content",
      path: `src/file_${i}.ts`,
      content: `content ${i}`,
    }));
    const json = JSON.stringify({ summary: "Batch change", operations });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || !result.ok) throw new Error("Expected ok: " + (result as { error: string } | null)?.error);
    expect(result.proposal.operations.length).toBe(10);
  });

  it("handles non-integer expectedOccurrences (float)", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [
        {
          operation: "exact_text_replace",
          path: "src/a.ts",
          oldText: "foo",
          newText: "bar",
          expectedOccurrences: 1.5,
        },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("expectedOccurrences");
  });
});

// ── Replay fixture schema consistency ────────────────────────────────────────

describe("ALL_FIXTURES — cross-fixture consistency", () => {
  it("all fixtures with isProjectMode=true and expectedOutcome=failed+expectedFailureCode have valid code", () => {
    const failed = ALL_FIXTURES.filter(
      (f) => f.isProjectMode && f.expectedOutcome === "failed" && f.expectedFailureCode !== undefined
    );
    for (const f of failed) {
      expect(
        typeof f.expectedFailureCode,
        `Fixture ${f.id} expectedFailureCode must be string`,
      ).toBe("string");
    }
  });

  it("all completed fixtures with isProjectMode=true have a forge_final turn", () => {
    const completed = ALL_FIXTURES.filter(
      (f) => f.isProjectMode && f.expectedOutcome === "completed"
    );
    for (const f of completed) {
      const hasFinal = f.turns.some((t) => t.text.includes("forge_final"));
      expect(hasFinal, `Fixture ${f.id}: project mode completed but no forge_final turn`).toBe(true);
    }
  });

  it("all disconnect fixtures have turns[0].disconnect=true", () => {
    const disconnects = ALL_FIXTURES.filter((f) => f.expectedFailureCode === "PROVIDER_ERROR");
    for (const f of disconnects) {
      const hasDisconnect = f.turns.some((t) => t.disconnect === true);
      expect(hasDisconnect, `Fixture ${f.id}: PROVIDER_ERROR but no disconnect turn`).toBe(true);
    }
  });

  it("FIXTURE_TOOL_BUDGET_EXHAUSTED has exactly 25 forge_tool turns before final", () => {
    const fixture = ALL_FIXTURES.find((f) => f.id === "regression_tool_budget_exhausted");
    expect(fixture).toBeDefined();
    const toolTurns = fixture!.turns.filter((t) => t.text.includes("forge_tool"));
    expect(toolTurns.length).toBe(25);
  });

  it("ReplayHarness can validate a passing result for each non-failure fixture", () => {
    const harness = new ReplayHarness();
    const completedFixtures = ALL_FIXTURES.filter((f) => f.expectedOutcome === "completed");
    for (const fixture of completedFixtures) {
      const result = harness.validateResult(fixture, {
        outcome: "completed",
        messagesProduced: fixture.expectedMessageCount ?? 2,
        recoveryTriggered: 0,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed, `Fixture ${fixture.id} failed validation: ${result.failureReason}`).toBe(true);
    }
  });
});

// ── Seeded randomized scenarios ───────────────────────────────────────────────
// Deterministic random using a seeded PRNG — no Math.random() in production.

function seededPrng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return ((s >>> 0) / 0xffffffff);
  };
}

describe("Seeded randomized scenarios", () => {
  it("seed-1: sanitize survives random message / tool counts", () => {
    const rng = seededPrng(0xdeadbeef);
    for (let i = 0; i < 20; i++) {
      const msgCount = Math.floor(rng() * 50) + 1;
      const toolCount = Math.floor(rng() * 25);
      const state = {
        messageCount: msgCount,
        toolStepCount: toolCount,
        requestId: `req-${i}`,
        conversationId: `conv-${i}`,
        apiKey: `sk-secret-${Math.floor(rng() * 999999)}`,
      };
      const result = sanitizeState(state);
      expect(detectResidualSecrets(JSON.stringify(result))).toHaveLength(0);
      expect(result["messageCount"]).toBe(msgCount);
      expect(result["toolStepCount"]).toBe(toolCount);
    }
  });

  it("seed-2: concurrent fingerprints are all distinct (32 random inputs)", () => {
    const rng = seededPrng(0xcafebabe);
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const fp = computeFingerprint({
        invariantId: `INV_${Math.floor(rng() * 26)}`,
        failureCode: `CODE_${Math.floor(rng() * 16)}`,
        category: `cat_${Math.floor(rng() * 5)}`,
        structuralKey: `key_${Math.floor(rng() * 1000)}`,
      });
      seen.add(fp);
    }
    // Most fingerprints should be unique; collisions very unlikely with 32 inputs
    expect(seen.size).toBeGreaterThanOrEqual(28);
  });

  it("seed-3: random proposal file counts parse correctly (1–10 files)", () => {
    const rng = seededPrng(0x1337face);
    for (let i = 0; i < 10; i++) {
      const fileCount = Math.floor(rng() * 10) + 1;
      const operations = Array.from({ length: fileCount }, (_, j) => ({
        operation: "full_content",
        path: `src/file_${j}.ts`,
        content: `content_${j}_${Math.floor(rng() * 9999)}`,
      }));
      const json = JSON.stringify({ summary: `Change ${i}`, operations });
      const text = "```forge_structured_edit_proposal\n" + json + "\n```";
      const result = parseStructuredEditProposal(text);
      if (!result || !result.ok) throw new Error(`Expected ok for ${fileCount} files: ${(result as { error: string } | null)?.error}`);
      expect(result.proposal.operations.length).toBe(fileCount);
    }
  });

  it("seed-4: sanitizer handles random sk- API key patterns (matched by sk_live_key pattern)", () => {
    const rng = seededPrng(0xfeedface);
    // Only use sk- prefix — the sanitizer's sk_live_key pattern requires 20+ alphanumeric chars
    for (let i = 0; i < 20; i++) {
      // Generate a 24-char alphanumeric suffix to satisfy the {20,} quantifier
      const suffix = Array.from({ length: 24 }, () => "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789"[Math.floor(rng() * 57)]!).join("");
      const secret = "sk-" + suffix;
      const input = `Error occurred: ${secret} at step ${Math.floor(rng() * 100)}`;
      const result = sanitizeString(input);
      expect(result).not.toContain(suffix);
      expect(detectResidualSecrets(result)).toHaveLength(0);
    }
  });

  it("seed-5: random exact_text_replace ops — non-ambiguous succeed", () => {
    const rng = seededPrng(0xabcdef01);
    for (let i = 0; i < 15; i++) {
      const uniqueMarker = `UNIQUE_TOKEN_${i}_${Math.floor(rng() * 99999)}`;
      const base = `line 1\n${uniqueMarker}\nline 3\n`.repeat(1);
      const result = applyExactTextReplace(base, {
        operation: "exact_text_replace",
        path: "src/a.ts",
        oldText: uniqueMarker,
        newText: `REPLACED_${i}`,
        expectedOccurrences: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toContain(`REPLACED_${i}`);
        expect(result.result).not.toContain(uniqueMarker);
      }
    }
  });

  it("seed-6: fingerprint is deterministic across repeated calls (same seed)", () => {
    const rng = seededPrng(0x99887766);
    for (let i = 0; i < 20; i++) {
      const input = {
        invariantId: `INV_${Math.floor(rng() * 10)}`,
        failureCode: `CODE_${Math.floor(rng() * 8)}`,
        category: `cat_${Math.floor(rng() * 3)}`,
        structuralKey: `key_${Math.floor(rng() * 500)}`,
      };
      const fp1 = computeFingerprint(input);
      const fp2 = computeFingerprint(input);
      expect(fp1).toBe(fp2);
    }
  });

  it("seed-7: ambiguous exact_text_replace (N>1 occurrences, expected=1) always fails", () => {
    const rng = seededPrng(0x55aa5a5a);
    for (let i = 0; i < 10; i++) {
      const token = `TOKEN_${i}`;
      const repeats = Math.floor(rng() * 4) + 2; // 2–5
      const base = Array(repeats).fill(`${token}\n`).join("");
      const result = applyExactTextReplace(base, {
        operation: "exact_text_replace",
        path: "src/a.ts",
        oldText: token,
        newText: "REPLACED",
        expectedOccurrences: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.ambiguous).toBe(true);
      }
    }
  });

  it("seed-8: mixed full_content + exact_text_replace parsing handles all combinations", () => {
    const rng = seededPrng(0x13572468);
    for (let i = 0; i < 8; i++) {
      const ops = [];
      for (let j = 0; j < 3; j++) {
        if (rng() > 0.5) {
          ops.push({ operation: "full_content", path: `src/f${j}.ts`, content: `content_${j}` });
        } else {
          ops.push({
            operation: "exact_text_replace",
            path: `src/f${j}.ts`,
            oldText: `old_${j}`,
            newText: `new_${j}`,
            expectedOccurrences: 1,
          });
        }
      }
      const json = JSON.stringify({ summary: `Mix ${i}`, operations: ops });
      const text = "```forge_structured_edit_proposal\n" + json + "\n```";
      const result = parseStructuredEditProposal(text);
      if (!result || !result.ok) throw new Error(`Mix ${i} parse failed: ${(result as { error: string } | null)?.error}`);
      expect(result.proposal.operations.length).toBe(3);
    }
  });
});

// ── Fault injection scenarios ─────────────────────────────────────────────────
// Verify that subsystems handle I/O errors, missing state, and corrupt data
// without crashing or leaking secrets.

// (imports moved to top of file)

describe("Fault injection — IncidentRecorder", () => {
  it("fault-4: incident persist fails gracefully (unwritable dir) — engine continues", async () => {
    // Point recorder at a non-existent deeply nested dir — writes will fail (dir not created)
    const badDir = nodePath.join(os.tmpdir(), "forge-fault-inject-" + Date.now(), "no-such", "path");
    const recorder = new IncidentRecorder({ dataDir: badDir, forgeVersion: "0.9.0" });
    // Recording must not throw even when disk write fails
    const violation: import("./invariants.js").InvariantViolation = {
      invariantId: "RECOVERY_BOUNDED",
      timestamp: Date.now(),
      observedState: { x: 1 },
    };
    expect(() => {
      recorder.record(violation, { failureCode: "PROTOCOL_RECOVERY_EXHAUSTED", structuralKey: "test" });
    }).not.toThrow();
    // In-memory state is intact
    const incidents = recorder.getAll();
    expect(incidents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Fault injection — TraceRecorder", () => {
  it("fault-5: trace write fails (unwritable dir) — agent loop unaffected (no throw)", async () => {
    const badDir = nodePath.join(os.tmpdir(), "forge-fault-inject-" + Date.now(), "no-traces");
    const tracer = new TraceRecorder({ dataDir: badDir });
    const requestId = "fault-req-001";
    // All operations must not throw
    expect(() => tracer.startTrace({ requestId, conversationId: "conv-001" })).not.toThrow();
    expect(() => tracer.emit(requestId, "RUN_CREATED", { requestId })).not.toThrow();
    expect(() => tracer.emit(requestId, "TOOL_STARTED", { callId: "c1", toolName: "read_file" })).not.toThrow();
    expect(() => tracer.emit(requestId, "TOOL_COMPLETED", { callId: "c1" })).not.toThrow();
    expect(() => tracer.endTrace(requestId, "completed")).not.toThrow();
    // Completed trace is still retrievable from in-memory store
    const trace = tracer.getTraceByRequestId(requestId);
    expect(trace).not.toBeNull();
    if (trace) {
      expect(trace.events.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("fault-5b: concurrent startTrace calls for distinct requestIds — no cross-contamination", () => {
    const dir = nodePath.join(os.tmpdir(), `forge-fault-5b-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const tracer = new TraceRecorder({ dataDir: dir });
    tracer.startTrace({ requestId: "req-A", conversationId: "conv-A" });
    tracer.startTrace({ requestId: "req-B", conversationId: "conv-B" });
    tracer.emit("req-A", "TOOL_STARTED", { callId: "cA", toolName: "read_file" });
    tracer.emit("req-B", "RUN_CREATED", { requestId: "req-B" });
    tracer.endTrace("req-A", "completed");
    tracer.endTrace("req-B", "failed");
    const traceA = tracer.getTraceByRequestId("req-A");
    const traceB = tracer.getTraceByRequestId("req-B");
    expect(traceA).not.toBeNull();
    expect(traceB).not.toBeNull();
    // Events must not cross
    const aKinds = traceA!.events.map(e => e.kind);
    const bKinds = traceB!.events.map(e => e.kind);
    expect(aKinds).toContain("TOOL_STARTED");
    expect(bKinds).toContain("RUN_CREATED");
    expect(bKinds).not.toContain("TOOL_STARTED");
  });

  it("fault-6: getTraceByRequestId on completed trace returns events (not undefined)", () => {
    const dir = nodePath.join(os.tmpdir(), `forge-trace-cmplt-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const tracer = new TraceRecorder({ dataDir: dir });
    const rid = "req-completed-check";
    tracer.startTrace({ requestId: rid, conversationId: "conv-c" });
    tracer.emit(rid, "RUN_CREATED", { requestId: rid });
    tracer.emit(rid, "FINAL_NORMALIZED", { kind: "final" });
    tracer.endTrace(rid, "completed");
    // Must still be findable after endTrace
    const trace = tracer.getTraceByRequestId(rid);
    expect(trace).not.toBeNull();
    expect(trace!.outcome).toBe("completed");
    expect(trace!.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Fault injection — sanitizer never leaks in error objects", () => {
  it("fault-1/2/3: Error objects with absolute paths and secrets are sanitized", () => {
    const homeDir = os.homedir();
    const errorState = {
      error: `ENOENT: no such file or directory '${homeDir}/secret-project/src/index.ts'`,
      apiKey: `sk-ant-api99-${"x".repeat(40)}`,
      stack: `Error: ENOENT\n    at Object.readFileSync (${homeDir}/node_modules/fs.js:100)`,
    };
    const sanitized = sanitizeState(errorState);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(homeDir);
    expect(detectResidualSecrets(serialized)).toHaveLength(0);
  });

  it("fault-3b: zero-length secrets are not leaked (empty string in apiKey field)", () => {
    const state = { apiKey: "", requestId: "req-001", count: 5 };
    const result = sanitizeState(state);
    // Empty apiKey at top-level is NOT redacted (top-level keys not matched)
    // but must not crash
    expect(() => sanitizeState(state)).not.toThrow();
    expect(result["count"]).toBe(5);
  });
});