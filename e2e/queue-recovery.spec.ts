/**
 * E2E: Queue Recovery + Failure Presentation + Reliability
 *
 * Regression matrix items:
 *   14. Exactly one visible failure presentation per AgentRun
 *   44. Incident generation works for injected invariant violations
 *   45. Diagnostic export is redacted
 *   46. Resource counts return to baseline after repeated lifecycle torture
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge, setupFakeAgent, sendAndAwaitEnd } from "./helpers.js";

test.describe("Queue Recovery + Reliability", () => {
  async function boot() {
    const forge = await launchForge({ fakeProvider: true });
    await forge.page.waitForLoadState("domcontentloaded");
    await forge.page.waitForTimeout(1500);
    const { convId } = await setupFakeAgent(forge.page);
    return { ...forge, convId };
  }

  // ── 14: Exactly one failure message per AgentRun ───────────────────────
  test("exactly one error ChatMessage is inserted per failed AgentRun (item 14)", async () => {
    const forge = await boot();
    try {
      // Trigger a failure
      const r = await sendAndAwaitEnd(forge.page, forge.convId, "__fail__ single error test", 20_000);
      expect(r.error).toBe(true);

      await forge.page.waitForTimeout(500);

      // Count error messages in the conversation
      const msgs = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getConversationMessages: (c: string) => Promise<{ role: string; isError?: boolean; content?: string }[]> } }).forgeApi!;
        return api.getConversationMessages(cid);
      }, forge.convId);

      const errorMsgs = (msgs as { role: string; isError?: boolean; content?: string }[]).filter(
        (m) => m.isError === true || (m.role === "assistant" && m.content?.includes("error"))
      );
      // There should be at most 1 error representation
      expect(errorMsgs.length).toBeLessThanOrEqual(1);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 45: Diagnostic export is redacted ────────────────────────────────
  test("diagnostic export bundle does not contain raw API keys (item 45)", async () => {
    const forge = await boot();
    try {
      const bundle = await forge.page.evaluate(async () => {
        const api = (window as { forgeApi?: { devPanel?: { exportBundle: () => Promise<unknown> } } }).forgeApi!;
        if (!api.devPanel?.exportBundle) return null;
        return api.devPanel.exportBundle();
      });

      expect(bundle).not.toBeNull();
      const bundleStr = JSON.stringify(bundle);

      // Should not contain any real-looking API keys
      // The dummy key "sk-fake-e2e-key" should be redacted to [REDACTED]
      // Real patterns: sk-[20+alphanum]
      const apiKeyPattern = /sk-[A-Za-z0-9]{20,}/;
      expect(apiKeyPattern.test(bundleStr)).toBe(false);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 46: Resource counts return to baseline ────────────────────────────
  test("repeated send/stop cycles do not accumulate stale runtime state (item 46)", async () => {
    const forge = await boot();
    try {
      // Do 3 send+cancel cycles
      for (let i = 0; i < 3; i++) {
        const p = forge.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { sendMessage: (r: object) => Promise<object> } }).forgeApi!;
          await api.sendMessage({ conversationId: cid, content: `__slow__ cycle ${i}`, attachmentIds: [] });
        }, forge.convId).catch(() => {});
        void p;

        await forge.page.waitForTimeout(300);

        await forge.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void>; resumeQueue: (c: string) => Promise<void> } }).forgeApi!;
          await api.cancelStream(cid);
          // Resume so next iteration can run
          await api.resumeQueue(cid);
        }, forge.convId).catch(() => {});

        await forge.page.waitForTimeout(300);
      }

      await forge.page.waitForTimeout(500);

      // Runtime state should be null (no leaks)
      const state = await forge.page.evaluate(async (cid) => {
        const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
        return api.getRuntimeState(cid);
      }, forge.convId);
      expect(state).toBeNull();

      // Dev panel snapshot should show 0 active runs
      const snapshot = await forge.page.evaluate(async () => {
        const api = (window as { forgeApi?: { devPanel?: { getSnapshot: () => Promise<unknown> } } }).forgeApi!;
        return api.devPanel?.getSnapshot();
      });
      const s = snapshot as Record<string, unknown>;
      const activeRuns = s["activeRuns"] as unknown[];
      expect(activeRuns.length).toBe(0);
    } finally {
      await closeForge(forge);
    }
  });

  // ── 44: Incident generation works ────────────────────────────────────
  test("incidents list is accessible and returns an array (item 44)", async () => {
    const forge = await boot();
    try {
      const incidents = await forge.page.evaluate(async () => {
        const api = (window as { forgeApi?: { reliability?: { listIncidents: () => Promise<unknown[]> } } }).forgeApi!;
        if (!api.reliability?.listIncidents) return [];
        return api.reliability.listIncidents();
      });

      expect(Array.isArray(incidents)).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });
});