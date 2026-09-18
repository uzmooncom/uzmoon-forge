/**
 * BrowserManager — main-process authority for all browser runtime state.
 *
 * Architecture:
 * - WebContentsView per tab (Electron 36, replaces deprecated BrowserView)
 * - All state is owned here; renderer is a presentation surface only
 * - No Forge preload exposed to website content
 * - Profile isolation via Electron session partitions
 * - Private sessions use in-memory (non-persistent) partitions
 */

import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import type {
  BrowserProfile,
  BrowserSession,
  BrowserTab,
  BrowserRuntimeState,
  BrowserAgentControl,
  PageSemanticSnapshot,
  PageSemanticElement,
  BrowserPendingApproval,
  BrowserDownloadItem,
  BrowserAgentBudget,
  BrowserBookmark,
  BrowserHistoryEntry,
  BrowserStatusSnapshot,
} from "../../shared/types.js";
import { BROWSER_LIMITS, BROWSER_IPC } from "../../shared/types.js";
import {
  saveBrowserProfile,
  getBrowserProfile,
  listBrowserProfiles,
  deleteBrowserProfile,
  updateBrowserProfile,
  saveBrowserSession,
  getBrowserSession,
  listBrowserSessions,
  updateBrowserSession,
  deleteBrowserSession,
  saveBrowserTab,
  getBrowserTab,
  listBrowserTabs,
  updateBrowserTab,
  deleteBrowserTab,
  deleteBrowserTabsBySession,
  saveBookmark,
  listBookmarks,
  deleteBookmark,
  updateBookmark,
  appendHistory,
  listHistory,
  clearHistory,
} from "../database/db.js";
import { assertInvariant } from "../reliability/invariants.js";
import { tryGetTraceRecorder } from "../reliability/index.js";

// ── Conditional Electron import (vitest runs without Electron) ─────────────

let electronWebContentsView: typeof import("electron").WebContentsView | undefined;
let electronSession: typeof import("electron").session | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const electron = require("electron") as typeof import("electron");
  electronWebContentsView = electron.WebContentsView;
  electronSession = electron.session;
} catch {
  // Running in test environment without Electron
}

// ── Runtime-only state (not persisted to DB) ───────────────────────────────

/** Live WebContentsView per tabId */
const _tabViews = new Map<string, import("electron").WebContentsView>();

/**
 * Active agent control tokens keyed by tabId.
 * Invariant: one interactive AgentRun per TAB, not per session.
 * Conversation A can control Tab-2 and Conversation B can control Tab-5
 * within the same browser session simultaneously.
 */
const _agentControls = new Map<string, BrowserAgentControl>();

/** Agent run budgets keyed by requestId */
const _agentBudgets = new Map<string, BrowserAgentBudget>();

/** Stable element ref maps: tabId → generation → ref → CSS selector */
const _elementRefs = new Map<string, Map<number, Map<string, string>>>();

/** Console entry buffers per tabId */
const _consoleBuffers = new Map<string, Array<{ level: string; message: string; source?: string; timestamp: number }>>();

/** Network entry buffers per tabId */
const _networkBuffers = new Map<string, Array<{ url: string; method: string; status: number; resourceType: string; timestamp: number; failureReason?: string }>>();

/** Pending approvals keyed by approval id */
const _pendingApprovals = new Map<string, {
  approval: BrowserPendingApproval;
  resolve: (approved: boolean) => void;
}>();

/** Active download items keyed by id */
const _downloads = new Map<string, BrowserDownloadItem>();

/** Revision counter for runtime state */
let _revision = 0;

/** Currently active session id */
let _activeSessionId: string | null = null;

/** Reference to the standalone Forge Browser BrowserWindow for WebContentsView parenting */
let _browserWindow: import("electron").BrowserWindow | null = null;

/** All active renderer WebContents that receive IPC push events */
const _senders = new Set<import("electron").WebContents>();

/** Currently visible tab view */
let _visibleTabId: string | null = null;

/** Data directory for screenshots */
let _dataDir: string | null = null;

/** Conversation → { sessionId, tabId } binding persisted across agent turns */
const _conversationBrowserBinding = new Map<string, { sessionId: string; tabId: string }>();

/** requestId → screenshot file paths captured during that agent run (evidence refs) */
const _screenshotEvidence = new Map<string, string[]>();

/** Whether the standalone browser window is currently open */
let _browserWindowOpen = false;

/** Injected callback to open the standalone browser window — avoids circular dep with browser-window-controller */
let _ensureWindowOpen: (() => void) | null = null;

/**
 * Register a callback that opens the standalone browser window.
 * Called by the app bootstrap (handlers.ts) so browser-manager never imports browser-window-controller.
 */
export function setEnsureWindowOpenFn(fn: () => void): void {
  _ensureWindowOpen = fn;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bumpRevision(): void {
  _revision++;
}

function pushRuntimeState(): void {
  const state = buildRuntimeState();
  for (const s of _senders) {
    if (s.isDestroyed()) continue;
    try { s.send(BROWSER_IPC.RUNTIME_STATE_PUSH, state); } catch { /* non-fatal */ }
  }
}

function pushToRenderer(channel: string, payload: unknown): void {
  for (const s of _senders) {
    if (s.isDestroyed()) continue;
    try { s.send(channel, payload); } catch { /* non-fatal */ }
  }
}

function buildRuntimeState(): BrowserRuntimeState {
  const profiles = listBrowserProfiles(true);
  const sessions = listBrowserSessions(true);
  const tabs: BrowserTab[] = [];
  for (const s of sessions) {
    tabs.push(...listBrowserTabs(true, s.id));
  }
  return {
    profiles,
    sessions,
    tabs,
    activeSessionId: _activeSessionId,
    agentControl: (() => {
      // Find agent control for the active tab (key is tabId now)
      if (!_activeSessionId) return null;
      const sess = getBrowserSession(true, _activeSessionId);
      if (!sess) return null;
      for (const tabId of sess.tabIds) {
        const ctrl = _agentControls.get(tabId);
        if (ctrl) return ctrl;
      }
      return null;
    })(),
    revision: _revision,
  };
}

/** Derive partition string from profile. */
function profilePartition(profile: BrowserProfile): string {
  return profile.partition;
}

/** Safe URL check — block unsafe schemes in agent context. */
function isSafeUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    // Allow http/https/about/data (data: for blank tabs only)
    if (["http:", "https:", "about:"].includes(u.protocol)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Normalize a raw user input to a navigable URL or search URL. */
export function normalizeNavigationInput(input: string, searchEngine = "https://www.google.com/search?q="): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  // Already has a scheme
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Looks like a hostname (contains a dot, no spaces)
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+/i.test(trimmed) && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  // Treat as search query
  return searchEngine + encodeURIComponent(trimmed);
}

/** Emit a browser trace event (best-effort, non-throwing). */
function emitTrace(
  kind: import("../../shared/types.js").TraceEvent["kind"],
  requestId: string,
  meta: Record<string, unknown>,
): void {
  try {
    const tr = tryGetTraceRecorder();
    if (tr) tr.emit(requestId, kind, meta);
  } catch { /* non-fatal */ }
}

// ── Init / Cleanup ─────────────────────────────────────────────────────────

export function initBrowserManager(
  sender: import("electron").WebContents,
  dataDir: string,
): void {
  _senders.add(sender);
  _dataDir = dataDir;

  // Ensure screenshot dir exists
  try {
    fs.mkdirSync(path.join(dataDir, "browser-screenshots"), { recursive: true });
  } catch { /* non-fatal */ }
}

/**
 * Set (or clear) the native BrowserWindow that hosts WebContentsViews.
 * Called by browser-window-controller when the standalone window opens/closes.
 */
export function setBrowserNativeWindow(
  win: import("electron").BrowserWindow | null,
): void {
  _browserWindow = win;
  _browserWindowOpen = win !== null;

  if (win === null) {
    // Window closed: destroy all WebContentsViews so they don't hold stale refs.
    // Active agent controls referencing destroyed views will fail gracefully on
    // next tool call — this is correct; the agent must request access again.
    for (const [tabId, view] of _tabViews) {
      try {
        if (!view.webContents.isDestroyed()) {
          view.webContents.stop();
        }
      } catch { /* non-fatal — view may already be destroyed */ }
      _tabViews.delete(tabId);
    }
    // Clear agent controls so the next request goes through approval again
    _agentControls.clear();
    _conversationBrowserBinding.clear();
  } else if (electronWebContentsView) {
    // When the native window becomes available, hydrate any tabs that were created
    // before the window existed (i.e. no WebContentsView yet).
    void _hydrateOrphanedTabs(win);
  }
}

/**
 * V17: Check whether the browser window is healthy (not destroyed, not stale).
 * Single source of truth — avoids _browserWindow/_browserWindowOpen desync.
 */
export function isBrowserWindowHealthy(): boolean {
  if (!_browserWindow) return false;
  // If the object doesn't have isDestroyed (e.g. stubs/tests), treat as healthy
  if (typeof (_browserWindow as { isDestroyed?: unknown }).isDestroyed !== "function") return true;
  try {
    if (_browserWindow.isDestroyed()) {
      // Reconcile: window was destroyed externally without us being notified
      _browserWindow = null;
      _browserWindowOpen = false;
      return false;
    }
    if (_browserWindow.webContents?.isDestroyed?.()) {
      _browserWindow = null;
      _browserWindowOpen = false;
      return false;
    }
    return true;
  } catch {
    _browserWindow = null;
    _browserWindowOpen = false;
    return false;
  }
}

/**
 * Create WebContentsViews for any tabs that exist in DB but have no live view.
 * Happens when bootstrapAgentControl creates a session/tab before the browser window opens.
 */
async function _hydrateOrphanedTabs(win: import("electron").BrowserWindow): Promise<void> {
  if (!electronWebContentsView) return;
  const sessions = listBrowserSessions(true);
  for (const session of sessions) {
    if (session.lifecycle !== "active") continue;
    const profile = getBrowserProfile(true, session.profileId);
    if (!profile) continue;
    const partition = profilePartition(profile);
    for (const tabId of session.tabIds) {
      if (_tabViews.has(tabId)) continue; // already has a view
      const tab = getBrowserTab(true, tabId);
      if (!tab) continue;

      try {
        const wc = new electronWebContentsView({
          webPreferences: {
            partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
        win.contentView.addChildView(wc);
        _tabViews.set(tabId, wc);
        _wireTabEvents(tabId, wc);
        wc.setVisible(false);

        // Navigate to the tab's URL if it's not about:blank
        if (tab.url && tab.url !== "about:blank") {
          await wc.webContents.loadURL(tab.url).catch(() => { /* non-fatal */ });
        }
      } catch {
        // Non-fatal: if hydration fails for a tab, agent will get an error
        // on first use and can retry
      }
    }
  }
}

/**
 * Add a renderer WebContents that should receive all browser IPC push events.
 * Called by browser-window-controller when the standalone window opens.
 */
export function addRendererSender(sender: import("electron").WebContents): void {
  _senders.add(sender);
}

/**
 * Remove a renderer WebContents (e.g. when the standalone window is closed).
 */
export function removeRendererSender(sender: import("electron").WebContents): void {
  _senders.delete(sender);
}

/** Called on startup to reconcile DB state with runtime. */
export function reconcileBrowserOnStartup(): void {
  // Mark any "active" sessions from a prior crash as "suspended"
  const sessions = listBrowserSessions(true);
  for (const s of sessions) {
    if (s.lifecycle === "active") {
      updateBrowserSession(true, s.id, { lifecycle: "suspended" });
    }
  }
  // Private sessions are deleted on restart — they had no persistence intent
  for (const s of sessions) {
    const profile = getBrowserProfile(true, s.profileId);
    if (profile?.persistenceMode === "private") {
      deleteBrowserTabsBySession(true, s.id);
      deleteBrowserSession(true, s.id);
    }
  }
}

/** Called before app quit — release all views and clean up private partitions. */
export async function cleanupBrowserOnQuit(): Promise<void> {
  // Save restore state for persistent sessions
  for (const [tabId] of _tabViews) {
    const tab = getBrowserTab(true, tabId);
    if (tab) {
      const session = getBrowserSession(true, tab.sessionId);
      if (session) {
        const profile = getBrowserProfile(true, session.profileId);
        if (profile?.persistenceMode === "persistent") {
          // Persist final tab URLs for restore
          _saveRestoreState(session.id);
        }
      }
    }
    _releaseTabView(tabId);
  }
  _tabViews.clear();
  _agentControls.clear();
  _agentBudgets.clear();
  _elementRefs.clear();
  _consoleBuffers.clear();
  _networkBuffers.clear();
  _pendingApprovals.clear();

  // Clean up private partitions
  if (electronSession) {
    const sessions = listBrowserSessions(true);
    for (const s of sessions) {
      const profile = getBrowserProfile(true, s.profileId);
      if (profile?.persistenceMode === "private") {
        try {
          const partition = profilePartition(profile);
          const sess = electronSession.fromPartition(partition);
          await sess.clearStorageData();
        } catch { /* non-fatal */ }
        deleteBrowserTabsBySession(true, s.id);
        deleteBrowserSession(true, s.id);
      }
    }
  }
}

/** Test reset — only for unit tests. */
export function _resetBrowserManagerForTest(): void {
  for (const [tabId] of _tabViews) {
    _releaseTabView(tabId);
  }
  _tabViews.clear();
  _agentControls.clear();
  _agentBudgets.clear();
  _elementRefs.clear();
  _consoleBuffers.clear();
  _networkBuffers.clear();
  _pendingApprovals.clear();
  _downloads.clear();
  _activeSessionId = null;
  _browserWindow = null;
  _senders.clear();
  _dataDir = null;
  _visibleTabId = null;
  _revision = 0;
  _conversationBrowserBinding.clear();
  _browserWindowOpen = false;
}

// ── Profile Management ─────────────────────────────────────────────────────

export function createBrowserProfile(opts: {
  name: string;
  persistenceMode: "persistent" | "private";
  agentAccessPolicy?: "off" | "ask" | "allowed";
}): BrowserProfile {
  const id = randomUUID();
  const partition = opts.persistenceMode === "persistent"
    ? `persist:forge-browser-${id}`
    : `forge-browser-private-${id}`;

  const profile: BrowserProfile = {
    id,
    name: opts.name,
    persistenceMode: opts.persistenceMode,
    agentAccessPolicy: opts.agentAccessPolicy ?? "ask",
    partition,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveBrowserProfile(true, profile);
  bumpRevision();
  pushRuntimeState();
  return profile;
}

export function listBrowserProfilesPublic(): BrowserProfile[] {
  return listBrowserProfiles(true);
}

export function updateBrowserProfilePublic(
  id: string,
  patch: Partial<Pick<BrowserProfile, "name" | "agentAccessPolicy" | "isDefault">>,
): BrowserProfile | null {
  const updated = updateBrowserProfile(true, id, patch);
  if (updated) {
    bumpRevision();
    pushRuntimeState();
  }
  return updated;
}

export async function deleteBrowserProfilePublic(id: string): Promise<void> {
  const profile = getBrowserProfile(true, id);
  if (!profile) return;

  // Close all sessions for this profile first
  const sessions = listBrowserSessions(true, id);
  for (const s of sessions) {
    await closeBrowserSession(s.id);
  }

  // Clear Chromium partition data for persistent profiles
  if (electronSession && profile.persistenceMode === "persistent") {
    try {
      const sess = electronSession.fromPartition(profile.partition);
      await sess.clearStorageData();
    } catch { /* non-fatal */ }
  }

  deleteBrowserProfile(true, id);
  bumpRevision();
  pushRuntimeState();
}

// ── Session Management ─────────────────────────────────────────────────────

export async function createBrowserSession(
  profileId: string,
  opts?: { name?: string },
): Promise<BrowserSession> {
  const profile = getBrowserProfile(true, profileId);
  if (!profile) {
    throw new Error(`BROWSER_PROFILE_NOT_FOUND: ${profileId}`);
  }

  assertInvariant(
    "BROWSER_PROFILE_ISOLATION",
    true,
    { profileId },
  );

  const id = randomUUID();
  const now = Date.now();
  const session: BrowserSession = {
    id,
    profileId,
    ...(opts?.name !== undefined && { name: opts.name }),
    lifecycle: "active",
    activeTabId: null,
    tabIds: [],
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  saveBrowserSession(true, session);

  // Update profile lastUsedAt
  updateBrowserProfile(true, profileId, { lastUsedAt: now });

  // Open a blank tab
  const tab = await _createTabInternal(id, profileId, "about:blank");
  updateBrowserSession(true, id, { activeTabId: tab.id, tabIds: [tab.id] });

  bumpRevision();
  pushToRenderer(BROWSER_IPC.SESSION_UPDATED, getBrowserSession(true, id));
  emitTrace("BROWSER_SESSION_CREATED", randomUUID(), { sessionId: id, profileId });
  pushRuntimeState();

  return getBrowserSession(true, id)!;
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  const session = getBrowserSession(true, sessionId);
  if (!session) return;

  const profile = getBrowserProfile(true, session.profileId);

  // Save restore state for persistent sessions
  if (profile?.persistenceMode === "persistent") {
    _saveRestoreState(sessionId);
  }

  // Revoke any agent control (tab-scoped — delete all tabs for this session)
  for (const tabId of session.tabIds) {
    const ctrl = _agentControls.get(tabId);
    if (ctrl) {
      _agentBudgets.delete(ctrl.requestId);
      _screenshotEvidence.delete(ctrl.requestId);
      _agentControls.delete(tabId);
    }
  }

  // Release all tab views
  for (const tabId of session.tabIds) {
    _releaseTabView(tabId);
    deleteBrowserTab(true, tabId);
  }

  // Clean up private partition
  if (profile?.persistenceMode === "private" && electronSession) {
    try {
      const sess = electronSession.fromPartition(profile.partition);
      await sess.clearStorageData();
    } catch { /* non-fatal */ }

    assertInvariant(
      "BROWSER_PRIVATE_NOT_PERSISTED",
      getBrowserSession(true, sessionId)?.lifecycle === "active",
      { sessionId },
    );
  }

  updateBrowserSession(true, sessionId, { lifecycle: "closed" });
  deleteBrowserTabsBySession(true, sessionId);
  deleteBrowserSession(true, sessionId);

  if (_activeSessionId === sessionId) {
    _activeSessionId = null;
  }

  bumpRevision();
  emitTrace("BROWSER_SESSION_CLOSED", randomUUID(), { sessionId });
  pushRuntimeState();
}

export function activateSession(sessionId: string): void {
  const session = getBrowserSession(true, sessionId);
  if (!session) return;

  _activeSessionId = sessionId;
  const activeTab = session.activeTabId;
  if (activeTab) {
    _showTabView(activeTab);
  }
  bumpRevision();
  pushRuntimeState();
}

// ── Tab Management ─────────────────────────────────────────────────────────

async function _createTabInternal(
  sessionId: string,
  profileId: string,
  url: string,
): Promise<BrowserTab> {
  const id = randomUUID();
  const now = Date.now();
  const tab: BrowserTab = {
    id,
    sessionId,
    profileId,
    url,
    title: url === "about:blank" ? "New Tab" : url,
    loadState: "idle",
    canGoBack: false,
    canGoForward: false,
    navigationGeneration: 0,
    createdAt: now,
    updatedAt: now,
  };
  saveBrowserTab(true, tab);

  // Create WebContentsView if in Electron environment
  if (electronWebContentsView && _browserWindow) {
    const profile = getBrowserProfile(true, profileId);
    const partition = profile ? profilePartition(profile) : `persist:forge-browser-${profileId}`;

    const wc = new electronWebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Forge preload is NOT exposed to web content
      },
    });

    _browserWindow.contentView.addChildView(wc);
    _tabViews.set(id, wc);

    // Wire events
    _wireTabEvents(id, wc);

    // Hide initially — showView positions and reveals
    wc.setVisible(false);

    // Navigate if not blank
    if (url !== "about:blank") {
      await wc.webContents.loadURL(url).catch(() => {
        updateBrowserTab(true, id, { loadState: "idle" });
      });
    }
  }

  emitTrace("BROWSER_TAB_CREATED", randomUUID(), { tabId: id, sessionId, url });
  return tab;
}

function _wireTabEvents(tabId: string, view: import("electron").WebContentsView): void {
  const wc = view.webContents;

  wc.on("did-start-loading", () => {
    updateBrowserTab(true, tabId, { loadState: "loading" });
    pushToRenderer(BROWSER_IPC.TAB_UPDATED, getBrowserTab(true, tabId));
    emitTrace("BROWSER_NAVIGATION_STARTED", randomUUID(), { tabId, url: wc.getURL() });
  });

  wc.on("did-finish-load", () => {
    const url = wc.getURL();
    const title = wc.getTitle() || url;
    const navGen = (getBrowserTab(true, tabId)?.navigationGeneration ?? 0) + 1;
    updateBrowserTab(true, tabId, {
      url,
      title,
      loadState: "loaded",
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      navigationGeneration: navGen,
    });
    // Invalidate element refs on navigation
    _elementRefs.delete(tabId);
    pushToRenderer(BROWSER_IPC.TAB_UPDATED, getBrowserTab(true, tabId));
    emitTrace("BROWSER_NAVIGATION_COMPLETED", randomUUID(), { tabId, url, title });
    // Record navigation in history (skips private profiles and internal URLs)
    const tabForHistory = getBrowserTab(true, tabId);
    if (tabForHistory) {
      const sessionForHistory = getBrowserSession(true, tabForHistory.sessionId);
      if (sessionForHistory) {
        recordNavigation(sessionForHistory.profileId, url, title);
      }
    }
    // Install dialog interceptors so window.alert/confirm/prompt are interceptable
    installDialogInterceptor(tabId).catch(() => { /* non-fatal */ });
  });

  wc.on("did-fail-load", (_ev, code, desc, validatedUrl) => {
    updateBrowserTab(true, tabId, { loadState: "idle", url: validatedUrl || wc.getURL() });
    pushToRenderer(BROWSER_IPC.TAB_UPDATED, getBrowserTab(true, tabId));
  });

  wc.on("page-title-updated", (_ev, title) => {
    updateBrowserTab(true, tabId, { title });
    pushToRenderer(BROWSER_IPC.TAB_UPDATED, getBrowserTab(true, tabId));
  });

  wc.on("render-process-gone", () => {
    updateBrowserTab(true, tabId, { loadState: "crashed" });
    _elementRefs.delete(tabId);
    // Release agent control if this tab was controlled (O(1) now that key is tabId)
    if (_agentControls.has(tabId)) {
      const ctrl = _agentControls.get(tabId)!;
      _agentBudgets.delete(ctrl.requestId);
      _screenshotEvidence.delete(ctrl.requestId);
      _agentControls.delete(tabId);
      pushToRenderer(BROWSER_IPC.AGENT_CONTROL_CHANGED, null);
    }
    assertInvariant("BROWSER_CRASH_RELEASED", true, { tabId });
    pushToRenderer(BROWSER_IPC.TAB_UPDATED, getBrowserTab(true, tabId));
    emitTrace("BROWSER_CRASHED", randomUUID(), { tabId });
  });

  wc.on("console-message", (_ev, level, message, _line, sourceId) => {
    const levelNames = ["verbose", "info", "warning", "error"];
    const levelName = levelNames[level] ?? "log";
    const buf = _consoleBuffers.get(tabId) ?? [];
    buf.push({ level: levelName, message: message.slice(0, 1024), source: sourceId, timestamp: Date.now() });
    // Keep last MAX_CONSOLE_ENTRIES entries
    if (buf.length > BROWSER_LIMITS.MAX_CONSOLE_ENTRIES * 2) {
      buf.splice(0, buf.length - BROWSER_LIMITS.MAX_CONSOLE_ENTRIES);
    }
    _consoleBuffers.set(tabId, buf);
  });

  // Block new-window from arbitrary website content
  wc.setWindowOpenHandler(({ url }) => {
    // Open target=_blank as a new Forge browser tab (handled asynchronously)
    const tab = getBrowserTab(true, tabId);
    if (tab) {
      void newBrowserTab(tab.sessionId, url).catch(() => {/* non-fatal */});
    }
    return { action: "deny" };
  });

  // Track network requests for bounded summary
  wc.session.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
    const buf = _networkBuffers.get(tabId) ?? [];
    buf.push({
      url: details.url,
      method: details.method,
      status: details.statusCode,
      resourceType: details.resourceType,
      timestamp: Date.now(),
    });
    if (buf.length > BROWSER_LIMITS.MAX_NETWORK_ENTRIES * 2) {
      buf.splice(0, buf.length - BROWSER_LIMITS.MAX_NETWORK_ENTRIES);
    }
    _networkBuffers.set(tabId, buf);
  });
}

export async function newBrowserTab(sessionId: string, url?: string): Promise<BrowserTab> {
  const session = getBrowserSession(true, sessionId);
  if (!session) throw new Error(`BROWSER_SESSION_NOT_FOUND: ${sessionId}`);

  if (session.tabIds.length >= BROWSER_LIMITS.MAX_TABS_PER_SESSION) {
    throw new Error("BROWSER_CONTENT_TOO_LARGE: tab limit reached");
  }

  const resolvedUrl = url ? normalizeNavigationInput(url) : "about:blank";
  const tab = await _createTabInternal(sessionId, session.profileId, resolvedUrl);

  const newTabIds = [...session.tabIds, tab.id];
  updateBrowserSession(true, sessionId, { activeTabId: tab.id, tabIds: newTabIds });

  if (_activeSessionId === sessionId) {
    _showTabView(tab.id);
  }

  bumpRevision();
  pushToRenderer(BROWSER_IPC.TAB_UPDATED, tab);
  pushRuntimeState();
  return tab;
}

export function closeBrowserTab(tabId: string): void {
  const tab = getBrowserTab(true, tabId);
  if (!tab) return;

  // Revoke agent control if this was the controlled tab (O(1) since key is tabId)
  if (_agentControls.has(tabId)) {
    const ctrl = _agentControls.get(tabId)!;
    _agentBudgets.delete(ctrl.requestId);
    _screenshotEvidence.delete(ctrl.requestId);
    _agentControls.delete(tabId);
    pushToRenderer(BROWSER_IPC.AGENT_CONTROL_CHANGED, null);
  }

  _releaseTabView(tabId);
  deleteBrowserTab(true, tabId);

  const session = getBrowserSession(true, tab.sessionId);
  if (session) {
    const newTabIds = session.tabIds.filter((id) => id !== tabId);
    const newActiveTabId = session.activeTabId === tabId
      ? (newTabIds[newTabIds.length - 1] ?? null)
      : session.activeTabId;
    updateBrowserSession(true, tab.sessionId, { activeTabId: newActiveTabId, tabIds: newTabIds });
    if (newActiveTabId && _activeSessionId === tab.sessionId) {
      _showTabView(newActiveTabId);
    }
  }

  bumpRevision();
  pushRuntimeState();
}

export function activateTab(tabId: string): void {
  const tab = getBrowserTab(true, tabId);
  if (!tab) return;
  updateBrowserSession(true, tab.sessionId, { activeTabId: tabId });
  if (_activeSessionId === tab.sessionId) {
    _showTabView(tabId);
  }
  bumpRevision();
  pushRuntimeState();
}

// ── Navigation ─────────────────────────────────────────────────────────────

export async function navigateTab(tabId: string, rawUrl: string): Promise<void> {
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  const url = normalizeNavigationInput(rawUrl);
  await view.webContents.loadURL(url).catch((_err) => {
    // did-fail-load event will handle state update
  });
}

export function navigateBack(tabId: string): void {
  const view = _tabViews.get(tabId);
  if (!view) return;
  if (view.webContents.canGoBack()) view.webContents.goBack();
}

export function navigateForward(tabId: string): void {
  const view = _tabViews.get(tabId);
  if (!view) return;
  if (view.webContents.canGoForward()) view.webContents.goForward();
}

export function reloadTab(tabId: string): void {
  const view = _tabViews.get(tabId);
  if (!view) return;
  view.webContents.reload();
}

export function stopTab(tabId: string): void {
  const view = _tabViews.get(tabId);
  if (!view) return;
  view.webContents.stop();
}

// ── View Positioning ───────────────────────────────────────────────────────

export function setBrowserViewBounds(rect: { x: number; y: number; width: number; height: number }): void {
  if (!_visibleTabId) return;
  const view = _tabViews.get(_visibleTabId);
  if (!view) return;
  try {
    view.setBounds(rect);
  } catch { /* non-fatal */ }
}

export function hideBrowserView(): void {
  if (!_visibleTabId) return;
  const view = _tabViews.get(_visibleTabId);
  if (view) {
    try { view.setVisible(false); } catch { /* non-fatal */ }
  }
}

export function showBrowserView(tabId?: string): void {
  const targetTabId = tabId ?? _visibleTabId;
  if (!targetTabId) return;
  const view = _tabViews.get(targetTabId);
  if (view) {
    try { view.setVisible(true); } catch { /* non-fatal */ }
    _visibleTabId = targetTabId;
  }
}

function _showTabView(tabId: string): void {
  // Hide currently visible view
  if (_visibleTabId && _visibleTabId !== tabId) {
    const prev = _tabViews.get(_visibleTabId);
    if (prev) try { prev.setVisible(false); } catch { /* non-fatal */ }
  }
  const view = _tabViews.get(tabId);
  if (view) {
    try { view.setVisible(true); } catch { /* non-fatal */ }
    _visibleTabId = tabId;
  }
}

function _releaseTabView(tabId: string): void {
  const view = _tabViews.get(tabId);
  if (!view) return;
  try {
    view.webContents.stop();
    _browserWindow?.contentView.removeChildView(view);
  } catch { /* non-fatal */ }
  _tabViews.delete(tabId);
  _elementRefs.delete(tabId);
  _consoleBuffers.delete(tabId);
  _networkBuffers.delete(tabId);
  if (_visibleTabId === tabId) _visibleTabId = null;
}

// ── Session Restore ────────────────────────────────────────────────────────

function _saveRestoreState(sessionId: string): void {
  const session = getBrowserSession(true, sessionId);
  if (!session) return;
  const tabs = listBrowserTabs(true, sessionId);
  const tabSnaps = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }));
  updateBrowserSession(true, sessionId, {
    restoreState: {
      tabs: tabSnaps,
      activeTabId: session.activeTabId,
      savedAt: Date.now(),
    },
  });
}

// ── Agent Access Control ───────────────────────────────────────────────────

export function grantAgentControl(control: BrowserAgentControl): void {
  const session = getBrowserSession(true, control.sessionId);
  if (!session) throw new Error(`BROWSER_SESSION_NOT_FOUND: ${control.sessionId}`);

  const profile = getBrowserProfile(true, session.profileId);
  assertInvariant(
    "BROWSER_AGENT_CONTROL_EXPLICIT",
    !!profile && profile.agentAccessPolicy !== "off",
    { sessionId: control.sessionId, profileId: session.profileId },
  );

  // Key by tabId — one AgentRun per tab, not per session
  _agentControls.set(control.tabId, control);
  _agentBudgets.set(control.requestId, {
    actionsUsed: 0,
    navigationsUsed: 0,
    screenshotsUsed: 0,
    readBytesUsed: 0,
  });

  pushToRenderer(BROWSER_IPC.AGENT_CONTROL_CHANGED, control);
  emitTrace("BROWSER_AGENT_CONTROL_STARTED", control.requestId, {
    sessionId: control.sessionId,
    tabId: control.tabId,
    conversationId: control.conversationId,
  });
}

/**
 * Release agent interactive control for a specific tab.
 * Does NOT clear _conversationBrowserBinding — the conversation context persists.
 */
export function revokeAgentControl(sessionId: string): void {
  // Find the ctrl by sessionId (for backward compat with callers that pass sessionId)
  // Since the new key is tabId, iterate to find by sessionId
  let tabIdToDelete: string | undefined;
  for (const [tabId, ctrl] of _agentControls) {
    if (ctrl.sessionId === sessionId) {
      tabIdToDelete = tabId;
      _agentBudgets.delete(ctrl.requestId);
      _screenshotEvidence.delete(ctrl.requestId);
      break;
    }
  }
  if (tabIdToDelete) _agentControls.delete(tabIdToDelete);
  pushToRenderer(BROWSER_IPC.AGENT_CONTROL_CHANGED, null);
}

/**
 * Release agent interactive control for a specific tab by tabId (preferred — O(1)).
 * Does NOT clear _conversationBrowserBinding.
 */
export function releaseAgentInteractiveControl(tabId: string): void {
  const ctrl = _agentControls.get(tabId);
  if (ctrl) {
    _agentBudgets.delete(ctrl.requestId);
    _screenshotEvidence.delete(ctrl.requestId);
    _agentControls.delete(tabId);
  }
  pushToRenderer(BROWSER_IPC.AGENT_CONTROL_CHANGED, null);
}

export function userTakeControl(sessionId: string): void {
  revokeAgentControl(sessionId);
}

/** Validate an agent control token — throws on mismatch. */
/**
 * Look up an active agent control by requestId.
 * Used by the tool executor to retrieve the ctrl token for a browser tool call.
 */
export function getAgentControlByRequestId(requestId: string): BrowserAgentControl | null {
  for (const ctrl of _agentControls.values()) {
    if (ctrl.requestId === requestId) return ctrl;
  }
  return null;
}

/**
 * Push a REQUEST_SHOW_BROWSER event to the renderer — asks the UI to switch to
 * the Browser workspace and (optionally) activate a specific session/tab.
 * Non-throwing: if sender is unavailable the event is silently dropped.
 */
export function requestShowBrowser(sessionId?: string, tabId?: string): void {
  // Push to all connected renderers (main window + browser window)
  pushToRenderer(BROWSER_IPC.REQUEST_SHOW_BROWSER, { sessionId, tabId });
}

/**
 * Ensure a default persistent profile + session + tab exists.
 * Creates them if needed and returns the active (or first) session.
 * Safe to call multiple times — idempotent.
 */
export async function ensureDefaultSession(): Promise<{ session: BrowserSession; tabId: string }> {
  const state = getBrowserRuntimeState();
  const activeSessions = state.sessions.filter((s) => s.lifecycle === "active");
  if (activeSessions.length > 0) {
    const preferred = _activeSessionId
      ? activeSessions.find((s) => s.id === _activeSessionId) ?? activeSessions[0]!
      : activeSessions[0]!;
    const tabId = preferred.activeTabId ?? preferred.tabIds[0];
    if (!tabId) throw new Error("BROWSER_SESSION_HAS_NO_TABS");
    return { session: preferred, tabId };
  }

  // Find or create default persistent profile
  const profiles = listBrowserProfilesPublic();
  let defaultProfile = profiles.find((p) => p.isDefault) ?? profiles.find((p) => p.persistenceMode === "persistent");
  if (!defaultProfile) {
    defaultProfile = createBrowserProfile({
      name: "Default",
      persistenceMode: "persistent",
      agentAccessPolicy: "ask",
    });
  } else if (defaultProfile.agentAccessPolicy === "off") {
    updateBrowserProfilePublic(defaultProfile.id, { agentAccessPolicy: "ask" });
    defaultProfile = getBrowserProfile(true, defaultProfile.id)!;
  }

  const session = await createBrowserSession(defaultProfile.id, { name: "Session 1" });
  const tabId = session.activeTabId ?? session.tabIds[0];
  if (!tabId) throw new Error("BROWSER_SESSION_HAS_NO_TABS");
  return { session, tabId };
}

export type BootstrapResult =
  | { ok: true; sessionId: string; tabId: string; policyDecision: "allowed" | "approved" }
  | { ok: false; reason: "policy_off" | "policy_rejected" | "session_error" | "no_profile"; message: string };

/**
 * Bootstrap agent control for a request.
 * Resolves the target session (preferred or best available, creating if needed),
 * checks the profile's agentAccessPolicy, and establishes BrowserAgentControl.
 */
export async function bootstrapAgentControl(opts: {
  requestId: string;
  conversationId: string;
  agentRunId: string;
  sessionId?: string;
  tabId?: string;
  purpose?: string;
}): Promise<BootstrapResult> {
  try {
    // 0. Ensure the browser window is open so WebContentsViews can be created
    //    for any tabs we create below. This must happen before ensureDefaultSession()
    //    to avoid tabs being created with no WebContentsView (they'd be DB-only).
    if (!_browserWindow && _ensureWindowOpen) {
      _ensureWindowOpen();
    }

    // 1. Resolve or create session
    let session: BrowserSession;
    let resolvedTabId: string;

    if (opts.sessionId) {
      const s = getBrowserSession(true, opts.sessionId);
      if (!s || s.lifecycle !== "active") {
        return { ok: false, reason: "session_error", message: `Session not found or inactive: ${opts.sessionId}` };
      }
      session = s;
      resolvedTabId = opts.tabId ?? s.activeTabId ?? s.tabIds[0] ?? "";
    } else {
      const result = await ensureDefaultSession();
      session = result.session;
      resolvedTabId = opts.tabId ?? result.tabId;
    }

    if (!resolvedTabId) {
      return { ok: false, reason: "session_error", message: "Session has no available tabs" };
    }

    // 2. Check policy
    const profile = getBrowserProfile(true, session.profileId);
    if (!profile) {
      return { ok: false, reason: "no_profile", message: `Profile not found for session: ${session.profileId}` };
    }

    if (profile.agentAccessPolicy === "off") {
      return {
        ok: false,
        reason: "policy_off",
        message:
          "Browser agent access is disabled for this profile. " +
          "The user can enable it in Browser Settings.",
      };
    }

    // 3. For "ask" policy, wait for user approval
    if (profile.agentAccessPolicy === "ask") {
      const approvalId = randomUUID();
      const approved = await requestApproval({
        id: approvalId,
        sessionId: session.id,
        tabId: resolvedTabId,
        url: "about:blank",
        action: "agent_control",
        risk: "INTERACTION",
        agentPurpose: opts.purpose ?? "Agent wants to control the browser",
        requestedAt: Date.now(),
      });
      if (!approved) {
        return { ok: false, reason: "policy_rejected", message: "User rejected browser agent access." };
      }
    }

    // 4. Activate session + show browser UI
    activateSession(session.id);
    if (session.tabIds.includes(resolvedTabId)) {
      activateTab(resolvedTabId);
    }
    requestShowBrowser(session.id, resolvedTabId);

    // 5. Establish agent control
    const control: BrowserAgentControl = {
      sessionId: session.id,
      tabId: resolvedTabId,
      conversationId: opts.conversationId,
      requestId: opts.requestId,
      agentRunId: opts.agentRunId,
      startedAt: Date.now(),
    };
    grantAgentControl(control);

    return {
      ok: true,
      sessionId: session.id,
      tabId: resolvedTabId,
      policyDecision: profile.agentAccessPolicy === "allowed" ? "allowed" : "approved",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "session_error", message: msg };
  }
}


export function validateAgentControl(
  sessionId: string,
  requestId: string,
  tabId: string,
): BrowserAgentControl {
  const ctrl = _agentControls.get(sessionId);
  assertInvariant(
    "BROWSER_AGENT_OWNERSHIP",
    !!ctrl && ctrl.requestId === requestId && ctrl.tabId === tabId,
    { sessionId, requestId, tabId, hasControl: !!ctrl },
  );
  if (!ctrl || ctrl.requestId !== requestId || ctrl.tabId !== tabId) {
    throw new Error("BROWSER_ACCESS_DENIED: agent control token mismatch");
  }
  return ctrl;
}

function _getBudget(requestId: string): BrowserAgentBudget {
  return _agentBudgets.get(requestId) ?? { actionsUsed: 0, navigationsUsed: 0, screenshotsUsed: 0, readBytesUsed: 0 };
}

function _checkActionBudget(requestId: string, kind: "action" | "navigation" | "screenshot"): void {
  const b = _getBudget(requestId);
  if (kind === "navigation" && b.navigationsUsed >= BROWSER_LIMITS.MAX_NAVIGATIONS_PER_REQUEST) {
    assertInvariant("BROWSER_AGENT_ACTION_BOUNDED", false, { requestId, kind, used: b.navigationsUsed });
    throw new Error("BROWSER_ACTION_BUDGET_EXCEEDED: navigation limit reached");
  }
  if (kind === "screenshot" && b.screenshotsUsed >= BROWSER_LIMITS.MAX_SCREENSHOTS_PER_REQUEST) {
    assertInvariant("BROWSER_AGENT_ACTION_BOUNDED", false, { requestId, kind, used: b.screenshotsUsed });
    throw new Error("BROWSER_ACTION_BUDGET_EXCEEDED: screenshot limit reached");
  }
  if (b.actionsUsed >= BROWSER_LIMITS.MAX_ACTIONS_PER_REQUEST) {
    assertInvariant("BROWSER_AGENT_ACTION_BOUNDED", false, { requestId, kind, used: b.actionsUsed });
    throw new Error("BROWSER_ACTION_BUDGET_EXCEEDED: action limit reached");
  }
}

function _incrementBudget(requestId: string, kind: "action" | "navigation" | "screenshot"): void {
  const b = _getBudget(requestId);
  b.actionsUsed++;
  if (kind === "navigation") b.navigationsUsed++;
  if (kind === "screenshot") b.screenshotsUsed++;
  _agentBudgets.set(requestId, b);
}

// ── Approval Queue ─────────────────────────────────────────────────────────

export function requestApproval(approval: BrowserPendingApproval): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    _pendingApprovals.set(approval.id, { approval, resolve });
    pushToRenderer(BROWSER_IPC.APPROVAL_REQUESTED, approval);
    emitTrace("BROWSER_APPROVAL_REQUESTED", randomUUID(), {
      approvalId: approval.id,
      action: approval.action,
      risk: approval.risk,
      url: approval.url,
    });
  });
}

export function resolveApproval(approvalId: string, approved: boolean): void {
  const entry = _pendingApprovals.get(approvalId);
  if (!entry) return;
  _pendingApprovals.delete(approvalId);
  entry.resolve(approved);
}

/**
 * Cancel all pending approvals associated with a requestId.
 * Called when a run is stopped so approval modals are dismissed immediately.
 */
export function cancelApprovalsForRequest(requestId: string): void {
  for (const [approvalId, entry] of _pendingApprovals) {
    // BrowserPendingApproval may carry requestId via agentRunId field
    // (set during bootstrapAgentControl). Check both fields.
    const aid = (entry.approval as { requestId?: string; agentRunId?: string });
    if (aid.requestId === requestId || aid.agentRunId === requestId) {
      _pendingApprovals.delete(approvalId);
      // Deny the approval — run is being stopped
      entry.resolve(false);
      pushToRenderer(BROWSER_IPC.APPROVAL_REQUESTED, {
        ...entry.approval,
        _cancelled: true,
      });
    }
  }
}

// ── Agent Tool Operations ──────────────────────────────────────────────────

export async function agentOpenUrl(
  ctrl: BrowserAgentControl,
  tabId: string,
  url: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId === tabId ? tabId : ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "navigation");

  assertInvariant(
    "BROWSER_PAGE_UNTRUSTED",
    true,
    { url, note: "agent opening URL — page content is untrusted" },
  );

  if (!isSafeUrl(url)) {
    assertInvariant("BROWSER_UNSAFE_URL", false, { url });
    throw new Error(`BROWSER_UNSAFE_URL: ${url}`);
  }

  _incrementBudget(ctrl.requestId, "navigation");
  await navigateTab(tabId, url);
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "open_url", tabId, url });
}

/**
 * Returns true if the tab's WebContents is currently loading (navigating).
 * Used by browser_wait_for 'navigation_settled' condition.
 */
export function isTabLoading(tabId: string): boolean {
  const view = _tabViews.get(tabId);
  if (!view) return false;
  try {
    return view.webContents.isLoading();
  } catch {
    return false;
  }
}

/** Extract a bounded semantic snapshot of the page for agent consumption. */
export async function agentReadPage(
  ctrl: BrowserAgentControl,
  tabId: string,
): Promise<PageSemanticSnapshot> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _checkElementRefCurrent(tabId, tab.navigationGeneration);

  _incrementBudget(ctrl.requestId, "action");

  // Execute bounded accessibility extraction in page context
  // This is Forge-internal instrumentation — not exposed as a model tool
  let snapshot: PageSemanticSnapshot;
  try {
    const rawResult = await view.webContents.executeJavaScript(`
      (function() {
        const MAX_TEXT = ${BROWSER_LIMITS.MAX_PAGE_TEXT_BYTES};
        const MAX_ELEMENTS = ${BROWSER_LIMITS.MAX_ELEMENTS_PER_SNAPSHOT};

        // Extract visible text (bounded)
        let text = document.body ? document.body.innerText : "";
        let truncated = false;
        if (text.length > MAX_TEXT) {
          text = text.slice(0, MAX_TEXT);
          truncated = true;
        }

        // Extract interactive elements
        const selectors = [
          'button', 'a[href]', 'input', 'select', 'textarea',
          '[role="button"]', '[role="link"]', '[role="textbox"]',
          '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
          'h1', 'h2', 'h3',
        ];
        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
        const elements = [];
        let refCounter = { b: 0, l: 0, i: 0, s: 0, t: 0, h: 0, o: 0 };

        for (const node of nodes.slice(0, MAX_ELEMENTS)) {
          const tag = node.tagName.toLowerCase();
          const role = node.getAttribute('role') || tag;
          const name = (node.getAttribute('aria-label') ||
                        node.getAttribute('title') ||
                        node.getAttribute('placeholder') ||
                        node.textContent?.trim() || '').slice(0, 200);

          let prefix = 'o';
          if (tag === 'button' || role === 'button') prefix = 'b';
          else if (tag === 'a') prefix = 'l';
          else if (tag === 'input' || tag === 'textarea' || role === 'textbox') prefix = 'i';
          else if (tag === 'select' || role === 'combobox') prefix = 's';
          else if (['h1','h2','h3'].includes(tag)) prefix = 'h';

          const ref = prefix + (++refCounter[prefix] || 0);
          const el = { ref, role, name };
          if (tag === 'a') el.href = node.getAttribute('href') || undefined;
          if (tag === 'input' || tag === 'textarea') {
            const inputType = (node.getAttribute('type') || '').toLowerCase();
            const sensitiveTypes = ['password', 'hidden'];
            const sensitiveNames = ['cc', 'card', 'cvv', 'cvc', 'ssn', 'pin', 'secret'];
            const inputName = (node.getAttribute('name') || node.getAttribute('id') || '').toLowerCase();
            const isSensitive = sensitiveTypes.includes(inputType) ||
              sensitiveNames.some(n => inputName.includes(n));
            el.value = isSensitive ? '[REDACTED]' : (node.value || undefined);
          }
          if (tag === 'input' && (node.type === 'checkbox' || node.type === 'radio')) {
            el.checked = node.checked;
          }
          el.disabled = node.disabled || node.getAttribute('aria-disabled') === 'true' || false;
          elements.push(el);
        }

        return { text, elements, truncated };
      })()
    `) as { text: string; elements: PageSemanticElement[]; truncated: boolean };

    const navGen = tab.navigationGeneration;
    // Store refs for subsequent click/type operations
    // (We store the index position since we can't serialize DOM nodes)
    _elementRefs.set(tabId, new Map([[navGen, new Map(
      rawResult.elements.map((el, idx) => [el.ref, `[data-forge-ref="${idx}"]`])
    )]]));

    snapshot = {
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      navigationGeneration: navGen,
      tabId,
      sessionId: ctrl.sessionId,
      capturedAt: Date.now(),
      text: rawResult.text,
      elements: rawResult.elements,
      truncated: rawResult.truncated,
    };

    // Track read bytes budget
    const b = _getBudget(ctrl.requestId);
    b.readBytesUsed += snapshot.text.length;
    if (b.readBytesUsed > BROWSER_LIMITS.MAX_READ_BYTES_PER_REQUEST) {
      assertInvariant("BROWSER_AGENT_ACTION_BOUNDED", false, { requestId: ctrl.requestId, kind: "read_bytes" });
      throw new Error("BROWSER_ACTION_BUDGET_EXCEEDED: page read byte limit reached");
    }
    _agentBudgets.set(ctrl.requestId, b);
  } catch (err) {
    if ((err as Error).message?.includes("BROWSER_")) throw err;
    throw new Error(`BROWSER_NAVIGATION_FAILED: page read failed — ${(err as Error).message}`);
  }

  assertInvariant("BROWSER_RESULT_REQUEST_SCOPED", true, { requestId: ctrl.requestId, tabId });
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "read_page", tabId, url: snapshot.url });
  return snapshot;
}

/** Click a semantic element by ref. */
export async function agentClick(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _checkElementRefCurrent(tabId, tab.navigationGeneration);

  _incrementBudget(ctrl.requestId, "action");

  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const selectors = [
          'button', 'a[href]', 'input', 'select', 'textarea',
          '[role="button"]', '[role="link"]', '[role="textbox"]',
          '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
          'h1', 'h2', 'h3',
        ];
        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
        const MAX_ELEMENTS = ${BROWSER_LIMITS.MAX_ELEMENTS_PER_SNAPSHOT};
        const refTarget = ${JSON.stringify(ref)};
        let refCounter = { b: 0, l: 0, i: 0, s: 0, t: 0, h: 0, o: 0 };
        for (const node of nodes.slice(0, MAX_ELEMENTS)) {
          const tag = node.tagName.toLowerCase();
          const role = node.getAttribute('role') || tag;
          let prefix = 'o';
          if (tag === 'button' || role === 'button') prefix = 'b';
          else if (tag === 'a') prefix = 'l';
          else if (tag === 'input' || tag === 'textarea' || role === 'textbox') prefix = 'i';
          else if (tag === 'select' || role === 'combobox') prefix = 's';
          else if (['h1','h2','h3'].includes(tag)) prefix = 'h';
          const r = prefix + (++refCounter[prefix] || 0);
          if (r === refTarget) { node.click(); return true; }
        }
        return false;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_NAVIGATION_FAILED: click failed — ${(err as Error).message}`);
  }

  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "click", tabId, ref });
}

/** Fill an input field by ref. */
export async function agentFill(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
  value: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");

  // Validate value doesn't contain prompt injection patterns (best-effort)
  assertInvariant("BROWSER_NO_RAW_AUTH_SECRET", !_looksLikeRawSecret(value), { ref, note: "fill value screened" });

  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const selectors = ['input', 'textarea', '[role="textbox"]', 'select', '[contenteditable]'];
        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
        const MAX_ELEMENTS = ${BROWSER_LIMITS.MAX_ELEMENTS_PER_SNAPSHOT};
        const refTarget = ${JSON.stringify(ref)};
        let counter = 0;
        for (const node of nodes.slice(0, MAX_ELEMENTS)) {
          const r = 'i' + (++counter);
          if (r === refTarget) {
            node.focus();
            node.value = ${JSON.stringify(value)};
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_NAVIGATION_FAILED: fill failed — ${(err as Error).message}`);
  }

  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "fill", tabId, ref });
}

/** Type text into the currently focused element. */
export async function agentType(
  ctrl: BrowserAgentControl,
  tabId: string,
  text: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _incrementBudget(ctrl.requestId, "action");

  view.webContents.sendInputEvent({ type: "char", keyCode: text });
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "type", tabId });
}

/** Press a keyboard key by name. */
export async function agentPressKey(
  ctrl: BrowserAgentControl,
  tabId: string,
  key: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _incrementBudget(ctrl.requestId, "action");

  view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "press_key", tabId, key });
}

/** Scroll the page by pixels. */
export async function agentScroll(
  ctrl: BrowserAgentControl,
  tabId: string,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _incrementBudget(ctrl.requestId, "action");

  view.webContents.sendInputEvent({ type: "mouseWheel", x: 100, y: 100, deltaX, deltaY });
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "scroll", tabId, deltaX, deltaY });
}

/** Find text on page — returns first match count. */
export async function agentFindText(
  ctrl: BrowserAgentControl,
  tabId: string,
  query: string,
): Promise<{ count: number }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");

  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _incrementBudget(ctrl.requestId, "action");

  return new Promise<{ count: number }>((resolve) => {
    view.webContents.findInPage(query.slice(0, 256));
    view.webContents.once("found-in-page", (_ev, result) => {
      view.webContents.stopFindInPage("clearSelection");
      resolve({ count: result.matches });
    });
    // Timeout fallback
    setTimeout(() => resolve({ count: 0 }), 3000);
  });
}

/** Capture a screenshot. Returns base64 PNG data URL. */
export async function agentScreenshot(
  ctrl: BrowserAgentControl,
  tabId: string,
): Promise<{ dataUrl: string; width: number; height: number; url: string; timestamp: number }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "screenshot");

  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);

  _incrementBudget(ctrl.requestId, "screenshot");

  const image = await view.webContents.capturePage({
    x: 0,
    y: 0,
    width: BROWSER_LIMITS.MAX_SCREENSHOT_WIDTH,
    height: BROWSER_LIMITS.MAX_SCREENSHOT_HEIGHT,
  });
  const size = image.getSize();
  const dataUrl = `data:image/png;base64,${image.toPNG().toString("base64")}`;

  // Optionally save to file for evidence refs
  let savedPath: string | undefined;
  if (_dataDir) {
    const screenshotDir = path.join(_dataDir, "browser-screenshots");
    const filename = `${tabId}-${Date.now()}.png`;
    const filepath = path.join(screenshotDir, filename);
    try {
      fs.writeFileSync(filepath, image.toPNG());
      savedPath = filepath;
    } catch { /* non-fatal */ }
  }

  // Record evidence ref for this requestId
  if (savedPath) {
    const existing = _screenshotEvidence.get(ctrl.requestId) ?? [];
    existing.push(savedPath);
    _screenshotEvidence.set(ctrl.requestId, existing);
  }

  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "screenshot", tabId, width: size.width, height: size.height });
  return { dataUrl, width: size.width, height: size.height, url: tab.url, timestamp: Date.now() };
}

/** Return screenshot file paths captured during the given agent request (evidence refs). */
export function getScreenshotEvidence(requestId: string): string[] {
  return _screenshotEvidence.get(requestId) ?? [];
}

/** Get bounded console log entries for a tab. */
export function agentGetConsole(
  ctrl: BrowserAgentControl,
  tabId: string,
): Array<{ level: string; message: string; source?: string; timestamp: number }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);

  const buf = _consoleBuffers.get(tabId) ?? [];
  return buf.slice(-BROWSER_LIMITS.MAX_CONSOLE_ENTRIES);
}

/** Get bounded network request summary for a tab. */
export function agentGetNetworkSummary(
  ctrl: BrowserAgentControl,
  tabId: string,
): Array<{ url: string; method: string; status: number; resourceType: string; timestamp: number }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);

  const buf = _networkBuffers.get(tabId) ?? [];
  // Never include Authorization or Cookie headers — only summary metadata
  return buf.slice(-BROWSER_LIMITS.MAX_NETWORK_ENTRIES).map((e) => ({
    url: _redactSensitiveUrlParams(e.url),
    method: e.method,
    status: e.status,
    resourceType: e.resourceType,
    timestamp: e.timestamp,
  }));
}

// ── Browser Runtime V3 — Extended Interaction ──────────────────────────────

/** Generic ref resolver used by multiple V3 actions. Searches standard selectors + shadow DOM. */
const _RESOLVE_REF_SCRIPT = `
(function resolveRef(refTarget) {
  const SELECTORS = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
    'h1', 'h2', 'h3', '[tabindex]', '[contenteditable]',
  ];
  function collectNodes(root) {
    const found = Array.from(root.querySelectorAll(SELECTORS.join(',')));
    const shadows = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) shadows.push(...collectNodes(el.shadowRoot));
    }
    return [...found, ...shadows];
  }
  const nodes = collectNodes(document);
  const MAX_ELEMENTS = 500;
  let refCounter = { b: 0, l: 0, i: 0, s: 0, t: 0, h: 0, o: 0 };
  for (const node of nodes.slice(0, MAX_ELEMENTS)) {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute ? (node.getAttribute('role') || tag) : tag;
    let prefix = 'o';
    if (tag === 'button' || role === 'button') prefix = 'b';
    else if (tag === 'a') prefix = 'l';
    else if (tag === 'input' || tag === 'textarea' || role === 'textbox') prefix = 'i';
    else if (tag === 'select' || role === 'combobox') prefix = 's';
    else if (['h1','h2','h3'].includes(tag)) prefix = 'h';
    const r = prefix + (++refCounter[prefix] || 0);
    if (r === refTarget) return node;
  }
  return null;
})
`;

/** Hover over an element by ref (triggers mouseenter/mouseover). */
export async function agentHover(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: hover failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "hover", tabId, ref });
}

/** Double-click an element by ref. */
export async function agentDoubleClick(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: double_click failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "double_click", tabId, ref });
}

/** Drag source element and drop onto target element. */
export async function agentDrag(
  ctrl: BrowserAgentControl,
  tabId: string,
  sourceRef: string,
  targetRef: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const src = resolve(${JSON.stringify(sourceRef)});
        const tgt = resolve(${JSON.stringify(targetRef)});
        if (!src || !tgt) return false;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: drag failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "drag", tabId, sourceRef, targetRef });
}

/** Focus an element without clicking. */
export async function agentFocus(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        node.focus();
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: focus failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "focus", tabId, ref });
}

/** Clear an input or contenteditable element. */
export async function agentClear(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        if ('value' in node) {
          node.value = '';
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (node.contentEditable === 'true') {
          node.textContent = '';
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: clear failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "clear", tabId, ref });
}

/** Scroll an element into the viewport. */
export async function agentScrollIntoView(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: scroll_into_view failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "scroll_into_view", tabId, ref });
}

/** Set checked state of a checkbox or radio button. */
export async function agentCheckbox(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
  checked: boolean,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        const el = node;
        if (el.type !== 'checkbox' && el.type !== 'radio') return false;
        if (el.checked !== ${checked}) {
          el.click(); // triggers change event naturally
        }
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: checkbox failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "checkbox", tabId, ref, checked });
}

/** Set a native <select> element to the given option value — proper implementation. */
export async function agentSelect(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
  value: string,
): Promise<void> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);
  _incrementBudget(ctrl.requestId, "action");
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node) return false;
        if (node.tagName && node.tagName.toLowerCase() === 'select') {
          node.value = ${JSON.stringify(value)};
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // contenteditable or custom combobox — fall back to fill
          node.focus();
          if ('value' in node) {
            node.value = ${JSON.stringify(value)};
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            node.textContent = ${JSON.stringify(value)};
            node.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: select failed — ${(err as Error).message}`);
  }
  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "select", tabId, ref, value });
}

/** Inject a file into an input[type=file] element via DataTransfer simulation. */
export async function agentUploadFile(
  ctrl: BrowserAgentControl,
  tabId: string,
  ref: string,
  filePath: string,
): Promise<{ fileName: string; fileSizeBytes: number }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  const tab = getBrowserTab(true, tabId);
  if (!view || !tab) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _checkElementRefCurrent(tabId, tab.navigationGeneration);

  // Read file content from disk — must be project-scoped path
  let fileContent: Buffer;
  let fileName: string;
  try {
    fileContent = fs.readFileSync(filePath);
    fileName = path.basename(filePath);
  } catch (err) {
    throw new Error(`BROWSER_UPLOAD_FAILED: cannot read file ${filePath} — ${(err as Error).message}`);
  }

  _incrementBudget(ctrl.requestId, "action");

  // Inject via executeJavaScript — build a File object from base64 content
  const base64 = fileContent.toString("base64");
  const mimeType = _guessMimeType(filePath);
  try {
    const injected = await view.webContents.executeJavaScript(`
      (function() {
        const resolve = ${_RESOLVE_REF_SCRIPT};
        const node = resolve(${JSON.stringify(ref)});
        if (!node || node.tagName.toLowerCase() !== 'input' || node.type !== 'file') return false;
        const byteStr = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });
        const file = new File([blob], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
        const dt = new DataTransfer();
        dt.items.add(file);
        Object.defineProperty(node, 'files', { value: dt.files, writable: false });
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    if (!injected) throw new Error("BROWSER_UPLOAD_FAILED: element ref not found or not an input[type=file]");
  } catch (err) {
    if ((err as Error).message.startsWith("BROWSER_UPLOAD_FAILED")) throw err;
    throw new Error(`BROWSER_UPLOAD_FAILED: injection failed — ${(err as Error).message}`);
  }

  emitTrace("BROWSER_AGENT_ACTION", ctrl.requestId, { action: "upload_file", tabId, ref, fileName, fileSizeBytes: fileContent.length });
  return { fileName, fileSizeBytes: fileContent.length };
}

function _guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.txt': 'text/plain', '.csv': 'text/csv',
    '.json': 'application/json', '.zip': 'application/zip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

/** Enumerate all video/audio elements in the tab. */
export async function agentGetMedia(
  ctrl: BrowserAgentControl,
  tabId: string,
): Promise<import('../../shared/types.js').BrowserMediaState[]> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _incrementBudget(ctrl.requestId, "action");
  try {
    const result = await view.webContents.executeJavaScript(`
      (function() {
        const elements = Array.from(document.querySelectorAll('video, audio'));
        let counter = { video: 0, audio: 0 };
        return elements.map(el => {
          const tag = el.tagName.toLowerCase();
          const ref = 'media-' + tag + '-' + (++counter[tag]);
          const rect = el.getBoundingClientRect();
          const srcRaw = el.src || el.currentSrc || '';
          // Redact auth tokens from src URLs
          let srcRedacted = srcRaw;
          try { const u = new URL(srcRaw); u.searchParams.delete('token'); u.searchParams.delete('key'); srcRedacted = u.toString(); } catch {}
          return {
            ref,
            elementTag: tag,
            srcRedacted,
            paused: el.paused,
            muted: el.muted,
            volume: el.volume,
            currentTime: el.currentTime,
            duration: isFinite(el.duration) ? el.duration : -1,
            readyState: el.readyState,
            visible: rect.width > 0 && rect.height > 0,
          };
        });
      })()
    `);
    return result as import('../../shared/types.js').BrowserMediaState[];
  } catch (err) {
    throw new Error(`BROWSER_MEDIA_NOT_FOUND: cannot enumerate media — ${(err as Error).message}`);
  }
}

/** Control a media element (play/pause/mute/etc.). */
export async function agentControlMedia(
  ctrl: BrowserAgentControl,
  tabId: string,
  action: import('../../shared/types.js').BrowserMediaState['ref'] extends string ? import('../../main/../main/agent-client/tool-types.js').BrowserMediaAction : never,
  ref: string | undefined,
  value: number | undefined,
): Promise<{ ok: boolean; targetRef?: string }> {
  validateAgentControl(ctrl.sessionId, ctrl.requestId, ctrl.tabId);
  _checkActionBudget(ctrl.requestId, "action");
  const view = _tabViews.get(tabId);
  if (!view) throw new Error(`BROWSER_TAB_NOT_FOUND: ${tabId}`);
  _incrementBudget(ctrl.requestId, "action");
  try {
    const result = await view.webContents.executeJavaScript(`
      (function() {
        const refTarget = ${JSON.stringify(ref ?? null)};
        const actionName = ${JSON.stringify(action)};
        const actionValue = ${JSON.stringify(value ?? null)};
        let elements = Array.from(document.querySelectorAll('video, audio'));
        let target = null;
        if (refTarget) {
          let counter = { video: 0, audio: 0 };
          for (const el of elements) {
            const tag = el.tagName.toLowerCase();
            const r = 'media-' + tag + '-' + (++counter[tag]);
            if (r === refTarget) { target = el; break; }
          }
        } else {
          // Target first playing (not paused) or first audible element
          target = elements.find(el => !el.paused && !el.muted) || elements.find(el => !el.paused) || elements[0] || null;
        }
        if (!target) return { ok: false };
        if (actionName === 'play') target.play();
        else if (actionName === 'pause') target.pause();
        else if (actionName === 'mute') target.muted = true;
        else if (actionName === 'unmute') target.muted = false;
        else if (actionName === 'set_volume') target.volume = Math.max(0, Math.min(1, actionValue));
        else if (actionName === 'seek') target.currentTime = actionValue;
        else if (actionName === 'fullscreen_mute') { elements.forEach(el => el.muted = true); }
        return { ok: true };
      })()
    `);
    return result as { ok: boolean; targetRef?: string };
  } catch (err) {
    throw new Error(`BROWSER_ACTION_FAILED: control_media failed — ${(err as Error).message}`);
  }
}

// ── Dialog interception ────────────────────────────────────────────────────

/** Pending JS dialogs per tab: tabId → array of pending dialogs */
const _pendingDialogs = new Map<string, import('../../shared/types.js').BrowserPendingDialog[]>();
/** Dialog resolve callbacks: dialogId → resolve function */
const _dialogResolvers = new Map<string, (result: { action: 'accept' | 'dismiss'; value?: string }) => void>();

/**
 * Install dialog interceptors in a tab via executeJavaScript.
 * Called in did-finish-load. Overrides window.alert/confirm/prompt
 * to emit IPC bridge messages instead of blocking.
 */
export async function installDialogInterceptor(tabId: string): Promise<void> {
  const view = _tabViews.get(tabId);
  if (!view) return;
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        if (window.__forgeDialogInstalled) return;
        window.__forgeDialogInstalled = true;
        function sendDialog(type, message, defaultValue) {
          return new Promise(function(resolve) {
            const id = 'dialog-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            window.__forgeDialogCallbacks = window.__forgeDialogCallbacks || {};
            window.__forgeDialogCallbacks[id] = resolve;
            window.postMessage({ __forge: true, type: 'dialog', dialogType: type, message, defaultValue, id }, '*');
          });
        }
        window.alert = function(msg) { sendDialog('alert', String(msg)); };
        window.confirm = function(msg) { return sendDialog('confirm', String(msg)); };
        window.prompt = function(msg, def) { return sendDialog('prompt', String(msg), def); };
      })()
    `);
  } catch { /* non-fatal — page may not support it */ }
}

/** Register a pending dialog (called from the WebContents dialog event listener). */
export function registerPendingDialog(tabId: string, dialog: import('../../shared/types.js').BrowserPendingDialog): void {
  const arr = _pendingDialogs.get(tabId) ?? [];
  arr.push(dialog);
  _pendingDialogs.set(tabId, arr);
  pushToRenderer(BROWSER_IPC.DIALOG_PENDING, { tabId, dialog });
}

/** Resolve a pending dialog (called by browser_handle_dialog tool). */
export function resolvePendingDialog(tabId: string, dialogId: string, action: 'accept' | 'dismiss', value?: string): boolean {
  const arr = _pendingDialogs.get(tabId);
  if (!arr) return false;
  const idx = arr.findIndex((d) => d.id === dialogId);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  if (arr.length === 0) _pendingDialogs.delete(tabId); else _pendingDialogs.set(tabId, arr);
  const resolver = _dialogResolvers.get(dialogId);
  if (resolver) { resolver({ action, ...(value !== undefined && { value }) }); _dialogResolvers.delete(dialogId); }
  pushToRenderer(BROWSER_IPC.DIALOG_RESOLVED, { tabId, dialogId, action });
  return true;
}

/** Get pending dialogs for a tab. */
export function getPendingDialogs(tabId: string): import('../../shared/types.js').BrowserPendingDialog[] {
  return (_pendingDialogs.get(tabId) ?? []).slice();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _checkElementRefCurrent(tabId: string, currentNavGen: number): void {
  const genMap = _elementRefs.get(tabId);
  if (!genMap) return; // No refs registered yet — OK
  const isStale = !genMap.has(currentNavGen);
  assertInvariant(
    "BROWSER_ELEMENT_REF_CURRENT",
    !isStale,
    { tabId, currentNavGen },
  );
}

/** Heuristic check for raw auth secret patterns in values. */
function _looksLikeRawSecret(value: string): boolean {
  // Only flag obvious known patterns — not a complete secret scanner
  return /^sk-[a-zA-Z0-9]{20,}/.test(value) || /^ghp_[a-zA-Z0-9]{20,}/.test(value);
}

/** Redact sensitive query parameters from URLs. */
function _redactSensitiveUrlParams(url: string): string {
  try {
    const u = new URL(url);
    const sensitive = ["token", "api_key", "apikey", "key", "secret", "access_token", "auth"];
    for (const param of sensitive) {
      if (u.searchParams.has(param)) u.searchParams.set(param, "[REDACTED]");
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ── Runtime State ──────────────────────────────────────────────────────────

export function getBrowserRuntimeState(): BrowserRuntimeState {
  return buildRuntimeState();
}

// ── V2.1: Read-only status (no agent control required) ─────────────────────

export function isBrowserWindowOpen(): boolean {
  // V17: validate actual window health, not just the flag (handles desync on macOS)
  if (_browserWindowOpen && !isBrowserWindowHealthy()) {
    _browserWindowOpen = false;
  }
  return _browserWindowOpen;
}

export function getBrowserStatus(): BrowserStatusSnapshot {
  const state = buildRuntimeState();
  const activeSession = state.activeSessionId
    ? state.sessions.find((s) => s.id === state.activeSessionId) ?? null
    : null;
  const activeTabId = activeSession?.activeTabId ?? null;
  const activeTab = activeTabId
    ? state.tabs.find((t) => t.id === activeTabId) ?? null
    : null;
  const activeProfile = activeSession
    ? state.profiles.find((p) => p.id === activeSession.profileId) ?? null
    : null;
  // _agentControls is now keyed by tabId — look up via the active tab
  const agentControl = activeTabId ? (_agentControls.get(activeTabId) ?? null) : null;
  return {
    isWindowOpen: _browserWindowOpen,
    tabCount: state.tabs.length,
    activeUrl: activeTab?.url ?? null,
    activeTitle: activeTab?.title ?? null,
    activeProfileName: activeProfile?.name ?? null,
    agentControlActive: agentControl !== null,
  };
}

/**
 * V17: Browser diagnostic summary for the Dev Panel.
 */
export function getBrowserDevSummary(): {
  windowOpen: boolean;
  windowHealthy: boolean;
  tabCount: number;
  activeAgentControls: number;
  conversationBindings: number;
  pendingApprovals: number;
} {
  const healthy = isBrowserWindowHealthy();
  return {
    windowOpen: _browserWindowOpen,
    windowHealthy: healthy,
    tabCount: _tabViews.size,
    activeAgentControls: _agentControls.size,
    conversationBindings: _conversationBrowserBinding.size,
    pendingApprovals: _pendingApprovals.size,
  };
}

// ── V2.1: Conversation → Tab binding ──────────────────────────────────────

/**
 * Resolve agent browser target for a given requestId/conversationId.
 * Returns existing agent control if present, OR bootstraps a new one.
 * Callers get a resolved { ctrl, errorMessage } — never need to call
 * bootstrapAgentControl directly.
 */
export async function resolveAgentBrowserTarget(
  requestId: string,
  conversationId: string,
  purpose?: string,
): Promise<{ ctrl: BrowserAgentControl; errorMessage: null } | { ctrl: null; errorMessage: string }> {
  // 1. Check if this request already has active control
  const existingByRequest = getAgentControlByRequestId(requestId);
  if (existingByRequest) {
    return { ctrl: existingByRequest, errorMessage: null };
  }

  // 2. Check conversation binding (cross-turn persistence) — validate before reusing
  const binding = _conversationBrowserBinding.get(conversationId);
  if (binding) {
    // Look up by tabId (canonical key)
    const ctrl = _agentControls.get(binding.tabId);
    if (ctrl) {
      // Validate session is still alive before reusing
      const sess = getBrowserSession(true, binding.sessionId);
      const tab = getBrowserTab(true, binding.tabId);
      if (sess && tab) {
        return { ctrl, errorMessage: null };
      }
    }
    // Stale binding — clear it and fall through to bootstrap
    _conversationBrowserBinding.delete(conversationId);
  }

  // 3. Bootstrap a new agent control
  const result = await bootstrapAgentControl({
    requestId,
    conversationId,
    agentRunId: requestId,
    purpose: purpose ?? "Browser task",
  });

  if (result.ok) {
    // Bind conversation to this session+tab for future turns
    _conversationBrowserBinding.set(conversationId, {
      sessionId: result.sessionId,
      tabId: result.tabId,
    });
    // Look up by tabId (canonical key)
    const ctrl = _agentControls.get(result.tabId);
    if (ctrl) return { ctrl, errorMessage: null };
    return { ctrl: null, errorMessage: "Could not acquire browser access. Try opening the browser first." };
  }

  // Map bootstrap error reasons to user-friendly messages
  if (result.reason === "policy_off") {
    return { ctrl: null, errorMessage: "Browser agent access is disabled. Enable it in Browser Settings → Profile → Agent Access." };
  }
  if (result.reason === "policy_rejected") {
    return { ctrl: null, errorMessage: "Browser access was declined. You can allow it next time a browser action is requested." };
  }
  if (result.reason === "no_profile") {
    return { ctrl: null, errorMessage: "No browser profile found. Open the browser and create a profile first." };
  }
  return { ctrl: null, errorMessage: "Could not acquire browser access. Try opening the browser first." };
}

/** Clear conversation binding (call when conversation is archived/deleted) */
export function clearConversationBrowserBinding(conversationId: string): void {
  _conversationBrowserBinding.delete(conversationId);
}

// ── V2.1: Bookmark wrappers ────────────────────────────────────────────────

export function addBookmark(opts: { profileId: string; url: string; title: string; favicon?: string }): BrowserBookmark {
  const bookmark: BrowserBookmark = {
    id: randomUUID(),
    profileId: opts.profileId,
    url: opts.url,
    title: opts.title,
    ...(opts.favicon !== undefined && { favicon: opts.favicon }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveBookmark(true, bookmark);
  return bookmark;
}

export function removeBookmark(id: string): void {
  deleteBookmark(true, id);
}

export function getBookmarks(profileId?: string): BrowserBookmark[] {
  return listBookmarks(true, profileId);
}

export function editBookmark(id: string, patch: Partial<Pick<BrowserBookmark, 'title' | 'folderId'>>): BrowserBookmark | null {
  return updateBookmark(true, id, patch);
}

export function isUrlBookmarked(profileId: string, url: string): BrowserBookmark | null {
  const bookmarks = listBookmarks(true, profileId);
  return bookmarks.find((b) => b.url === url) ?? null;
}

// ── V2.1: History wrappers ─────────────────────────────────────────────────

/**
 * Record a navigation in history. Private profiles are NEVER recorded.
 */
export function recordNavigation(profileId: string, url: string, title: string): void {
  // Never persist history for private sessions
  const profile = getBrowserProfile(true, profileId);
  if (!profile || profile.persistenceMode === "private") return;
  // Skip blank/internal pages
  if (!url || url === "about:blank" || url.startsWith("forge://")) return;
  const entry: BrowserHistoryEntry = {
    id: randomUUID(),
    profileId,
    url,
    title: title || url,
    visitedAt: Date.now(),
  };
  appendHistory(true, entry);
}

export function getBrowserHistory(profileId?: string, limit = 200): BrowserHistoryEntry[] {
  return listHistory(true, profileId, limit);
}

export function clearBrowserHistory(profileId?: string): void {
  clearHistory(true, profileId);
}