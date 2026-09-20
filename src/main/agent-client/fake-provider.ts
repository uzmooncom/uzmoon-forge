/**
 * V18 — Fake Provider
 *
 * Deterministic LLM response engine for Playwright e2e tests.
 * Activated when FORGE_TEST_PROVIDER=fake is set in the environment.
 *
 * Response routing:
 *  - Messages containing "__fail__"            → throw provider error
 *  - Messages containing "__slow__"            → delay 2s then respond (demo/manual use only)
 *  - Messages containing "__tool__"            → emit a read_file forge_tool call, then forge_final
 *  - Messages containing "__human__"           → emit a forge_final with status="blocked" (waiting_for_human)
 *  - Messages containing "__checkpoint:NAME__" → block on named deferred until released via
 *                                                releaseCheckpoint("NAME") — deterministic barrier
 *  - All other messages → echo a forge_final response immediately
 *
 * Checkpoint API (for use in E2E tests):
 *   waitForCheckpointBlocked("NAME")  — resolves when the fake provider is blocked on NAME
 *   releaseCheckpoint("NAME")         — unblocks the fake provider; resolves any blocked fakeRequest
 *   resetCheckpoints()                — clear all state (call in afterEach)
 */

// Minimal shape matching RequestOptions in client.ts (not exported from client)
export interface FakeRequestOpts {
  messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
  /** Optional abort signal — when aborted, checkpoint barriers reject with 'cancelled' */
  signal?: AbortSignal;
  [key: string]: unknown;
}

export const FAKE_PROVIDER_ENV = "FORGE_TEST_PROVIDER";

export function isFakeProviderEnabled(): boolean {
  return process.env[FAKE_PROVIDER_ENV] === "fake";
}

// ── Checkpoint registry ────────────────────────────────────────────────────
// Each entry is a deferred promise that blocks fakeRequest until released.

interface CheckpointEntry {
  /** Resolves fakeRequest when the test calls releaseCheckpoint(name) */
  releaseP: Promise<void>;
  release: () => void;
  /** Resolves when fakeRequest is actually blocked (waiting on releaseP) */
  blockedP: Promise<void>;
  setBlocked: () => void;
}

const _checkpoints = new Map<string, CheckpointEntry>();

function _getOrCreateCheckpoint(name: string): CheckpointEntry {
  const existing = _checkpoints.get(name);
  if (existing) return existing;

  let release!: () => void;
  const releaseP = new Promise<void>((res) => { release = res; });

  let setBlocked!: () => void;
  const blockedP = new Promise<void>((res) => { setBlocked = res; });

  const entry: CheckpointEntry = { releaseP, release, blockedP, setBlocked };
  _checkpoints.set(name, entry);
  return entry;
}

/**
 * Wait until fakeRequest is provably blocked on the named checkpoint.
 * Use this in tests BEFORE calling getRuntimeState to ensure the run is live.
 */
export function waitForCheckpointBlocked(name: string): Promise<void> {
  return _getOrCreateCheckpoint(name).blockedP;
}

/**
 * Release the named checkpoint, allowing the blocked fakeRequest to continue.
 * Returns immediately if the checkpoint was never created (no-op).
 */
export function releaseCheckpoint(name: string): void {
  const entry = _checkpoints.get(name);
  if (entry) entry.release();
}

/**
 * Reset all checkpoint state. Call in afterEach to prevent cross-test bleed.
 */
export function resetCheckpoints(): void {
  // Release any still-blocked checkpoints so async code doesn't leak
  for (const [, entry] of _checkpoints) {
    entry.release();
  }
  _checkpoints.clear();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractLastUserText(opts: FakeRequestOpts): string {
  const messages = opts.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const textBlock = m.content.find((b: { type?: string; text?: string }) => b.type === "text");
        if (textBlock && typeof textBlock.text === "string") return textBlock.text;
      }
    }
  }
  return "";
}

function makeForgeFinal(content: string): string {
  const payload = JSON.stringify({ content });
  return `\`\`\`forge_final\n${payload}\n\`\`\``;
}

function makeForgeFinalBlocked(reason: string): string {
  const inner = JSON.stringify({ status: "blocked", summary: reason, evidenceRefs: [] });
  const payload = JSON.stringify({ content: inner });
  return `\`\`\`forge_final\n${payload}\n\`\`\``;
}

function makeForgeToolRead(filePath: string): string {
  const toolCallJson = JSON.stringify({
    callId: "fake-call-001",
    name: "read_file",
    arguments: { path: filePath },
  });
  return `\`\`\`forge_tool\n${toolCallJson}\n\`\`\``;
}

// ── Main fake request handler ──────────────────────────────────────────────

export async function fakeRequest(opts: FakeRequestOpts): Promise<string> {
  const userText = extractLastUserText(opts).toLowerCase();

  if (userText.includes("__fail__")) {
    throw new Error("FAKE_PROVIDER: simulated provider failure");
  }

  // __checkpoint:NAME__ — block deterministically until released by the test.
  // The run is guaranteed to be alive inside activeRunRegistry while blocked.
  // Races against the AbortSignal so cancelStream() still works.
  const checkpointMatch = userText.match(/__checkpoint:([a-z0-9_-]+)__/);
  if (checkpointMatch) {
    const name = checkpointMatch[1]!;
    const entry = _getOrCreateCheckpoint(name);
    // Signal that we are now blocked (test can call waitForCheckpointBlocked)
    entry.setBlocked();

    // Race: either the test releases the checkpoint OR the AbortSignal fires
    const signal = opts.signal;
    if (signal?.aborted) {
      throw new Error("cancelled");
    }
    await new Promise<void>((resolve, reject) => {
      // Resolve when checkpoint is released
      void entry.releaseP.then(resolve);
      // Reject when aborted
      if (signal) {
        if (signal.aborted) { reject(new Error("cancelled")); return; }
        const onAbort = () => reject(new Error("cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        // Clean up the abort listener when checkpoint resolves normally
        void entry.releaseP.then(() => signal.removeEventListener("abort", onAbort));
      }
    });

    return makeForgeFinal(`Checkpoint ${name} released.`);
  }

  // __slow__ — timer-based delay, kept for manual demo/exploratory use.
  // Do NOT use this for correctness assertions in concurrency tests.
  if (userText.includes("__slow__")) {
    await new Promise((r) => setTimeout(r, 2000));
    return makeForgeFinal("Slow response complete.");
  }

  if (userText.includes("__tool__")) {
    // Simulate one tool step, then a final answer.
    const hasPriorToolResult = opts.messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("forge_tool_result"),
    );
    if (hasPriorToolResult) {
      return makeForgeFinal("Tool call processed. Here is the file content summary.");
    }
    return makeForgeToolRead("/tmp/fake-test-file.txt");
  }

  if (userText.includes("__human__")) {
    return makeForgeFinalBlocked("This step requires human completion (simulated).");
  }

  // ── Task step magic strings ────────────────────────────────────────────

  if (userText.includes("__step_complete__")) {
    const stepResult = JSON.stringify({
      status: "completed",
      summary: "Step completed successfully (simulated).",
      evidenceRefs: [],
    });
    return `\`\`\`forge_step_result\n${stepResult}\n\`\`\``;
  }

  if (userText.includes("__step_blocked__")) {
    const stepResult = JSON.stringify({
      status: "blocked",
      summary: "Step blocked — human action required (simulated).",
      evidenceRefs: [],
    });
    return `\`\`\`forge_step_result\n${stepResult}\n\`\`\``;
  }

  if (userText.includes("__step_replan__")) {
    const stepResult = JSON.stringify({
      status: "replan_required",
      summary: "Step outcome requires plan revision (simulated).",
      evidenceRefs: [],
      recommendedPlanChanges: "Add a prerequisite step for environment setup.",
    });
    return `\`\`\`forge_step_result\n${stepResult}\n\`\`\``;
  }

  if (userText.includes("__step_failed__")) {
    const stepResult = JSON.stringify({
      status: "failed",
      summary: "Step failed with an unrecoverable error (simulated).",
      evidenceRefs: [],
    });
    return `\`\`\`forge_step_result\n${stepResult}\n\`\`\``;
  }

  // Default: echo
  const echo = `Fake provider response to: "${userText.slice(0, 80)}"`;
  return makeForgeFinal(echo);
}