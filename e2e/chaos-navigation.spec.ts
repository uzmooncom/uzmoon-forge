/**
 * E2E Chaos: Navigation During Active Operations
 *
 * While an operation is running, navigate away and back.
 * The UI must always correspond to the selected conversation/project.
 * No cross-contamination between conversations.
 *
 * BUG criteria:
 *   - Messages from conv A appear in conv B after switch
 *   - Runtime state for wrong conv shows as active
 *   - Stream from dead conv populates live conv messages
 *   - Queue state leaks between convs
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
  const { profileId, convId } = await setupFakeAgent(forge.page);
  return { ...forge, convId, profileId };
}

async function makeConv(page: Page, profileId: string, label = "") {
  return page.evaluate(async ([pid, lbl]: [string, string]) => {
    const api = (window as { forgeApi?: { createConversation: (c: object) => Promise<void> } }).forgeApi!;
    const now = Date.now();
    const id = `nav-conv-${lbl}-${now}`;
    await api.createConversation({
      id,
      title: `Nav Conv ${lbl}`,
      defaultAgentProfileId: pid,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }, [profileId, label] as [string, string]);
}

async function getRuntimeState(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
    return api.getRuntimeState(cid);
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

async function cancelStream(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
    return api.cancelStream(cid);
  }, convId);
}

async function getMessages(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { getConversationMessages: (c: string) => Promise<Array<{ role: string; id: string; content: string }>> } }).forgeApi!;
    return api.getConversationMessages(cid);
  }, convId);
}

test.describe("Chaos: Navigation During Active Operations", () => {
  test.setTimeout(90_000);

  // ── Stream on A, switch to B 10 times, switch back, verify A completed ─
  test("rapid conv switch during stream: A completes correctly, B stays empty", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "b");
    const convCId = await makeConv(forge.page, forge.profileId, "c");
    try {
      // Start slow stream on A
      const aResultP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ nav-switch-test", 30_000);
      await waitForStreamStart(forge.page, 8000, forge.convId);

      // Rapidly "navigate" between B and C 10 times (simulated via IPC reads)
      // We use getConversationMessages calls as a proxy for navigation
      for (let i = 0; i < 10; i++) {
        await getMessages(forge.page, convBId);
        await getMessages(forge.page, convCId);
        await forge.page.waitForTimeout(30);
      }

      // A should complete normally
      const aResult = await aResultP;
      expect(aResult.error).toBeFalsy();

      await waitForIdle(forge.page, forge.convId, 5000);

      // B and C must have no messages (we only navigated, never sent)
      const bMsgs = await getMessages(forge.page, convBId);
      const cMsgs = await getMessages(forge.page, convCId);
      const bAssistant = (bMsgs ?? []).filter((m) => m.role === "assistant");
      const cAssistant = (cMsgs ?? []).filter((m) => m.role === "assistant");
      expect(bAssistant.length).toBe(0);
      expect(cAssistant.length).toBe(0);

      // A must have exactly one assistant message
      const aMsgs = await getMessages(forge.page, forge.convId);
      const aAssistant = (aMsgs ?? []).filter((m) => m.role === "assistant");
      expect(aAssistant.length).toBe(1);
    } finally {
      await closeForge(forge);
    }
  });

  // ── getRuntimeState for wrong conv is null after navigation ──────────
  test("runtime state is scoped per conv: B never shows A's runtime", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "runtime-b");
    try {
      // Stream on A
      const aP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ runtime-scoped", 30_000);
      await waitForStreamStart(forge.page, 8000, forge.convId);

      // Poll B's runtime 10 times during A's stream — must always be null
      for (let i = 0; i < 10; i++) {
        const stateB = await getRuntimeState(forge.page, convBId);
        expect(stateB, `B runtime must be null during A's stream (poll ${i})`).toBeNull();
        await forge.page.waitForTimeout(100);
      }

      await cancelStream(forge.page, forge.convId);
      const aResult = await aP;
      expect(aResult.error).toBeFalsy();

      // After cancel, A's runtime also null
      await waitForIdle(forge.page, forge.convId, 5000);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Messages do not cross-contaminate across convs ───────────────────
  test("message isolation: messages never appear in wrong conv after rapid switching", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "isolation-b");
    try {
      // Send distinct messages to both convs
      const [rA, rB] = await Promise.all([
        sendAndAwaitEnd(forge.page, forge.convId, "message for conv A only", 20_000),
        sendAndAwaitEnd(forge.page, convBId, "message for conv B only", 20_000),
      ]);

      expect(rA.error).toBeFalsy();
      expect(rB.error).toBeFalsy();

      await waitForIdle(forge.page, forge.convId, 5000);
      await waitForIdle(forge.page, convBId, 5000);

      // Read messages for both
      const aMsgs = await getMessages(forge.page, forge.convId);
      const bMsgs = await getMessages(forge.page, convBId);

      // A's messages must not contain B's content and vice versa
      const aContents = (aMsgs ?? []).map((m) => m.content).join(" ");
      const bContents = (bMsgs ?? []).map((m) => m.content).join(" ");

      // The user messages must be scoped
      expect(aContents).toContain("message for conv A only");
      expect(bContents).toContain("message for conv B only");
      expect(aContents).not.toContain("message for conv B only");
      expect(bContents).not.toContain("message for conv A only");
    } finally {
      await closeForge(forge);
    }
  });

  // ── Send to A while B is streaming: both complete independently ───────
  test("interleaved sends: A and B complete independently without contamination", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "interleave-b");
    try {
      // Start A first (slow)
      const aP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ interleave-A", 30_000);
      await forge.page.waitForTimeout(200);

      // Start B (normal speed)
      const bP = sendAndAwaitEnd(forge.page, convBId, "interleave-B normal", 20_000);

      const [rA, rB] = await Promise.all([aP, bP]);
      expect(rA.error).toBeFalsy();
      expect(rB.error).toBeFalsy();
      expect(rB.message?.role).toBe("assistant");

      // Both idle
      await waitForIdle(forge.page, forge.convId, 5000);
      await waitForIdle(forge.page, convBId, 5000);

      // B's message must not appear in A
      const aMsgs = await getMessages(forge.page, forge.convId);
      const bMsgs = await getMessages(forge.page, convBId);
      const aIds = new Set((aMsgs ?? []).map((m) => m.id));
      const bIds = (bMsgs ?? []).map((m) => m.id);
      for (const id of bIds) {
        expect(aIds.has(id), `Message ${id} from B must not appear in A`).toBe(false);
      }
    } finally {
      await closeForge(forge);
    }
  });

  // ── Queue state isolation ─────────────────────────────────────────────
  test("queue state isolation: getQueueState for B never shows A's items", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "queue-isolation");
    try {
      // Enqueue multiple on A
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { sendMessage: (r: object) => Promise<unknown> } }).forgeApi!;
        await api.sendMessage({ conversationId: cid, content: "queue-A-1", attachmentIds: [] });
        await api.sendMessage({ conversationId: cid, content: "queue-A-2", attachmentIds: [] });
      }, forge.convId);

      // B's queue must be empty
      const bQueue = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: Array<{ id: string }> }> } }).forgeApi!;
        return api.getQueue(cid);
      }, convBId);

      if (bQueue) {
        expect(bQueue.items.length).toBe(0);
      }

      // Cancel A and let it settle
      await forge.page.waitForTimeout(200);
      await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
        await api.cancelStream(cid);
      }, forge.convId);
      await forge.page.waitForTimeout(2000);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Stream completes after multiple rapid navigate-aways ─────────────
  test("stream survives 20 rapid navigate-aways: completes with correct message", async () => {
    const forge = await boot();
    const convBIds = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeConv(forge.page, forge.profileId, `nav20-${i}`))
    );
    try {
      const aP = sendAndAwaitEnd(forge.page, forge.convId, "__slow__ nav-20-test", 30_000);
      await waitForStreamStart(forge.page, 8000, forge.convId);

      // 20 rapid navigate-aways (simulated by reading messages from other convs)
      for (let i = 0; i < 20; i++) {
        const targetConv = convBIds[i % convBIds.length]!;
        await getMessages(forge.page, targetConv);
        await forge.page.waitForTimeout(20);
      }

      const aResult = await aP;
      expect(aResult.error).toBeFalsy();
      // After slow stream, message should be present
      await waitForIdle(forge.page, forge.convId, 5000);

      const aMsgs = await getMessages(forge.page, forge.convId);
      const aAssistant = (aMsgs ?? []).filter((m) => m.role === "assistant");
      expect(aAssistant.length).toBeGreaterThanOrEqual(1);
    } finally {
      await closeForge(forge);
    }
  });

  // ── Cancel navigated-away conv: no leak into current conv ────────────
  test("cancel while away from conv: cancel targets correct conv, not active one", async () => {
    const forge = await boot();
    const convBId = await makeConv(forge.page, forge.profileId, "cancel-away");
    try {
      // Use a checkpoint so B is provably mid-execution when we cancel
      const CKPT = "cancel-away";
      const bP = sendAndAwaitEnd(forge.page, convBId, `__checkpoint:${CKPT}__ cancel-away-test`, 25_000);

      // Wait until fakeRequest is blocked at checkpoint — stream is live
      await forge.page.evaluate(async (name) => {
        const api = (window as { forgeApi?: { test?: { waitForCheckpointBlocked: (n: string) => Promise<void> } } }).forgeApi!;
        await api.test?.waitForCheckpointBlocked(name);
      }, CKPT);

      // "Navigate away" to A — then cancel B explicitly
      await getMessages(forge.page, forge.convId); // simulate being on conv A
      await cancelStream(forge.page, convBId); // cancel B explicitly (not active conv)

      // Release checkpoint so fakeRequest can exit cleanly
      await forge.page.evaluate(async (name) => {
        const api = (window as { forgeApi?: { test?: { releaseCheckpoint: (n: string) => Promise<void> } } }).forgeApi!;
        await api.test?.releaseCheckpoint(name);
      }, CKPT);

      const bResult = await bP;
      expect(bResult.error).toBeFalsy();
      expect(bResult.cancelled).toBe(true);

      // A must be completely unaffected
      const aState = await getRuntimeState(forge.page, forge.convId);
      expect(aState).toBeNull();

      const aMsgs = await getMessages(forge.page, forge.convId);
      const aAssistant = (aMsgs ?? []).filter((m) => m.role === "assistant");
      expect(aAssistant.length).toBe(0); // A never sent a message
    } finally {
      await closeForge(forge);
    }
  });
});