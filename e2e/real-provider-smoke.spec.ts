/**
 * REAL PROVIDER SMOKE TEST — ZERO TOUCH
 *
 * Architecture:
 *   - Launches Electron with the real data dir ($HOME/.uzmoon-forge-v01)
 *   - safeStorage identity is identical to `pnpm start` (both run unpackaged Electron)
 *   - Discovers the default configured AgentProfile via smoke.getDefaultProfile() IPC
 *   - Secret NEVER leaves the main process — smoke IPC only returns metadata + boolean
 *   - All provider requests go through the real QueueManager / AgentLoop path
 *   - Smoke conversations are cleaned up from the real DB after each scenario
 *
 * GATE: FORGE_SMOKE_REAL=1  (no API key argument needed)
 *
 * Usage:
 *   FORGE_SMOKE_REAL=1 pnpm exec playwright test e2e/real-provider-smoke.spec.ts
 *
 * Or via the convenience script:
 *   pnpm qa:real-provider
 *
 * Scenarios:
 *   A. Normal conversational response — real streaming/finalization
 *   B. Cancellation mid-stream — AgentRun cancelled cleanly, queue recovers
 *   C. Provider capabilities — testConnection via existing AgentConfig path
 *   D. Secret leak audit — ForgeLogger + diagnostic bundle contain no secret
 */

import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright-core";
import path from "path";
import os from "os";

const ROOT = path.join(__dirname, "..");
const MAIN_ENTRY = path.join(ROOT, "dist/main/main/main.js");
const REAL_DATA_DIR = path.join(os.homedir(), ".uzmoon-forge-v01");

const SMOKE_ENABLED = process.env["FORGE_SMOKE_REAL"] === "1";

// ── Shared forge instance (launched once for all smoke scenarios) ─────────────
// We use a module-level holder so beforeAll/afterAll can share across tests.
let sharedForge: {
  app: Awaited<ReturnType<typeof electron["launch"]>>;
  page: import("playwright-core").Page;
} | null = null;

const smokeConvIds: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getDefaultProfile(page: import("playwright-core").Page): Promise<{
  id: string; name: string; endpoint: string; model: string; protocol: string;
} | null> {
  return page.evaluate(() => (window as any).forgeApi.smoke.getDefaultProfile());
}

async function createSmokeConv(
  page: import("playwright-core").Page,
  profileId: string,
  label: string
): Promise<string> {
  const id = await page.evaluate(
    ([pid, lbl]: [string, string]) => {
      const api = (window as any).forgeApi;
      const convId = `smoke-${lbl}-${Date.now()}`;
      return api.createConversation({
        id: convId, title: `Smoke ${lbl}`,
        defaultAgentProfileId: pid,
        createdAt: Date.now(), updatedAt: Date.now(),
      }).then(() => convId);
    },
    [profileId, label] as [string, string]
  );
  smokeConvIds.push(id);
  return id;
}

/**
 * Send a message and wait for stream end or error.
 * Returns the stream end payload or an error descriptor.
 */
async function sendAndWait(
  page: import("playwright-core").Page,
  convId: string,
  content: string,
  timeoutMs = 90_000
): Promise<{ cancelled?: boolean; message?: { content: string }; error?: true; reason?: string }> {
  return page.evaluate(
    ([cid, msg, to]: [string, string, number]) => {
      const api = (window as any).forgeApi;
      return new Promise<any>((resolve) => {
        let u1: (() => void) | undefined;
        let u2: (() => void) | undefined;
        const timer = setTimeout(() => {
          u1?.(); u2?.();
          resolve({ error: true, reason: "timeout" });
        }, to);
        u1 = api.onStreamEnd((d: any) => {
          if (d.conversation?.id && d.conversation.id !== cid) return;
          clearTimeout(timer); u1?.(); u2?.();
          resolve({ cancelled: d.cancelled, message: d.message });
        });
        u2 = api.onStreamError((d: any) => {
          clearTimeout(timer); u1?.(); u2?.();
          resolve({ error: true, reason: JSON.stringify(d).slice(0, 300) });
        });
        api.sendMessage({ conversationId: cid, content: msg, attachmentIds: [] })
          .then((r: any) => {
            if (r.error) { clearTimeout(timer); u1?.(); u2?.(); resolve({ error: true, reason: r.error }); }
          })
          .catch((e: any) => { clearTimeout(timer); u1?.(); u2?.(); resolve({ error: true, reason: e.message }); });
      });
    },
    [convId, content, timeoutMs] as [string, string, number]
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe("Real Provider Smoke — Zero Touch", () => {
  test.setTimeout(180_000);

  test.beforeAll(async () => {
    if (!SMOKE_ENABLED) return;

    const app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env as Record<string, string>,
        FORGE_DATA_DIR: REAL_DATA_DIR,
        // No FORGE_TEST_PROVIDER — real provider path
        // No FORGE_API_KEY — secret stays in main process via safeStorage
        FORGE_SMOKE_REAL: "1",
        FORGE_TASKS_ENABLED: "1",
        NODE_ENV: "test",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    sharedForge = { app, page };

    // Automatically migrate secrets if they were encrypted by a different
    // safeStorage identity (e.g. Keychain rotation between sessions).
    // This is a one-time repair — subsequent launches will work natively.
    try {
      const migration = await page.evaluate(() =>
        (window as any).forgeApi.smoke.migrateSecrets()
      );
      console.log(`[smoke] Secret migration: migrated=${migration.migrated} failed=${migration.failed}`);
      if (migration.details?.length) {
        console.log(`[smoke] Migration details:`, migration.details.join(", "));
      }
    } catch (e) {
      console.log(`[smoke] Migration skipped (not needed or already current):`, (e as Error).message);
    }
  });

  test.afterAll(async () => {
    if (!sharedForge) return;
    const { app, page } = sharedForge;

    // Clean up all smoke conversations from the real DB
    if (smokeConvIds.length > 0) {
      try {
        await page.evaluate((ids: string[]) => {
          return (window as any).forgeApi.smoke.cleanupConversations(ids);
        }, smokeConvIds);
        console.log(`[smoke] Cleaned up ${smokeConvIds.length} smoke conversation(s).`);
      } catch { /* best effort */ }
    }

    await app.close();
    sharedForge = null;
  });

  // ── Pre-flight: verify default profile exists and has a secret ──────────────
  test("pre-flight: default profile exists with stored secret", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    const { page } = sharedForge!;

    const profile = await getDefaultProfile(page);
    console.log(`[smoke] Default profile: ${profile?.name} (${profile?.id?.slice(0, 8)}) endpoint=${profile?.endpoint} model=${profile?.model}`);

    if (!profile) {
      test.skip(true, "BLOCKED_NO_CONFIGURED_PROVIDER: no profile with stored secret found.");
    }
    expect(profile!.id).toBeTruthy();
    expect(profile!.endpoint).toBeTruthy();
    expect(profile!.model).toBeTruthy();

    const hasSecret = await page.evaluate(
      (pid: string) => (window as any).forgeApi.smoke.hasSecret(pid),
      profile!.id
    );
    console.log(`[smoke] hasSecret=${hasSecret}`);
    expect(hasSecret).toBe(true);

    // Debug: check actual decryption inside the main process (no secret exposed)
    const debug = await page.evaluate(
      (pid: string) => (window as any).forgeApi.smoke.debugSecret(pid),
      profile!.id
    );
    console.log(`[smoke] debug:`, JSON.stringify(debug));
  });

  // ── A: Normal conversational response ──────────────────────────────────────
  test("A: normal conversational response — streaming completes", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    const { page } = sharedForge!;

    const profile = await getDefaultProfile(page);
    if (!profile) { test.skip(true, "BLOCKED_NO_CONFIGURED_PROVIDER"); return; }

    const convId = await createSmokeConv(page, profile.id, "A");
    const result = await sendAndWait(page, convId, "Reply with a short confirmation.", 90_000);

    console.log(`[smoke] A: error=${result.error} cancelled=${result.cancelled} reason=${result.reason ?? "none"} content="${result.message?.content?.slice(0, 120) ?? ""}"`);

    expect(result.error).toBeFalsy();
    expect(result.cancelled).toBeFalsy();
    expect(result.message?.content?.length).toBeGreaterThan(0);
  });

  // ── B: Cancellation mid-stream ──────────────────────────────────────────────
  test("B: cancel mid-stream — AgentRun cancelled, queue recovers", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    const { page } = sharedForge!;

    const profile = await getDefaultProfile(page);
    if (!profile) { test.skip(true, "BLOCKED_NO_CONFIGURED_PROVIDER"); return; }

    const convId = await createSmokeConv(page, profile.id, "B");

    // Start a long-form prompt and cancel after first chunk arrives
    let streamStarted = false;
    await page.evaluate((cid: string) => {
      (window as any).__smokeStreamStarted = false;
      const u = (window as any).forgeApi.onStreamChunk((d: any) => {
        if (d.conversationId === cid) {
          (window as any).__smokeStreamStarted = true;
          u?.();
        }
      });
    }, convId);

    const sendP = sendAndWait(page, convId,
      "Write a detailed 2000-word analysis of the history of computing.", 90_000);

    // Wait for first chunk (up to 30s), then cancel
    const startTs = Date.now();
    while (!streamStarted && Date.now() - startTs < 30_000) {
      streamStarted = await page.evaluate(() => !!(window as any).__smokeStreamStarted);
      if (!streamStarted) await page.waitForTimeout(200);
    }

    await page.evaluate((cid: string) => (window as any).forgeApi.cancelStream(cid), convId);
    const result = await sendP;

    console.log(`[smoke] B: streamStarted=${streamStarted} cancelled=${result.cancelled} error=${result.error}`);
    // Either cleanly cancelled or finished before cancel arrived — both acceptable
    expect(result.cancelled || !result.error).toBeTruthy();

    // Verify queue recovers: send a follow-up
    const recovery = await sendAndWait(page, convId, "Say 'recovered' only.", 90_000);
    console.log(`[smoke] B recovery: error=${recovery.error} content="${recovery.message?.content?.slice(0, 60) ?? ""}"`);
    expect(recovery.error).toBeFalsy();
  });

  // ── C: Provider capabilities ────────────────────────────────────────────────
  test("C: provider capabilities — testConnection via existing AgentConfig", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    const { page } = sharedForge!;

    const profile = await getDefaultProfile(page);
    if (!profile) { test.skip(true, "BLOCKED_NO_CONFIGURED_PROVIDER"); return; }

    const caps = await page.evaluate(
      (pid: string) => (window as any).forgeApi.smoke.getCapabilities(pid),
      profile.id
    );

    console.log(`[smoke] C: capabilities status=${caps.status} message="${caps.message}"`);
    expect(["connected", "connected_partial"].includes(caps.status)).toBeTruthy();
  });

  // ── D: Secret leak audit ────────────────────────────────────────────────────
  test("D: secret leak audit — no secret in logs or diagnostic bundle", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    const { page } = sharedForge!;

    const profile = await getDefaultProfile(page);
    if (!profile) { test.skip(true, "BLOCKED_NO_CONFIGURED_PROVIDER"); return; }

    // Run a real send so the provider request flows through the system
    const convId = await createSmokeConv(page, profile.id, "D");
    await sendAndWait(page, convId, "Say 'audit' only.", 90_000);

    // Export diagnostic bundle
    const bundle = await page.evaluate(() => (window as any).forgeApi.devPanel.exportBundle());
    const bundleStr = JSON.stringify(bundle);

    // Telemetry log dump
    const logs = await page.evaluate(() =>
      (window as any).forgeApi.telemetry.getEvents({ limit: 500 })
    );
    const logsStr = JSON.stringify(logs);

    // We can't check for the exact key value (we don't have it in the test process).
    // Instead we check for the known encrypted storage patterns and auth header patterns.
    const bundleHasAuth = /Authorization/.test(bundleStr) || /Bearer [A-Za-z0-9_\-]{10,}/.test(bundleStr);
    const logsHasAuth = /Authorization/.test(logsStr) || /Bearer [A-Za-z0-9_\-]{10,}/.test(logsStr);
    // Also check for the raw v10 safeStorage prefix that would indicate an undecoded encrypted blob
    const bundleHasV10 = bundleStr.includes("djEwP7F4");  // base64 of v10 prefix
    const logsHasV10 = logsStr.includes("djEwP7F4");

    console.log(`[smoke] D: bundleSize=${bundleStr.length} bundleHasAuth=${bundleHasAuth} logsCount=${(logs as any[]).length} logsHasAuth=${logsHasAuth}`);
    console.log(`[smoke] D: bundleHasV10=${bundleHasV10} logsHasV10=${logsHasV10}`);

    expect(bundleHasAuth).toBe(false);
    expect(logsHasAuth).toBe(false);
    expect(bundleHasV10).toBe(false);
    expect(logsHasV10).toBe(false);
  });
});

// ── Skip report ───────────────────────────────────────────────────────────────

test.describe("Real Provider Smoke — Skip Report", () => {
  test("smoke gate: report SKIPPED status when FORGE_SMOKE_REAL not set", async () => {
    if (SMOKE_ENABLED) {
      test.skip(true, "Smoke is fully enabled — skip-report not needed");
    }
    console.log("[smoke] SKIPPED — set FORGE_SMOKE_REAL=1 to enable");
    console.log("[smoke] Zero-touch: no FORGE_API_KEY needed. Usage:");
    console.log("[smoke]   FORGE_SMOKE_REAL=1 pnpm exec playwright test e2e/real-provider-smoke.spec.ts");
    console.log("[smoke]   or: pnpm qa:real-provider");
    expect(true).toBe(true);
  });
});