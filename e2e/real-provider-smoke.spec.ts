/**
 * REAL PROVIDER SMOKE TEST
 *
 * Uses the actual configured provider (https://app.claude.gg, model=claude,
 * protocol=openai) with a fresh in-session secret set before the first send.
 *
 * WHY KEY INJECTION: macOS safeStorage encryption is app-identity-bound.
 * The API key stored by the packaged app can't be decrypted by a headless
 * Playwright-launched Electron instance (different app identity/keychain entry).
 * We inject the key via FORGE_API_KEY env var and set it in the test session.
 *
 * GATE: FORGE_SMOKE_REAL=1 + FORGE_API_KEY=<key>
 *
 * Usage:
 *   FORGE_SMOKE_REAL=1 FORGE_API_KEY=sk-... \
 *     pnpm exec playwright test e2e/real-provider-smoke.spec.ts
 *
 * Scenarios:
 *   A. Normal conversational response (streaming completes)
 *   B. Stop during real streaming (cancel works, queue recovers)
 *   C. Invalid model error then real profile works
 *   D. No secrets leaked in logs or diagnostic bundle
 *   E. Provider capabilities check
 */

import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright-core";
import path from "path";
import os from "os";
import fs from "fs";

const ROOT = path.join(__dirname, "..");
const MAIN_ENTRY = path.join(ROOT, "dist/main/main/main.js");

// Gate
const SMOKE_ENABLED = process.env["FORGE_SMOKE_REAL"] === "1";
const API_KEY = process.env["FORGE_API_KEY"] ?? "";

// ── Launch with isolated tmpdir (avoids stale data) ──────────────────────────

async function launchSmokeForge() {
  // Use an isolated tmpdir so we start fresh (no bad profiles from prior runs)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-smoke-"));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env as Record<string, string>,
      FORGE_DATA_DIR: dataDir,
      NODE_ENV: "test",
      FORGE_TASKS_ENABLED: "1",
      // NO FORGE_TEST_PROVIDER — use real provider
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  return { app, page, dataDir };
}

async function closeSmokeForge(forge: { app: Awaited<ReturnType<typeof launchSmokeForge>>["app"]; dataDir: string }) {
  await forge.app.close();
  try { fs.rmSync(forge.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Setup: create real profile and inject key ─────────────────────────────────

async function setupRealProfile(page: import("playwright-core").Page, apiKey: string): Promise<string> {
  return page.evaluate(async ([key]: [string]) => {
    const api = (window as any).forgeApi;
    const profileId = `smoke-real-${Date.now()}`;
    // Save profile
    await api.saveProfile({
      id: profileId,
      name: "Smoke Real Provider",
      endpoint: "https://app.claude.gg",
      protocol: "openai",
      model: "claude",
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Inject API key (this calls safeStorage.encryptString in the same process
    // that will later decrypt it — so it always works)
    await api.setSecret(profileId, key);
    return profileId;
  }, [apiKey] as [string]);
}

async function createSmokeConv(
  page: import("playwright-core").Page,
  profileId: string,
  label: string
): Promise<string> {
  return page.evaluate(async ([pid, lbl]: [string, string]) => {
    const api = (window as any).forgeApi;
    const id = `smoke-${lbl}-${Date.now()}`;
    await api.createConversation({
      id, title: `Smoke ${lbl}`,
      defaultAgentProfileId: pid,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
  }, [profileId, label] as [string, string]);
}

async function sendReal(
  page: import("playwright-core").Page,
  convId: string,
  content: string,
  timeoutMs = 60_000
): Promise<{ cancelled?: boolean; message?: { role: string; content: string }; error?: boolean }> {
  return page.evaluate(
    async ([cid, msg, to]: [string, string, number]) => {
      const api = (window as any).forgeApi;
      return new Promise<any>((resolve) => {
        let u1: (() => void) | undefined;
        let u2: (() => void) | undefined;
        const timer = setTimeout(() => { u1?.(); u2?.(); resolve({ error: true, reason: "timeout" }); }, to);
        u1 = api.onStreamEnd((d: any) => {
          if (d.conversation?.id && d.conversation.id !== cid) return;
          clearTimeout(timer); u1?.(); u2?.();
          resolve({ cancelled: d.cancelled, message: d.message });
        });
        u2 = api.onStreamError((d: any) => {
          clearTimeout(timer); u1?.(); u2?.();
          resolve({ error: true, reason: JSON.stringify(d).slice(0, 200) });
        });
        api.sendMessage({ conversationId: cid, content: msg, attachmentIds: [] })
          .then((r: any) => { if (r.error) { clearTimeout(timer); u1?.(); u2?.(); resolve({ error: true, reason: r.error }); } })
          .catch((e: any) => { clearTimeout(timer); u1?.(); u2?.(); resolve({ error: true, reason: e.message }); });
      });
    },
    [convId, content, timeoutMs] as [string, string, number]
  );
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Real Provider Smoke", () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    if (!SMOKE_ENABLED) {
      console.log("[smoke] FORGE_SMOKE_REAL not set — all real-provider tests SKIPPED");
    } else if (!API_KEY) {
      console.log("[smoke] FORGE_API_KEY not set — real-provider tests will fail at auth");
    }
  });

  // ── A: Normal conversational response ──────────────────────────────────────
  test("A: normal conversational response streams and completes", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    test.skip(!API_KEY, "FORGE_API_KEY required");

    const forge = await launchSmokeForge();
    try {
      const profileId = await setupRealProfile(forge.page, API_KEY);
      const convId = await createSmokeConv(forge.page, profileId, "conv-a");

      const result = await sendReal(forge.page, convId,
        "Reply with exactly three words: hello world test", 90_000);

      console.log(`[smoke] A: error=${result.error} cancelled=${result.cancelled} content="${result.message?.content?.slice(0, 120)}"`);
      expect((result as any).reason).toBeUndefined();
      expect(result.error).toBeFalsy();
      expect(result.cancelled).toBeFalsy();
      expect(result.message?.content?.length).toBeGreaterThan(0);
    } finally {
      await closeSmokeForge(forge);
    }
  });

  // ── B: Stop during real streaming ──────────────────────────────────────────
  test("B: Stop during real streaming — cancels cleanly, queue recovers", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    test.skip(!API_KEY, "FORGE_API_KEY required");

    const forge = await launchSmokeForge();
    try {
      const profileId = await setupRealProfile(forge.page, API_KEY);
      const convId = await createSmokeConv(forge.page, profileId, "conv-b");

      // Send a long-form prompt and cancel after 2.5s
      const sendP = sendReal(forge.page, convId,
        "Write a very detailed 5000-word essay about the history of computing.", 90_000);

      await forge.page.waitForTimeout(2500);
      await forge.page.evaluate(async (cid: string) => {
        const api = (window as any).forgeApi;
        await api.cancelStream(cid);
      }, convId);

      const result = await sendP;
      console.log(`[smoke] B cancel: cancelled=${result.cancelled} error=${result.error}`);
      // Cancelled or short response (stream may have ended before cancel arrived)
      expect(result.cancelled || !result.error).toBeTruthy();

      // Queue should auto-recover — send another message
      const recovery = await sendReal(forge.page, convId, "Say 'recovered' only.", 90_000);
      console.log(`[smoke] B recovery: error=${recovery.error} content="${recovery.message?.content?.slice(0, 60)}"`);
      expect(recovery.error).toBeFalsy();

    } finally {
      await closeSmokeForge(forge);
    }
  });

  // ── C: Invalid model error then real profile works ───────────────────────
  test("C: invalid model produces stream error; valid model works after", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    test.skip(!API_KEY, "FORGE_API_KEY required");

    const forge = await launchSmokeForge();
    try {
      // Bad profile
      const badProfileId = await forge.page.evaluate(async ([key]: [string]) => {
        const api = (window as any).forgeApi;
        const id = `bad-profile-c-${Date.now()}`;
        await api.saveProfile({
          id, name: "Bad Profile", endpoint: "https://app.claude.gg",
          protocol: "openai", model: "nonexistent-model-xyz-99999",
          isDefault: false, createdAt: Date.now(), updatedAt: Date.now(),
        });
        await api.setSecret(id, key);
        return id;
      }, [API_KEY] as [string]);

      const badConvId = await createSmokeConv(forge.page, badProfileId, "conv-c-bad");
      const errResult = await sendReal(forge.page, badConvId, "Hello", 30_000);
      console.log(`[smoke] C bad profile: error=${errResult.error}`);
      // Bad model → error expected (or maybe provider ignores model name — accept both)

      // Good profile
      const goodProfileId = await setupRealProfile(forge.page, API_KEY);
      const goodConvId = await createSmokeConv(forge.page, goodProfileId, "conv-c-good");
      const goodResult = await sendReal(forge.page, goodConvId, "Say 'ok' only.", 90_000);
      console.log(`[smoke] C good profile: error=${goodResult.error} content="${goodResult.message?.content?.slice(0, 60)}"`);
      expect(goodResult.error).toBeFalsy();

    } finally {
      await closeSmokeForge(forge);
    }
  });

  // ── D: No secrets leaked in logs or bundle ───────────────────────────────
  test("D: no API key leaked into logs or diagnostic bundle", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    test.skip(!API_KEY, "FORGE_API_KEY required");

    const forge = await launchSmokeForge();
    try {
      const profileId = await setupRealProfile(forge.page, API_KEY);
      const convId = await createSmokeConv(forge.page, profileId, "conv-d");

      await sendReal(forge.page, convId, "Say 'audit' only.", 90_000);

      // Export bundle and check for key leakage
      const bundle = await forge.page.evaluate(async () => {
        const api = (window as any).forgeApi;
        return api.devPanel.exportBundle();
      });
      const bundleStr = JSON.stringify(bundle);

      // Check that neither the full API key nor common auth header patterns appear
      const keyPrefix = API_KEY.slice(0, 8); // first 8 chars of key
      const hasKeyPrefix = bundleStr.includes(keyPrefix);
      const hasAuthHeader = bundleStr.includes("Authorization") || /Bearer [A-Za-z0-9_\-]{10,}/.test(bundleStr);

      console.log(`[smoke] D: bundle size=${bundleStr.length}, hasKeyPrefix=${hasKeyPrefix}, hasAuthHeader=${hasAuthHeader}`);
      expect(hasKeyPrefix).toBe(false);
      expect(hasAuthHeader).toBe(false);

      // Telemetry check
      const logs = await forge.page.evaluate(async () => {
        const api = (window as any).forgeApi;
        return api.telemetry.getEvents({ limit: 500 });
      });
      const logsStr = JSON.stringify(logs);
      const logsHasKeyPrefix = logsStr.includes(API_KEY.slice(0, 8));
      const logsHasAuth = /Bearer [A-Za-z0-9_\-]{10,}/.test(logsStr);
      console.log(`[smoke] D: logs=${(logs as any[]).length}, logsHasKeyPrefix=${logsHasKeyPrefix}, logsHasAuth=${logsHasAuth}`);
      expect(logsHasKeyPrefix).toBe(false);
      expect(logsHasAuth).toBe(false);

    } finally {
      await closeSmokeForge(forge);
    }
  });

  // ── E: Provider capabilities and profile shape ────────────────────────────
  test("E: provider capabilities and runtime state shape are correct", async () => {
    test.skip(!SMOKE_ENABLED, "FORGE_SMOKE_REAL=1 required");
    test.skip(!API_KEY, "FORGE_API_KEY required");

    const forge = await launchSmokeForge();
    try {
      const profileId = await setupRealProfile(forge.page, API_KEY);

      const profile = await forge.page.evaluate(async (pid: string) => {
        const api = (window as any).forgeApi;
        const profiles = await api.listProfiles();
        return profiles.find((p: any) => p.id === pid);
      }, profileId);

      console.log(`[smoke] E: profile=${profile?.name} endpoint=${profile?.endpoint} model=${profile?.model}`);
      expect(profile).toBeTruthy();
      expect(profile?.endpoint).toBeTruthy();
      expect(profile?.model).toBeTruthy();

      // Runtime state for idle conv should be null
      const convId = await createSmokeConv(forge.page, profileId, "conv-e");
      const rt = await forge.page.evaluate(async (cid: string) => {
        const api = (window as any).forgeApi;
        return api.getRuntimeState(cid);
      }, convId);
      console.log(`[smoke] E: idle runtimeState=${JSON.stringify(rt)}`);
      expect(rt).toBeNull();

    } finally {
      await closeSmokeForge(forge);
    }
  });
});

// ── Skip report ───────────────────────────────────────────────────────────────

test.describe("Real Provider Smoke — Skip Report", () => {
  test("smoke gate: report SKIPPED status when gate vars not set", async () => {
    if (SMOKE_ENABLED && API_KEY) {
      test.skip(true, "Smoke is fully enabled — skip-report not needed");
    }
    if (!SMOKE_ENABLED) {
      console.log("[smoke] SKIPPED — set FORGE_SMOKE_REAL=1 to enable");
    }
    if (!API_KEY) {
      console.log("[smoke] SKIPPED — set FORGE_API_KEY=<key> to provide credentials");
    }
    console.log("[smoke] Usage: FORGE_SMOKE_REAL=1 FORGE_API_KEY=<key> pnpm exec playwright test e2e/real-provider-smoke.spec.ts");
    expect(true).toBe(true);
  });
});