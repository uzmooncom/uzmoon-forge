/**
 * Forge Structured Telemetry Logger
 *
 * Every log entry is a structured event — no raw debug strings.
 * Backed by a bounded ring buffer (2000 entries default) for the Dev Panel.
 * Redacts secrets via the existing sanitizer before any storage.
 */
import { sanitizeState } from "../reliability/sanitizer.js";
import { RingBuffer } from "./ring-buffer.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogCategory =
  | "runtime"
  | "queue"
  | "provider"
  | "stream"
  | "tool"
  | "browser"
  | "browser-window"
  | "browser-control"
  | "approval"
  | "human-intervention"
  | "ipc"
  | "renderer"
  | "persistence"
  | "reliability"
  | "performance"
  | "security"
  | "permission";

export interface ForgeLogEntry {
  /** Monotonic entry ID within this session */
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  event: string;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  streamId?: string;
  toolCallId?: string;
  browserTabId?: string;
  state?: string;
  durationMs?: number;
  /** Sanitized freeform metadata */
  metadata?: Record<string, unknown>;
  /** Error message if applicable */
  errorMessage?: string;
  /** Error stack (dev mode only) */
  errorStack?: string;
}

// ── Level ordering ─────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

// ── Logger ─────────────────────────────────────────────────────────────────

const LOG_BUFFER_CAPACITY = 2000;

export class ForgeLogger {
  private readonly _buffer: RingBuffer<ForgeLogEntry>;
  private _seq = 0;
  private _minLevel: LogLevel;
  private readonly _devMode: boolean;

  constructor(opts?: { capacity?: number; minLevel?: LogLevel; devMode?: boolean }) {
    this._buffer = new RingBuffer(opts?.capacity ?? LOG_BUFFER_CAPACITY);
    this._minLevel = opts?.minLevel ?? (process.env["NODE_ENV"] === "production" ? "info" : "debug");
    this._devMode = opts?.devMode ?? process.env["NODE_ENV"] !== "production";
  }

  private _shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this._minLevel];
  }

  private _sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
    try {
      return sanitizeState(meta) as Record<string, unknown>;
    } catch {
      return { _sanitizeFailed: true };
    }
  }

  log(
    level: LogLevel,
    category: LogCategory,
    event: string,
    meta?: {
      conversationId?: string;
      requestId?: string;
      agentRunId?: string;
      streamId?: string;
      toolCallId?: string;
      browserTabId?: string;
      state?: string;
      durationMs?: number;
      metadata?: Record<string, unknown>;
      error?: Error | unknown;
    },
  ): void {
    if (!this._shouldLog(level)) return;

    const entry: ForgeLogEntry = {
      id: ++this._seq,
      timestamp: Date.now(),
      level,
      category,
      event,
    };

    if (meta) {
      if (meta.conversationId) Object.assign(entry, { conversationId: meta.conversationId });
      if (meta.requestId) Object.assign(entry, { requestId: meta.requestId });
      if (meta.agentRunId) Object.assign(entry, { agentRunId: meta.agentRunId });
      if (meta.streamId) Object.assign(entry, { streamId: meta.streamId });
      if (meta.toolCallId) Object.assign(entry, { toolCallId: meta.toolCallId });
      if (meta.browserTabId) Object.assign(entry, { browserTabId: meta.browserTabId });
      if (meta.state) Object.assign(entry, { state: meta.state });
      if (meta.durationMs !== undefined) Object.assign(entry, { durationMs: meta.durationMs });
      if (meta.metadata) Object.assign(entry, { metadata: this._sanitizeMeta(meta.metadata) });
      if (meta.error) {
        const err = meta.error;
        const errorMessage = err instanceof Error ? err.message : String(err);
        Object.assign(entry, { errorMessage });
        if (this._devMode && err instanceof Error && err.stack) {
          Object.assign(entry, { errorStack: err.stack });
        }
      }
    }

    this._buffer.push(entry);

    // Also emit to console in dev mode for easy inspection
    if (this._devMode || level === "error" || level === "fatal") {
      const prefix = `[forge:${category}] ${event}`;
      const ids = [
        meta?.conversationId ? `conv=${meta.conversationId.slice(0, 8)}` : null,
        meta?.requestId ? `req=${meta.requestId.slice(0, 8)}` : null,
        meta?.agentRunId ? `run=${meta.agentRunId.slice(0, 8)}` : null,
      ].filter(Boolean).join(" ");
      const line = ids ? `${prefix} (${ids})` : prefix;

      if (level === "error" || level === "fatal") {
        console.error(`[${level.toUpperCase()}] ${line}`); // eslint-disable-line no-console
      } else if (level === "warn") {
        console.warn(`[WARN] ${line}`); // eslint-disable-line no-console
      } else if (this._devMode) {
        // eslint-disable-next-line no-console
        console.debug(`[${level.toUpperCase()}] ${line}`);
      }
    }
  }

  // ── Convenience methods ──────────────────────────────────────────────────

  trace(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("trace", category, event, meta);
  }
  debug(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("debug", category, event, meta);
  }
  info(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("info", category, event, meta);
  }
  warn(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("warn", category, event, meta);
  }
  error(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("error", category, event, meta);
  }
  fatal(category: LogCategory, event: string, meta?: Parameters<ForgeLogger["log"]>[3]): void {
    this.log("fatal", category, event, meta);
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** All events in insertion order */
  getAll(): ForgeLogEntry[] {
    return this._buffer.toArray();
  }

  /** Filter events by level, category, and/or text search */
  query(opts: {
    minLevel?: LogLevel;
    category?: LogCategory;
    conversationId?: string;
    requestId?: string;
    agentRunId?: string;
    search?: string;
    limit?: number;
  }): ForgeLogEntry[] {
    let events = this._buffer.toArray();

    if (opts.minLevel) {
      const minOrder = LEVEL_ORDER[opts.minLevel];
      events = events.filter((e) => LEVEL_ORDER[e.level] >= minOrder);
    }
    if (opts.category) events = events.filter((e) => e.category === opts.category);
    if (opts.conversationId) events = events.filter((e) => e.conversationId === opts.conversationId);
    if (opts.requestId) events = events.filter((e) => e.requestId === opts.requestId);
    if (opts.agentRunId) events = events.filter((e) => e.agentRunId === opts.agentRunId);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      events = events.filter(
        (e) =>
          e.event.toLowerCase().includes(q) ||
          e.errorMessage?.toLowerCase().includes(q) ||
          JSON.stringify(e.metadata ?? {}).toLowerCase().includes(q),
      );
    }
    if (opts.limit) events = events.slice(-opts.limit);
    return events;
  }

  /** Clear the ring buffer */
  clear(): void {
    this._buffer.clear();
  }

  get entryCount(): number {
    return this._buffer.size;
  }

  setMinLevel(level: LogLevel): void {
    this._minLevel = level;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

/** Application-wide logger singleton */
export const forgeLogger = new ForgeLogger();