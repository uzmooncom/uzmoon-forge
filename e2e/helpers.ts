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

/**
 * Poll a condition (called in the renderer via page.evaluate) until it returns true.
 * The condFn is serialized and executed inside the renderer context.
 */
export async function pollFor(
  page: Page,
  condFn: () => Promise<boolean> | boolean,
  timeout = 15_000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (true) {
    const result = await page.evaluate(condFn);
    if (result) return;
    if (Date.now() - start > timeout) throw new Error(`pollFor timeout after ${timeout}ms`);
    await page.waitForTimeout(interval);
  }
}

/**
 * Create a fake agent profile and set a dummy secret so the fake provider
 * can process messages without a real API key.
 *
 * Returns { profileId, convId } for use in chat tests.
 */
export async function setupFakeAgent(page: Page): Promise<{ profileId: string; convId: string }> {
  const result = await page.evaluate(async () => {
    // Correct preload API method names:
    //   saveProfile (not saveAgentProfile)
    //   setDefaultProfile (not setDefaultAgentProfile)
    //   createConversation takes a full Conversation object and returns void
    //   getConversationMessages (not getConvMessages)
    const api = (window as { forgeApi?: {
      saveProfile: (p: object) => Promise<object>;
      setSecret: (key: string, val: string) => Promise<void>;
      setDefaultProfile: (id: string) => Promise<void>;
      createConversation: (conv: object) => Promise<void>;
    } }).forgeApi!;

    const now = Date.now();
    const profileId = `fake-e2e-${now}`;
    const convId = `fake-conv-${now}`;

    await api.saveProfile({
      id: profileId,
      name: "Fake E2E Agent",
      endpoint: "https://api.anthropic.com",
      protocol: "anthropic",
      model: "claude-3-5-haiku-20241022",
      isDefault: true,
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    await api.setSecret(profileId, "sk-fake-e2e-key");
    await api.setDefaultProfile(profileId);

    // createConversation takes a full Conversation object; generate id client-side
    await api.createConversation({
      id: convId,
      title: "E2E Test Conversation",
      defaultAgentProfileId: profileId,
      createdAt: now,
      updatedAt: now,
    });

    return { profileId, convId };
  });

  return result as { profileId: string; convId: string };
}

/**
 * Subscribe to onStreamStart for convId and wait until it fires.
 * Sets window.forgeApi._e2eStreamStarted = true when stream begins.
 * Returns true if stream started within timeout, false otherwise.
 */
export async function waitForStreamStart(page: Page, timeout = 8000): Promise<boolean> {
  // Register listener
  await page.evaluate(() => {
    const api = (window as { forgeApi?: { onStreamStart?: (cb: () => void) => () => void; _e2eStreamStarted?: boolean } }).forgeApi;
    if (api?.onStreamStart) {
      api._e2eStreamStarted = false;
      api.onStreamStart(() => { if (api) api._e2eStreamStarted = true; });
    }
  });

  // Poll until true or timeout
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(150);
    const started = await page.evaluate(() => {
      return (window as { forgeApi?: { _e2eStreamStarted?: boolean } }).forgeApi?._e2eStreamStarted === true;
    });
    if (started) return true;
  }
  return false;
}

/**
 * Send a message and wait for STREAM_END for the specific convId, returning the final ChatMessage.
 * Filters by conversation.id so concurrent stream ends for other convs are ignored.
 */
export async function sendAndAwaitEnd(
  page: Page,
  convId: string,
  content: string,
  timeout = 30_000
): Promise<{ cancelled?: boolean; message?: { role: string; content: string }; error?: boolean }> {
  return page.evaluate(
    async ([cid, msg, to]: [string, string, number]) => {
      const api = (window as { forgeApi?: {
        sendMessage: (req: object) => Promise<{ queueItemId?: string; error?: string }>;
        onStreamEnd: (cb: (d: {
          streamId: string;
          message?: { role: string; content: string };
          cancelled?: boolean;
          conversation?: { id: string };
        }) => void) => () => void;
        onStreamError: (cb: (d: { streamId: string }) => void) => () => void;
      } }).forgeApi!;

      return new Promise<{ cancelled?: boolean; message?: { role: string; content: string }; error?: boolean }>((resolve) => {
        let unsub1: (() => void) | undefined;
        let unsub2: (() => void) | undefined;
        const timer = setTimeout(() => {
          unsub1?.();
          unsub2?.();
          resolve({ error: true });
        }, to);

        unsub1 = api.onStreamEnd((data) => {
          // Filter: only handle stream ends for OUR conversation
          if (data.conversation?.id && data.conversation.id !== cid) return;
          clearTimeout(timer);
          unsub1?.();
          unsub2?.();
          resolve({ cancelled: data.cancelled, message: data.message });
        });
        unsub2 = api.onStreamError(() => {
          clearTimeout(timer);
          unsub1?.();
          unsub2?.();
          resolve({ error: true });
        });

        api.sendMessage({ conversationId: cid, content: msg, attachmentIds: [] })
          .then((r) => { if (r.error) { clearTimeout(timer); unsub1?.(); unsub2?.(); resolve({ error: true }); } })
          .catch(() => { clearTimeout(timer); unsub1?.(); unsub2?.(); resolve({ error: true }); });
      });
    },
    [convId, content, timeout] as [string, string, number]
  );
}