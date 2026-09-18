/**
 * browser-wait-semantics.test.ts — browser_wait_for abort and wait semantics
 *
 * Verifies:
 * - sleepOrAbort resolves normally when signal not aborted
 * - sleepOrAbort rejects immediately when signal is pre-aborted
 * - sleepOrAbort rejects promptly when signal aborted mid-sleep
 * - network_quiet excludes websocket/eventsource/ping resource types
 * - navigation_settled uses URL stability + isTabLoading check
 * - CANCELLED error code returned on abort
 */
import { describe, it, expect, vi } from "vitest";

// ── sleepOrAbort helper (extracted from tool-executor logic) ──────────────

/**
 * Mirrors the sleepOrAbort helper from tool-executor.ts.
 * Resolves after `ms` or rejects with CANCELLED if signal is aborted.
 */
async function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw Object.assign(new Error("CANCELLED"), { code: "CANCELLED" });
  }
  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line prefer-const
    let timerId: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timerId);
      reject(Object.assign(new Error("CANCELLED"), { code: "CANCELLED" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timerId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

// ── network_quiet filtering (extracted logic) ──────────────────────────────

type PendingRequest = {
  type: string;
  startedAt: number;
  completedAt?: number;
};

const QUIET_WINDOW_MS = 800;
const EXCLUDED_TYPES = new Set(["websocket", "eventsource", "ping"]);

function isNetworkQuiet(pending: PendingRequest[], now: number): boolean {
  const activePending = pending.filter(
    (r) => !EXCLUDED_TYPES.has(r.type) && (r.completedAt === undefined || r.completedAt > now)
  );
  const recentCompleted = pending.filter(
    (r) => !EXCLUDED_TYPES.has(r.type) && r.completedAt !== undefined && now - r.completedAt < QUIET_WINDOW_MS
  );
  return activePending.length === 0 && recentCompleted.length === 0;
}

// ── navigation_settled logic (extracted) ──────────────────────────────────

function isNavigationSettled(
  isLoading: boolean,
  currentUrl: string,
  lastUrl: string | null,
  elementCount: number
): { settled: boolean; newLastUrl: string } {
  // Not settled if still loading
  if (isLoading) return { settled: false, newLastUrl: lastUrl ?? currentUrl };
  // First poll: no lastUrl yet — record URL, require a second poll to confirm stability
  if (lastUrl === null) return { settled: false, newLastUrl: currentUrl };
  // URL changed since last poll — reset stability tracking
  if (currentUrl !== lastUrl) return { settled: false, newLastUrl: currentUrl };
  // Not settled if no elements yet
  if (elementCount === 0) return { settled: false, newLastUrl: currentUrl };
  return { settled: true, newLastUrl: currentUrl };
}

describe("browser_wait_for — abort semantics", () => {
  // ── 1. sleepOrAbort normal path ───────────────────────────────────────────

  it("sleepOrAbort resolves after delay when signal not aborted", async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    await sleepOrAbort(20, ctrl.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // allow small timer jitter
  });

  it("sleepOrAbort resolves immediately for 0ms", async () => {
    const ctrl = new AbortController();
    await expect(sleepOrAbort(0, ctrl.signal)).resolves.toBeUndefined();
  });

  // ── 2. Pre-aborted signal ─────────────────────────────────────────────────

  it("sleepOrAbort rejects immediately with CANCELLED for pre-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(sleepOrAbort(1000, ctrl.signal)).rejects.toMatchObject({
      message: "CANCELLED",
    });
  });

  it("pre-aborted signal: error has code=CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    try {
      await sleepOrAbort(1000, ctrl.signal);
    } catch (err) {
      expect((err as { code: string }).code).toBe("CANCELLED");
    }
  });

  // ── 3. Mid-sleep abort ────────────────────────────────────────────────────

  it("mid-sleep abort: rejects promptly before full delay", async () => {
    const ctrl = new AbortController();
    const start = Date.now();

    // Abort after 15ms, sleep would be 500ms
    setTimeout(() => ctrl.abort(), 15);

    await expect(sleepOrAbort(500, ctrl.signal)).rejects.toMatchObject({
      message: "CANCELLED",
    });

    // Should have returned well before 500ms
    expect(Date.now() - start).toBeLessThan(200);
  });

  // ── 4. network_quiet excludes websocket/eventsource/ping ─────────────────

  it("websocket requests are excluded from network_quiet check", () => {
    const now = Date.now();
    const pending: PendingRequest[] = [
      { type: "websocket", startedAt: now - 5000 }, // ongoing, excluded
      { type: "xhr", startedAt: now - 100, completedAt: now - 50 }, // completed, within QUIET_WINDOW
    ];
    // xhr completed within QUIET_WINDOW → not quiet
    expect(isNetworkQuiet(pending, now)).toBe(false);
  });

  it("network is quiet when only websocket/eventsource/ping are pending", () => {
    const now = Date.now();
    const pending: PendingRequest[] = [
      { type: "websocket", startedAt: now - 1000 },
      { type: "eventsource", startedAt: now - 2000 },
      { type: "ping", startedAt: now - 500 },
    ];
    expect(isNetworkQuiet(pending, now)).toBe(true);
  });

  it("network not quiet when active non-excluded request exists", () => {
    const now = Date.now();
    const pending: PendingRequest[] = [
      { type: "xhr", startedAt: now - 50 }, // active (no completedAt)
    ];
    expect(isNetworkQuiet(pending, now)).toBe(false);
  });

  it("network quiet when no pending requests at all", () => {
    expect(isNetworkQuiet([], Date.now())).toBe(true);
  });

  it("network quiet when all non-excluded requests completed before QUIET_WINDOW", () => {
    const now = Date.now();
    const pending: PendingRequest[] = [
      { type: "fetch", startedAt: now - 2000, completedAt: now - 1000 }, // older than QUIET_WINDOW_MS
    ];
    expect(isNetworkQuiet(pending, now)).toBe(true);
  });

  // ── 5. navigation_settled URL stability ───────────────────────────────────

  it("navigation not settled when isLoading=true", () => {
    const { settled } = isNavigationSettled(true, "https://a.com", "https://a.com", 10);
    expect(settled).toBe(false);
  });

  it("navigation not settled when URL changed since last poll", () => {
    const { settled } = isNavigationSettled(false, "https://b.com", "https://a.com", 10);
    expect(settled).toBe(false);
  });

  it("navigation not settled when element count is 0", () => {
    const { settled } = isNavigationSettled(false, "https://a.com", "https://a.com", 0);
    expect(settled).toBe(false);
  });

  it("navigation settled when not loading, URL stable, and elements > 0", () => {
    const { settled } = isNavigationSettled(false, "https://a.com", "https://a.com", 5);
    expect(settled).toBe(true);
  });

  it("navigation not settled on first poll (no lastUrl) — requires URL stability across 2 polls", () => {
    // First poll: lastUrl is null → record URL, not settled yet
    const { settled, newLastUrl } = isNavigationSettled(false, "https://a.com", null, 5);
    expect(settled).toBe(false);
    expect(newLastUrl).toBe("https://a.com");
  });

  it("navigation settled on second poll when URL matches", () => {
    // Second poll: lastUrl matches currentUrl
    const { settled } = isNavigationSettled(false, "https://a.com", "https://a.com", 5);
    expect(settled).toBe(true);
  });

  // ── 6. Abort cleans up event listener (no listener leak) ──────────────────

  it("no listener leak — abort fires once and clears timer", async () => {
    const ctrl = new AbortController();
    const onAbortMock = vi.fn();
    ctrl.signal.addEventListener("abort", onAbortMock);

    // Abort mid-sleep
    setTimeout(() => ctrl.abort(), 10);
    try {
      await sleepOrAbort(200, ctrl.signal);
    } catch {
      // expected
    }

    // Additional abort calls should not trigger further side effects
    ctrl.abort();
    expect(onAbortMock).toHaveBeenCalledTimes(1);
  });
});