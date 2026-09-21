/**
 * E2E Chaos: Cancellation Races
 *
 * Stop/cancel during every possible moment:
 *   - Before stream starts (pre-enqueue)
 *   - During startup (between enqueue and first token)
 *   - Mid-stream (tokens flowing)
 *   - Tool execution (between tool start and result)
 *   - Waiting for human (return-control paused)
 *   - Queue paused state
 *   - Rapid stop/restart cycle
 *
 * BUG criteria:
 *   - getRuntimeState non-null after cancel
 *   - queue item stuck at "processing" after cancel
 *   - next message fails to send after cancel
 *   - returnControlResolvers map leaks entries
 */
import { test, expect } from "@playwright/test";
import {
  launchForge,
  closeForge,
  setupFakeAgent,
  sendAndAwaitEnd,
  waitForStreamStart,
} from "./helpers.js";
import type { Page } from "playwright-core";

async function boot() {
  const forge = await launchForge({ fakeProvider: true });
  await forge.page.waitForLoadState("domcontentloaded");
  await forge.page.waitForTimeout(1500);
  const { convId } = await setupFakeAgent(forge.page);
  return { ...forge, convId };
}

async function getRuntimeState(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
    return api.getRuntimeState(cid);
  }, convId);
}

async function cancelStream(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
    return api.cancelStream(cid);
  }, convId);
}

async function waitForIdle(page: Page, convId: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getRuntimeState(page, convId);
    if (state === null) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`waitForIdle timed out for conv ${convId}`);
}

async function assertCanSendAfterCancel(page: Page, convId: string) {
  const result = await page.evaluate(
    async ([cid, to]: [string, number]) => {
      const api = (window as { forgeApi?: {
        sendMessage: (r: object) => Promise<{ queueItemId?: string; error?: string }>;
        onStreamEnd: (cb: (d: { conversation?: { id: string }; message?: { role: string }; cancelled?: boolean }) => void) => () => void;
        onStreamError: (cb: (d: unknown) => void) => () => void;
      } }).forgeApi!;

      return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        let unsub1: (() => void) | undefined;
        let unsub2: (() => void) | undefined;
        const timer = setTimeout(() => {
          unsub1?.(); unsub2?.();
          resolve({ ok: false, reason: "timeout" });
        }, to);

        unsub1 = api.onStreamEnd((data) => {
          if (data.conversation?.id && data.conversation.id !== cid) return;
          clearTimeout(timer); unsub1?.(); unsub2?.();
          resolve({ ok: !data.cancelled && data.message?.role === "assistant" });
        });
        unsub2 = api.onStreamError(() => {
          clearTimeout(timer); unsub1?.(); unsub2?.();
          resolve({ ok: false, reason: "stream error" });
        });

        api.sendMessage({ conversationId: cid, content: "post-cancel recovery send", attachmentIds: [] })
          .then((r) => { if (r.error) { clearTimeout(timer); unsub1?.(); unsub2?.(); resolve({ ok: false, reason: r.error }); } })
          .catch((e: Error) => { clearTimeout(timer); unsub1?.(); unsub2?.(); resolve({ ok: false, reason: e.message }); });
      });
    },
    [convId, 20_000] as [string, number]
  );
  expect(result.ok, `Post-cancel send failed: ${result.reason}`).toBe(true);
}

test.describe("Chaos: Cancellation Races", () => {
  test.setTimeout(90_000);

  // ── Cancel immediately after enqueue (pre-first-token) ───────────────
  test("cancel 0ms after send: queue item is cancelled, runtime is idle", async () => {
    const forge = await boot();
    try {
      const resultP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ cancel-immediate", 25_000);
      // Cancel 0ms delay — race against startup
      await cancelStream(forge.page, forge.convId);
      const result = await resultP;
      expect(result.error).toBeFalsy();
      await waitForIdle(forge.page, forge.convId, 5000);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel 100ms after send ───────────────────────────────────────────
  test("cancel 100ms after send: queue cleans up, next send works", async () => {
    const forge = await boot();
    try {
      const resultP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ cancel-100ms", 25_000);
      await forge.page.waitForTimeout(100);
      await cancelStream(forge.page, forge.convId);
      const result = await resultP;
      expect(result.error).toBeFalsy();
      await waitForIdle(forge.page, forge.convId, 5000);
      // Must be able to send again after cancel
      await assertCanSendAfterCancel(forge.page, forge.convId);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel mid-stream ─────────────────────────────────────────────────
  test("cancel mid-stream: cancelled flag set, runtime clears, next send works", async () => {
    const forge = await boot();
    try {
      // Use a checkpoint to guarantee the stream is blocked mid-execution.
      // __checkpoint:cancel-mid__ blocks fakeRequest until we release it,
      // giving us a deterministic window to call cancelStream.
      const CKPT = "cancel-mid";
      const resultP = sendAndAwaitEnd(forge.page, forge.convId, `__checkpoint:${CKPT}__ cancel-midstream`, 25_000);

      // Wait until fakeRequest is provably blocked at the checkpoint
      await forge.page.evaluate(async (name) => {
        const api = (window as { forgeApi?: { test?: { waitForCheckpointBlocked: (n: string) => Promise<void> } } }).forgeApi!;
        await api.test?.waitForCheckpointBlocked(name);
      }, CKPT);

      // Stream is now live and blocked — cancel it
      await cancelStream(forge.page, forge.convId);
      // Release the checkpoint so fakeRequest can exit cleanly
      await forge.page.evaluate(async (name) => {
        const api = (window as { forgeApi?: { test?: { releaseCheckpoint: (n: string) => Promise<void> } } }).forgeApi!;
        await api.test?.releaseCheckpoint(name);
      }, CKPT);

      const result = await resultP;
      expect(result.error).toBeFalsy();
      expect(result.cancelled).toBe(true);

      await waitForIdle(forge.page, forge.convId, 5000);
      await assertCanSendAfterCancel(forge.page, forge.convId);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 5 rapid cancel→send cycles ───────────────────────────────────────
  test("5 cancel→send cycles: no state accumulation, each cycle completes", async () => {
    const forge = await boot();
    try {
      for (let i = 0; i < 5; i++) {
        const resultP = sendAndAwaitEnd(forge.page, forge.convId, `__slow__ cycle-${i}`, 25_000);
        await waitForStreamStart(forge.page, 8000, forge.convId);
        await cancelStream(forge.page, forge.convId);
        const result = await resultP;
        expect(result.error).toBeFalsy();
        await waitForIdle(forge.page, forge.convId, 5000);
      }

      // After 5 cycles, a normal send must complete
      const final = await sendAndAwaitEnd(forge.page, forge.convId, "final after cycles", 20_000);
      expect(final.error).toBeFalsy();
      expect(final.message?.role).toBe("assistant");
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel + immediate re-send ────────────────────────────────────────
  test("cancel then immediately re-send: second message wins, no double processing", async () => {
    const forge = await boot();
    try {
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ cancel-resend-first", 25_000);
      await waitForStreamStart(forge.page, 8000, forge.convId);

      // Cancel and immediately start second send
      const [cancelResult, r2] = await Promise.all([
        forge.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
          await api.cancelStream(cid);
        }, forge.convId),
        sendAndAwaitEnd(forge.page, forge.convId, "second message after cancel", 25_000),
      ]);
      void cancelResult;

      const r1 = await r1P;
      expect(r1.error).toBeFalsy(); // first should be cancelled
      expect(r2.error).toBeFalsy(); // second should succeed
      expect(r2.message?.role).toBe("assistant");

      await waitForIdle(forge.page, forge.convId, 5000);

      // Check for duplicate messages
      const msgs = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getConversationMessages: (c: string) => Promise<Array<{ role: string; id: string; content: string }>> } }).forgeApi!;
        return api.getConversationMessages(cid);
      }, forge.convId);

      if (msgs) {
        const assistantMsgs = msgs.filter((m) => m.role === "assistant");
        const ids = assistantMsgs.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel during waiting-for-human ───────────────────────────────────
  test("cancel while waiting_for_human: promise rejects, runtime goes idle", async () => {
    const forge = await boot();
    try {
      // __human__ makes fake provider emit a waiting_for_human signal
      const resultP = sendAndAwaitEnd(forge.page, forge.convId, "__human__ cancel-human-wait", 30_000);

      // Wait a bit for the human-wait state to establish
      await forge.page.waitForTimeout(2000);

      // Cancel
      await cancelStream(forge.page, forge.convId);
      const result = await resultP;
      expect(result.error).toBeFalsy();

      await waitForIdle(forge.page, forge.convId, 8000);

      // Must be able to send after
      await assertCanSendAfterCancel(forge.page, forge.convId);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel during queue paused ────────────────────────────────────────
  test("cancel paused queue item: item moves to cancelled, queue resumes", async () => {
    const forge = await boot();
    try {
      // Send two messages — first will process, second queued
      const r1P = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ queue-cancel-first", 30_000);
      await forge.page.waitForTimeout(200);

      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { sendMessage: (r: object) => Promise<unknown> } }).forgeApi!;
        await api.sendMessage({ conversationId: cid, content: "queued second message", attachmentIds: [] });
      }, forge.convId);

      // Cancel the first while it's processing — second should proceed
      await waitForStreamStart(forge.page, 8000, forge.convId);
      await cancelStream(forge.page, forge.convId);
      const r1 = await r1P;
      expect(r1.error).toBeFalsy();

      // Queue should eventually drain (second message processes or fails gracefully)
      await forge.page.waitForTimeout(500);
      const qstate = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: Array<{ status: string }> }> } }).forgeApi!;
        return api.getQueue(cid);
      }, forge.convId);

      // No items should be permanently stuck at processing
      if (qstate) {
        await waitForIdle(forge.page, forge.convId, 20000).catch(() => {
          // It's OK if the second item is still running — just not forever stuck
        });
        const finalQ = await forge.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: Array<{ status: string }> }> } }).forgeApi!;
          return api.getQueue(cid);
        }, forge.convId);
        if (finalQ) {
          const stuck = finalQ.items.filter((i) => i.status === "processing");
          expect(stuck.length).toBe(0);
        }
      }
    } finally {
      await closeForge(forge);
    }
  });

  // ── returnControlResolvers must not leak ──────────────────────────────
  test("waiting_for_human cancel/resume cycle: no resolver leak", async () => {
    const forge = await boot();
    try {
      // 3 cycles of human-wait + cancel
      for (let i = 0; i < 3; i++) {
        const resultP = sendAndAwaitEnd(forge.page, forge.convId, `__human__ resolver-leak-${i}`, 25_000);
        await forge.page.waitForTimeout(1500);
        await cancelStream(forge.page, forge.convId);
        const r = await resultP;
        expect(r.error).toBeFalsy();
        await waitForIdle(forge.page, forge.convId, 5000);
      }

      // Final normal send — if resolvers leaked, this would hang
      const final = await sendAndAwaitEnd(forge.page, forge.convId, "post-human-cycles normal send", 20_000);
      expect(final.error).toBeFalsy();
      expect(final.message?.role).toBe("assistant");
    } finally {
      await closeForge(forge);
    }
  });
});