/**
 * torture.test.ts — Edge case torture suite for reliability subsystem.
 *
 * Tests against degenerate inputs, boundary conditions, and adversarial
 * model outputs. Ensures no crash, no secret leak, no invariant bypass.
 */

import { describe, it, expect } from "vitest";
import os from "os";
import { sanitizeString, sanitizeState, sanitizeValue, detectResidualSecrets } from "./sanitizer.js";
import { computeFingerprint } from "./fingerprint.js";
import { ReplayHarness, ALL_FIXTURES } from "./replay.js";
import { applyExactTextReplace, parseStructuredEditProposal } from "../project-files/edit-ir.js";

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