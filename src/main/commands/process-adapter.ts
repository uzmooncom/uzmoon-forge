/**
 * process-adapter.ts — Cross-platform process spawning and termination.
 *
 * Production adapter: NodeProcessAdapter
 * - shell: false always
 * - detached: true on Unix so we can kill the entire process group
 * - Windows: taskkill /T for owned process tree termination (never kills unrelated processes)
 * - StringDecoder for UTF-8 chunk safety (no partial multi-byte char corruption)
 * - Output batching: emits buffered chunks at OUTPUT_BATCH_INTERVAL_MS or OUTPUT_BATCH_SIZE_BYTES
 *
 * Test adapter: FakeProcessAdapter
 * - Fully deterministic — no real OS processes
 * - Injects: success, non-zero exit, hang, timeout, stdout flood, stderr flood, spawn error, cancel race
 * - Does NOT create a parallel production runner — fake only for tests
 */
import { spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import os from "os";
import { COMMAND_LIMITS } from "./command-limits.js";

// ── Interface ───────────────────────────────────────────────────────────────

export interface SpawnOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type OutputKind = "stdout" | "stderr";

export interface OutputEvent {
  kind: OutputKind;
  data: Buffer;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
}

export interface SpawnHandle {
  /** Fires for each chunk of output (stdout or stderr) */
  onOutput: (cb: (event: OutputEvent) => void) => void;
  /** Fires exactly once when the process ends */
  onComplete: (cb: (result: ProcessResult) => void) => void;
  /** Cancel the process (graceful kill → SIGKILL after grace period) */
  cancel(): void;
  /** Whether the process has already terminated */
  readonly terminated: boolean;
}

export interface IProcessAdapter {
  spawn(opts: SpawnOptions): SpawnHandle;
}

// ── NodeProcessAdapter ──────────────────────────────────────────────────────

const SIGTERM_GRACE_MS = 3000;

/**
 * Production process adapter.
 * - shell: false (never evaluates shell operators)
 * - Output decoded as UTF-8 with StringDecoder (no partial char corruption)
 * - Output batched for IPC efficiency
 * - Unix: detached + process-group kill (SIGTERM → SIGKILL)
 * - Windows: taskkill /F /T /PID for owned process tree (never kills unrelated PIDs)
 */
export class NodeProcessAdapter implements IProcessAdapter {
  spawn(opts: SpawnOptions): SpawnHandle {
    const isWindows = os.platform() === "win32";

    let child: ChildProcess;
    let _terminated = false;
    let timedOut = false;
    let cancelRequested = false;
    let spawnError: string | null = null;

    const outputListeners: Array<(event: OutputEvent) => void> = [];
    const completeListeners: Array<(result: ProcessResult) => void> = [];

    let completeFired = false;
    function fireComplete(result: ProcessResult) {
      if (completeFired) return;
      completeFired = true;
      _terminated = true;
      clearBatchTimer();
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      for (const cb of completeListeners) cb(result);
    }

    // ── Output batching ────────────────────────────────────────────────

    let batchBuffer: Array<OutputEvent> = [];
    let batchTimerHandle: ReturnType<typeof setTimeout> | null = null;
    let batchAccumulatedBytes = 0;

    function flushBatch() {
      if (batchBuffer.length === 0) return;
      const events = batchBuffer;
      batchBuffer = [];
      batchAccumulatedBytes = 0;
      for (const ev of events) {
        for (const cb of outputListeners) cb(ev);
      }
    }

    function scheduleBatch() {
      if (batchTimerHandle !== null) return;
      batchTimerHandle = setTimeout(() => {
        batchTimerHandle = null;
        flushBatch();
      }, COMMAND_LIMITS.OUTPUT_BATCH_INTERVAL_MS);
    }

    function clearBatchTimer() {
      if (batchTimerHandle !== null) {
        clearTimeout(batchTimerHandle);
        batchTimerHandle = null;
      }
      flushBatch();
    }

    function enqueueOutput(kind: OutputKind, data: Buffer) {
      batchBuffer.push({ kind, data });
      batchAccumulatedBytes += data.length;
      if (batchAccumulatedBytes >= COMMAND_LIMITS.OUTPUT_BATCH_SIZE_BYTES) {
        clearBatchTimer(); // flush immediately when threshold hit
      } else {
        scheduleBatch();
      }
    }

    // ── Spawn ──────────────────────────────────────────────────────────

    try {
      child = spawn(opts.executable, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        // Unix: detached=true creates new process group so we can kill(-pgid)
        // Windows: detached:false — use taskkill /T instead
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Spawn failed synchronously (e.g. executable not found)
      spawnError = err instanceof Error ? err.message : String(err);
      _terminated = true;
      // Fire asynchronously so callers can attach listeners first
      process.nextTick(() => {
        fireComplete({ exitCode: null, signal: null, timedOut: false, spawnError });
      });
      return makeHandle();
    }

    // Prevent child from keeping Node event loop alive
    if (!isWindows) {
      child.unref();
    }

    // ── UTF-8 stream decoding ─────────────────────────────────────────

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout?.on("data", (chunk: Buffer) => {
      // Decode to handle partial multi-byte sequences correctly
      const decoded = stdoutDecoder.write(chunk);
      if (decoded.length > 0) enqueueOutput("stdout", Buffer.from(decoded));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const decoded = stderrDecoder.write(chunk);
      if (decoded.length > 0) enqueueOutput("stderr", Buffer.from(decoded));
    });

    child.stdout?.on("end", () => {
      const remaining = stdoutDecoder.end();
      if (remaining.length > 0) enqueueOutput("stdout", Buffer.from(remaining));
    });

    child.stderr?.on("end", () => {
      const remaining = stderrDecoder.end();
      if (remaining.length > 0) enqueueOutput("stderr", Buffer.from(remaining));
    });

    // ── Process lifecycle ─────────────────────────────────────────────

    child.on("error", (err) => {
      spawnError = err.message;
      clearBatchTimer();
      fireComplete({ exitCode: null, signal: null, timedOut, spawnError });
    });

    child.on("close", (code, signal) => {
      clearBatchTimer();
      fireComplete({
        exitCode: code ?? null,
        signal: signal ?? null,
        timedOut,
        spawnError,
      });
    });

    // ── Timeout ───────────────────────────────────────────────────────

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        timedOut = true;
        doKill();
      }, opts.timeoutMs);
      // Prevent timeout from keeping Node alive
      if (timeoutHandle.unref) timeoutHandle.unref();
    }

    // ── Cross-platform process tree kill ─────────────────────────────

    function doKill() {
      if (completeFired) return;
      cancelRequested = true;

      if (isWindows) {
        killWindowsProcessTree(child);
      } else {
        killUnixProcessGroup(child);
      }
    }

    // ── Handle builder ─────────────────────────────────────────────

    function makeHandle(): SpawnHandle {
      return {
        onOutput(cb) { outputListeners.push(cb); },
        onComplete(cb) { completeListeners.push(cb); },
        cancel() { doKill(); },
        get terminated() { return _terminated; },
      };
    }

    // Return handle immediately — listeners attached by caller before events fire
    const handle = makeHandle();

    // Suppress unused var warning
    void cancelRequested;

    return handle;
  }
}

// ── Unix process group kill ─────────────────────────────────────────────────

/**
 * Kill the Unix process group owned by child.
 * detached:true puts child in its own process group (pgid = child.pid).
 * We kill -pgid to terminate all descendants atomically.
 * Never kills processes outside this group — safe.
 */
function killUnixProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  try {
    // SIGTERM first — gives process a chance to clean up
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process already exited or we lack permissions — ignore
    return;
  }

  // Escalate to SIGKILL after grace period if still alive
  const escalateTimer = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
  }, SIGTERM_GRACE_MS);

  if (escalateTimer.unref) escalateTimer.unref();
}

// ── Windows process tree kill ───────────────────────────────────────────────

/**
 * Kill the Windows process tree rooted at child.
 * Uses `taskkill /F /T /PID <pid>` — terminates the target PID and all
 * processes it has spawned (the /T flag walks the ownership tree).
 * /PID is explicit — never kills by name, so unrelated processes are safe.
 */
function killWindowsProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  try {
    // spawn taskkill as a fire-and-forget; we don't wait for its result
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      shell: false,
      stdio: "ignore",
      detached: true,
    });
    killer.unref();
  } catch {
    // taskkill not available — fall back to direct SIGKILL on child only
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// ── FakeProcessAdapter ──────────────────────────────────────────────────────

export type FakeScenario =
  | { kind: "success"; stdoutChunks?: string[]; stderrChunks?: string[]; exitCode?: number; delayMs?: number }
  | { kind: "nonzero"; exitCode: number; stdoutChunks?: string[]; stderrChunks?: string[]; delayMs?: number }
  | { kind: "hang" }
  | { kind: "spawn_error"; message: string }
  | { kind: "stdout_flood"; chunkCount: number; chunkSize: number; exitCode?: number }
  | { kind: "stderr_flood"; chunkCount: number; chunkSize: number; exitCode?: number }
  | { kind: "cancel_race"; delayBeforeCancelMs: number; exitCode?: number };

export interface FakeSpawnHandle extends SpawnHandle {
  /** Complete the fake process externally (for test control) */
  resolve(result: ProcessResult): void;
  /** Emit an output chunk externally */
  emitOutput(kind: OutputKind, data: string): void;
}

/**
 * Deterministic fake process adapter for unit/integration tests.
 * No real OS processes. All scenarios are driven by JS timers or explicit test control.
 */
export class FakeProcessAdapter implements IProcessAdapter {
  private readonly scenarios: FakeScenario[];
  private callIndex = 0;
  private handles: FakeSpawnHandle[] = [];

  constructor(scenarios: FakeScenario[]) {
    this.scenarios = scenarios;
  }

  spawn(_opts: SpawnOptions): SpawnHandle {
    const scenario = this.scenarios[this.callIndex] ?? { kind: "success" };
    this.callIndex++;

    let _terminated = false;
    const outputListeners: Array<(event: OutputEvent) => void> = [];
    const completeListeners: Array<(result: ProcessResult) => void> = [];
    let completeFired = false;

    function fireOutput(kind: OutputKind, data: string) {
      const buf = Buffer.from(data, "utf8");
      for (const cb of outputListeners) cb({ kind, data: buf });
    }

    function fireComplete(result: ProcessResult) {
      if (completeFired) return;
      completeFired = true;
      _terminated = true;
      for (const cb of completeListeners) cb(result);
    }

    const handle: FakeSpawnHandle = {
      onOutput(cb) { outputListeners.push(cb); },
      onComplete(cb) { completeListeners.push(cb); },
      cancel() {
        if (!completeFired) {
          fireComplete({ exitCode: null, signal: "SIGTERM", timedOut: false, spawnError: null });
        }
      },
      get terminated() { return _terminated; },
      resolve(result) { fireComplete(result); },
      emitOutput(kind, data) { fireOutput(kind, data); },
    };

    this.handles.push(handle);

    // Execute scenario asynchronously so callers can attach listeners
    process.nextTick(() => runScenario(scenario, handle, fireOutput, fireComplete));

    return handle;
  }

  /** Get the nth spawned handle for test control */
  getHandle(index: number): FakeSpawnHandle | undefined {
    return this.handles[index];
  }

  /** Reset call index and handles for reuse across tests */
  reset() {
    this.callIndex = 0;
    this.handles = [];
  }
}

function runScenario(
  scenario: FakeScenario,
  handle: FakeSpawnHandle,
  fireOutput: (kind: OutputKind, data: string) => void,
  fireComplete: (result: ProcessResult) => void
): void {
  switch (scenario.kind) {
    case "success":
    case "nonzero": {
      const delay = scenario.delayMs ?? 0;
      const chunks = scenario.stdoutChunks ?? [];
      const errChunks = scenario.stderrChunks ?? [];
      const code = scenario.kind === "nonzero" ? scenario.exitCode : (scenario.exitCode ?? 0);

      const go = () => {
        for (const c of chunks) fireOutput("stdout", c);
        for (const c of errChunks) fireOutput("stderr", c);
        fireComplete({ exitCode: code, signal: null, timedOut: false, spawnError: null });
      };

      if (delay > 0) setTimeout(go, delay);
      else process.nextTick(go);
      break;
    }

    case "hang":
      // Never completes on its own — caller must call handle.cancel() or handle.resolve()
      break;

    case "spawn_error": {
      const msg = scenario.message;
      process.nextTick(() => {
        fireComplete({ exitCode: null, signal: null, timedOut: false, spawnError: msg });
      });
      break;
    }

    case "stdout_flood": {
      const { chunkCount, chunkSize } = scenario;
      const chunk = "x".repeat(chunkSize);
      const code = scenario.exitCode ?? 0;
      process.nextTick(() => {
        for (let i = 0; i < chunkCount; i++) fireOutput("stdout", chunk);
        fireComplete({ exitCode: code, signal: null, timedOut: false, spawnError: null });
      });
      break;
    }

    case "stderr_flood": {
      const { chunkCount, chunkSize } = scenario;
      const chunk = "e".repeat(chunkSize);
      const code = scenario.exitCode ?? 0;
      process.nextTick(() => {
        for (let i = 0; i < chunkCount; i++) fireOutput("stderr", chunk);
        fireComplete({ exitCode: code, signal: null, timedOut: false, spawnError: null });
      });
      break;
    }

    case "cancel_race": {
      const { delayBeforeCancelMs } = scenario;
      const code = scenario.exitCode ?? 0;
      setTimeout(() => {
        fireOutput("stdout", "some output before cancel");
        fireComplete({ exitCode: code, signal: null, timedOut: false, spawnError: null });
      }, delayBeforeCancelMs);
      // Don't auto-cancel — let the test drive handle.cancel() at the right time
      break;
    }
  }
}