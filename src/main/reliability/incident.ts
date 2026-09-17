/**
 * incident.ts — Incident recorder, deduplication, and local persistence.
 *
 * Responsibilities:
 *  - Receive InvariantViolations from InvariantMonitor
 *  - Sanitize before any persistence
 *  - Compute fingerprint for deduplication
 *  - Persist to <dataDir>/incidents/incidents.json (bounded ring buffer)
 *  - Emit callback for IPC broadcasting to renderer
 *  - Never send data externally without user opt-in
 *
 * Storage limits (§81 — no unbounded arrays):
 *  - MAX_INCIDENTS = 200 (ring buffer, oldest discarded)
 *  - MAX_INCIDENT_AGE_MS = 7 days
 *
 * Schema versioning: INCIDENT_SCHEMA_VERSION = 1
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ForgeIncident, IncidentCategory, ForgeSeverity, ForgeFailureCode } from "../../shared/types.js";
import type { InvariantViolation } from "./invariants.js";
import { getInvariant } from "./invariants.js";
import { sanitizeState } from "./sanitizer.js";
import { computeFingerprint } from "./fingerprint.js";
import type { KnownIncidentEntry } from "./fingerprint.js";

// ── Schema version ────────────────────────────────────────────────────────────

export const INCIDENT_SCHEMA_VERSION = 1;

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_INCIDENTS = 200;
const MAX_INCIDENT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Storage ───────────────────────────────────────────────────────────────────

interface IncidentStore {
  schemaVersion: number;
  incidents: ForgeIncident[];
}

// ── IncidentRecorder ──────────────────────────────────────────────────────────

export type NewIncidentCallback = (incident: ForgeIncident) => void;

export class IncidentRecorder {
  private incidentsFile: string;
  private incidents: ForgeIncident[] = [];
  private seenFingerprints = new Map<string, string>(); // fingerprint → incidentId
  private knownManifest: KnownIncidentEntry[] = [];
  private onNewIncident: NewIncidentCallback | null = null;
  private forgeVersion: string;

  constructor(opts: {
    dataDir: string;
    forgeVersion: string;
    knownManifest?: KnownIncidentEntry[];
  }) {
    this.incidentsFile = path.join(opts.dataDir, "incidents", "incidents.json");
    this.forgeVersion = opts.forgeVersion;
    this.knownManifest = opts.knownManifest ?? [];
    this._loadFromDisk();
  }

  /** Register callback for live incident broadcasting (IPC push to renderer) */
  setNewIncidentCallback(cb: NewIncidentCallback): void {
    this.onNewIncident = cb;
  }

  /** Update known incident manifest (e.g. after downloading/bundling new manifest) */
  setKnownManifest(manifest: KnownIncidentEntry[]): void {
    this.knownManifest = manifest;
  }

  /**
   * Record an invariant violation as an incident.
   * - Sanitizes observedState before persistence
   * - Deduplicates by fingerprint (increments occurrenceCount on repeat)
   * - Persists to disk (best-effort)
   * - Calls onNewIncident callback
   */
  record(
    violation: InvariantViolation,
    opts: {
      failureCode?: ForgeFailureCode;
      structuralKey?: string;
      traceId?: string;
      projectId?: string;
      agentRunId?: string;
    } = {},
  ): ForgeIncident {
    const def = getInvariant(violation.invariantId);

    const category: IncidentCategory = (def?.category as IncidentCategory) ?? "AGENT_RUNTIME";
    const severity: ForgeSeverity = (def?.severity as ForgeSeverity) ?? "medium";
    const failureCode: ForgeFailureCode = opts.failureCode ?? "INVARIANT_VIOLATION";

    const fingerprint = computeFingerprint({
      invariantId: violation.invariantId,
      failureCode,
      category,
      ...(opts.structuralKey !== undefined && { structuralKey: opts.structuralKey }),
    });

    // Sanitize observedState — never persist raw secrets or paths
    const sanitizedState = sanitizeState(violation.observedState ?? {}, { omitContent: true });
    const sanitizedExpected = violation.expectedState
      ? sanitizeState(violation.expectedState, { omitContent: true })
      : undefined;

    // Check known manifest
    const known = this.knownManifest.find((e) => e.fingerprint === fingerprint);

    const now = Date.now();
    const existingId = this.seenFingerprints.get(fingerprint);
    if (existingId) {
      // Dedup — update existing record
      const existing = this.incidents.find((i) => i.id === existingId);
      if (existing) {
        existing.occurrenceCount += 1;
        existing.lastSeen = now;
        if (opts.traceId && !existing.traceId) {
          existing.traceId = opts.traceId;
        }
        this._saveToDisk();
        return existing;
      }
    }

    // New incident
    const incident: ForgeIncident = {
      id: randomUUID(),
      fingerprint,
      invariantId: violation.invariantId,
      category,
      severity,
      failureCode,
      forgeVersion: this.forgeVersion,
      runtimeSchemaVersion: INCIDENT_SCHEMA_VERSION,
      ...(violation.requestId !== undefined && { requestId: violation.requestId }),
      ...(violation.conversationId !== undefined && { conversationId: violation.conversationId }),
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
      ...(opts.agentRunId !== undefined && { agentRunId: opts.agentRunId }),
      observedState: sanitizedState,
      ...(sanitizedExpected && { expectedState: sanitizedExpected }),
      ...(opts.traceId !== undefined && { traceId: opts.traceId }),
      firstSeen: now,
      lastSeen: now,
      occurrenceCount: 1,
      knownIssue: !!known,
    };

    this.incidents.push(incident);
    this.seenFingerprints.set(fingerprint, incident.id);

    this._enforceRetention();
    this._saveToDisk();

    if (this.onNewIncident) {
      try {
        this.onNewIncident(incident);
      } catch {
        // Never throw from callback
      }
    }

    return incident;
  }

  getAll(): ForgeIncident[] {
    return [...this.incidents];
  }

  getById(id: string): ForgeIncident | undefined {
    return this.incidents.find((i) => i.id === id);
  }

  getByFingerprint(fingerprint: string): ForgeIncident | undefined {
    const id = this.seenFingerprints.get(fingerprint);
    return id ? this.incidents.find((i) => i.id === id) : undefined;
  }

  clear(): void {
    this.incidents = [];
    this.seenFingerprints.clear();
    this._saveToDisk();
  }

  getMetrics(): {
    total: number;
    critical: number;
    high: number;
    byCategory: Record<string, number>;
    knownIssues: number;
    oldestSeen: number | null;
  } {
    const byCategory: Record<string, number> = {};
    let critical = 0;
    let high = 0;
    let knownIssues = 0;
    let oldestSeen: number | null = null;

    for (const inc of this.incidents) {
      byCategory[inc.category] = (byCategory[inc.category] ?? 0) + 1;
      if (inc.severity === "critical") critical++;
      if (inc.severity === "high") high++;
      if (inc.knownIssue) knownIssues++;
      if (oldestSeen === null || inc.firstSeen < oldestSeen) oldestSeen = inc.firstSeen;
    }

    return {
      total: this.incidents.length,
      critical,
      high,
      byCategory,
      knownIssues,
      oldestSeen,
    };
  }

  /** Check stability gate — returns violations as array of strings (empty = pass) */
  checkStabilityGate(): string[] {
    const violations: string[] = [];
    const criticalActive = this.incidents.filter((i) => i.severity === "critical" && !i.knownIssue);
    if (criticalActive.length > 0) {
      violations.push(`${criticalActive.length} active critical invariant violations`);
    }
    const crossContam = this.incidents.filter((i) => i.invariantId === "NO_CROSS_RUN_CONTAMINATION");
    if (crossContam.length > 0) {
      violations.push(`${crossContam.length} cross-run contamination incidents`);
    }
    const dupFinal = this.incidents.filter((i) => i.invariantId === "1_USER_1_ASSISTANT");
    if (dupFinal.length > 0) {
      violations.push(`${dupFinal.length} duplicate final message incidents`);
    }
    const staleWrite = this.incidents.filter((i) => i.invariantId === "STALE_BASE_PROTECTION");
    if (staleWrite.length > 0) {
      violations.push(`${staleWrite.length} unsafe stale write incidents`);
    }
    const resourceOwnership = this.incidents.filter((i) => i.invariantId === "RESOURCE_OWNERSHIP_CLEAN");
    if (resourceOwnership.length > 0) {
      violations.push(`${resourceOwnership.length} resource ownership violations`);
    }
    return violations;
  }

  private _enforceRetention(): void {
    const cutoff = Date.now() - MAX_INCIDENT_AGE_MS;
    // Remove expired incidents (older than 7 days)
    this.incidents = this.incidents.filter((i) => i.lastSeen >= cutoff);
    // Enforce max count — drop oldest first
    if (this.incidents.length > MAX_INCIDENTS) {
      const dropped = this.incidents.splice(0, this.incidents.length - MAX_INCIDENTS);
      for (const d of dropped) {
        this.seenFingerprints.delete(d.fingerprint);
      }
    }
    // Rebuild seenFingerprints to stay consistent
    this.seenFingerprints.clear();
    for (const inc of this.incidents) {
      this.seenFingerprints.set(inc.fingerprint, inc.id);
    }
  }

  private _loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.incidentsFile)) return;
      const raw = fs.readFileSync(this.incidentsFile, "utf-8");
      const store = JSON.parse(raw) as IncidentStore;
      if (store.schemaVersion !== INCIDENT_SCHEMA_VERSION) {
        // Discard incompatible schema — safe per §77
        return;
      }
      this.incidents = store.incidents ?? [];
      // Rebuild seenFingerprints
      for (const inc of this.incidents) {
        this.seenFingerprints.set(inc.fingerprint, inc.id);
      }
      // Enforce retention after load
      this._enforceRetention();
    } catch {
      // Corrupt store — start fresh
      this.incidents = [];
      this.seenFingerprints.clear();
    }
  }

  private _saveToDisk(): void {
    try {
      const dir = path.dirname(this.incidentsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const store: IncidentStore = {
        schemaVersion: INCIDENT_SCHEMA_VERSION,
        incidents: this.incidents,
      };
      fs.writeFileSync(this.incidentsFile, JSON.stringify(store, null, 2), "utf-8");
    } catch {
      // Best-effort — never throw
    }
  }
}