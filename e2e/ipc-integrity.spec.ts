/**
 * E2E: IPC Integrity
 *
 * Verifies that key IPC channels are registered and respond to basic queries
 * without crashing. These tests run in the renderer context via
 * page.evaluate() to call window.forgeApi.
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge } from "./helpers.js";

test.describe("IPC Integrity", () => {
  test("forgeApi is exposed on window", async () => {
    const forge = await launchForge();
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);

      const hasApi = await page.evaluate(() => typeof (window as { forgeApi?: unknown }).forgeApi !== "undefined");
      expect(hasApi).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });

  test("getAppState returns a valid object", async () => {
    const forge = await launchForge();
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);

      const state = await page.evaluate(async () => {
        const api = (window as { forgeApi?: { getAppState?: () => Promise<unknown> } }).forgeApi;
        if (!api?.getAppState) return null;
        return api.getAppState();
      });

      expect(state).not.toBeNull();
      expect(typeof state).toBe("object");
    } finally {
      await closeForge(forge);
    }
  });

  test("listConversations returns an array", async () => {
    const forge = await launchForge();
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);

      const result = await page.evaluate(async () => {
        const api = (window as {
          forgeApi?: { listConversations?: (scopeId?: string | null) => Promise<unknown> }
        }).forgeApi;
        if (!api?.listConversations) return null;
        return api.listConversations(null);
      });

      expect(Array.isArray(result)).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });

  test("telemetry.getEvents returns an array", async () => {
    const forge = await launchForge();
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);

      const result = await page.evaluate(async () => {
        const api = (window as {
          forgeApi?: { telemetry?: { getEvents?: (opts: object) => Promise<unknown> } }
        }).forgeApi;
        if (!api?.telemetry?.getEvents) return null;
        return api.telemetry.getEvents({ limit: 10 });
      });

      expect(Array.isArray(result)).toBe(true);
    } finally {
      await closeForge(forge);
    }
  });

  test("devPanel.getSnapshot returns an object with expected keys", async () => {
    const forge = await launchForge();
    const { page } = forge;

    try {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1200); // give initDevState time to wire up

      const result = await page.evaluate(async () => {
        const api = (window as {
          forgeApi?: { devPanel?: { getSnapshot?: () => Promise<unknown> } }
        }).forgeApi;
        if (!api?.devPanel?.getSnapshot) return null;
        return api.devPanel.getSnapshot();
      });

      expect(result).not.toBeNull();
      const snapshot = result as Record<string, unknown>;
      expect(Array.isArray(snapshot["activeRuns"])).toBe(true);
      expect(typeof snapshot["capturedAt"]).toBe("number");
      expect(typeof snapshot["browser"]).toBe("object");
    } finally {
      await closeForge(forge);
    }
  });
});