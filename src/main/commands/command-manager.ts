/**
 * command-manager.ts — Canonical command execution authority.
 *
 * All command lifecycle decisions are made here. Renderer has no process privilege.
 * No ChildProcess, AbortController, or stream object ever leaves this module.
 *
 * Security invariants enforced here:
 * - COMMAND_CWD_WITHIN_PROJECT: cwd resolves to within project root (symlink-safe)
 * - COMMAND_REQUIRES_AUTHORIZATION: only approved/trusted commands spawn
 * - COMMAND_START_ONCE: commandId set prevents duplicate spawn
 * - COMMAND_IDENTITY_IMMUTABLE: spec never mutated after creation
 * - COMMAND_NO_PROVIDER_SECRET_ENV: safe env built by command-env module
 * - COMMAND_PROCESS_RELEASED: live handles cleared on terminal state
 *
 * State machine:
 *   proposed → awaiting_approval → queued → running → succeeded/failed/timed_out
 *             ↘ blocked (policy block)
 *             ↘ rejected (user reject)
 *   Any active → cancelled (user stop, agent cancel, app shutdown)
 */
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";
import type { WebContents } from "electron";
import type {
  CommandExecution,
  CommandState,
  CommandSpec,
  CommandSource,
  CommandTrustRule,
  CommandEvidenceRef,
  CommandOutputPage,
} from "../../shared/types.js";
import { COMMAND_IPC, COMMAND_LIMITS, COMMAND_TERMINAL_STATES } from "../../shared/types.js";
import type { ForgeFailureCode } from "../../shared/types.js";
import {
  evaluatePolicyWithScriptHash,
  normalizeSpec,
  formatCommandForDisplay,
  resolveScriptContentHash,
  resolveScriptBody,
} from "./command-policy.js";
import { buildSafeChildEnvironment } from "./command-env.js";
import {
  OutputBuffer,
  stripAnsiAndControlChars,
  sanitizeCommandOutputForModel,
} from "./output-buffer.js";
import { assertInvariant } from "../reliability/invariants.js";
import { tryGetTraceRecorder } from "../reliability/index.js";
import * as db from "../database/db.js";

// ── DB sentinel ──────────────────────────────────────────────────────────────
// All db functions take `_db: true` as first arg.
// We pass the literal `true` — same pattern as QueueManager.ts.
const DB = true as const;

// ── Process handle registry (in-memory only, never persisted) ────────────────

interface LiveProcess {
  commandId: string;
  handle: import("./process-adapter.js").SpawnHandle;
  buffer: OutputBuffer;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

// ── Module-level state ──────────────────────────────────────────────────────

let _adapter: import("./process-adapter.js").IProcessAdapter | null = null;
let _sender: WebContents | null = null;

/** Live process handles — never persisted, cleared on terminal state */
const _liveProcesses = new Map<string, LiveProcess>();

/** Guards against duplicate spawn for same commandId */
const _spawnedIds = new Set<string>();

/** Track active lifecycle promises for deterministic drain */
const _activeLifecyclePromises = new Set<Promise<void>>();

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the command manager with a process adapter and WebContents sender.
 * Must be called once from main.ts after window is created.
 */
export function initCommandManager(
  adapter: import("./process-adapter.js").IProcessAdapter,
  sender: WebContents
): void {
  _adapter = adapter;
  _sender = sender;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ProposeOptions {
  projectId: string;
  projectRoot: string;
  spec: CommandSpec;
  source: CommandSource;
  conversationId?: string;
  requestId?: string;
  queueItemId?: string;
}

/**
 * Propose a command. Runs policy, creates CommandExecution record.
 * If policy=block: record inserted as "blocked" immediately (no approval).
 * If policy=allow (trusted): record inserted as "queued" and auto-runs.
 * If policy=ask: record inserted as "awaiting_approval".
 */
export function propose(opts: ProposeOptions): CommandExecution {
  // Validate CWD containment (COMMAND_CWD_WITHIN_PROJECT)
  const resolvedCwd = resolveCwdSafe(opts.projectRoot, opts.spec.cwdRelative);
  assertInvariant(
    "COMMAND_CWD_WITHIN_PROJECT",
    resolvedCwd !== null,
    { projectRoot: opts.projectRoot, cwdRelative: opts.spec.cwdRelative },
    { hint: "cwd must resolve within project root" }
  );
  if (resolvedCwd === null) {
    throw new Error(`COMMAND_CWD_ESCAPE: "${opts.spec.cwdRelative}" escapes project root`);
  }

  // Evaluate policy
  const trustRules = db.listTrustRules(DB, opts.projectId);
  const policyDecision = evaluatePolicyWithScriptHash(opts.spec, trustRules, opts.projectRoot);

  const id = randomUUID();
  const now = Date.now();
  const displayCommand = formatCommandForDisplay(opts.spec);

  let initialState: CommandState;
  let authorizationState: CommandExecution["authorizationState"];

  if (policyDecision.decision === "block") {
    initialState = "blocked";
    authorizationState = "blocked_by_policy";
  } else if (policyDecision.decision === "allow") {
    initialState = "queued";
    authorizationState = policyDecision.trustRuleId ? "trusted" : "approved_once";
  } else {
    initialState = "awaiting_approval";
    authorizationState = "pending";
  }

  const record: CommandExecution = {
    id,
    projectId: opts.projectId,
    ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
    ...(opts.requestId !== undefined && { requestId: opts.requestId }),
    ...(opts.queueItemId !== undefined && { queueItemId: opts.queueItemId }),
    source: opts.source,
    spec: opts.spec,
    displayCommand,
    policyDecision,
    authorizationState,
    state: initialState,
    createdAt: now,
  };

  db.insertCommand(DB, record);

  // Emit trace event
  const tracer = tryGetTraceRecorder();
  if (tracer && opts.requestId) {
    tracer.emit(opts.requestId, "COMMAND_PROPOSED", {
      commandId: id,
      executable: opts.spec.executable,
      riskClass: policyDecision.riskClass,
      decision: policyDecision.decision,
    });
  }

  pushStateChange(record);

  // Auto-run if allowed
  if (initialState === "queued") {
    void _launchCommand(record, opts.projectRoot);
  }

  return record;
}

/**
 * Approve a command that is awaiting approval.
 * mode: "once" = approve this run only; "trust" = create a trust rule.
 */
export function approveCommand(
  commandId: string,
  mode: "once" | "trust"
): CommandExecution | null {
  const record = db.getCommand(DB, commandId);
  if (!record) return null;

  // Re-validate state — renderer may send stale approval
  if (record.state !== "awaiting_approval") return record;

  // CRITICAL: re-evaluate policy in main (never trust renderer's decision)
  const project = db.getProject(DB, record.projectId);
  if (!project) {
    return updateCommandState(commandId, "cancelled");
  }

  const trustRules = db.listTrustRules(DB, record.projectId);
  const freshDecision = evaluatePolicyWithScriptHash(
    record.spec,
    trustRules,
    project.workingDirectory
  );

  // If policy changed to block since approval was shown — deny
  if (freshDecision.decision === "block") {
    return updateCommandState(commandId, "blocked");
  }

  assertInvariant(
    "COMMAND_REQUIRES_AUTHORIZATION",
    record.state === "awaiting_approval",
    { commandId, state: record.state },
    { hint: "only awaiting_approval commands can be approved" }
  );

  // Create trust rule if requested
  if (mode === "trust") {
    const normalized = normalizeSpec(record.spec);
    const scriptHash = resolveScriptContentHash(record.spec, project.workingDirectory) ?? undefined;
    const scriptBody = resolveScriptBody(record.spec, project.workingDirectory) ?? undefined;

    const trustRule: CommandTrustRule = {
      id: randomUUID(),
      projectId: record.projectId,
      normalizedSpec: normalized,
      ...(scriptHash !== undefined && { scriptContentHash: scriptHash }),
      ...(scriptBody !== undefined && { scriptBodySnapshot: scriptBody }),
      createdAt: Date.now(),
      useCount: 0,
    };
    db.insertTrustRule(DB, trustRule);

    // Emit trust granted trace event
    const tracer = tryGetTraceRecorder();
    if (tracer && record.requestId) {
      tracer.emit(record.requestId, "COMMAND_TRUST_GRANTED", {
        commandId,
        trustRuleId: trustRule.id,
      });
    }
  }

  const updated = db.updateCommand(DB, commandId, {
    state: "queued",
    authorizationState: mode === "trust" ? "trusted" : "approved_once",
  });

  if (updated) {
    pushStateChange(updated);
    void _launchCommand(updated, project.workingDirectory);
  }

  return updated;
}

/**
 * Reject a command that is awaiting approval.
 */
export function rejectCommand(commandId: string): CommandExecution | null {
  const record = db.getCommand(DB, commandId);
  if (!record) return null;
  if (record.state !== "awaiting_approval") return record;

  const updated = db.updateCommand(DB, commandId, {
    state: "cancelled",
    authorizationState: "rejected",
    completedAt: Date.now(),
  });
  if (updated) pushStateChange(updated);
  return updated;
}

/**
 * Cancel an active command (any non-terminal state).
 */
export function cancelCommand(commandId: string): CommandExecution | null {
  const record = db.getCommand(DB, commandId);
  if (!record) return null;
  if (COMMAND_TERMINAL_STATES.has(record.state)) return record;

  // Kill live process if running
  const live = _liveProcesses.get(commandId);
  if (live) {
    live.handle.cancel();
  }

  const updated = db.updateCommand(DB, commandId, {
    state: "cancelled",
    completedAt: Date.now(),
  });
  if (updated) pushStateChange(updated);
  return updated;
}

/**
 * Get a command execution record.
 */
export function getCommand(commandId: string): CommandExecution | null {
  return db.getCommand(DB, commandId);
}

/**
 * List command executions, optionally filtered by project and/or conversation.
 */
export function listCommands(
  projectId?: string,
  conversationId?: string
): CommandExecution[] {
  return db.listCommands(DB, projectId, conversationId);
}

/**
 * Get paged output text for a command (ANSI-stripped, safe for renderer).
 */
export function readCommandOutput(
  commandId: string,
  offsetBytes = 0,
  limitBytes = COMMAND_LIMITS.OUTPUT_PAGE_BYTES
): CommandOutputPage {
  // Try live buffer first
  const live = _liveProcesses.get(commandId);
  const text = live
    ? live.buffer.getText()
    : (db.getCommandOutputText(DB, commandId) ?? "");

  const safe = stripAnsiAndControlChars(text);
  const safeBuf = Buffer.from(safe, "utf8");
  const sliced = safeBuf.slice(offsetBytes, offsetBytes + limitBytes).toString("utf8");

  return {
    commandId,
    text: sliced,
    truncated: safeBuf.length > offsetBytes + limitBytes,
    totalBytes: safeBuf.length,
  };
}

/**
 * List trust rules for a project.
 */
export function listTrustRules(projectId: string): CommandTrustRule[] {
  return db.listTrustRules(DB, projectId);
}

/**
 * Revoke a trust rule by ID.
 */
export function revokeTrustRule(ruleId: string): void {
  const rule = db.getTrustRule(DB, ruleId);
  if (!rule) return;
  db.deleteTrustRule(DB, ruleId);
}

/**
 * Cancel all running/queued commands for a project.
 */
export function cancelProjectCommands(projectId: string): void {
  const commands = db.listCommands(DB, projectId);
  for (const cmd of commands) {
    if (!COMMAND_TERMINAL_STATES.has(cmd.state)) {
      cancelCommand(cmd.id);
    }
  }
}

/**
 * Cancel all active commands (called on app quit).
 */
export async function cancelAllOnQuit(): Promise<void> {
  const all = db.listCommands(DB);
  for (const cmd of all) {
    if (!COMMAND_TERMINAL_STATES.has(cmd.state)) {
      cancelCommand(cmd.id);
    }
  }
  await _boundedWait(2000);
}

/**
 * Build a CommandEvidenceRef from a completed command execution.
 * Used to extend RequestContextLedger.
 */
export function buildEvidenceRef(commandId: string): CommandEvidenceRef | null {
  const record = getCommand(commandId);
  if (!record) return null;

  const live = _liveProcesses.get(commandId);
  const rawText = live
    ? live.buffer.getRawText()
    : (db.getCommandOutputText(DB, commandId) ?? "");

  const modelOutput = sanitizeCommandOutputForModel(rawText);
  const outputHash = rawText
    ? createHash("sha256").update(rawText, "utf8").digest("hex")
    : undefined;

  const summary = _buildOutputSummary(record, rawText);

  return {
    commandId: record.id,
    executable: record.spec.executable,
    args: record.spec.args,
    cwdRelative: record.spec.cwdRelative,
    exitCode: record.exitCode ?? null,
    state: record.state,
    ...(outputHash !== undefined && { outputHash }),
    modelOutput,
    outputSummary: summary,
    ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
    executedAt: record.startedAt ?? record.createdAt,
  };
}

// ── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Deterministic drain for tests: cancel fake processes, await all lifecycle promises.
 */
export async function drainCommandManagerForTest(): Promise<void> {
  for (const [, live] of _liveProcesses) {
    live.handle.cancel();
  }
  const snapshot = Array.from(_activeLifecyclePromises);
  await Promise.allSettled(snapshot);
}

/**
 * Reset module state for tests.
 */
export function _resetCommandManagerForTest(): void {
  _liveProcesses.clear();
  _spawnedIds.clear();
  _activeLifecyclePromises.clear();
  _sender = null;
  _adapter = null;
}

export function _setTestSender(sender: WebContents | null): void {
  _sender = sender;
}

export function _setTestAdapter(
  adapter: import("./process-adapter.js").IProcessAdapter
): void {
  _adapter = adapter;
}

// ── Internal: startup reconciliation ───────────────────────────────────────

/**
 * On main-process restart: any command that was "running" or "queued" is now
 * orphaned. Reconcile to "cancelled".
 */
export function reconcileOnStartup(): void {
  const all = db.listCommands(DB);
  for (const cmd of all) {
    if (cmd.state === "running" || cmd.state === "queued") {
      db.updateCommand(DB, cmd.id, {
        state: "cancelled",
        completedAt: Date.now(),
      });
    }
  }
}

// ── Internal: launch ────────────────────────────────────────────────────────

async function _launchCommand(
  record: CommandExecution,
  projectRoot: string
): Promise<void> {
  const promise = _doLaunch(record, projectRoot);
  _activeLifecyclePromises.add(promise);
  promise.finally(() => _activeLifecyclePromises.delete(promise));
  await promise;
}

async function _doLaunch(
  record: CommandExecution,
  projectRoot: string
): Promise<void> {
  // COMMAND_START_ONCE: prevent duplicate spawn
  assertInvariant(
    "COMMAND_START_ONCE",
    !_spawnedIds.has(record.id),
    { commandId: record.id },
    { hint: "command may only be spawned once" }
  );
  if (_spawnedIds.has(record.id)) return;
  _spawnedIds.add(record.id);

  // Re-validate cwd at spawn time (race: project may have moved)
  const resolvedCwd = resolveCwdSafe(projectRoot, record.spec.cwdRelative);
  if (resolvedCwd === null) {
    const updated = db.updateCommand(DB, record.id, {
      state: "failed",
      completedAt: Date.now(),
      ..._makeFailureCode("COMMAND_CWD_ESCAPE"),
    });
    if (updated) pushStateChange(updated);
    return;
  }

  // Concurrency check
  const running = Array.from(_liveProcesses.values()).filter(
    (lp) => db.getCommand(DB, lp.commandId)?.projectId === record.projectId
  );
  if (running.length >= COMMAND_LIMITS.MAX_CONCURRENT_PER_PROJECT) {
    const updated = db.updateCommand(DB, record.id, {
      state: "failed",
      completedAt: Date.now(),
    });
    if (updated) pushStateChange(updated);
    return;
  }

  // Build safe environment
  const safeEnv = buildSafeChildEnvironment();

  // Transition to running
  const started = Date.now();
  const startedRecord = db.updateCommand(DB, record.id, {
    state: "running",
    startedAt: started,
  });
  if (startedRecord) pushStateChange(startedRecord);

  // Get adapter
  if (!_adapter) {
    const updated = db.updateCommand(DB, record.id, {
      state: "failed",
      completedAt: Date.now(),
    });
    if (updated) pushStateChange(updated);
    return;
  }

  const buffer = new OutputBuffer();
  const timeoutMs = record.spec.timeoutMs ?? COMMAND_LIMITS.DEFAULT_TIMEOUT_MS;

  // Spawn
  const handle = _adapter.spawn({
    executable: record.spec.executable,
    args: record.spec.args,
    cwd: resolvedCwd,
    env: safeEnv,
    timeoutMs,
  });

  _liveProcesses.set(record.id, { commandId: record.id, handle, buffer, timeoutHandle: null });

  // Wire output
  handle.onOutput((ev) => {
    buffer.append(ev.kind, ev.data);
    _sender?.send(COMMAND_IPC.OUTPUT_CHUNK, {
      commandId: record.id,
      kind: ev.kind,
      text: ev.data.toString("utf8"),
    });
  });

  // Wire completion
  await new Promise<void>((resolve) => {
    handle.onComplete((result) => {
      const completedAt = Date.now();
      const durationMs = completedAt - started;

      // Determine final state
      let finalState: CommandState;
      let exitCode: number | null = result.exitCode;

      if (result.timedOut) {
        finalState = "timed_out";
        exitCode = null;
      } else if (result.spawnError) {
        finalState = "failed";
      } else if (_isCommandCancelled(record.id)) {
        finalState = "cancelled";
      } else {
        finalState = result.exitCode === 0 ? "succeeded" : "failed";
      }

      const outputMeta = buffer.getMetadata();

      // Save output text to DB
      db.setCommandOutputText(DB, record.id, buffer.getRawText());

      // Update record
      const updated = db.updateCommand(DB, record.id, {
        state: finalState,
        exitCode: exitCode ?? undefined,
        ...(result.signal ? { signal: result.signal } : {}),
        completedAt,
        durationMs,
        outputMetadata: outputMeta,
        ...(result.spawnError ? _makeFailureCode("COMMAND_SPAWN_FAILED") : {}),
        ...(result.timedOut ? _makeFailureCode("COMMAND_TIMEOUT") : {}),
      });

      // Emit trace event
      const tracer = tryGetTraceRecorder();
      if (tracer && record.requestId) {
        const kind = finalState === "timed_out"
          ? ("COMMAND_TIMED_OUT" as const)
          : finalState === "cancelled"
          ? ("COMMAND_CANCELLED" as const)
          : ("COMMAND_COMPLETED" as const);
        tracer.emit(record.requestId, kind, {
          commandId: record.id,
          exitCode,
          durationMs,
          state: finalState,
        });
      }

      // Clean up live process (COMMAND_PROCESS_RELEASED)
      _liveProcesses.delete(record.id);

      if (updated) {
        pushStateChange(updated);
        _sender?.send(COMMAND_IPC.COMPLETE, { commandId: record.id, record: updated });
      }

      resolve();
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve cwd with symlink-safe containment check.
 * Returns absolute path or null if escape detected.
 */
function resolveCwdSafe(projectRoot: string, cwdRelative: string): string | null {
  if (!projectRoot) return null;

  const normalizedRoot = path.resolve(projectRoot);

  let candidate: string;
  if (!cwdRelative || cwdRelative === "." || cwdRelative === "") {
    candidate = normalizedRoot;
  } else {
    // Reject absolute paths
    if (path.isAbsolute(cwdRelative)) return null;
    candidate = path.resolve(normalizedRoot, cwdRelative);
  }

  // Static path traversal check
  if (!candidate.startsWith(normalizedRoot + path.sep) && candidate !== normalizedRoot) {
    return null;
  }

  // Symlink-safe: resolve real path to catch symlink escapes
  try {
    const real = fs.realpathSync(candidate);
    const realRoot = fs.realpathSync(normalizedRoot);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      return null;
    }
    return real;
  } catch {
    // Directory doesn't exist yet — use static check result
    return candidate;
  }
}

function _isCommandCancelled(commandId: string): boolean {
  const record = db.getCommand(DB, commandId);
  return record?.state === "cancelled";
}

function updateCommandState(
  commandId: string,
  state: CommandState
): CommandExecution | null {
  const updated = db.updateCommand(DB, commandId, { state, completedAt: Date.now() });
  if (updated) pushStateChange(updated);
  return updated;
}

function pushStateChange(record: CommandExecution): void {
  try {
    _sender?.send(COMMAND_IPC.STATE_CHANGE, record);
  } catch {
    // Window may be closing
  }
}

function _makeFailureCode(code: ForgeFailureCode): { failureCode: ForgeFailureCode } {
  return { failureCode: code };
}

function _buildOutputSummary(record: CommandExecution, rawText: string): string {
  const exitStr =
    record.exitCode !== undefined && record.exitCode !== null
      ? ` (exit ${record.exitCode})`
      : "";
  const stateStr =
    record.state === "timed_out"
      ? " [timed out]"
      : record.state === "cancelled"
      ? " [cancelled]"
      : "";
  const lines = rawText.split("\n").filter((l) => l.trim()).length;
  const linesStr = lines > 0 ? ` — ${lines} output lines` : "";
  return `${record.displayCommand}${exitStr}${stateStr}${linesStr}`;
}

async function _boundedWait(maxMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, maxMs);
    if (t.unref) t.unref();
  });
}