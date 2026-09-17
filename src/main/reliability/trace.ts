/**
 * trace.ts — TraceRecorder.
 *
 * Records semantic events during AgentRun execution.
 * Used for:
 *   - Failure diagnosis (what happened before the incident?)
 *   - Deterministic replay (reproduce the exact failure scenario)
 *   - Regression corpus seeding (save failing traces as test fixtures)
 *
 * Performance requirements (§81):
 *   - Trace semantic events ONLY — not every streamed token
 *   - No synchronous disk write per event (batch/persist on run end)
 *   - Event arrays are bounded per trace (MAX_EVENTS_PER_TRACE = 500)
 *   - Total trace store bounded (MAX_STORED_TRACES = 50)
 *
 * Privacy (§80):
 *   - No raw prompt/content in events
 *   - No absolute paths in events
 *   - No secret values in meta
 *   - Sanitizer applied before any persistence
 *
 * Schema: TRACE_SCHEMA_VERSION = 1
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { TraceEvent } from "../../shared/types.js";
import { sanitizeState } from "./sanitizer.js";

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_TRACE = 500;
const MAX_STORED_TRACES = 50;

// ── Schema ────────────────────────────────────────────────────────────────────

export const TRACE_SCHEMA_VERSION = 1;

// ── Trace record ──────────────────────────────────────────────────────────────

export interface AgentRunTrace {
  traceId: string;
  requestId: string;
  conversationId: string;
  projectId?: string;
  startedAt: number;
  endedAt?: number;
  outcome: "completed" | "failed" | "cancelled" | "in_progress";
  failureCode?: string;
  events: TraceEvent[];
  eventCount: number;
  truncated: boolean;
}

interface TraceStore {
  schemaVersion: number;
  traces: AgentRunTrace[];
}

// ── TraceRecorder ─────────────────────────────────────────────────────────────

export class TraceRecorder {
  private tracesDir: string;
  private activeTraces = new Map<string, AgentRunTrace>(); // traceId → trace
  private requestToTrace = new Map<string, string>(); // requestId → traceId
  private completedTraces: AgentRunTrace[] = [];
  private readonly tracesFile: string;

  constructor(opts: { dataDir: string }) {
    this.tracesDir = path.join(opts.dataDir, "traces");
    this.tracesFile = path.join(this.tracesDir, "traces.json");
    this._loadFromDisk();
  }

  /**
   * Start recording a trace for a new AgentRun.
   * Returns traceId.
   */
  startTrace(opts: {
    requestId: string;
    conversationId: string;
    projectId?: string;
  }): string {
    const traceId = randomUUID();
    const trace: AgentRunTrace = {
      traceId,
      requestId: opts.requestId,
      conversationId: opts.conversationId,
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
      startedAt: Date.now(),
      outcome: "in_progress",
      events: [],
      eventCount: 0,
      truncated: false,
    };
    this.activeTraces.set(traceId, trace);
    this.requestToTrace.set(opts.requestId, traceId);
    return traceId;
  }

  /**
   * Emit a semantic event to the active trace for a request.
   * Non-throwing — silently ignores if no active trace for requestId.
   */
  emit(
    requestId: string,
    kind: TraceEvent["kind"],
    meta: Record<string, unknown>,
    opts: { toolCallId?: string; resourceId?: string } = {},
  ): void {
    const traceId = this.requestToTrace.get(requestId);
    if (!traceId) return;
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    if (trace.events.length >= MAX_EVENTS_PER_TRACE) {
      trace.truncated = true;
      return;
    }

    const event: TraceEvent = {
      traceId,
      requestId,
      conversationId: trace.conversationId,
      ...(trace.projectId !== undefined && { projectId: trace.projectId }),
      sequence: trace.events.length,
      timestamp: Date.now(),
      kind,
      // Sanitize meta before storing — no secrets, no absolute paths
      meta: sanitizeState(meta, { omitContent: true }) as Record<string, unknown>,
      ...(opts.toolCallId && { toolCallId: opts.toolCallId }),
      ...(opts.resourceId && { resourceId: opts.resourceId }),
    };

    trace.events.push(event);
    trace.eventCount = trace.events.length;
  }

  /**
   * Mark a trace as completed/failed/cancelled and move to completed store.
   */
  endTrace(
    requestId: string,
    outcome: "completed" | "failed" | "cancelled",
    failureCode?: string,
  ): AgentRunTrace | null {
    const traceId = this.requestToTrace.get(requestId);
    if (!traceId) return null;
    const trace = this.activeTraces.get(traceId);
    if (!trace) return null;

    trace.outcome = outcome;
    trace.endedAt = Date.now();
    if (failureCode) trace.failureCode = failureCode;

    // Emit the terminal run event before moving to completed store
    const terminalKind: TraceEvent["kind"] =
      outcome === "completed" ? "RUN_COMPLETED" :
      outcome === "cancelled" ? "RUN_CANCELLED" :
      "RUN_FAILED";
    this.emit(requestId, terminalKind, {
      ...(failureCode !== undefined && { failureCode }),
    });

    this.activeTraces.delete(traceId);
    this.requestToTrace.delete(requestId);

    this.completedTraces.push(trace);
    this._enforceRetention();
    this._saveToDisk();

    return trace;
  }

  getTraceByRequestId(requestId: string): AgentRunTrace | undefined {
    // Check active first, then completed
    const traceId = this.requestToTrace.get(requestId);
    if (traceId) return this.activeTraces.get(traceId);
    return this.completedTraces.find((t) => t.requestId === requestId);
  }

  getTraceById(traceId: string): AgentRunTrace | undefined {
    return (
      this.activeTraces.get(traceId) ??
      this.completedTraces.find((t) => t.traceId === traceId)
    );
  }

  /** Get all completed traces (for replay harness) */
  getCompletedTraces(): AgentRunTrace[] {
    return [...this.completedTraces];
  }

  /** Get traces filtered by outcome */
  getFailedTraces(): AgentRunTrace[] {
    return this.completedTraces.filter((t) => t.outcome === "failed");
  }

  clear(): void {
    this.activeTraces.clear();
    this.requestToTrace.clear();
    this.completedTraces = [];
    this._saveToDisk();
  }

  private _enforceRetention(): void {
    if (this.completedTraces.length > MAX_STORED_TRACES) {
      this.completedTraces.splice(0, this.completedTraces.length - MAX_STORED_TRACES);
    }
  }

  private _loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.tracesFile)) return;
      const raw = fs.readFileSync(this.tracesFile, "utf-8");
      const store = JSON.parse(raw) as TraceStore;
      if (store.schemaVersion !== TRACE_SCHEMA_VERSION) return;
      this.completedTraces = store.traces ?? [];
      this._enforceRetention();
    } catch {
      this.completedTraces = [];
    }
  }

  private _saveToDisk(): void {
    try {
      if (!fs.existsSync(this.tracesDir)) {
        fs.mkdirSync(this.tracesDir, { recursive: true });
      }
      const store: TraceStore = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        traces: this.completedTraces,
      };
      fs.writeFileSync(this.tracesFile, JSON.stringify(store), "utf-8");
    } catch {
      // Best-effort
    }
  }
}