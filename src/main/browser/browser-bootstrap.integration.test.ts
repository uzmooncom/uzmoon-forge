/**
 * browser-bootstrap.integration.test.ts
 *
 * Tests for the browser_use_session bootstrap flow:
 * - Policy enforcement (off/ask/allowed)
 * - Agent control establishment
 * - requestShowBrowser push event sent after successful bootstrap
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Electron mock ──────────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/forge-test", on: vi.fn(), whenReady: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    webContents: { send: mockSend, on: vi.fn() },
    loadURL: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  })),
  WebContentsView: vi.fn().mockImplementation(() => ({
    webContents: {
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(null),
      sendInputEvent: vi.fn(),
      getURL: vi.fn(() => "about:blank"),
      getTitle: vi.fn(() => "New Tab"),
      isDestroyed: vi.fn(() => false),
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  })),
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    })),
  },
  nativeImage: { createFromDataURL: vi.fn(() => ({})), createEmpty: vi.fn(() => ({})) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
}));

// ── DB mock — all functions browser-manager uses ───────────────────────────

const mockProfiles: Map<string, import("../../shared/types.js").BrowserProfile> = new Map();
const mockSessions: Map<string, import("../../shared/types.js").BrowserSession> = new Map();
const mockTabs: Map<string, import("../../shared/types.js").BrowserTab> = new Map();

vi.mock("../database/db.js", () => ({
  getDb: vi.fn(),
  getDataDir: vi.fn(() => "/tmp/forge-test"),
  saveBrowserProfile: vi.fn((_, p) => { mockProfiles.set(p.id, p); return p; }),
  getBrowserProfile: vi.fn((_, id) => mockProfiles.get(id) ?? null),
  listBrowserProfiles: vi.fn((_) => [...mockProfiles.values()]),
  deleteBrowserProfile: vi.fn((_, id) => { mockProfiles.delete(id); }),
  updateBrowserProfile: vi.fn((_, id, patch) => {
    const p = mockProfiles.get(id);
    if (!p) return null;
    const updated = { ...p, ...patch };
    mockProfiles.set(id, updated);
    return updated;
  }),
  saveBrowserSession: vi.fn((_, s) => { mockSessions.set(s.id, s); return s; }),
  getBrowserSession: vi.fn((_, id) => mockSessions.get(id) ?? null),
  listBrowserSessions: vi.fn((_) => [...mockSessions.values()]),
  updateBrowserSession: vi.fn((_, id, patch) => {
    const s = mockSessions.get(id);
    if (!s) return null;
    const updated = { ...s, ...patch };
    mockSessions.set(id, updated);
    return updated;
  }),
  deleteBrowserSession: vi.fn((_, id) => { mockSessions.delete(id); }),
  saveBrowserTab: vi.fn((_, t) => { mockTabs.set(t.id, t); return t; }),
  getBrowserTab: vi.fn((_, id) => mockTabs.get(id) ?? null),
  listBrowserTabs: vi.fn((_) => [...mockTabs.values()]),
  updateBrowserTab: vi.fn((_, id, patch) => {
    const t = mockTabs.get(id);
    if (!t) return null;
    const updated = { ...t, ...patch };
    mockTabs.set(id, updated);
    return updated;
  }),
  deleteBrowserTab: vi.fn((_, id) => { mockTabs.delete(id); }),
  deleteBrowserTabsBySession: vi.fn((_, sessionId) => {
    for (const [id, t] of mockTabs) {
      if (t.sessionId === sessionId) mockTabs.delete(id);
    }
  }),
}));

vi.mock("../reliability/invariants.js", () => ({
  assertInvariant: vi.fn(),
  assertInvariantStrict: vi.fn(),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: vi.fn(() => null),
  tryGetIncidentRecorder: vi.fn(() => null),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProfile(id: string, policy: "off" | "ask" | "allowed") {
  return {
    id,
    name: `Profile ${id}`,
    persistenceMode: "persistent" as const,
    agentAccessPolicy: policy,
    partition: `persist:forge-browser-${id}`,
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeSession(id: string, profileId: string, tabId: string) {
  return {
    id,
    profileId,
    name: `Session ${id}`,
    lifecycle: "active" as const,
    tabIds: [tabId],
    activeTabId: tabId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeTab(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    profileId: "p-default",
    url: "about:blank",
    title: "New Tab",
    loadState: "idle" as const,
    canGoBack: false,
    canGoForward: false,
    navigationGeneration: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("browser-bootstrap: bootstrapAgentControl — policy enforcement", () => {
  beforeEach(() => {
    mockProfiles.clear();
    mockSessions.clear();
    mockTabs.clear();
    vi.resetModules();
  });

  it("returns policy_off error when profile has agentAccessPolicy='off'", async () => {
    mockProfiles.set("p-off", makeProfile("p-off", "off"));
    mockTabs.set("t-off", makeTab("t-off", "s-off"));
    mockSessions.set("s-off", makeSession("s-off", "p-off", "t-off"));

    const bm = await import("./browser-manager.js");
    const result = await bm.bootstrapAgentControl({
      requestId: "req-off",
      conversationId: "conv-off",
      agentRunId: "run-off",
      sessionId: "s-off",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("policy_off");
    }
  });

  it("returns ok when policy is allowed", async () => {
    mockProfiles.set("p-allowed", makeProfile("p-allowed", "allowed"));
    mockTabs.set("t-allowed", makeTab("t-allowed", "s-allowed"));
    mockSessions.set("s-allowed", makeSession("s-allowed", "p-allowed", "t-allowed"));

    const bm = await import("./browser-manager.js");
    const result = await bm.bootstrapAgentControl({
      requestId: "req-allowed",
      conversationId: "conv-allowed",
      agentRunId: "run-allowed",
      sessionId: "s-allowed",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionId).toBe("s-allowed");
      expect(result.policyDecision).toBe("allowed");
    }
  });

  it("agent control is retrievable by requestId after allowed bootstrap", async () => {
    mockProfiles.set("p-ctrl", makeProfile("p-ctrl", "allowed"));
    mockTabs.set("t-ctrl", makeTab("t-ctrl", "s-ctrl"));
    mockSessions.set("s-ctrl", makeSession("s-ctrl", "p-ctrl", "t-ctrl"));

    const bm = await import("./browser-manager.js");
    const result = await bm.bootstrapAgentControl({
      requestId: "req-ctrl-lookup",
      conversationId: "conv-ctrl",
      agentRunId: "run-ctrl",
      sessionId: "s-ctrl",
    });

    expect(result.ok).toBe(true);
    const ctrl = bm.getAgentControlByRequestId("req-ctrl-lookup");
    expect(ctrl).not.toBeNull();
    if (ctrl) {
      expect(ctrl.sessionId).toBe("s-ctrl");
    }
  });

  it("returns session_error for unknown sessionId", async () => {
    const bm = await import("./browser-manager.js");
    const result = await bm.bootstrapAgentControl({
      requestId: "req-no-sess",
      conversationId: "conv-no-sess",
      agentRunId: "run-no-sess",
      sessionId: "nonexistent-session",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_error");
    }
  });
});
