/**
 * E2E: Fake Provider
 *
 * Verifies that FORGE_TEST_PROVIDER=fake activates the deterministic fake
 * response engine. These tests run the app with the fake provider env var
 * and confirm the module loads without crashing.
 *
 * Note: Full conversation-level testing requires an agent connection to be
 * configured. These tests focus on the infrastructure (env detection, IPC
 * stability) without needing a real API key.
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge } from "./helpers.js";

test.describe("Fake Provider", () => {
  test("app launches cleanly with FORGE_TEST_PROVIDER=fake", async () => {
    const forge = await launchForge({ fakeProvider: true });
    const { page } = forge;

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1500);

      // No renderer errors should appear
      expect(errors).toHaveLength(0);

      // App should still render correctly
      const bodyLen = await page.evaluate(() => document.body.innerText.length);
      expect(bodyLen).toBeGreaterThan(0);
    } finally {
      await closeForge(forge);
    }
  });

  test("telemetry API is functional with fake provider", async () => {
    const forge = await launchForge({ fakeProvider: true });
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);

      const result = await page.evaluate(async () => {
        const api = (window as {
          forgeApi?: { telemetry?: { getEvents?: (opts: object) => Promise<unknown> } }
        }).forgeApi;
        if (!api?.telemetry?.getEvents) return null;
        return api.telemetry.getEvents({ limit: 50 });
      });

      expect(Array.isArray(result)).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });

  test("devPanel snapshot works with fake provider enabled", async () => {
    const forge = await launchForge({ fakeProvider: true });
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1200);

      const snapshot = await page.evaluate(async () => {
        const api = (window as {
          forgeApi?: { devPanel?: { getSnapshot?: () => Promise<unknown> } }
        }).forgeApi;
        if (!api?.devPanel?.getSnapshot) return null;
        return api.devPanel.getSnapshot();
      });

      expect(snapshot).not.toBeNull();
      const s = snapshot as Record<string, unknown>;
      // Snapshot is always valid regardless of provider mode
      expect(typeof s["appVersion"]).toBe("string");
      expect(Array.isArray(s["activeRuns"])).toBe(true);
      expect(Array.isArray(s["queueSummary"])).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });
});