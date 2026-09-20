/**
 * Evidence Registry — Task Runtime V1 Corrections
 *
 * Stores opaque evidence records produced by real Forge runtime/tool execution.
 * Step results that cite evidence must pass validation here.
 *
 * Rules:
 * - Every evidence ref is an opaque UUID assigned by this registry
 * - Model cannot fabricate refs — only refs in this registry are valid
 * - Refs are scoped to taskId + agentRunId (cannot cross tasks)
 * - Refs expire after 24h (configurable) to prevent stale use
 */

import { randomUUID } from "crypto";
import type {
  CommandEvidenceRef,
  BrowserEvidenceRef,
  AgentReadRef,
  AgentRun,
} from "../../shared/types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type EvidenceKind =
  | "command"
  | "browser"
  | "file_read"
  | "git"
  | "agent_read";

/** A real evidence record produced by Forge runtime execution */
export interface EvidenceRecord {
  id: string;
  taskId: string;
  stepId: string;
  agentRunId: string;
  kind: EvidenceKind;
  createdAt: number;
  /** Unix ms — evidence invalid after this time (optional) */
  expiresAt?: number;
  /** The underlying artifact */
  payload:
    | CommandEvidenceRef
    | BrowserEvidenceRef
    | AgentReadRef
    | GitEvidencePayload
    | GenericEvidencePayload;
}

export interface GitEvidencePayload {
  operation: "stage" | "unstage" | "commit" | "status" | "diff" | "log";
  projectId: string;
  commitHash?: string;
  fileCount?: number;
  summary: string;
}

export interface GenericEvidencePayload {
  description: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceValidationResult {
  valid: boolean;
  record?: EvidenceRecord;
  reason?: string;
}

// ── Evidence validity window ────────────────────────────────────────────────

const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── In-memory store ────────────────────────────────────────────────────────
// Keyed by evidence ID (opaque UUID)

const _registry = new Map<string, EvidenceRecord>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a new evidence record produced by real runtime execution.
 * Returns the opaque evidence ID to be included in step results.
 */
export function registerEvidence(
  record: Omit<EvidenceRecord, "id" | "createdAt" | "expiresAt">
): string {
  const id = randomUUID();
  const now = Date.now();
  _registry.set(id, {
    ...record,
    id,
    createdAt: now,
    expiresAt: now + EVIDENCE_TTL_MS,
  });
  return id;
}

/**
 * Validate an evidence ref string against the registry.
 * Returns the record if valid, or a reason if not.
 */
export function validateEvidenceRef(
  ref: string,
  taskId: string,
  agentRunId: string
): EvidenceValidationResult {
  const record = _registry.get(ref);

  if (!record) {
    return { valid: false, reason: `Evidence ref not found in registry: ${ref}` };
  }

  if (record.taskId !== taskId) {
    return {
      valid: false,
      reason: `Evidence ref ${ref} belongs to task ${record.taskId}, not ${taskId}`,
    };
  }

  if (record.agentRunId !== agentRunId) {
    // Allow evidence from a previous step of the same task
    // (completed steps produce evidence that later steps can cite)
    const isFromSameTask = record.taskId === taskId;
    if (!isFromSameTask) {
      return {
        valid: false,
        reason: `Evidence ref ${ref} belongs to agentRun ${record.agentRunId}, not accessible from ${agentRunId}`,
      };
    }
  }

  if (record.expiresAt !== undefined && Date.now() > record.expiresAt) {
    return {
      valid: false,
      reason: `Evidence ref ${ref} has expired (created at ${record.createdAt})`,
    };
  }

  return { valid: true, record };
}

/**
 * Validate a list of evidence refs and return:
 * - validRefs: refs that passed validation
 * - invalidRefs: refs that failed (with reasons for logging)
 */
export function validateEvidenceRefs(
  refs: string[],
  taskId: string,
  agentRunId: string
): { validRefs: string[]; invalidRefs: Array<{ ref: string; reason: string }> } {
  const validRefs: string[] = [];
  const invalidRefs: Array<{ ref: string; reason: string }> = [];

  for (const ref of refs) {
    const result = validateEvidenceRef(ref, taskId, agentRunId);
    if (result.valid) {
      validRefs.push(ref);
    } else {
      invalidRefs.push({ ref, reason: result.reason ?? "unknown" });
    }
  }

  return { validRefs, invalidRefs };
}

/**
 * Get a specific evidence record by ID (for inspection/display).
 */
export function getEvidenceRecord(id: string): EvidenceRecord | null {
  return _registry.get(id) ?? null;
}

/**
 * Get all evidence records for a given task + step.
 */
export function getStepEvidence(taskId: string, stepId: string): EvidenceRecord[] {
  const results: EvidenceRecord[] = [];
  for (const record of _registry.values()) {
    if (record.taskId === taskId && record.stepId === stepId) {
      results.push(record);
    }
  }
  return results;
}

/**
 * Collect evidence from an AgentLoopResult and register it against a task step.
 * Returns the list of opaque evidence IDs that can be cited in step results.
 */
export function collectAndRegisterEvidence(
  agentRun: AgentRun,
  taskId: string,
  stepId: string,
  commandRefs: CommandEvidenceRef[],
  browserRefs: BrowserEvidenceRef[],
  agentReadRefs: AgentReadRef[]
): string[] {
  const evidenceIds: string[] = [];
  const agentRunId = agentRun.requestId;

  for (const cmd of commandRefs) {
    const id = registerEvidence({
      taskId,
      stepId,
      agentRunId,
      kind: "command",
      payload: cmd,
    });
    evidenceIds.push(id);
  }

  for (const browser of browserRefs) {
    const id = registerEvidence({
      taskId,
      stepId,
      agentRunId,
      kind: "browser",
      payload: browser,
    });
    evidenceIds.push(id);
  }

  for (const read of agentReadRefs) {
    const id = registerEvidence({
      taskId,
      stepId,
      agentRunId,
      kind: "agent_read",
      payload: read,
    });
    evidenceIds.push(id);
  }

  return evidenceIds;
}

/**
 * Check whether evidence satisfies a verification policy.
 * Returns true if policy is satisfied.
 */
export function checkVerificationPolicy(
  evidenceIds: string[],
  policy: "none" | "evidence_required" | "build_test" | "browser"
): { satisfied: boolean; reason?: string } {
  if (policy === "none") {
    return { satisfied: true };
  }

  if (evidenceIds.length === 0) {
    return { satisfied: false, reason: "No evidence refs provided" };
  }

  const records = evidenceIds
    .map((id) => _registry.get(id))
    .filter((r): r is EvidenceRecord => r !== undefined);

  if (policy === "evidence_required") {
    return records.length > 0
      ? { satisfied: true }
      : { satisfied: false, reason: "No valid evidence records found" };
  }

  if (policy === "build_test") {
    const cmdRecords = records.filter((r) => r.kind === "command");
    const passing = cmdRecords.filter((r) => {
      const payload = r.payload as CommandEvidenceRef;
      return payload.exitCode === 0;
    });
    return passing.length > 0
      ? { satisfied: true }
      : {
          satisfied: false,
          reason: `No command evidence with exitCode=0 found (policy: build_test)`,
        };
  }

  if (policy === "browser") {
    const browserRecords = records.filter((r) => r.kind === "browser");
    return browserRecords.length > 0
      ? { satisfied: true }
      : { satisfied: false, reason: "No browser evidence found (policy: browser)" };
  }

  return { satisfied: false, reason: `Unknown policy: ${policy}` };
}

/**
 * Expire and clean up evidence older than TTL.
 * Call periodically to prevent unbounded growth.
 */
export function sweepExpiredEvidence(): number {
  const now = Date.now();
  let swept = 0;
  for (const [id, record] of _registry) {
    if (record.expiresAt !== undefined && now > record.expiresAt) {
      _registry.delete(id);
      swept++;
    }
  }
  return swept;
}

/**
 * Get registry size (for monitoring / leak detection).
 */
export function getRegistrySize(): number {
  return _registry.size;
}

/** FOR TESTS ONLY — clear all evidence records */
export function _resetEvidenceRegistryForTest(): void {
  _registry.clear();
}
