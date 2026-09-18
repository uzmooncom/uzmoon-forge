/**
 * V17 E2E Helpers — launch Electron and create a Playwright page from it.
 *
 * Uses playwright-core's _electron module (Electron is the browser here).
 */
import { _electron as electron } from "playwright-core";
import type { ElectronApplication, Page } from "playwright-core";
import path from "path";
import fs from "fs";
import os from "os";

const ROOT = path.join(__dirname, "..");
const MAIN_ENTRY = path.join(ROOT, "dist/main/main/main.js");

export interface ForgeApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
}

export async function launchForge(opts: {
  fakeProvider?: boolean;
  extraEnv?: Record<string, string>;
} = {}): Promise<ForgeApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    FORGE_DATA_DIR: dataDir,
    NODE_ENV: "test",
    ...(opts.fakeProvider ? { FORGE_TEST_PROVIDER: "fake" } : {}),
    ...opts.extraEnv,
  };

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env,
    // Disable GPU in CI
    executablePath: undefined,
  });

  const page = await app.firstWindow();
  // Wait for renderer to be ready
  await page.waitForLoadState("domcontentloaded");

  return { app, page, dataDir };
}

export async function closeForge(forgeApp: ForgeApp): Promise<void> {
  await forgeApp.app.close();
  // Clean up temp data dir
  try {
    fs.rmSync(forgeApp.dataDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

/**
 * Wait for an element matching selector to be visible.
 * Retries up to the given timeout (default 10s).
 */
export async function waitForVisible(page: Page, selector: string, timeout = 10_000): Promise<void> {
  await page.waitForSelector(selector, { state: "visible", timeout });
}

/**
 * Get the text content of a selector (trimmed).
 */
export async function getText(page: Page, selector: string): Promise<string> {
  const el = await page.$(selector);
  if (!el) return "";
  return ((await el.textContent()) ?? "").trim();
}