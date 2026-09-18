/**
 * dev-process-manager.ts — Long-running project process lifecycle.
 *
 * Handles dev servers (pnpm dev, npm run dev, vite, etc.) that must stay
 * alive across agent runs. Key differences from CommandManager:
 *
 * - No timeout: processes run until explicitly stopped or app quits
 * - URL detection: detects localhost URLs in output (Vite, CRA, Next.js, etc.)
 * - Ready probing: HTTP GET to detected URL to confirm server is up
 * - App-quit cleanup: all processes terminated on app exit
 * - shell: false — always. No shell composition.
 *
 * Architecture: extends existing CommandManager infrastructure.
 * - Reuses NodeProcessAdapter (already created in main.ts)
 * - Reuses buildSafeChildEnvironment from command-env.ts
 * - Reuses resolveProjectPath from eligibility.ts for cwd containment
 * - Reuses OutputBuffer for bounded output capture
 */
import { randomUUID } from "crypto";
import path from "path";
import http from "http";
import https from "https";
import { DevProcessRecord, DevProcessState, DEV_PROCESS_IPC } from "../../shared/types.js";
import { NodeProcessAdapter, type SpawnHandle } from "./process-adapter.js";
import { buildSafeChildEnvironment } from "./command-env.js";
import { OutputBuffer } from "./output-buffer.js";
import { COMMAND_LIMITS } from "./command-limits.js";

// ── Module state ─────────────────────────────────────────────────────────────

interface LiveDevProcess {
  processId: string;
  record: DevProcessRecord;
  handle: SpawnHandle;
  buffer: OutputBuffer;
  urlDetectTimer: ReturnType<typeof setInterval> | null;
}

const _adapter = new NodeProcessAdapter();
const _liveProcesses = new Map<string, LiveDevProcess>();

// Renderer sender for push events
let _sender: import("electron").WebContents | null = null;

// URL patterns detected from common dev servers (Vite, CRA, Next, Nuxt, etc.)
const URL_PATTERNS = [
  /https?:\/\/localhost:\d+/g,
  /https?:\/\/127\.0\.0\.1:\d+/g,
  /(?:Local|Network|running at|started on|listening on|available at)[^\n]*?(https?:\/\/[^\s,\n]+)/gi,
  /➜\s+Local:\s+(https?:\/\/[^\s]+)/g,
];

// ── Initialisation ────────────────────────────────────────────────────────────

export function initDevProcessManager(sender: import("electron").WebContents): void {
  _sender = sender;
}

export function cleanupDevProcessesOnQuit(): void {
  for (const live of _liveProcesses.values()) {
    try { live.handle.cancel(); } catch { /* ignore */ }
  }
  _liveProcesses.clear();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface StartDevProcessOpts {
  executable: string;
  args: string[];
  cwdAbsolute: string;
  projectId: string;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  purpose?: string;
  userOwned?: boolean;
}

export function startDevProcess(opts: StartDevProcessOpts): DevProcessRecord {
  const id = randomUUID();
  const now = Date.now();

  const record: DevProcessRecord = {
    id,
    projectId: opts.projectId,
    ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
    ...(opts.requestId !== undefined && { requestId: opts.requestId }),
    ...(opts.agentRunId !== undefined && { agentRunId: opts.agentRunId }),
    executable: opts.executable,
    args: opts.args,
    cwd: opts.cwdAbsolute,
    state: "starting",
    readyState: "detecting",
    detectedUrls: [],
    startedAt: now,
    userOwned: opts.userOwned ?? false,
  };

  const buffer = new OutputBuffer();
  const safeEnv = buildSafeChildEnvironment();

  const handle = _adapter.spawn({
    executable: opts.executable,
    args: opts.args,
    cwd: opts.cwdAbsolute,
    env: safeEnv,
    // Long-running: no artificial timeout — 24 hours
    timeoutMs: 24 * 60 * 60 * 1000,
  });

  const live: LiveDevProcess = { processId: id, record, handle, buffer, urlDetectTimer: null };
  _liveProcesses.set(id, live);

  // Wire output
  handle.onOutput((ev) => {
    buffer.append(ev.kind, ev.data);
    _tryDetectUrls(live, ev.data.toString("utf8"));
  });

  // Wire completion
  handle.onComplete((result) => {
    const finalState: DevProcessState = result.spawnError
      ? "failed"
      : result.timedOut
      ? "stopped"
      : result.exitCode === 0
      ? "stopped"
      : "failed";

    _updateRecord(live, {
      state: finalState,
      readyState: live.record.readyState === "ready" ? "ready" : "unknown",
      stoppedAt: Date.now(),
    });
    if (live.urlDetectTimer) clearInterval(live.urlDetectTimer);
    _liveProcesses.delete(id);
    _pushStateChanged(live.record);
  });

  // Update to running after successful spawn wire-up
  _updateRecord(live, { state: "running" });
  _pushStateChanged(live.record);

  return { ...record };
}

export function listDevProcesses(projectId?: string): DevProcessRecord[] {
  const all = Array.from(_liveProcesses.values()).map((lp) => ({ ...lp.record }));
  if (!projectId) return all;
  return all.filter((r) => r.projectId === projectId);
}

export function readDevProcessOutput(processId: string): { found: boolean; output: string } {
  const live = _liveProcesses.get(processId);
  if (!live) return { found: false, output: "" };
  return { found: true, output: live.buffer.getSanitizedModelOutput() };
}

export function stopDevProcess(processId: string): { found: boolean } {
  const live = _liveProcesses.get(processId);
  if (!live) return { found: false };
  if (live.urlDetectTimer) {
    clearInterval(live.urlDetectTimer);
    live.urlDetectTimer = null;
  }
  _updateRecord(live, { state: "stopping" });
  _pushStateChanged(live.record);
  live.handle.cancel();
  return { found: true };
}

// ── URL detection ─────────────────────────────────────────────────────────────

function _tryDetectUrls(live: LiveDevProcess, chunk: string): void {
  if (live.record.readyState === "ready") return;

  const found = new Set<string>(live.record.detectedUrls);
  for (const pattern of URL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.exec(chunk)) !== null) {
      const url = (match[1] ?? match[0]).trim().replace(/\/$/, "");
      if (url.startsWith("http")) found.add(url);
    }
  }

  const urls = Array.from(found);
  if (urls.length > live.record.detectedUrls.length) {
    _updateRecord(live, { detectedUrls: urls, readyState: "detecting" });
    _pushStateChanged(live.record);
    // Probe the first new URL
    const candidate = urls.find((u) => !live.record.detectedUrls.includes(u)) ?? urls[0]!;
    _probeUrl(live, candidate);
  }
}

function _probeUrl(live: LiveDevProcess, url: string): void {
  if (live.record.readyState === "ready") return;

  const MAX_PROBE_ATTEMPTS = 30;
  const PROBE_INTERVAL_MS = 1000;
  let attempts = 0;

  if (live.urlDetectTimer) clearInterval(live.urlDetectTimer);
  live.urlDetectTimer = setInterval(() => {
    attempts++;
    if (attempts > MAX_PROBE_ATTEMPTS) {
      clearInterval(live.urlDetectTimer!);
      live.urlDetectTimer = null;
      if (live.record.readyState !== "ready") {
        _updateRecord(live, { readyState: "timeout" });
        _pushStateChanged(live.record);
      }
      return;
    }

    _httpProbe(url)
      .then((ok) => {
        if (ok && live.record.readyState !== "ready") {
          clearInterval(live.urlDetectTimer!);
          live.urlDetectTimer = null;
          _updateRecord(live, { readyState: "ready", readyUrl: url });
          _pushStateChanged(live.record);
        }
      })
      .catch(() => { /* probe failed — keep trying */ });
  }, PROBE_INTERVAL_MS);

  // Unref so Node doesn't keep alive for this alone
  if (live.urlDetectTimer.unref) live.urlDetectTimer.unref();
}

function _httpProbe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const timeout = 2000;

    try {
      const req = lib.get(
        { hostname: parsed.hostname, port: parsed.port, path: "/", timeout },
        (res) => {
          resolve(res.statusCode !== undefined && res.statusCode < 500);
          res.destroy();
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.setTimeout(timeout);
    } catch {
      resolve(false);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _updateRecord(live: LiveDevProcess, patch: Partial<DevProcessRecord>): void {
  Object.assign(live.record, patch);
}

function _pushStateChanged(record: DevProcessRecord): void {
  if (_sender && !_sender.isDestroyed()) {
    _sender.send(DEV_PROCESS_IPC.STATE_CHANGED, { ...record });
  }
}

// ── Output bounds ─────────────────────────────────────────────────────────────
// Re-export for tool-executor use
export { COMMAND_LIMITS };

// ── Project path resolution helper ───────────────────────────────────────────

/**
 * Resolve absolute cwd for a dev process using the same containment logic as
 * CommandManager — ensures no path traversal outside project root.
 */
export function resolveDevProcessCwd(projectRoot: string, cwdRelative?: string): string | null {
  if (!cwdRelative) return projectRoot;
  const abs = path.resolve(projectRoot, cwdRelative);
  if (!abs.startsWith(path.resolve(projectRoot))) return null;
  return abs;
}