/**
 * edit-ir.test.ts — Structured Edit IR tests.
 * §93: EDIT_AMBIGUITY_BLOCKED invariant enforcement.
 */

import { describe, it, expect } from "vitest";
import {
  parseStructuredEditProposal,
  countStructuredFences,
  applyExactTextReplace,
  normalizeToFullContent,
  stripStructuredEditFence,
} from "./edit-ir.js";

// ── parseStructuredEditProposal ───────────────────────────────────────────────

describe("parseStructuredEditProposal", () => {
  const validFullContent = JSON.stringify({
    summary: "Replace config key",
    operations: [
      { operation: "full_content", path: "src/config.ts", content: "export const x = 1;\n" },
    ],
  });

  it("returns null when no fence present", () => {
    const result = parseStructuredEditProposal("Just some regular text.");
    expect(result).toBeNull();
  });

  it("parses a valid full_content operation", () => {
    const text = "```forge_structured_edit_proposal\n" + validFullContent + "\n```";
    const result = parseStructuredEditProposal(text);
    expect(result).not.toBeNull();
    if (!result || !result.ok) throw new Error("Expected ok");
    expect(result.proposal.summary).toBe("Replace config key");
    expect(result.proposal.operations.length).toBe(1);
    expect(result.proposal.operations[0]!.operation).toBe("full_content");
    expect(result.proposal.operations[0]!.path).toBe("src/config.ts");
  });

  it("parses a valid exact_text_replace operation", () => {
    const json = JSON.stringify({
      summary: "Rename method",
      operations: [
        {
          operation: "exact_text_replace",
          path: "src/service.ts",
          oldText: "oldMethod()",
          newText: "newMethod()",
          expectedOccurrences: 1,
        },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    expect(result).not.toBeNull();
    if (!result || !result.ok) throw new Error("Expected ok");
    expect(result.proposal.operations[0]!.operation).toBe("exact_text_replace");
  });

  it("returns error for multiple fences", () => {
    const fence = "```forge_structured_edit_proposal\n" + validFullContent + "\n```";
    const result = parseStructuredEditProposal(fence + "\n\n" + fence);
    expect(result).not.toBeNull();
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("Multiple");
  });

  it("returns error for invalid JSON", () => {
    const text = "```forge_structured_edit_proposal\n{broken\n```";
    const result = parseStructuredEditProposal(text);
    expect(result).not.toBeNull();
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("invalid JSON");
  });

  it("returns error for missing summary", () => {
    const json = JSON.stringify({
      operations: [{ operation: "full_content", path: "src/a.ts", content: "x" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("summary");
  });

  it("returns error for empty summary", () => {
    const json = JSON.stringify({
      summary: "   ",
      operations: [{ operation: "full_content", path: "src/a.ts", content: "x" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("summary");
  });

  it("returns error for empty operations array", () => {
    const json = JSON.stringify({ summary: "Some change", operations: [] });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("operations");
  });

  it("returns error for unknown operation type", () => {
    const json = JSON.stringify({
      summary: "Bad op",
      operations: [{ operation: "delete_file", path: "src/a.ts" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("unknown operation");
  });

  it("returns error for absolute path in operation", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [{ operation: "full_content", path: "/absolute/path.ts", content: "x" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("relative");
  });

  it("returns error when exact_text_replace has empty oldText", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [
        {
          operation: "exact_text_replace",
          path: "src/a.ts",
          oldText: "",
          newText: "something",
          expectedOccurrences: 1,
        },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("oldText");
  });

  it("returns error when expectedOccurrences is zero", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [
        {
          operation: "exact_text_replace",
          path: "src/a.ts",
          oldText: "foo",
          newText: "bar",
          expectedOccurrences: 0,
        },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("expectedOccurrences");
  });

  it("returns error when expectedOccurrences is negative", () => {
    const json = JSON.stringify({
      summary: "Change",
      operations: [
        {
          operation: "exact_text_replace",
          path: "src/a.ts",
          oldText: "foo",
          newText: "bar",
          expectedOccurrences: -1,
        },
      ],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || result.ok) throw new Error("Expected error");
    expect(result.error).toContain("expectedOccurrences");
  });

  it("parses optional explanation field", () => {
    const json = JSON.stringify({
      summary: "Add logging",
      explanation: "Adds debug logging to improve observability.",
      operations: [{ operation: "full_content", path: "src/a.ts", content: "x" }],
    });
    const text = "```forge_structured_edit_proposal\n" + json + "\n```";
    const result = parseStructuredEditProposal(text);
    if (!result || !result.ok) throw new Error("Expected ok");
    expect(result.proposal.explanation).toBe("Adds debug logging to improve observability.");
  });
});

// ── countStructuredFences ─────────────────────────────────────────────────────

describe("countStructuredFences", () => {
  it("returns 0 for text with no fence", () => {
    expect(countStructuredFences("hello world")).toBe(0);
  });

  it("returns 1 for text with one fence", () => {
    const text = "```forge_structured_edit_proposal\n{}\n```";
    expect(countStructuredFences(text)).toBe(1);
  });

  it("returns 2 for text with two fences", () => {
    const fence = "```forge_structured_edit_proposal\n{}\n```";
    expect(countStructuredFences(fence + "\n\n" + fence)).toBe(2);
  });
});

// ── applyExactTextReplace ─────────────────────────────────────────────────────

describe("applyExactTextReplace", () => {
  it("replaces a single occurrence correctly", () => {
    const base = "function oldName() { return 1; }";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "oldName",
      newText: "newName",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("function newName() { return 1; }");
    expect(result.replacementCount).toBe(1);
  });

  it("replaces multiple occurrences when expectedOccurrences > 1", () => {
    const base = "foo() + foo() + foo()";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "foo()",
      newText: "bar()",
      expectedOccurrences: 3,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("bar() + bar() + bar()");
    expect(result.replacementCount).toBe(3);
  });

  it("returns ambiguous error when actual > expected", () => {
    const base = "foo foo foo";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
      expectedOccurrences: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBe(true);
    expect(result.actualOccurrences).toBe(3);
    expect(result.error).toContain("3 time(s)");
  });

  it("returns ambiguous error when actual < expected", () => {
    const base = "foo is here once";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
      expectedOccurrences: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBe(true);
    expect(result.actualOccurrences).toBe(1);
  });

  it("returns ambiguous error when oldText absent (count 0 ≠ expected 1)", () => {
    // When actual count (0) ≠ expectedOccurrences (1), the ambiguity guard fires
    // with ambiguous=true. A dedicated not-found path is NOT taken separately.
    const base = "no match here";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "xyzzy",
      newText: "bar",
      expectedOccurrences: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.actualOccurrences).toBe(0);
    expect(result.ambiguous).toBe(true);
  });

  it("handles multi-line oldText", () => {
    const base = "line1\nline2\nline3\nline4";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "line2\nline3",
      newText: "NEW_BLOCK",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("line1\nNEW_BLOCK\nline4");
  });

  it("handles empty newText (deletion)", () => {
    const base = "keep this, remove this, keep this too";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: " remove this,",
      newText: "",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("keep this, keep this too");
  });

  it("is exact (no regex metachar interpretation)", () => {
    const base = "x.y.z";
    // "." would match any char in regex, but here must be literal
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "x.y",
      newText: "a.b",
      expectedOccurrences: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toBe("a.b.z");
  });

  it("never writes when ambiguous (EDIT_AMBIGUITY_BLOCKED guarantee)", () => {
    const base = "const x = 1;\nconst x = 2;\n";
    const result = applyExactTextReplace(base, {
      operation: "exact_text_replace",
      path: "src/a.ts",
      oldText: "const x",
      newText: "const y",
      expectedOccurrences: 1,
    });
    expect(result.ok).toBe(false);
    // Verify: the caller must never write if not ok
    // (This test documents the contract; the caller is normalizeToFullContent)
  });
});

// ── normalizeToFullContent ────────────────────────────────────────────────────

describe("normalizeToFullContent", () => {
  it("normalizes a valid exact_text_replace to full_content", () => {
    const base = "const API_KEY = 'old_key';\n";
    const op = {
      operation: "exact_text_replace" as const,
      path: "src/config.ts",
      oldText: "old_key",
      newText: "new_key",
      expectedOccurrences: 1,
    };
    const result = normalizeToFullContent(op, base);
    if (!result.ok) throw new Error(result.error);
    expect(result.op.operation).toBe("full_content");
    expect(result.op.path).toBe("src/config.ts");
    expect(result.op.content).toBe("const API_KEY = 'new_key';\n");
  });

  it("returns error when ambiguous", () => {
    const base = "foo bar foo";
    const op = {
      operation: "exact_text_replace" as const,
      path: "src/a.ts",
      oldText: "foo",
      newText: "baz",
      expectedOccurrences: 1,
    };
    const result = normalizeToFullContent(op, base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBe(true);
  });

  it("returns error when not found", () => {
    const base = "no match in here";
    const op = {
      operation: "exact_text_replace" as const,
      path: "src/a.ts",
      oldText: "xyzzy",
      newText: "abc",
      expectedOccurrences: 1,
    };
    const result = normalizeToFullContent(op, base);
    expect(result.ok).toBe(false);
  });
});

// ── stripStructuredEditFence ──────────────────────────────────────────────────

describe("stripStructuredEditFence", () => {
  it("removes the fence block from text", () => {
    const fence = "```forge_structured_edit_proposal\n{}\n```";
    const text = "Some text before.\n" + fence + "\nSome text after.";
    const result = stripStructuredEditFence(text);
    expect(result).not.toContain("forge_structured_edit_proposal");
    expect(result).toContain("Some text before.");
    expect(result).toContain("Some text after.");
  });

  it("returns unchanged text when no fence present", () => {
    const text = "Normal model output.";
    expect(stripStructuredEditFence(text)).toBe("Normal model output.");
  });

  it("removes all fence instances from text with two fences", () => {
    const fence = "```forge_structured_edit_proposal\n{}\n```";
    const text = fence + "\n\n" + fence;
    const result = stripStructuredEditFence(text);
    expect(result).not.toContain("forge_structured_edit_proposal");
  });
});