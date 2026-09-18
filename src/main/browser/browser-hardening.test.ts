/**
 * Browser Runtime V2.1 — Hardening tests
 *
 * Tests for:
 *  - Default agentAccessPolicy is now "ask" (not "off")
 *  - isBrowserWindowOpen() tracks window state
 *  - getBrowserStatus() returns correct snapshot
 *  - Bookmark CRUD (addBookmark, getBookmarks, removeBookmark, editBookmark, isUrlBookmarked)
 *  - History recording (recordNavigation, getBrowserHistory, clearBrowserHistory)
 *  - Private profile history is never recorded
 *  - clearConversationBrowserBinding cleans up correctly
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// ── Electron mock ──────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  WebContentsView: vi.fn().mockImplementation(() => ({
    webContents: {
      id: Math.floor(Math.random() * 10000),
      loadURL: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn().mockReturnValue("about:blank"),
      getTitle: vi.fn().mockReturnValue(""),
      canGoBack: vi.fn().mockReturnValue(false),
      canGoForward: vi.fn().mockReturnValue(false),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      stop: vi.fn(),
      sendInputEvent: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(null),
      on: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    setBounds: vi.fn(),
    setBackgroundColor: vi.fn(),
  })),
  BrowserWindow: vi.fn().mockImplementation(() => ({
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    isDestroyed: vi.fn().mockReturnValue(false),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  })),
  ipcMain: {
    on: vi.fn(),
    once: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/forge-test-app"),
    on: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  session: {
    fromPartition: vi.fn().mockReturnValue({
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    }),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../reliability/invariants.js", () => ({
  assertInvariant: vi.fn().mockReturnValue(true),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: vi.fn().mockReturnValue(null),
}));

// ── Imports after mock ─────────────────────────────────────────────────────

import { getDb, resetDb } from "../database/db.js";
import {
  _resetBrowserManagerForTest,
  createBrowserProfile,
  setBrowserNativeWindow,
  isBrowserWindowOpen,
  getBrowserStatus,
  addBookmark,
  getBookmarks,
  removeBookmark,
  editBookmark,
  isUrlBookmarked,
  recordNavigation,
  getBrowserHistory,
  clearBrowserHistory,
  clearConversationBrowserBinding,
} from "./browser-manager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bh-test-"));
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  resetDb();
  getDb(path.join(tmpDir, "data"));
  _resetBrowserManagerForTest();
});

// ── Default policy ─────────────────────────────────────────────────────────

describe("createBrowserProfile defaults", () => {
  it("defaults agentAccessPolicy to 'ask'", () => {
    const profile = createBrowserProfile({ name: "Test", persistenceMode: "persistent" });
    expect(profile.agentAccessPolicy).toBe("ask");
  });

  it("respects explicit 'off' policy", () => {
    const profile = createBrowserProfile({
      name: "Off",
      persistenceMode: "persistent",
      agentAccessPolicy: "off",
    });
    expect(profile.agentAccessPolicy).toBe("off");
  });

  it("respects explicit 'allowed' policy", () => {
    const profile = createBrowserProfile({
      name: "Allowed",
      persistenceMode: "persistent",
      agentAccessPolicy: "allowed",
    });
    expect(profile.agentAccessPolicy).toBe("allowed");
  });
});

// ── Window open tracking ───────────────────────────────────────────────────

describe("isBrowserWindowOpen", () => {
  it("returns false initially", () => {
    expect(isBrowserWindowOpen()).toBe(false);
  });

  it("returns true after setBrowserNativeWindow with a non-null window", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBrowserNativeWindow({ fake: "window" } as any);
    expect(isBrowserWindowOpen()).toBe(true);
  });

  it("returns false after setBrowserNativeWindow(null)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBrowserNativeWindow({ fake: "window" } as any);
    setBrowserNativeWindow(null);
    expect(isBrowserWindowOpen()).toBe(false);
  });

  it("_resetBrowserManagerForTest resets to false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBrowserNativeWindow({ fake: "window" } as any);
    _resetBrowserManagerForTest();
    expect(isBrowserWindowOpen()).toBe(false);
  });
});

// ── getBrowserStatus ───────────────────────────────────────────────────────

describe("getBrowserStatus", () => {
  it("returns correct defaults when no session is active", () => {
    const status = getBrowserStatus();
    expect(status.isWindowOpen).toBe(false);
    expect(status.tabCount).toBe(0);
    expect(status.activeUrl).toBeNull();
    expect(status.activeTitle).toBeNull();
    expect(status.activeProfileName).toBeNull();
    expect(status.agentControlActive).toBe(false);
  });

  it("reflects window open state", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBrowserNativeWindow({ fake: "window" } as any);
    const status = getBrowserStatus();
    expect(status.isWindowOpen).toBe(true);
  });
});

// ── Bookmark CRUD ──────────────────────────────────────────────────────────

describe("Bookmark management", () => {
  it("addBookmark creates a bookmark with correct fields", () => {
    const profile = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    const bm = addBookmark({ profileId: profile.id, url: "https://example.com", title: "Example" });
    expect(bm.profileId).toBe(profile.id);
    expect(bm.url).toBe("https://example.com");
    expect(bm.title).toBe("Example");
    expect(typeof bm.id).toBe("string");
    expect(bm.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("getBookmarks returns bookmarks for a profile", () => {
    const p1 = createBrowserProfile({ name: "P1", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "P2", persistenceMode: "persistent" });
    addBookmark({ profileId: p1.id, url: "https://a.com", title: "A" });
    addBookmark({ profileId: p1.id, url: "https://b.com", title: "B" });
    addBookmark({ profileId: p2.id, url: "https://c.com", title: "C" });

    const p1Bookmarks = getBookmarks(p1.id);
    expect(p1Bookmarks).toHaveLength(2);
    expect(p1Bookmarks.map((b) => b.url)).toContain("https://a.com");
    expect(p1Bookmarks.map((b) => b.url)).toContain("https://b.com");
  });

  it("getBookmarks without profileId returns all bookmarks", () => {
    const p1 = createBrowserProfile({ name: "P1", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "P2", persistenceMode: "persistent" });
    addBookmark({ profileId: p1.id, url: "https://a.com", title: "A" });
    addBookmark({ profileId: p2.id, url: "https://b.com", title: "B" });

    const all = getBookmarks();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("removeBookmark deletes the bookmark", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    const bm = addBookmark({ profileId: p.id, url: "https://example.com", title: "E" });
    removeBookmark(bm.id);
    const remaining = getBookmarks(p.id);
    expect(remaining.find((b) => b.id === bm.id)).toBeUndefined();
  });

  it("editBookmark updates title", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    const bm = addBookmark({ profileId: p.id, url: "https://example.com", title: "Old Title" });
    const updated = editBookmark(bm.id, { title: "New Title" });
    expect(updated?.title).toBe("New Title");
  });

  it("isUrlBookmarked returns bookmark for matching URL", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    addBookmark({ profileId: p.id, url: "https://example.com", title: "E" });
    const found = isUrlBookmarked(p.id, "https://example.com");
    expect(found).not.toBeNull();
    expect(found?.url).toBe("https://example.com");
  });

  it("isUrlBookmarked returns null for non-bookmarked URL", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    const found = isUrlBookmarked(p.id, "https://notbookmarked.com");
    expect(found).toBeNull();
  });

  it("addBookmark stores favicon when provided", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    const bm = addBookmark({
      profileId: p.id,
      url: "https://example.com",
      title: "E",
      favicon: "https://example.com/favicon.ico",
    });
    expect(bm.favicon).toBe("https://example.com/favicon.ico");
  });
});

// ── History recording ──────────────────────────────────────────────────────

describe("History recording", () => {
  it("recordNavigation stores entry for persistent profile", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    recordNavigation(p.id, "https://example.com", "Example");
    const hist = getBrowserHistory(p.id);
    expect(hist.some((e) => e.url === "https://example.com")).toBe(true);
  });

  it("recordNavigation does NOT store entry for private profile", () => {
    const p = createBrowserProfile({ name: "Private", persistenceMode: "private" });
    recordNavigation(p.id, "https://secret.com", "Secret");
    const hist = getBrowserHistory(p.id);
    expect(hist.some((e) => e.url === "https://secret.com")).toBe(false);
  });

  it("recordNavigation skips about:blank", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    recordNavigation(p.id, "about:blank", "");
    const hist = getBrowserHistory(p.id);
    expect(hist.some((e) => e.url === "about:blank")).toBe(false);
  });

  it("recordNavigation skips forge:// internal URLs", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    recordNavigation(p.id, "forge://newtab", "New Tab");
    const hist = getBrowserHistory(p.id);
    expect(hist.some((e) => e.url === "forge://newtab")).toBe(false);
  });

  it("getBrowserHistory returns entries filtered by profileId", () => {
    const p1 = createBrowserProfile({ name: "P1", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "P2", persistenceMode: "persistent" });
    recordNavigation(p1.id, "https://p1.com", "P1");
    recordNavigation(p2.id, "https://p2.com", "P2");

    const p1Hist = getBrowserHistory(p1.id);
    expect(p1Hist.every((e) => e.profileId === p1.id)).toBe(true);
    expect(p1Hist.some((e) => e.url === "https://p1.com")).toBe(true);
    expect(p1Hist.some((e) => e.url === "https://p2.com")).toBe(false);
  });

  it("clearBrowserHistory removes entries for a profile", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    recordNavigation(p.id, "https://a.com", "A");
    recordNavigation(p.id, "https://b.com", "B");
    clearBrowserHistory(p.id);
    const hist = getBrowserHistory(p.id);
    expect(hist).toHaveLength(0);
  });

  it("clearBrowserHistory without profileId clears all history", () => {
    const p1 = createBrowserProfile({ name: "P1", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "P2", persistenceMode: "persistent" });
    recordNavigation(p1.id, "https://p1.com", "P1");
    recordNavigation(p2.id, "https://p2.com", "P2");
    clearBrowserHistory();
    expect(getBrowserHistory(p1.id)).toHaveLength(0);
    expect(getBrowserHistory(p2.id)).toHaveLength(0);
  });

  it("getBrowserHistory respects limit", () => {
    const p = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    for (let i = 0; i < 10; i++) {
      recordNavigation(p.id, `https://site${i}.com`, `Site ${i}`);
    }
    const limited = getBrowserHistory(p.id, 5);
    expect(limited.length).toBeLessThanOrEqual(5);
  });
});

// ── clearConversationBrowserBinding ───────────────────────────────────────

describe("clearConversationBrowserBinding", () => {
  it("does not throw when clearing a non-existent binding", () => {
    expect(() => clearConversationBrowserBinding("conv-nonexistent")).not.toThrow();
  });

  it("clears binding after reset", () => {
    _resetBrowserManagerForTest();
    expect(() => clearConversationBrowserBinding("conv-1")).not.toThrow();
  });
});