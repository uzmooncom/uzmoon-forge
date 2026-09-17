/**
 * edit-ir.ts — Structured Edit IR (Intermediate Representation).
 *
 * V0.9 introduces compact multi-file edit proposals alongside the existing
 * full-content proposal format. The Edit IR allows the model to express changes
 * as exact text replacements (like a search/replace), rather than repeating
 * entire unchanged file contents.
 *
 * TWO OPERATION TYPES:
 *
 *   1. FullContentReplace — model supplies complete new file content.
 *      Same as V0.3 forge_edit_proposal. Always safe: no ambiguity.
 *      Required when: model read the complete file via read_file.
 *
 *   2. ExactTextReplace — model supplies oldText + newText + expectedOccurrences.
 *      Forge applies the replacement to the immutable base snapshot.
 *      Guards:
 *        - oldText must appear exactly expectedOccurrences times (default: 1)
 *        - If actual count ≠ expected → EDIT_AMBIGUITY_BLOCKED (invariant violation)
 *        - No write if ambiguous
 *
 * INVARIANT (INV_EDIT_AMBIGUITY_BLOCKED):
 *   ExactTextReplace where actual occurrences ≠ expectedOccurrences must be
 *   rejected before any filesystem write.
 *
 * INVARIANT (INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES):
 *   Malformed IR must never result in a partial write.
 *
 * Safe File Editing integration:
 *   normalizeEditIR() is called BEFORE captureProposalTarget().
 *   It normalizes IR operations to FullContentReplace using the base snapshot,
 *   so the rest of the existing edit pipeline (preflight, apply, undo) is unchanged.
 *
 * forge_structured_edit_proposal fence format:
 * ```forge_structured_edit_proposal
 * {
 *   "summary": "Rename config key",
 *   "operations": [
 *     {
 *       "operation": "exact_text_replace",
 *       "path": "src/config.ts",
 *       "oldText": "apiKey:",
 *       "newText": "apiToken:",
 *       "expectedOccurrences": 3
 *     }
 *   ]
 * }
 * ```
 */

import type { EditOperationIR, FullContentEditOp, ExactTextReplaceOp, StructuredEditProposal } from "../../shared/types.js";

export { type EditOperationIR, type FullContentEditOp, type ExactTextReplaceOp, type StructuredEditProposal };

// ── Parse ─────────────────────────────────────────────────────────────────────

const STRUCTURED_FENCE_RE = /```forge_structured_edit_proposal\n([\s\S]*?)\n```/g;

/**
 * Count forge_structured_edit_proposal fences in text.
 */
export function countStructuredFences(text: string): number {
  const re = new RegExp(STRUCTURED_FENCE_RE.source, "g");
  let count = 0;
  while (re.exec(text) !== null) count++;
  return count;
}

/**
 * Extract and parse a forge_structured_edit_proposal from model output text.
 * Returns null if no fence found.
 * Returns { ok: false, error } if fence present but malformed.
 * Returns { ok: true, proposal } on success.
 */
export function parseStructuredEditProposal(
  text: string,
): { ok: true; proposal: StructuredEditProposal } | { ok: false; error: string } | null {
  const count = countStructuredFences(text);
  if (count === 0) return null;
  if (count > 1) {
    return { ok: false, error: "Multiple forge_structured_edit_proposal blocks are not allowed in a single response" };
  }

  const re = new RegExp(STRUCTURED_FENCE_RE.source, "g");
  const match = re.exec(text);
  if (!match || !match[1]) {
    return { ok: false, error: "forge_structured_edit_proposal fence found but could not be extracted" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: "forge_structured_edit_proposal contains invalid JSON" };
  }

  const validated = validateStructuredProposal(raw);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  return { ok: true, proposal: validated.proposal };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateStructuredProposal(
  raw: unknown,
): { ok: true; proposal: StructuredEditProposal } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "forge_structured_edit_proposal must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["summary"] !== "string" || !obj["summary"].trim()) {
    return { ok: false, error: "forge_structured_edit_proposal requires a non-empty 'summary' string" };
  }

  if (!Array.isArray(obj["operations"])) {
    return { ok: false, error: "forge_structured_edit_proposal requires an 'operations' array" };
  }

  if (obj["operations"].length === 0) {
    return { ok: false, error: "forge_structured_edit_proposal.operations must not be empty" };
  }

  const MAX_CONTEXT_BYTES = 512 * 1024; // 512 KB per operation content
  const operations: EditOperationIR[] = [];

  for (let i = 0; i < (obj["operations"] as unknown[]).length; i++) {
    const op = (obj["operations"] as unknown[])[i];
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      return { ok: false, error: `operations[${i}]: must be an object` };
    }
    const o = op as Record<string, unknown>;

    const opType = o["operation"];
    if (opType !== "full_content" && opType !== "exact_text_replace") {
      return { ok: false, error: `operations[${i}]: unknown operation type "${String(opType)}"` };
    }

    const p = o["path"];
    if (typeof p !== "string" || !p.trim()) {
      return { ok: false, error: `operations[${i}]: 'path' must be a non-empty string` };
    }

    // Reject absolute paths
    if (p.startsWith("/") || p.startsWith("\\") || p.includes(":")) {
      return { ok: false, error: `operations[${i}]: 'path' must be a relative project path, not absolute` };
    }

    if (opType === "full_content") {
      const content = o["content"];
      if (typeof content !== "string") {
        return { ok: false, error: `operations[${i}] (full_content): 'content' must be a string` };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES) {
        return { ok: false, error: `operations[${i}] (full_content): content exceeds 512 KB limit` };
      }
      operations.push({ operation: "full_content", path: p, content });
    } else {
      // exact_text_replace
      const oldText = o["oldText"];
      const newText = o["newText"];
      const expectedOccurrences = o["expectedOccurrences"];

      if (typeof oldText !== "string" || oldText.length === 0) {
        return { ok: false, error: `operations[${i}] (exact_text_replace): 'oldText' must be a non-empty string` };
      }
      if (typeof newText !== "string") {
        return { ok: false, error: `operations[${i}] (exact_text_replace): 'newText' must be a string` };
      }
      if (
        typeof expectedOccurrences !== "number" ||
        !Number.isInteger(expectedOccurrences) ||
        expectedOccurrences < 1
      ) {
        return {
          ok: false,
          error: `operations[${i}] (exact_text_replace): 'expectedOccurrences' must be a positive integer`,
        };
      }
      operations.push({
        operation: "exact_text_replace",
        path: p,
        oldText,
        newText,
        expectedOccurrences,
      });
    }
  }

  return {
    ok: true,
    proposal: {
      summary: (obj["summary"] as string).trim(),
      ...(typeof obj["explanation"] === "string" && obj["explanation"].trim()
        ? { explanation: obj["explanation"].trim() }
        : {}),
      operations,
    },
  };
}

// ── ExactTextReplace application ──────────────────────────────────────────────

export interface ApplyExactReplaceResult {
  ok: true;
  result: string;
  replacementCount: number;
}

export interface ApplyExactReplaceError {
  ok: false;
  error: string;
  /** INV_EDIT_AMBIGUITY_BLOCKED when actual count differs from expected */
  ambiguous?: boolean;
  actualOccurrences?: number;
}

/**
 * Apply an ExactTextReplace operation to baseContent.
 * Guards:
 *   - Count actual occurrences of oldText in baseContent
 *   - If actual ≠ op.expectedOccurrences → return ambiguous error (no write)
 *   - Replace all expectedOccurrences instances (left-to-right)
 *
 * This function NEVER throws — returns typed result.
 */
export function applyExactTextReplace(
  baseContent: string,
  op: ExactTextReplaceOp,
): ApplyExactReplaceResult | ApplyExactReplaceError {
  const { oldText, newText, expectedOccurrences } = op;

  // Count occurrences without regex (literal string match)
  let actualOccurrences = 0;
  for (let searchFrom = 0; searchFrom <= baseContent.length; ) {
    const idx = baseContent.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    actualOccurrences++;
    searchFrom = idx + oldText.length;
  }

  if (actualOccurrences !== expectedOccurrences) {
    return {
      ok: false,
      error:
        `Ambiguous replacement: oldText appears ${actualOccurrences} time(s) in "${op.path}", ` +
        `but expectedOccurrences is ${expectedOccurrences}. No changes were made.`,
      ambiguous: true,
      actualOccurrences,
    };
  }

  if (actualOccurrences === 0) {
    return {
      ok: false,
      error: `oldText not found in "${op.path}". No changes were made.`,
      ambiguous: false,
      actualOccurrences: 0,
    };
  }

  // Apply all replacements (split/join for literal, non-regex replacement)
  const result = baseContent.split(oldText).join(newText);
  return { ok: true, result, replacementCount: actualOccurrences };
}

/**
 * Normalize an ExactTextReplaceOp to a FullContentEditOp using the immutable base snapshot content.
 * This allows the rest of the edit pipeline (preflight, apply, undo) to remain unchanged.
 *
 * Returns null if the operation cannot be normalized (ambiguous, not found, etc.)
 */
export function normalizeToFullContent(
  op: ExactTextReplaceOp,
  baseContent: string,
): { ok: true; op: FullContentEditOp } | { ok: false; error: string; ambiguous?: boolean } {
  const result = applyExactTextReplace(baseContent, op);
  if (!result.ok) {
    return { ok: false, error: result.error, ...(result.ambiguous !== undefined && { ambiguous: result.ambiguous }) };
  }
  return {
    ok: true,
    op: {
      operation: "full_content",
      path: op.path,
      content: result.result,
    },
  };
}

/**
 * Strip forge_structured_edit_proposal fences from model output text.
 * Used to clean proposal fences from persisted ChatMessage content.
 */
export function stripStructuredEditFence(text: string): string {
  return text.replace(new RegExp(STRUCTURED_FENCE_RE.source, "g"), "").trim();
}