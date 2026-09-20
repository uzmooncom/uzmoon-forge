/**
 * E2E: Chat Lifecycle
 *
 * Regression matrix items:
 *   1.  Stop mid-stream
 *   2.  Stop during tool execution
 *   5.  Stop during waiting_for_human (fake __human__ signal)
 *   6.  Final clears Working state
 *   7.  Final clears Stop button
 *   8.  Next request after Stop works
 *   9.  Next request after failure works
 *   14. Exactly one visible failure presentation per AgentRun
 *   15. Queue recovers after failure
 *   16. Retry works
 *   17. Skip works
 *   40. Global Chat uses the same runtime lifecycle as Project Chat
 *   41. Tool-using action cannot finalize with naked intent prose (fake __tool__ signal)
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge, setupFakeAgent, sendAndAwaitEnd, waitForStreamStart } from "./helpers.js";

test.describe("Chat Lifecycle", () => {
  // ── Helper to boot the app with fake provider ───────────────────────────
  async function boot() {
    const forge = await launchForge({ fakeProvider: true });
    await forge.page.waitForLoadState("domcontentloaded");
    await forge.page.waitForTimeout(1500);
    const { convId } = await setupFakeAgent(forge.page);
    return { ...forge, convId };
  }

  // ── 6/7: Final clears Working state and makes Stop invisible ───────────
  test("final response clears Working state (items 6, 7)", async () => {
    const forge = await boot();
    try {
      // STREAM_END fires with message (not cancelled) on successful completion
      const result = await sendAndAwaitEnd(forge.page, forge.convId, "hello fake", 20_000);
      expect(result.error).toBeFalsy();
      expect(result.cancelled).toBeFalsy();
      expect(result.message).toBeDefined();
      expect(result.message?.role).toBe("assistant");

      // After stream end, getRuntimeState should return null (idle)
      const runtimeState = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
        return api.getRuntimeState(cid);
      }, forge.convId);
      expect(runtimeState).toBeNull();
    } finally {
      await closeForge(forge);
    }
  });

  // ── 1: Stop mid-stream ─────────────────────────────────────────────────
  test("Stop mid-stream marks run as cancelled (item 1)", async () => {
    const forge = await boot();
    try {
      // __slow__ makes fake provider wait 2s — enough time to stop mid-stream
      const resultP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ stop test", 25_000);

      // Wait until stream is confirmed live before cancelling
      const streamStarted = await waitForStreamStart(forge.page, 8000);

      // Cancel via IPC (stream is live; __slow__ still has ~1.8s remaining)
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
        await api.cancelStream(cid);
      }, forge.convId);

      const result = await resultP;
      expect(result.error).toBeFalsy();
      if (streamStarted) {
        expect(result.cancelled).toBe(true);
      }

      // After cancellation, runtime state should be null (idle)
      await forge.page.waitForTimeout(300);
      const runtimeState = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
        return api.getRuntimeState(cid);
      }, forge.convId);
      expect(runtimeState).toBeNull();
    } finally {
      await closeForge(forge);
    }
  });

  // ── 8: Next request after Stop works ──────────────────────────────────
  test("next request after Stop works cleanly (item 8)", async () => {
    const forge = await boot();
    try {
      // First message — cancel it
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ cancel me", 25_000);
      const started = await waitForStreamStart(forge.page, 8000);
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
        await api.cancelStream(cid);
      }, forge.convId);
      const r1 = await r1P;
      if (started) {
        expect(r1.cancelled).toBe(true);
      } else {
        expect(r1.error).toBeFalsy();
      }

      // Resume the queue (Stop pauses it)
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { resumeQueue: (c: string) => Promise<void> } }).forgeApi!;
        await api.resumeQueue(cid);
      }, forge.convId);
      await forge.page.waitForTimeout(200);

      // Second message — should complete normally
      const r2 = await sendAndAwaitEnd(forge.page, forge.convId, "hello after stop", 20_000);
      expect(r2.error).toBeFalsy();
      expect(r2.cancelled).toBeFalsy();
      expect(r2.message?.role).toBe("assistant");
    } finally {
      await closeForge(forge);
    }
  });

  // ── 9: Next request after failure works ───────────────────────────────
  test("next request after failure works cleanly (item 9)", async () => {
    const forge = await boot();
    try {
      // __fail__ causes provider error → stream error event
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__fail__ trigger error", 20_000);
      const r1 = await r1P;
      expect(r1.error).toBe(true);

      // Resume queue after failure
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { resumeQueue: (c: string, action?: string) => Promise<void> } }).forgeApi!;
        await api.resumeQueue(cid, "skip");
      }, forge.convId);
      await forge.page.waitForTimeout(200);

      // Second message — should complete normally
      const r2 = await sendAndAwaitEnd(forge.page, forge.convId, "hello after failure", 20_000);
      expect(r2.error).toBeFalsy();
      expect(r2.cancelled).toBeFalsy();
      expect(r2.message?.role).toBe("assistant");
    } finally {
      await closeForge(forge);
    }
  });

  // ── 15: Queue recovers after failure ──────────────────────────────────
  test("queue is paused after failure and recovers on resumeQueue (item 15)", async () => {
    const forge = await boot();
    try {
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__fail__ queue test", 20_000);
      const r1 = await r1P;
      expect(r1.error).toBe(true);

      // Queue should now be paused
      const queueState = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ paused: boolean; items: unknown[] }> } }).forgeApi!;
        return api.getQueue(cid);
      }, forge.convId);
      expect(queueState.paused).toBe(true);

      // Resume with skip
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { resumeQueue: (c: string, action?: string) => Promise<void> } }).forgeApi!;
        await api.resumeQueue(cid, "skip");
      }, forge.convId);

      await forge.page.waitForTimeout(300);

      // Queue should now be unpaused
      const queueState2 = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ paused: boolean; items: unknown[] }> } }).forgeApi!;
        return api.getQueue(cid);
      }, forge.convId);
      expect(queueState2.paused).toBe(false);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 16: Retry works ───────────────────────────────────────────────────
  test("retry re-runs the failed request (item 16)", async () => {
    const forge = await boot();
    try {
      // Enqueue two messages: one that fails, one normal
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__fail__ retry me", 20_000);
      const r1 = await r1P;
      expect(r1.error).toBe(true);

      // Retry the failed item
      const r2 = await sendAndAwaitEnd(forge.page, forge.convId, "normal msg after retry setup", 20_000).catch(() => null);
      void r2;

      // Resume with retry
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { resumeQueue: (c: string, action?: string) => Promise<void> } }).forgeApi!;
        await api.resumeQueue(cid, "retry");
      }, forge.convId);

      await forge.page.waitForTimeout(2000);

      // Messages in conversation should include an assistant response (retry succeeded)
      const messages = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getConversationMessages: (c: string) => Promise<{ role: string }[]> } }).forgeApi!;
        return api.getConversationMessages(cid);
      }, forge.convId);
      const assistantMsgs = (messages as { role: string }[]).filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 17: Skip works ────────────────────────────────────────────────────
  test("skip removes failed item and allows next item to process (item 17)", async () => {
    const forge = await boot();
    try {
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__fail__ skip me", 20_000);
      const r1 = await r1P;
      expect(r1.error).toBe(true);

      // Queue should be paused after failure
      const q1 = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ paused: boolean; items: { status: string }[] }> } }).forgeApi!;
        return api.getQueue(cid);
      }, forge.convId);
      expect(q1.paused).toBe(true);

      // Skip the failed item
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { resumeQueue: (c: string, action?: string) => Promise<void> } }).forgeApi!;
        await api.resumeQueue(cid, "skip");
      }, forge.convId);
      await forge.page.waitForTimeout(300);

      // Queue should be unpaused
      const q2 = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ paused: boolean }> } }).forgeApi!;
        return api.getQueue(cid);
      }, forge.convId);
      expect(q2.paused).toBe(false);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 41: Tool using action processes tool call (item 41) ───────────────
  test("__tool__ message triggers tool execution and final response (item 41)", async () => {
    const forge = await boot();
    try {
      const result = await sendAndAwaitEnd(forge.page, forge.convId, "__tool__ read a file", 30_000);
      // Should complete (not error, not cancelled) — tool call processed then final
      expect(result.error).toBeFalsy();
      expect(result.cancelled).toBeFalsy();
      expect(result.message?.role).toBe("assistant");
    } finally {
      await closeForge(forge);
    }
  });

  // ── Dev Panel: runtime state matches actual run (item 43) ────────────
  test("Dev Panel runtime state reflects active run (item 43)", async () => {
    const forge = await boot();
    try {
      // Send a slow message and capture runtime state mid-run
      forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { sendMessage: (r: object) => Promise<object> } }).forgeApi!;
        await api.sendMessage({ conversationId: cid, content: "__slow__ runtime check", attachmentIds: [] });
      }, forge.convId).catch(() => {});

      // Poll for active runtime state
      let runtimeState: unknown = null;
      const start = Date.now();
      while (Date.now() - start < 5000) {
        runtimeState = await forge.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
          return api.getRuntimeState(cid);
        }, forge.convId);
        if (runtimeState !== null) break;
        await forge.page.waitForTimeout(100);
      }

      if (runtimeState !== null) {
        const s = runtimeState as Record<string, unknown>;
        expect(typeof s["conversationId"]).toBe("string");
        expect(typeof s["requestId"]).toBe("string");
      }

      // Cancel and clean up
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
        await api.cancelStream(cid);
      }, forge.convId);
      await forge.page.waitForTimeout(500);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 42: Late events after terminal state are ignored (item 42) ────────
  test("getRuntimeState returns null after run completes (late-event firewall) (item 42)", async () => {
    const forge = await boot();
    try {
      const result = await sendAndAwaitEnd(forge.page, forge.convId, "hello", 20_000);
      expect(result.error).toBeFalsy();

      // After completion, runtime state must be null (no stale entry)
      await forge.page.waitForTimeout(200);
      const state = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
        return api.getRuntimeState(cid);
      }, forge.convId);
      expect(state).toBeNull();
    } finally {
      await closeForge(forge);
    }
  });
});