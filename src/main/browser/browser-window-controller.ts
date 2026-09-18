/**
 * BrowserWindowController — manages the standalone Forge Browser native window.
 *
 * Architecture:
 * - Forge has TWO native windows: Main (Chat/Projects/…) + Browser (standalone)
 * - This module owns the Browser window's BrowserWindow object
 * - BrowserManager remains canonical for all tab/session/agent state
 * - WebContentsViews are parented to _browserWindow (not to the main window)
 * - openBrowserWindow() is idempotent — repeated calls focus the existing window
 *
 * macOS: closing the Browser window does NOT quit the app (macOS standard).
 * App quit: cleanupBrowserWindowOnQuit() releases all views gracefully.
 */

import path from "path";
import type { BrowserWindow as BrowserWindowType, WebContents } from "electron";
import { BROWSER_IPC } from "../../shared/types.js";
import * as browserManager from "./browser-manager.js";

// ── Conditional Electron import (vitest runs without Electron) ──────────────

let ElectronBrowserWindow: typeof BrowserWindowType | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const electron = require("electron") as typeof import("electron");
  ElectronBrowserWindow = electron.BrowserWindow;
} catch {
  // Running in test environment
}

// ── State ────────────────────────────────────────────────────────────────────

let _browserWindow: BrowserWindowType | null = null;

/** WebContents of main Forge window — for cross-window IPC events */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _mainSender: WebContents | null = null;

/** Path to the built browser renderer entry */
let _browserRendererPath: string | null = null;

/** Dev mode URL for browser renderer */
const BROWSER_DEV_URL = "http://localhost:5174";

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Must be called once during app startup (after main window is created).
 * @param mainSender WebContents of the main Forge window
 * @param distDir    Path to the dist directory (where dist/renderer lives)
 */
export function initBrowserWindowController(
  _mainSenderParam: WebContents,
  distDir: string,
): void {
  _mainSender = _mainSenderParam;
  _browserRendererPath = path.join(distDir, "renderer", "browser-app", "browser-app.html");
}

// ── Window Lifecycle ──────────────────────────────────────────────────────────

/**
 * Open the Forge Browser window (or focus it if already open).
 * Idempotent — calling multiple times is safe.
 */
export function openBrowserWindow(): void {
  if (!ElectronBrowserWindow) return; // test environment

  if (_browserWindow && !_browserWindow.isDestroyed()) {
    // Already open — just focus it
    if (_browserWindow.isMinimized()) _browserWindow.restore();
    _browserWindow.focus();
    return;
  }

  _createBrowserWindow();
}

/** Focus the browser window if it is already open. */
export function focusBrowserWindow(): void {
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    if (_browserWindow.isMinimized()) _browserWindow.restore();
    _browserWindow.focus();
  }
}

/** Hide the browser window without destroying it. */
export function hideBrowserWindow(): void {
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    _browserWindow.hide();
  }
}

/** Show and focus the browser window if it exists. */
export function showBrowserWindow(): void {
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    _browserWindow.show();
    _browserWindow.focus();
  } else {
    openBrowserWindow();
  }
}

/** Close the browser window. Resources are released in the 'closed' handler. */
export function closeBrowserWindow(): void {
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    _browserWindow.close();
  }
}

/** Returns the current BrowserWindow reference (may be null if not open). */
export function getBrowserWindowRef(): BrowserWindowType | null {
  return _browserWindow && !_browserWindow.isDestroyed() ? _browserWindow : null;
}

/** Returns true if the standalone browser window is currently open. */
export function isBrowserWindowOpen(): boolean {
  return _browserWindow !== null && !_browserWindow.isDestroyed();
}

/**
 * Called by the agent runtime when it wants to show the browser to the user.
 * Opens/focuses the window and optionally activates a session/tab.
 */
export function requestShowStandaloneBrowser(sessionId?: string, tabId?: string): void {
  openBrowserWindow();
  // After window is open, activate the requested session/tab via BrowserManager
  if (sessionId) {
    browserManager.activateSession(sessionId);
  }
  if (tabId) {
    browserManager.activateTab(tabId);
  }
  // Push to browser renderer once it is ready (renderer will pull state on mount)
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    try {
      _browserWindow.webContents.send(BROWSER_IPC.REQUEST_SHOW_BROWSER, { sessionId, tabId });
    } catch { /* non-fatal */ }
  }
}

/** Called on app before-quit — release all views and save state. */
export async function cleanupBrowserWindowOnQuit(): Promise<void> {
  await browserManager.cleanupBrowserOnQuit();
  if (_browserWindow && !_browserWindow.isDestroyed()) {
    try { _browserWindow.close(); } catch { /* non-fatal */ }
  }
  _browserWindow = null;
}

// ── Private ───────────────────────────────────────────────────────────────────

function _createBrowserWindow(): void {
  if (!ElectronBrowserWindow) return;

  const win = new ElectronBrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d0d0f",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    title: "Forge Browser",
    webPreferences: {
      // Preload exposed to browser chrome renderer (not to web page content)
      preload: path.join(__dirname, "../../../preload/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  // Wire BrowserManager to use this window for WebContentsView parenting
  browserManager.setBrowserNativeWindow(win);

  // Notify BrowserManager's sender so it can push IPC events to browser renderer too
  browserManager.addRendererSender(win.webContents);

  // Load browser renderer
  if (process.env["NODE_ENV"] === "development") {
    void win.loadURL(BROWSER_DEV_URL);
    // Only open devtools when explicitly requested
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    if (_browserRendererPath) {
      void win.loadFile(_browserRendererPath);
    }
  }

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // macOS: closing the browser window just hides it (standard behavior)
  // On other platforms: destroying and nulling
  win.on("close", (e) => {
    if (process.platform === "darwin") {
      // On macOS, hide instead of close so persistent sessions survive
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    // Remove this window's sender from BrowserManager
    browserManager.removeRendererSender(win.webContents);
    // Tell BrowserManager the native window is gone — hide views safely
    browserManager.setBrowserNativeWindow(null);
    _browserWindow = null;
  });

  // Block navigation to external URLs in browser chrome renderer
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  _browserWindow = win;
}