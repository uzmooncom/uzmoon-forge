/**
 * Dev Panel — Main Process Snapshot API
 *
 * Aggregates runtime state from QueueManager, BrowserManager, IncidentRecorder,
 * TraceRecorder, and ForgeLogger into a single sanitized snapshot for the Dev Panel.
 */
import { sanitizeState } from "../reliability/sanitizer.js";
import { tryGetTraceRecorder, tryGetIncidentRecorder } from "../reliability/index.js";
import { forgeLogger } from "./logger.js";
import type { ForgeLogEntry } from "./logger.js";
import type { AgentRunState } from "../../shared/types.js";
import type { ActiveRunEntry } from "../queue/QueueManager.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DevRunSummary {
  requestId: string;
  agentRunId: string;
  conversationId: string;
  state: AgentRunState;
  startedAt: number;
  durationMs: number;
  toolStepCount: number;
  waitingForHuman: boolean;
  approvalPending: boolean;
}

export interface DevQueueSummary {
  conversationId: string;
  queuedCount: number;
  processingCount: number;
  failedCount: number;
  paused: boolean;
}

export interface DevBrowserSummary {
  windowOpen: boolean;
  windowHealthy: boolean;
  tabCount: number;
  activeAgentControls: number;
  conversationBindings: number;
  pendingApprovals: number;
}

export interface DevIncidentSummary {
  id: string;
  invariantId: string;
  category: string;
  failureCode: string;
  timestamp: number;
  fingerprint: string;
}

export interface DevSnapshot {
  capturedAt: number;
  appVersion: string;
  activeRuns: DevRunSummary[];
  queueSummary: DevQueueSummary[];
  browser: DevBrowserSummary;
  recentIncidents: DevIncidentSummary[];
  logStats: {
    total: number;
    errors: number;
    warnings: number;
    fatals: number;
  };
  /** Hang warnings — runs active for over HANG_THRESHOLD_MS with no recent tool activity */
  hangWarnings: Array<{ requestId: string; durationMs: number; lastToolMs: number | null }>;
}

export interface DevRunTimeline {
  requestId: string;
  events: Array<{
    kind: string;
    timestamp: number;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface DiagnosticBundle {
  schemaVersion: "1.0";
  exportedAt: number;
  appVersion: string;
  snapshot: DevSnapshot;
  recentLogs: ForgeLogEntry[];
  incidents: DevIncidentSummary[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const HANG_THRESHOLD_MS = 60_000; // 1 minute of no tool progress = suspected hang

// ── State accessors (injected to avoid circular deps) ─────────────────────

// These are set from handlers.ts after QueueManager and BrowserManager are initialized
type ActiveRunsGetter = () => ActiveRunEntry[];

type QueueSummaryGetter = () => DevQueueSummary[];
type BrowserSummaryGetter = () => DevBrowserSummary;

let _getActiveRuns: ActiveRunsGetter = () => [];
let _getQueueSummary: QueueSummaryGetter = () => [];
let _getBrowserSummary: BrowserSummaryGetter = () => ({
  windowOpen: false,
  windowHealthy: false,
  tabCount: 0,
  activeAgentControls: 0,
  conversationBindings: 0,
  pendingApprovals: 0,
});

let _appVersion = "unknown";

export function initDevState(opts: {
  getActiveRuns: ActiveRunsGetter;
  getQueueSummary: QueueSummaryGetter;
  getBrowserSummary: BrowserSummaryGetter;
  appVersion: string;
}): void {
  _getActiveRuns = opts.getActiveRuns;
  _getQueueSummary = opts.getQueueSummary;
  _getBrowserSummary = opts.getBrowserSummary;
  _appVersion = opts.appVersion;
}

// ── Snapshot Builder ───────────────────────────────────────────────────────

export function buildDevSnapshot(): DevSnapshot {
  const now = Date.now();
  const activeRuns = _getActiveRuns();

  // Build run summaries
  const runSummaries: DevRunSummary[] = activeRuns.map((r) => ({
    requestId: r.requestId,
    agentRunId: r.agentRunId,
    conversationId: r.conversationId,
    state: r.state,
    startedAt: r.startedAt,
    durationMs: now - r.startedAt,
    toolStepCount: r.toolActivity.length,
    waitingForHuman: r.waitingForHuman,
    approvalPending: r.approvalPending,
  }));

  // Hang detection: active runs with no tool activity in HANG_THRESHOLD_MS
  const hangWarnings = activeRuns
    .filter((r) => {
      if (r.state === "waiting_for_human") return false; // not a hang
      const runAge = now - r.startedAt;
      if (runAge < HANG_THRESHOLD_MS) return false;
      const completedTools = r.toolActivity.filter((t) => t.completedAt !== undefined);
      const lastToolMs = completedTools.length > 0
        ? Math.max(...completedTools.map((t) => t.completedAt!))
        : null;
      const timeSinceProgress = lastToolMs ? now - lastToolMs : runAge;
      return timeSinceProgress > HANG_THRESHOLD_MS;
    })
    .map((r) => {
      const completedTools = r.toolActivity.filter((t) => t.completedAt !== undefined);
      const lastToolMs = completedTools.length > 0
        ? Math.max(...completedTools.map((t) => t.completedAt!))
        : null;
      return { requestId: r.requestId, durationMs: now - r.startedAt, lastToolMs };
    });

  // Incident summaries
  const incidentRecorder = tryGetIncidentRecorder();
  const recentIncidents: DevIncidentSummary[] = incidentRecorder
    ? incidentRecorder.getAll().slice(-20).map((inc) => ({
        id: inc.id,
        invariantId: inc.invariantId,
        category: inc.category as string,
        failureCode: inc.failureCode as string,
        timestamp: inc.lastSeen,
        fingerprint: inc.fingerprint,
      }))
    : [];

  // Log stats
  const allLogs = forgeLogger.getAll();
  const logStats = {
    total: allLogs.length,
    errors: allLogs.filter((e) => e.level === "error").length,
    warnings: allLogs.filter((e) => e.level === "warn").length,
    fatals: allLogs.filter((e) => e.level === "fatal").length,
  };

  return {
    capturedAt: now,
    appVersion: _appVersion,
    activeRuns: runSummaries,
    queueSummary: _getQueueSummary(),
    browser: _getBrowserSummary(),
    recentIncidents,
    logStats,
    hangWarnings,
  };
}

export function getRunTimeline(requestId: string): DevRunTimeline {
  const tracer = tryGetTraceRecorder();
  if (!tracer) return { requestId, events: [] };

  // Use forgeLogger to reconstruct timeline from logged trace events for this requestId
  const logEntries = forgeLogger.query({ requestId });
  const events = logEntries.map((e) => ({
    kind: e.event,
    timestamp: e.timestamp,
    ...(e.durationMs !== undefined && { durationMs: e.durationMs }),
    ...(e.metadata ? { metadata: sanitizeState(e.metadata) as Record<string, unknown> } : {}),
  }));

  return { requestId, events };
}

export function buildDiagnosticBundle(): DiagnosticBundle {
  const snapshot = buildDevSnapshot();
  const recentLogs = forgeLogger.query({ limit: 500 });
  // Redact all log metadata (already done by logger, double-check)
  const sanitizedLogs: ForgeLogEntry[] = recentLogs.map((entry) => ({
    ...entry,
    ...(entry.metadata
      ? { metadata: sanitizeState(entry.metadata) as Record<string, unknown> }
      : {}),
  }));

  const incidentRecorder = tryGetIncidentRecorder();
  const incidents: DevIncidentSummary[] = incidentRecorder
    ? incidentRecorder.getAll().map((inc) => ({
        id: inc.id,
        invariantId: inc.invariantId,
        category: inc.category as string,
        failureCode: inc.failureCode as string,
        timestamp: inc.lastSeen,
        fingerprint: inc.fingerprint,
      }))
    : [];

  return {
    schemaVersion: "1.0",
    exportedAt: Date.now(),
    appVersion: _appVersion,
    snapshot,
    recentLogs: sanitizedLogs,
    incidents,
  };
}