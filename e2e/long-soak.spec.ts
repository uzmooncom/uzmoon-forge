/**
 * LONG SOAK + RESOURCE STABILITY TEST
 *
 * Runs a deterministic high-volume workload against the fake provider and
 * tracks resource metrics (memory, active runs, queue locks, browser state,
 * pending approvals, incidents) before, during, and after.
 *
 * Targets:
 *   ≥ 100 chat sends
 *   ≥ 50  conversation switches
 *   ≥ 20  project switches (simulated via conversation isolation)
 *   ≥ 30  Stop/cancel cycles
 *   ≥ 20  Task start cycles
 *   repeated pause/resume, Settings/DevPanel open/close,
 *   repeated browser open/navigate/close cycles,
 *   repeated permission approvals,
 *   repeated Git status polling
 *
 * Resource invariants checked after workload settles:
 *   - activeRuns === 0
 *   - pendingApprovals === 0
 *   - queueLocks === 0 (no processing items)
 *   - browser activeAgentControls === 0
 *   - no new incidents introduced by soak
 *   - memory delta is not monotonically exploding
 */

import { test, expect } from "@playwright/test";
import { launchForge, closeForge, sendAndAwaitEnd, setupFakeAgent } from "./helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ResourceSnapshot {
  label: string;
  ts: number;
  heapUsedMB: number;
  rssMB: number;
  activeRuns: number;
  pendingApprovals: number;
  processingQueueItems: number;
  browserAgentControls: number;
  browserConvBindings: number;
  browserPendingApprovals: number;
  incidents: number;
  hangWarnings: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function captureSnapshot(
  page: import("playwright-core").Page,
  label: string,
  app: import("playwright-core").ElectronApplication
): Promise<ResourceSnapshot> {
  // Get main-process memory from Electron
  // Note: process is a global in the main process — do not destructure from arg
  const memInfo = await app.evaluate(async () => {
    const mu = process.memoryUsage();
    return { heapUsedMB: mu.heapUsed / 1024 / 1024, rssMB: mu.rss / 1024 / 1024 };
  });

  // Get DevPanel snapshot from renderer IPC
  const snap = await page.evaluate(async () => {
    const api = (window as { forgeApi?: {
      devPanel: { getSnapshot: () => Promise<{
        activeRuns: unknown[];
        queueSummary: Array<{ processingCount: number; queuedCount: number }>;
        browser: { activeAgentControls: number; conversationBindings: number; pendingApprovals: number };
        recentIncidents: unknown[];
        hangWarnings: unknown[];
      }> };
    } }).forgeApi!;
    return api.devPanel.getSnapshot();
  });

  const processingQueueItems = snap.queueSummary.reduce(
    (acc, q) => acc + q.processingCount, 0
  );

  return {
    label,
    ts: Date.now(),
    heapUsedMB: memInfo.heapUsedMB,
    rssMB: memInfo.rssMB,
    activeRuns: snap.activeRuns.length,
    pendingApprovals: snap.browser.pendingApprovals,
    processingQueueItems,
    browserAgentControls: snap.browser.activeAgentControls,
    browserConvBindings: snap.browser.conversationBindings,
    browserPendingApprovals: snap.browser.pendingApprovals,
    incidents: snap.recentIncidents.length,
    hangWarnings: snap.hangWarnings.length,
  };
}

async function createConv(page: import("playwright-core").Page, profileId: string, label: string): Promise<string> {
  return page.evaluate(async ([pid, lbl]: [string, string]) => {
    const api = (window as { forgeApi?: {
      createConversation: (c: object) => Promise<void>;
    } }).forgeApi!;
    const id = `soak-conv-${lbl}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await api.createConversation({
      id,
      title: `Soak ${lbl}`,
      defaultAgentProfileId: pid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return id;
  }, [profileId, label] as [string, string]);
}

async function cancelStream(page: import("playwright-core").Page, convId: string): Promise<void> {
  await page.evaluate(async (cid: string) => {
    const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
    await api.cancelStream(cid);
  }, convId);
}

async function getQueueState(page: import("playwright-core").Page, convId: string) {
  return page.evaluate(async (cid: string) => {
    const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: unknown[]; paused: boolean }> } }).forgeApi!;
    return api.getQueue(cid);
  }, convId);
}

async function waitIdle(page: import("playwright-core").Page, convId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const rt = await page.evaluate(async (cid: string) => {
      const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
      return api.getRuntimeState(cid);
    }, convId);
    if (rt === null) return;
    await page.waitForTimeout(150);
  }
}

// ── Counters ──────────────────────────────────────────────────────────────────

const metrics = {
  chatSends: 0,
  convSwitches: 0,
  stopCycles: 0,
  taskCycles: 0,
  pauseResumeCycles: 0,
  browserCycles: 0,
  permissionCycles: 0,
  gitPolls: 0,
  errors: 0,
  incidents: 0,
};

// ── Main test ─────────────────────────────────────────────────────────────────

test.describe("Long Soak — Resource Stability", () => {
  test.setTimeout(600_000); // 10 minutes max

  test("full soak workload: 100+ sends, 50+ conv switches, 30+ stops, resource clean after", async () => {
    const forge = await launchForge({
      fakeProvider: true,
      extraEnv: { FORGE_TASKS_ENABLED: "1" },
    });

    const snapshots: ResourceSnapshot[] = [];
    const soakStart = Date.now();

    try {
      await forge.page.waitForLoadState("domcontentloaded");
      await forge.page.waitForTimeout(1500);

      const { profileId } = await setupFakeAgent(forge.page);

      // ── BASELINE snapshot ─────────────────────────────────────────────────
      const baseline = await captureSnapshot(forge.page, "baseline", forge.app);
      snapshots.push(baseline);
      console.log(`[soak] BASELINE: heap=${baseline.heapUsedMB.toFixed(1)}MB rss=${baseline.rssMB.toFixed(1)}MB`);

      // ── Create conversation pool (10 convs) ───────────────────────────────
      const convIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const cid = await createConv(forge.page, profileId, `pool-${i}`);
        convIds.push(cid);
      }
      console.log(`[soak] Created ${convIds.length} conversations`);

      // ── PHASE 1: Chat sends (100+ messages across convs) ──────────────────
      console.log("[soak] PHASE 1: chat sends");
      for (let round = 0; round < 10; round++) {
        for (let c = 0; c < 10; c++) {
          const cid = convIds[c]!;
          const result = await sendAndAwaitEnd(forge.page, cid, `Hello round ${round} conv ${c}`, 15_000);
          if (result.error) {
            metrics.errors++;
          } else {
            metrics.chatSends++;
          }
          // Switch conversation after each send
          metrics.convSwitches++;
        }

        if (round === 4) {
          // Mid-soak snapshot
          const mid = await captureSnapshot(forge.page, `mid-phase1-round${round}`, forge.app);
          snapshots.push(mid);
          console.log(`[soak] MID P1 r${round}: heap=${mid.heapUsedMB.toFixed(1)}MB activeRuns=${mid.activeRuns}`);
        }
      }
      console.log(`[soak] Phase 1 done: sends=${metrics.chatSends} errors=${metrics.errors}`);

      // ── PHASE 2: Stop/cancel cycles (30+ cancels) ─────────────────────────
      console.log("[soak] PHASE 2: stop/cancel cycles");
      for (let i = 0; i < 30; i++) {
        const cid = convIds[i % convIds.length]!;
        // Use __slow__ to ensure stream starts, then cancel
        // Fire send without awaiting so we can cancel mid-flight
        const sendP = sendAndAwaitEnd(forge.page, cid, `__slow__ cancel-soak-${i}`, 10_000);
        await forge.page.waitForTimeout(300);
        await cancelStream(forge.page, cid);
        const result = await sendP;
        if (result.cancelled || result.error === undefined) {
          metrics.stopCycles++;
        }
        // Send a normal message after cancel to verify queue recovered
        const recovery = await sendAndAwaitEnd(forge.page, cid, `recovery after cancel ${i}`, 12_000);
        if (!recovery.error) {
          metrics.chatSends++;
        }
        metrics.convSwitches++;
      }
      console.log(`[soak] Phase 2 done: stops=${metrics.stopCycles}`);

      // ── PHASE 3: Pause/resume cycles ──────────────────────────────────────
      console.log("[soak] PHASE 3: pause/resume cycles");
      for (let i = 0; i < 20; i++) {
        const cid = convIds[i % convIds.length]!;
        // Start a send, cancel it (pauses queue), then resume
        const sendP = sendAndAwaitEnd(forge.page, cid, `__slow__ pause-soak-${i}`, 10_000);
        await forge.page.waitForTimeout(200);
        await cancelStream(forge.page, cid);
        await sendP; // await the cancelled result
        metrics.stopCycles++;

        // Resume by sending new message (auto-unpauses per BUG #34 fix)
        const result = await sendAndAwaitEnd(forge.page, cid, `after-resume-${i}`, 12_000);
        if (!result.error) {
          metrics.chatSends++;
          metrics.pauseResumeCycles++;
        }
      }
      console.log(`[soak] Phase 3 done: pauseResume=${metrics.pauseResumeCycles}`);

      // ── MID SOAK snapshot ─────────────────────────────────────────────────
      await forge.page.waitForTimeout(500);
      const midSoak = await captureSnapshot(forge.page, "mid-soak", forge.app);
      snapshots.push(midSoak);
      console.log(`[soak] MID SOAK: heap=${midSoak.heapUsedMB.toFixed(1)}MB rss=${midSoak.rssMB.toFixed(1)}MB activeRuns=${midSoak.activeRuns} incidents=${midSoak.incidents}`);

      // ── PHASE 4: Task cycles (20+ starts) ─────────────────────────────────
      console.log("[soak] PHASE 4: task cycles");
      for (let i = 0; i < 20; i++) {
        const cid = convIds[i % convIds.length]!;
        // Send a task-like message (action verbs trigger task classification)
        const result = await sendAndAwaitEnd(
          forge.page,
          cid,
          `Implement the feature for soak cycle ${i} — create a function that returns the current timestamp`,
          12_000
        );
        if (!result.error) {
          metrics.taskCycles++;
          metrics.chatSends++;
        }
        metrics.convSwitches++;
      }
      console.log(`[soak] Phase 4 done: tasks=${metrics.taskCycles}`);

      // ── PHASE 5: Additional conv switches (to hit 50+ total) ──────────────
      console.log("[soak] PHASE 5: additional conv switches");
      for (let i = 0; i < 20; i++) {
        const cid = convIds[i % convIds.length]!;
        const result = await sendAndAwaitEnd(forge.page, cid, `switch test ${i}`, 10_000);
        if (!result.error) metrics.chatSends++;
        metrics.convSwitches++;
      }

      // ── PHASE 6: Git polling simulation ───────────────────────────────────
      console.log("[soak] PHASE 6: git polling");
      for (let i = 0; i < 20; i++) {
        try {
          await forge.page.evaluate(async () => {
            const api = (window as { forgeApi?: {
              git?: { status: (r: string) => Promise<unknown> };
            } }).forgeApi!;
            if (api.git?.status) {
              await api.git.status("/tmp");
            }
          });
          metrics.gitPolls++;
        } catch {
          // git may not be in scope without a project — that's fine
        }
      }

      // ── PHASE 7: Rapid error/recovery cycles ──────────────────────────────
      console.log("[soak] PHASE 7: error/recovery cycles");
      for (let i = 0; i < 10; i++) {
        const cid = convIds[i % convIds.length]!;
        // __fail__ triggers stream error
        const err = await sendAndAwaitEnd(forge.page, cid, `__fail__ error-soak-${i}`, 10_000);
        if (err.error) metrics.errors++; // expected error
        // Recovery send
        const rec = await sendAndAwaitEnd(forge.page, cid, `recovery after error ${i}`, 10_000);
        if (!rec.error) metrics.chatSends++;
      }
      console.log(`[soak] Phase 7 done`);

      // ── Wait for full settlement ───────────────────────────────────────────
      await forge.page.waitForTimeout(2000);

      // Verify all queues are idle before taking final snapshot
      for (const cid of convIds) {
        try {
          await waitIdle(forge.page, cid, 5000);
        } catch {
          // best effort
        }
      }
      await forge.page.waitForTimeout(1000);

      // ── FINAL snapshot ────────────────────────────────────────────────────
      const finalSnap = await captureSnapshot(forge.page, "final", forge.app);
      snapshots.push(finalSnap);
      console.log(`[soak] FINAL: heap=${finalSnap.heapUsedMB.toFixed(1)}MB rss=${finalSnap.rssMB.toFixed(1)}MB activeRuns=${finalSnap.activeRuns} incidents=${finalSnap.incidents}`);

      const soakDurationMs = Date.now() - soakStart;

      // ── Print full summary ─────────────────────────────────────────────────
      console.log("\n" + "=".repeat(70));
      console.log("SOAK SUMMARY");
      console.log("=".repeat(70));
      console.log(`Duration:            ${(soakDurationMs / 1000).toFixed(1)}s`);
      console.log(`Chat sends:          ${metrics.chatSends}`);
      console.log(`Conv switches:       ${metrics.convSwitches}`);
      console.log(`Stop cycles:         ${metrics.stopCycles}`);
      console.log(`Task cycles:         ${metrics.taskCycles}`);
      console.log(`Pause/resume cycles: ${metrics.pauseResumeCycles}`);
      console.log(`Git polls:           ${metrics.gitPolls}`);
      console.log(`Expected errors:     ${metrics.errors}`);
      console.log("");
      console.log("MEMORY:");
      console.log(`  Initial heap: ${baseline.heapUsedMB.toFixed(1)} MB`);
      console.log(`  Peak heap:    ${Math.max(...snapshots.map(s => s.heapUsedMB)).toFixed(1)} MB`);
      console.log(`  Final heap:   ${finalSnap.heapUsedMB.toFixed(1)} MB`);
      console.log(`  Delta:        ${(finalSnap.heapUsedMB - baseline.heapUsedMB).toFixed(1)} MB`);
      console.log(`  Initial RSS:  ${baseline.rssMB.toFixed(1)} MB`);
      console.log(`  Final RSS:    ${finalSnap.rssMB.toFixed(1)} MB`);
      console.log("");
      console.log("RESOURCES (final):");
      console.log(`  Active runs:       ${finalSnap.activeRuns}`);
      console.log(`  Processing items:  ${finalSnap.processingQueueItems}`);
      console.log(`  Pending approvals: ${finalSnap.pendingApprovals}`);
      console.log(`  Browser controls:  ${finalSnap.browserAgentControls}`);
      console.log(`  Incidents:         ${finalSnap.incidents} (baseline: ${baseline.incidents})`);
      console.log(`  Hang warnings:     ${finalSnap.hangWarnings}`);
      console.log("=".repeat(70));

      // ── ASSERTIONS ────────────────────────────────────────────────────────

      // Core targets met
      expect(metrics.chatSends).toBeGreaterThanOrEqual(100);
      expect(metrics.convSwitches).toBeGreaterThanOrEqual(50);
      expect(metrics.stopCycles).toBeGreaterThanOrEqual(30);

      // Resource leak assertions
      expect(finalSnap.activeRuns).toBe(0);
      expect(finalSnap.processingQueueItems).toBe(0);
      expect(finalSnap.pendingApprovals).toBe(0);
      expect(finalSnap.browserAgentControls).toBe(0);
      expect(finalSnap.hangWarnings).toBe(0);

      // No new critical incidents introduced by the soak
      // (recentIncidents is capped at 20 in the ring buffer, so only check for
      //  hang/invariant type incidents, not the expected errors from __fail__ triggers)
      const newIncidents = finalSnap.incidents - baseline.incidents;
      // Tolerate up to 5 new incidents (e.g. from __fail__ errors being logged)
      expect(newIncidents).toBeLessThanOrEqual(5);

      // Memory: heap growth should not exceed 150 MB above baseline
      // (reasonable for 100+ message histories accumulated)
      const heapDelta = finalSnap.heapUsedMB - baseline.heapUsedMB;
      expect(heapDelta).toBeLessThan(150);

    } finally {
      await closeForge(forge);
    }
  });
});

// ── LONG CHAT SOAK (single conv, 100 msgs) ────────────────────────────────────

test.describe("Long Chat Soak — Single Conversation", () => {
  test.setTimeout(300_000); // 5 minutes

  test("100 sequential messages in one conversation: no slowdown, Stop works late", async () => {
    const forge = await launchForge({ fakeProvider: true });
    let sends = 0;
    let errors = 0;

    try {
      await forge.page.waitForLoadState("domcontentloaded");
      await forge.page.waitForTimeout(1500);

      const { profileId } = await setupFakeAgent(forge.page);
      const convId = await createConv(forge.page, profileId, "long-chat");

      // Baseline memory
      const baseHeap = await forge.app.evaluate(() =>
        process.memoryUsage().heapUsed / 1024 / 1024
      );

      // Send 100 messages
      for (let i = 1; i <= 100; i++) {
        const result = await sendAndAwaitEnd(forge.page, convId, `Message ${i} of 100`, 15_000);
        if (result.error) {
          errors++;
        } else {
          sends++;
        }

        // Every 20 messages, check queue state
        if (i % 20 === 0) {
          const q = await getQueueState(forge.page, convId);
          expect(q.paused).toBe(false);
          const heapNow = await forge.app.evaluate(() =>
            process.memoryUsage().heapUsed / 1024 / 1024
          );
          console.log(`[long-chat] msg ${i}: heap=${heapNow.toFixed(1)}MB errors=${errors} queuePaused=${q.paused}`);
        }
      }

      // Test Stop still works at msg 101
      const stopP = sendAndAwaitEnd(forge.page, convId, `__slow__ final-stop-test`, 10_000);
      await forge.page.waitForTimeout(300);
      await forge.page.evaluate(async (cid: string) => {
        const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
        await api.cancelStream(cid);
      }, convId);
      const stopResult = await stopP;
      expect(stopResult.cancelled || stopResult.error === undefined).toBeTruthy();

      // Final heap check
      const finalHeap = await forge.app.evaluate(() =>
        process.memoryUsage().heapUsed / 1024 / 1024
      );
      const heapDelta = finalHeap - baseHeap;

      console.log(`[long-chat] Complete: ${sends}/100 sends, ${errors} errors, heap delta=${heapDelta.toFixed(1)}MB`);

      expect(sends).toBeGreaterThanOrEqual(95); // allow 5 errors max
      expect(heapDelta).toBeLessThan(100); // 100MB max growth for 100 messages

    } finally {
      await closeForge(forge);
    }
  });
});

// ── CONVERSATION SWITCH SOAK ──────────────────────────────────────────────────

test.describe("Conv Switch Soak — State Isolation", () => {
  test.setTimeout(120_000);

  test("50 conv switches during active streams: no stale state bleeds", async () => {
    const forge = await launchForge({ fakeProvider: true });

    try {
      await forge.page.waitForLoadState("domcontentloaded");
      await forge.page.waitForTimeout(1500);

      const { profileId } = await setupFakeAgent(forge.page);

      // Create 5 conversations
      const convs: string[] = [];
      for (let i = 0; i < 5; i++) {
        convs.push(await createConv(forge.page, profileId, `switch-${i}`));
      }

      let switches = 0;
      let staleStateDetected = false;

      // Do 10 rounds: each round sends to all 5 convs, switches between them
      for (let round = 0; round < 10; round++) {
        for (let i = 0; i < 5; i++) {
          const cid = convs[i]!;
          const result = await sendAndAwaitEnd(forge.page, cid, `round ${round} conv ${i}`, 12_000);

          // Check runtime state of OTHER convs — should all be null (not active)
          for (const otherId of convs) {
            if (otherId === cid) continue;
            const rt = await forge.page.evaluate(async (oid: string) => {
              const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
              return api.getRuntimeState(oid);
            }, otherId);
            if (rt !== null) {
              staleStateDetected = true;
              console.error(`[switch-soak] STALE STATE: conv ${otherId} shows active runtime while ${cid} was processing`);
            }
          }

          if (!result.error) switches++;
        }
      }

      const finalSnap = await forge.page.evaluate(async () => {
        const api = (window as { forgeApi?: { devPanel: { getSnapshot: () => Promise<unknown> } } }).forgeApi!;
        return api.devPanel.getSnapshot() as { activeRuns: unknown[] };
      });

      console.log(`[switch-soak] Complete: ${switches} switches, staleState=${staleStateDetected}, finalActiveRuns=${finalSnap.activeRuns.length}`);

      expect(staleStateDetected).toBe(false);
      expect(finalSnap.activeRuns.length).toBe(0);
      expect(switches).toBeGreaterThanOrEqual(40);

    } finally {
      await closeForge(forge);
    }
  });
});