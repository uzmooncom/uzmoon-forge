/**
 * index.ts — ReliabilityEngine.
 *
 * Single entry point for the Forge Reliability Subsystem.
 * Wires together: InvariantMonitor, IncidentRecorder, TraceRecorder,
 * SelfHealingEngine, and KnownIncidentRegistry.
 *
 * Called once from main.ts after getDb() and before registerHandlers().
 * All subsystem internals are hidden behind this API surface.
 */

import { registerViolationHandler } from "./invariants.js";
import { IncidentRecorder } from "./incident.js";
import { TraceRecorder } from "./trace.js";
import { SelfHealingEngine } from "./self-healing.js";
import { KNOWN_INCIDENTS } from "./known-incidents.js";
import type { InvariantViolation } from "./invariants.js";
import type { ForgeIncident } from "../../shared/types.js";

// Re-export everything needed by consumers
export { assertInvariant, assertInvariantStrict, getAllInvariants, registerViolationHandler } from "./invariants.js";
export * from "./invariants.js";
export { IncidentRecorder } from "./incident.js";
export { TraceRecorder } from "./trace.js";
export { SelfHealingEngine } from "./self-healing.js";
export { computeFingerprint, buildDedupeKey } from "./fingerprint.js";
export { sanitizeString, sanitizeState, sanitizeValue, buildGitHubIssuePayload, detectResidualSecrets, hasNoAbsolutePaths } from "./sanitizer.js";
export { ReplayHarness, ALL_FIXTURES } from "./replay.js";
export { KNOWN_INCIDENTS, lookupKnownIncident } from "./known-incidents.js";
export type { ReplayFixture, ReplayResult } from "./replay.js";
export type { InvariantViolation } from "./invariants.js";
export type { KnownIncidentEntry } from "./fingerprint.js";
export type { AgentRunTrace } from "./trace.js";
export type { ImprovementCandidate, HealingLevel } from "./self-healing.js";

// ── Singleton engine ──────────────────────────────────────────────────────────

let _recorder: IncidentRecorder | null = null;
let _tracer: TraceRecorder | null = null;
let _healer: SelfHealingEngine | null = null;
let _notifyIncidentCb: ((inc: ForgeIncident) => void) | null = null;

/**
 * Bootstrap the reliability subsystem.
 * Must be called once during app startup before any agent runs.
 *
 * @param dataDir    — app data directory (e.g. $HOME/.uzmoon-forge-v01)
 * @param version    — forge version string (e.g. "0.9.0")
 * @param notifyInc  — callback to push new incidents to renderer via IPC
 */
export function initReliabilityEngine(opts: {
  dataDir: string;
  version: string;
  notifyIncident?: (incident: ForgeIncident) => void;
}): void {
  _notifyIncidentCb = opts.notifyIncident ?? null;

  _recorder = new IncidentRecorder({
    dataDir: opts.dataDir,
    forgeVersion: opts.version,
    knownManifest: KNOWN_INCIDENTS,
  });

  _tracer = new TraceRecorder({ dataDir: opts.dataDir });

  _healer = new SelfHealingEngine();

  // Wire violation handler: violations flow into IncidentRecorder
  registerViolationHandler((violation: InvariantViolation) => {
    if (!_recorder) return;
    const incident = _recorder.record(violation);

    // Fire IPC callback for renderer notification
    if (_notifyIncidentCb) {
      try {
        _notifyIncidentCb(incident);
      } catch {
        // Never throw from reliability subsystem
      }
    }

    // Trigger healing engine (async, non-blocking)
    if (_healer) {
      _healer.handleIncident(incident).catch(() => {
        // Best-effort
      });
    }
  });

  if (_recorder && opts.notifyIncident) {
    _recorder.setNewIncidentCallback(opts.notifyIncident);
  }
}

// ── Accessors ─────────────────────────────────────────────────────────────────

export function getIncidentRecorder(): IncidentRecorder {
  if (!_recorder) throw new Error("ReliabilityEngine not initialized — call initReliabilityEngine() first");
  return _recorder;
}

export function getTraceRecorder(): TraceRecorder {
  if (!_tracer) throw new Error("ReliabilityEngine not initialized — call initReliabilityEngine() first");
  return _tracer;
}

export function getSelfHealingEngine(): SelfHealingEngine {
  if (!_healer) throw new Error("ReliabilityEngine not initialized — call initReliabilityEngine() first");
  return _healer;
}

/** Safe accessor that returns null if not initialized (use in tests). */
export function tryGetIncidentRecorder(): IncidentRecorder | null {
  return _recorder;
}

export function tryGetTraceRecorder(): TraceRecorder | null {
  return _tracer;
}

/** Reset for test isolation — only call in tests */
export function _resetReliabilityEngineForTest(): void {
  _recorder = null;
  _tracer = null;
  _healer = null;
  _notifyIncidentCb = null;
  // Reset violation handler by re-registering null (the handler registry is module-level)
  // We do this by requiring tests to re-init after reset
}