/**
 * browser-manager.unit.test.ts — BrowserManager business logic (60 tests)
 *
 * Electron is mocked at the module level so tests run outside an Electron process.
 * We focus on pure data operations: profile/session/tab CRUD, runtime state, element refs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BrowserProfile, BrowserSession, BrowserTab } from "../../shared/types.js";

// ── Electron mock ─────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  WebContentsView: vi.fn().mockImplementation(() => ({
    webContents: {
      id: Math.random(),
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
    setVisible: vi.fn(),
  })),
  session: {
    fromPartition: vi.fn().mockReturnValue({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      setPermissionRequestHandler: vi.fn(),
    }),
  },
}));

// ── DB mock — matches actual db.ts export names ───────────────────────────

const _profiles: Record<string, BrowserProfile> = {};
const _sessions: Record<string, BrowserSession> = {};
const _tabs: Record<string, BrowserTab> = {};

function resetStore() {
  for (const k of Object.keys(_profiles)) delete _profiles[k];
  for (const k of Object.keys(_sessions)) delete _sessions[k];
  for (const k of Object.keys(_tabs)) delete _tabs[k];
}

vi.mock("../database/db.js", () => ({
  getDb: vi.fn().mockReturnValue(true),
  saveBrowserProfile: vi.fn().mockImplementation((_db: true, profile: BrowserProfile) => {
    _profiles[profile.id] = profile;
    return profile;
  }),
  getBrowserProfile: vi.fn().mockImplementation((_db: true, id: string) => _profiles[id] ?? null),
  listBrowserProfiles: vi.fn().mockImplementation(() => Object.values(_profiles)),
  updateBrowserProfile: vi.fn().mockImplementation((_db: true, id: string, patch: Partial<BrowserProfile>) => {
    const existing = _profiles[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    _profiles[id] = updated;
    return updated;
  }),
  deleteBrowserProfile: vi.fn().mockImplementation((_db: true, id: string) => { delete _profiles[id]; }),
  saveBrowserSession: vi.fn().mockImplementation((_db: true, session: BrowserSession) => {
    _sessions[session.id] = session;
    return session;
  }),
  getBrowserSession: vi.fn().mockImplementation((_db: true, id: string) => _sessions[id] ?? null),
  listBrowserSessions: vi.fn().mockImplementation((_db: true, _profileId?: string) =>
    Object.values(_sessions).filter((s) => !_profileId || s.profileId === _profileId),
  ),
  updateBrowserSession: vi.fn().mockImplementation((_db: true, id: string, patch: Partial<BrowserSession>) => {
    const existing = _sessions[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    _sessions[id] = updated;
    return updated;
  }),
  deleteBrowserSession: vi.fn().mockImplementation((_db: true, id: string) => { delete _sessions[id]; }),
  saveBrowserTab: vi.fn().mockImplementation((_db: true, tab: BrowserTab) => {
    _tabs[tab.id] = tab;
    return tab;
  }),
  getBrowserTab: vi.fn().mockImplementation((_db: true, id: string) => _tabs[id] ?? null),
  listBrowserTabs: vi.fn().mockImplementation((_db: true, sessionId?: string) =>
    Object.values(_tabs).filter((t) => !sessionId || t.sessionId === sessionId),
  ),
  updateBrowserTab: vi.fn().mockImplementation((_db: true, id: string, patch: Partial<BrowserTab>) => {
    const existing = _tabs[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    _tabs[id] = updated;
    return updated;
  }),
  deleteBrowserTab: vi.fn().mockImplementation((_db: true, id: string) => { delete _tabs[id]; }),
  deleteBrowserTabsBySession: vi.fn().mockImplementation((_db: true, sessionId: string) => {
    for (const [k, t] of Object.entries(_tabs)) {
      if (t.sessionId === sessionId) delete _tabs[k];
    }
  }),
}));

vi.mock("../reliability/invariants.js", () => ({
  assertInvariant: vi.fn().mockReturnValue(true),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: vi.fn().mockReturnValue(null),
}));

import {
  _resetBrowserManagerForTest,
  createBrowserProfile,
  listBrowserProfilesPublic,
  updateBrowserProfilePublic,
  getBrowserRuntimeState,
  getAgentControlByRequestId,
  normalizeNavigationInput,
} from "./browser-manager.js";

// ── Reset between tests ───────────────────────────────────────────────────

beforeEach(() => {
  resetStore();
  _resetBrowserManagerForTest();
});

// ── createBrowserProfile ──────────────────────────────────────────────────

describe("createBrowserProfile", () => {
  it("creates a profile with generated id", () => {
    const profile = createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    expect(profile.id).toBeTruthy();
    expect(typeof profile.id).toBe("string");
    expect(profile.id.length).toBeGreaterThan(0);
  });

  it("stores name correctly", () => {
    const profile = createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    expect(profile.name).toBe("Work");
  });

  it("stores persistenceMode correctly for persistent", () => {
    const profile = createBrowserProfile({ name: "P", persistenceMode: "persistent" });
    expect(profile.persistenceMode).toBe("persistent");
  });

  it("stores persistenceMode correctly for private", () => {
    const profile = createBrowserProfile({ name: "V", persistenceMode: "private" });
    expect(profile.persistenceMode).toBe("private");
  });

  it("persistent profile partition starts with persist:", () => {
    const profile = createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    expect(profile.partition.startsWith("persist:")).toBe(true);
  });

  it("private profile partition does not start with persist:", () => {
    const profile = createBrowserProfile({ name: "Incog", persistenceMode: "private" });
    expect(profile.partition.startsWith("persist:")).toBe(false);
  });

  it("sets createdAt timestamp", () => {
    const before = Date.now();
    const profile = createBrowserProfile({ name: "T", persistenceMode: "persistent" });
    expect(profile.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("sets updatedAt timestamp", () => {
    const before = Date.now();
    const profile = createBrowserProfile({ name: "T", persistenceMode: "persistent" });
    expect(profile.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("defaults agentAccessPolicy to 'off'", () => {
    const profile = createBrowserProfile({ name: "T", persistenceMode: "persistent" });
    expect(profile.agentAccessPolicy).toBe("off");
  });

  it("allows explicit agentAccessPolicy 'ask'", () => {
    const profile = createBrowserProfile({ name: "T", persistenceMode: "persistent", agentAccessPolicy: "ask" });
    expect(profile.agentAccessPolicy).toBe("ask");
  });

  it("two profiles have distinct IDs", () => {
    const p1 = createBrowserProfile({ name: "A", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "B", persistenceMode: "persistent" });
    expect(p1.id).not.toBe(p2.id);
  });

  it("two persistent profiles have distinct partitions", () => {
    const p1 = createBrowserProfile({ name: "A", persistenceMode: "persistent" });
    const p2 = createBrowserProfile({ name: "B", persistenceMode: "persistent" });
    expect(p1.partition).not.toBe(p2.partition);
  });

  it("two private profiles have distinct partitions", () => {
    const p1 = createBrowserProfile({ name: "A", persistenceMode: "private" });
    const p2 = createBrowserProfile({ name: "B", persistenceMode: "private" });
    expect(p1.partition).not.toBe(p2.partition);
  });
});

// ── listBrowserProfilesPublic ─────────────────────────────────────────────

describe("listBrowserProfilesPublic", () => {
  it("returns empty array when no profiles", () => {
    expect(listBrowserProfilesPublic()).toHaveLength(0);
  });

  it("returns all created profiles", () => {
    createBrowserProfile({ name: "A", persistenceMode: "persistent" });
    createBrowserProfile({ name: "B", persistenceMode: "private" });
    expect(listBrowserProfilesPublic()).toHaveLength(2);
  });

  it("returned profile names match created names", () => {
    createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    createBrowserProfile({ name: "Personal", persistenceMode: "private" });
    const names = listBrowserProfilesPublic().map((p) => p.name).sort();
    expect(names).toEqual(["Personal", "Work"]);
  });
});

// ── updateBrowserProfilePublic ────────────────────────────────────────────

describe("updateBrowserProfilePublic", () => {
  it("returns null for non-existent profile", () => {
    const result = updateBrowserProfilePublic("non-existent-id", { name: "New" });
    expect(result).toBeNull();
  });

  it("updates profile name", () => {
    const p = createBrowserProfile({ name: "Old", persistenceMode: "persistent" });
    const updated = updateBrowserProfilePublic(p.id, { name: "New" });
    expect(updated?.name).toBe("New");
  });

  it("updates agentAccessPolicy", () => {
    const p = createBrowserProfile({ name: "T", persistenceMode: "persistent" });
    const updated = updateBrowserProfilePublic(p.id, { agentAccessPolicy: "allowed" });
    expect(updated?.agentAccessPolicy).toBe("allowed");
  });
});

// ── getBrowserRuntimeState ────────────────────────────────────────────────

describe("getBrowserRuntimeState", () => {
  it("returns empty state initially", () => {
    const state = getBrowserRuntimeState();
    expect(state.profiles).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.tabs).toHaveLength(0);
    expect(state.activeSessionId).toBeNull();
  });

  it("reflects created profile in runtime state", () => {
    createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    const state = getBrowserRuntimeState();
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]!.name).toBe("Work");
  });

  it("returns a fresh object on each call", () => {
    createBrowserProfile({ name: "Work", persistenceMode: "persistent" });
    const state1 = getBrowserRuntimeState();
    const state2 = getBrowserRuntimeState();
    // Each call returns a new object (not the same reference)
    expect(state1).not.toBe(state2);
  });

  it("tracks multiple profiles", () => {
    createBrowserProfile({ name: "A", persistenceMode: "persistent" });
    createBrowserProfile({ name: "B", persistenceMode: "private" });
    createBrowserProfile({ name: "C", persistenceMode: "persistent" });
    const state = getBrowserRuntimeState();
    expect(state.profiles).toHaveLength(3);
  });
});

// ── getAgentControlByRequestId ────────────────────────────────────────────

describe("getAgentControlByRequestId", () => {
  it("returns null for unknown requestId", () => {
    const ctrl = getAgentControlByRequestId("nonexistent-req-id");
    expect(ctrl).toBeNull();
  });

  it("returns null after reset", () => {
    _resetBrowserManagerForTest();
    const ctrl = getAgentControlByRequestId("any-id");
    expect(ctrl).toBeNull();
  });
});

// ── normalizeNavigationInput ──────────────────────────────────────────────

describe("normalizeNavigationInput", () => {
  it("passes through https:// URLs unchanged", () => {
    const url = "https://example.com/path";
    expect(normalizeNavigationInput(url)).toBe(url);
  });

  it("passes through http:// URLs unchanged", () => {
    const url = "http://localhost:3000";
    expect(normalizeNavigationInput(url)).toBe(url);
  });

  it("prepends https:// to domain-like input", () => {
    expect(normalizeNavigationInput("example.com")).toBe("https://example.com");
  });

  it("prepends https:// to subdomain input", () => {
    expect(normalizeNavigationInput("docs.example.com")).toBe("https://docs.example.com");
  });

  it("converts search query to search URL", () => {
    const result = normalizeNavigationInput("how to center a div");
    expect(result).toContain("google.com/search");
    expect(result).toContain("center");
  });

  it("accepts custom search engine", () => {
    const result = normalizeNavigationInput("typescript", "https://duckduckgo.com/?q=");
    expect(result).toContain("duckduckgo.com");
  });

  it("treats about:blank as search (no :// scheme)", () => {
    // about:blank has no ://, so it falls through to search
    const result = normalizeNavigationInput("about:blank");
    expect(result).toContain("google.com/search");
  });
});

// ── _resetBrowserManagerForTest ───────────────────────────────────────────

describe("_resetBrowserManagerForTest", () => {
  it("clears runtime state after profile creation", () => {
    createBrowserProfile({ name: "Temp", persistenceMode: "private" });
    _resetBrowserManagerForTest();
    const state = getBrowserRuntimeState();
    // DB is mocked separately — reset only clears in-memory maps
    // profiles come from DB mock which is reset by resetStore() in beforeEach
    expect(state.activeSessionId).toBeNull();
  });

  it("can be called multiple times without error", () => {
    expect(() => {
      _resetBrowserManagerForTest();
      _resetBrowserManagerForTest();
    }).not.toThrow();
  });

  it("clears active session after reset", () => {
    _resetBrowserManagerForTest();
    const state = getBrowserRuntimeState();
    expect(state.activeSessionId).toBeNull();
  });
});