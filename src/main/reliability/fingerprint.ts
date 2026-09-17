/**
 * fingerprint.ts — Incident Fingerprinter.
 *
 * Produces a deterministic structural fingerprint for each incident class.
 * Two incidents with the same root cause must produce the same fingerprint,
 * regardless of runtime details (requestId, conversationId, timestamps).
 *
 * Fingerprint inputs:
 *   - invariantId (stable ID string, not human text)
 *   - failureCode (typed enum value)
 *   - category (broad class)
 *   - structuralKey (optional: state machine path, tool name, edit op type...)
 *
 * Fingerprint must NOT depend on:
 *   - requestId / conversationId / agentRunId (vary per occurrence)
 *   - timestamps (vary per occurrence)
 *   - raw content (volatile and large)
 *   - absolute paths (user-specific)
 */

import { createHash } from "crypto";

export interface FingerprintInput {
  invariantId: string;
  failureCode: string;
  category: string;
  /** Optional structural discriminator — e.g. "state:processing_turn→executing_tools", "tool:read_file" */
  structuralKey?: string;
}

/**
 * Compute a stable 12-hex-char fingerprint for the given incident class.
 * Same inputs → same fingerprint across runtimes and versions.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const canonical = [
    input.invariantId,
    input.failureCode,
    input.category,
    input.structuralKey ?? "",
  ]
    .join("|")
    .toLowerCase();

  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

/**
 * Known incident manifest entry — describes a class of incidents
 * that have been diagnosed, fixed, or have safe mitigations.
 */
export interface KnownIncidentEntry {
  fingerprint: string;
  invariantId: string;
  title: string;
  description: string;
  status: "known_bug" | "fixed" | "wont_fix" | "needs_investigation";
  fixedInVersion?: string;
  mitigation?: string;
  /** Optional regression test ID that covers this incident class */
  regressionTestId?: string;
}

/**
 * Build a deduplication key for in-memory seen-set.
 * Same as fingerprint for structural dedup.
 */
export function buildDedupeKey(input: FingerprintInput): string {
  return computeFingerprint(input);
}

/**
 * Check if two fingerprints match (constant-time comparison not required
 * here — these are not security tokens, just structural identifiers).
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  return a === b;
}