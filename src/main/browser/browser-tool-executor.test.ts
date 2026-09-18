/**
 * browser-tool-executor.test.ts — Browser tool dispatch (40 tests)
 *
 * Tests that each browser tool name routes to the correct handler and
 * returns the expected output shape. BrowserManager and its Electron deps
 * are fully mocked.
 *
 * Key implementation notes discovered from source:
 * - `browser_click` args use `ref` (not `element_ref`)
 * - `browser_fill` args use `ref` + `value` (not `element_ref`)
 * - `browser_select` args use `ref` + `value` (not `element_ref` / `option_value`)
 * - `browser_open_url` calls `bm.agentOpenUrl(ctrl, tabId, url)` (not `navigateTab`)
 * - `browser_close_tab` calls `bm.closeBrowserTab()` unconditionally (no tab existence check)
 * - `browser_select` uses `bm.agentSelect` internally
 * - Results return `data` field (not `output`)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ForgeToolCall } from "../../shared/types.js";
import type { ToolExecutionContext } from "../../main/project-files/tool-executor.js";

// ── Mock browser-manager ──────────────────────────────────────────────────

const mockBm = {
  getBrowserRuntimeState: vi.fn(),
  getAgentControlByRequestId: vi.fn(),
  normalizeNavigationInput: vi.fn((url: string) => url),
  newBrowserTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  activateTab: vi.fn(),
  activateSession: vi.fn(),
  navigateTab: vi.fn(),
  navigateBack: vi.fn(),
  navigateForward: vi.fn(),
  reloadTab: vi.fn(),
  stopTab: vi.fn(),
  agentOpenUrl: vi.fn(),
  agentReadPage: vi.fn(),
  agentFindText: vi.fn(),
  agentClick: vi.fn(),
  agentType: vi.fn(),
  agentFill: vi.fn(),
  agentSelect: vi.fn(),
  agentPressKey: vi.fn(),
  agentScroll: vi.fn(),
  agentScreenshot: vi.fn(),
  agentGetConsole: vi.fn(),
  agentGetNetworkSummary: vi.fn(),
  // Browser Runtime V3
  agentHover: vi.fn(),
  agentDoubleClick: vi.fn(),
  agentDrag: vi.fn(),
  agentFocus: vi.fn(),
  agentClear: vi.fn(),
  agentScrollIntoView: vi.fn(),
  agentCheckbox: vi.fn(),
  agentUploadFile: vi.fn(),
  agentGetMedia: vi.fn(),
  agentControlMedia: vi.fn(),
  resolvePendingDialog: vi.fn(),
  isBrowserWindowOpen: vi.fn(),
  getBrowserStatus: vi.fn(),
  requestShowBrowser: vi.fn(),
};

vi.mock("../browser/browser-manager.js", () => mockBm);

// ── Mock db ───────────────────────────────────────────────────────────────

vi.mock("../database/db.js", () => ({
  getDb: vi.fn().mockReturnValue(true),
  saveBrowserTab: vi.fn(),
  getBrowserTab: vi.fn().mockReturnValue(null),
  listBrowserTabs: vi.fn().mockReturnValue([]),
  updateBrowserTab: vi.fn(),
  deleteBrowserTab: vi.fn(),
  deleteBrowserTabsBySession: vi.fn(),
}));

// ── Mock other deps ───────────────────────────────────────────────────────

vi.mock("../commands/command-manager.js", () => ({
  getCommandManager: vi.fn().mockReturnValue(null),
}));

vi.mock("../project-files/service.js", () => ({
  getProjectFileService: vi.fn().mockReturnValue(null),
}));

vi.mock("../project-files/edit-service.js", () => ({
  captureProposalTarget: vi.fn().mockResolvedValue(null),
}));

vi.mock("../reliability/invariants.js", () => ({
  assertInvariant: vi.fn().mockReturnValue(true),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: vi.fn().mockReturnValue(null),
}));

import { executeProjectTool } from "../../main/project-files/tool-executor.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    projectId: "proj-1",
    projectRoot: "/tmp/test-project",
    requestId: "req-test-1",
    conversationId: "conv-1",
    readBytesUsed: 0,
    commandsRunThisRequest: 0,
    ...overrides,
  };
}

function makeCall(name: string, arguments_: Record<string, unknown> = {}): ForgeToolCall {
  return { callId: "call-1", name, arguments: arguments_ };
}

// ── Shared mock data ──────────────────────────────────────────────────────

const mockCtrl = {
  requestId: "req-test-1",
  sessionId: "sess-1",
  conversationId: "conv-1",
  agentRunId: "run-1",
  startedAt: Date.now(),
};

const mockTab = {
  id: "tab-1",
  sessionId: "sess-1",
  profileId: "p-1",
  url: "https://example.com",
  title: "Example",
  loadState: "loaded",
  canGoBack: false,
  canGoForward: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockSession = {
  id: "sess-1",
  profileId: "p-1",
  lifecycle: "active",
  tabIds: ["tab-1"],
  activeTabId: "tab-1",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockState = {
  profiles: [],
  sessions: [mockSession],
  tabs: [mockTab],
  activeSessionId: "sess-1",
  revision: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBm.getBrowserRuntimeState.mockReturnValue(mockState);
  mockBm.getAgentControlByRequestId.mockReturnValue(mockCtrl);
  mockBm.normalizeNavigationInput.mockImplementation((url: string) => url);
});

// ── browser_list_sessions ─────────────────────────────────────────────────

describe("browser_list_sessions", () => {
  it("returns ok: true", async () => {
    const r = await executeProjectTool(makeCall("browser_list_sessions"), makeCtx());
    expect(r.result.ok).toBe(true);
  });

  it("calls getBrowserRuntimeState", async () => {
    await executeProjectTool(makeCall("browser_list_sessions"), makeCtx());
    expect(mockBm.getBrowserRuntimeState).toHaveBeenCalled();
  });

  it("result data contains sessions array", async () => {
    const r = await executeProjectTool(makeCall("browser_list_sessions"), makeCtx());
    expect(r.result.data).toBeDefined();
    expect((r.result.data as { sessions: unknown[] }).sessions).toBeDefined();
  });

  it("result data contains correct session count", async () => {
    const r = await executeProjectTool(makeCall("browser_list_sessions"), makeCtx());
    expect((r.result.data as { total: number }).total).toBe(1);
  });
});

// ── browser_new_tab ────────────────────────────────────────────────────────

describe("browser_new_tab", () => {
  it("calls newBrowserTab when session exists", async () => {
    mockBm.newBrowserTab.mockResolvedValue({ ...mockTab, id: "tab-2" });
    await executeProjectTool(makeCall("browser_new_tab", { session_id: "sess-1" }), makeCtx());
    expect(mockBm.newBrowserTab).toHaveBeenCalledWith("sess-1", undefined);
  });

  it("passes url to newBrowserTab when provided", async () => {
    mockBm.newBrowserTab.mockResolvedValue({ ...mockTab, id: "tab-2" });
    await executeProjectTool(
      makeCall("browser_new_tab", { session_id: "sess-1", url: "https://google.com" }),
      makeCtx(),
    );
    expect(mockBm.newBrowserTab).toHaveBeenCalledWith("sess-1", "https://google.com");
  });

  it("returns error when session not found", async () => {
    mockBm.getBrowserRuntimeState.mockReturnValue({ ...mockState, sessions: [], tabs: [] });
    const r = await executeProjectTool(makeCall("browser_new_tab", { session_id: "no-such" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

// ── browser_close_tab ─────────────────────────────────────────────────────

describe("browser_close_tab", () => {
  it("calls closeBrowserTab with tab_id", async () => {
    mockBm.closeBrowserTab.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_close_tab", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.closeBrowserTab).toHaveBeenCalledWith("tab-1");
  });

  it("returns ok: true on close (no existence check)", async () => {
    // Implementation calls bm.closeBrowserTab unconditionally — no tab existence check
    mockBm.closeBrowserTab.mockReturnValue(undefined);
    const r = await executeProjectTool(makeCall("browser_close_tab", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
  });
});

// ── browser_switch_tab ────────────────────────────────────────────────────

describe("browser_switch_tab", () => {
  it("calls activateTab with tab_id", async () => {
    mockBm.activateTab.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_switch_tab", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.activateTab).toHaveBeenCalledWith("tab-1");
  });
});

// ── browser_open_url ──────────────────────────────────────────────────────

describe("browser_open_url", () => {
  it("calls agentOpenUrl (not navigateTab) with ctrl, tab_id, url", async () => {
    mockBm.agentOpenUrl.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_open_url", { tab_id: "tab-1", url: "https://example.com" }),
      makeCtx(),
    );
    expect(mockBm.agentOpenUrl).toHaveBeenCalledWith(mockCtrl, "tab-1", "https://example.com");
  });

  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(
      makeCall("browser_open_url", { tab_id: "tab-1", url: "https://example.com" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
  });

  it("normalizes URL before navigation", async () => {
    mockBm.agentOpenUrl.mockResolvedValue(undefined);
    mockBm.normalizeNavigationInput.mockReturnValue("https://normalized.com");
    await executeProjectTool(
      makeCall("browser_open_url", { tab_id: "tab-1", url: "normalized.com" }),
      makeCtx(),
    );
    expect(mockBm.normalizeNavigationInput).toHaveBeenCalledWith("normalized.com");
  });
});

// ── browser_back / forward / reload / stop ────────────────────────────────

describe("browser_back", () => {
  it("calls navigateBack with tab_id", async () => {
    mockBm.navigateBack.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_back", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.navigateBack).toHaveBeenCalledWith("tab-1");
  });
});

describe("browser_forward", () => {
  it("calls navigateForward with tab_id", async () => {
    mockBm.navigateForward.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_forward", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.navigateForward).toHaveBeenCalledWith("tab-1");
  });
});

describe("browser_reload", () => {
  it("calls reloadTab with tab_id", async () => {
    mockBm.reloadTab.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_reload", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.reloadTab).toHaveBeenCalledWith("tab-1");
  });
});

describe("browser_stop", () => {
  it("calls stopTab with tab_id", async () => {
    mockBm.stopTab.mockReturnValue(undefined);
    await executeProjectTool(makeCall("browser_stop", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.stopTab).toHaveBeenCalledWith("tab-1");
  });
});

// ── browser_read_page ─────────────────────────────────────────────────────

describe("browser_read_page", () => {
  it("calls agentReadPage with ctrl and tab_id", async () => {
    mockBm.agentReadPage.mockResolvedValue({ text: "Page content", byteLength: 12 });
    await executeProjectTool(makeCall("browser_read_page", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.agentReadPage).toHaveBeenCalledWith(mockCtrl, "tab-1");
  });

  it("returns ok: true on success", async () => {
    mockBm.agentReadPage.mockResolvedValue({ text: "Content", byteLength: 7 });
    const r = await executeProjectTool(makeCall("browser_read_page", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
  });

  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_read_page", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

// ── browser_find_text ─────────────────────────────────────────────────────

describe("browser_find_text", () => {
  it("calls agentFindText with ctrl, tab_id, query", async () => {
    mockBm.agentFindText.mockResolvedValue({ count: 3 });
    await executeProjectTool(
      makeCall("browser_find_text", { tab_id: "tab-1", query: "hello" }),
      makeCtx(),
    );
    expect(mockBm.agentFindText).toHaveBeenCalledWith(mockCtrl, "tab-1", "hello");
  });

  it("returns matchCount in data", async () => {
    mockBm.agentFindText.mockResolvedValue({ count: 5 });
    const r = await executeProjectTool(
      makeCall("browser_find_text", { tab_id: "tab-1", query: "world" }),
      makeCtx(),
    );
    expect((r.result.data as { matchCount: number }).matchCount).toBe(5);
  });
});

// ── browser_click ─────────────────────────────────────────────────────────

describe("browser_click", () => {
  it("calls agentClick with ctrl, tab_id, ref", async () => {
    // Note: arg is `ref` not `element_ref`
    mockBm.agentClick.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_click", { tab_id: "tab-1", ref: "b1" }),
      makeCtx(),
    );
    expect(mockBm.agentClick).toHaveBeenCalledWith(mockCtrl, "tab-1", "b1");
  });

  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(
      makeCall("browser_click", { tab_id: "tab-1", ref: "b1" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
  });
});

// ── browser_type ──────────────────────────────────────────────────────────

describe("browser_type", () => {
  it("calls agentType with ctrl, tab_id, text", async () => {
    mockBm.agentType.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_type", { tab_id: "tab-1", text: "hello world" }),
      makeCtx(),
    );
    expect(mockBm.agentType).toHaveBeenCalledWith(mockCtrl, "tab-1", "hello world");
  });

  it("returns char count in data", async () => {
    mockBm.agentType.mockResolvedValue(undefined);
    const r = await executeProjectTool(
      makeCall("browser_type", { tab_id: "tab-1", text: "hello" }),
      makeCtx(),
    );
    expect((r.result.data as { charsTyped: number }).charsTyped).toBe(5);
  });
});

// ── browser_fill ──────────────────────────────────────────────────────────

describe("browser_fill", () => {
  it("calls agentFill with ctrl, tab_id, ref, value", async () => {
    // Note: arg is `ref` not `element_ref`, and `value` not `element_value`
    mockBm.agentFill.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_fill", { tab_id: "tab-1", ref: "i1", value: "test@example.com" }),
      makeCtx(),
    );
    expect(mockBm.agentFill).toHaveBeenCalledWith(mockCtrl, "tab-1", "i1", "test@example.com");
  });
});

// ── browser_select ────────────────────────────────────────────────────────

describe("browser_select", () => {
  it("calls agentSelect with ctrl, tab_id, ref, value", async () => {
    mockBm.agentSelect.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_select", { tab_id: "tab-1", ref: "s1", value: "option-1" }),
      makeCtx(),
    );
    expect(mockBm.agentSelect).toHaveBeenCalledWith(mockCtrl, "tab-1", "s1", "option-1");
  });

  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(
      makeCall("browser_select", { tab_id: "tab-1", ref: "s1", value: "opt-1" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
  });
});

// ── browser_press_key ─────────────────────────────────────────────────────

describe("browser_press_key", () => {
  it("calls agentPressKey with ctrl, tab_id, key", async () => {
    mockBm.agentPressKey.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_press_key", { tab_id: "tab-1", key: "Enter" }),
      makeCtx(),
    );
    expect(mockBm.agentPressKey).toHaveBeenCalledWith(mockCtrl, "tab-1", "Enter");
  });
});

// ── browser_scroll ────────────────────────────────────────────────────────

describe("browser_scroll", () => {
  it("calls agentScroll with ctrl, tab_id, delta_x, delta_y", async () => {
    mockBm.agentScroll.mockResolvedValue(undefined);
    await executeProjectTool(
      makeCall("browser_scroll", { tab_id: "tab-1", delta_x: 0, delta_y: 300 }),
      makeCtx(),
    );
    expect(mockBm.agentScroll).toHaveBeenCalledWith(mockCtrl, "tab-1", 0, 300);
  });
});

// ── browser_screenshot ────────────────────────────────────────────────────

describe("browser_screenshot", () => {
  it("calls agentScreenshot with ctrl and tab_id", async () => {
    mockBm.agentScreenshot.mockResolvedValue({ base64: "abc123", mimeType: "image/png" });
    await executeProjectTool(makeCall("browser_screenshot", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.agentScreenshot).toHaveBeenCalledWith(mockCtrl, "tab-1");
  });

  it("returns ok: true on success", async () => {
    mockBm.agentScreenshot.mockResolvedValue({ base64: "abc", mimeType: "image/png" });
    const r = await executeProjectTool(makeCall("browser_screenshot", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
  });

  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_screenshot", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

// ── browser_get_console ───────────────────────────────────────────────────

describe("browser_get_console", () => {
  it("calls agentGetConsole with ctrl and tab_id", async () => {
    mockBm.agentGetConsole.mockReturnValue([]);
    await executeProjectTool(makeCall("browser_get_console", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.agentGetConsole).toHaveBeenCalledWith(mockCtrl, "tab-1");
  });

  it("returns ok: true when agent has control", async () => {
    mockBm.agentGetConsole.mockReturnValue([]);
    const r = await executeProjectTool(makeCall("browser_get_console", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
  });
});

// ── browser_get_network_summary ───────────────────────────────────────────

describe("browser_get_network_summary", () => {
  it("calls agentGetNetworkSummary with ctrl and tab_id", async () => {
    mockBm.agentGetNetworkSummary.mockReturnValue([]);
    await executeProjectTool(makeCall("browser_get_network_summary", { tab_id: "tab-1" }), makeCtx());
    expect(mockBm.agentGetNetworkSummary).toHaveBeenCalledWith(mockCtrl, "tab-1");
  });

  it("returns ok: true when agent has control", async () => {
    mockBm.agentGetNetworkSummary.mockReturnValue([]);
    const r = await executeProjectTool(makeCall("browser_get_network_summary", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
  });
});

// ── Browser Runtime V3 — Extended Interaction ─────────────────────────────

describe("browser_hover", () => {
  it("calls agentHover with ctrl, tab_id, ref", async () => {
    mockBm.agentHover.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_hover", { tab_id: "tab-1", ref: "b3" }), makeCtx());
    expect(mockBm.agentHover).toHaveBeenCalledWith(mockCtrl, "tab-1", "b3");
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_hover", { tab_id: "tab-1", ref: "b3" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

describe("browser_double_click", () => {
  it("calls agentDoubleClick with ctrl, tab_id, ref", async () => {
    mockBm.agentDoubleClick.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_double_click", { tab_id: "tab-1", ref: "b2" }), makeCtx());
    expect(mockBm.agentDoubleClick).toHaveBeenCalledWith(mockCtrl, "tab-1", "b2");
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_double_click", { tab_id: "tab-1", ref: "b2" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

describe("browser_drag", () => {
  it("calls agentDrag with ctrl, tab_id, sourceRef, targetRef", async () => {
    mockBm.agentDrag.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_drag", { tab_id: "tab-1", source_ref: "b1", target_ref: "b2" }), makeCtx());
    expect(mockBm.agentDrag).toHaveBeenCalledWith(mockCtrl, "tab-1", "b1", "b2");
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_drag", { tab_id: "tab-1", source_ref: "b1", target_ref: "b2" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

describe("browser_focus", () => {
  it("calls agentFocus with ctrl, tab_id, ref", async () => {
    mockBm.agentFocus.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_focus", { tab_id: "tab-1", ref: "i1" }), makeCtx());
    expect(mockBm.agentFocus).toHaveBeenCalledWith(mockCtrl, "tab-1", "i1");
  });
});

describe("browser_clear", () => {
  it("calls agentClear with ctrl, tab_id, ref", async () => {
    mockBm.agentClear.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_clear", { tab_id: "tab-1", ref: "i2" }), makeCtx());
    expect(mockBm.agentClear).toHaveBeenCalledWith(mockCtrl, "tab-1", "i2");
  });
});

describe("browser_scroll_into_view", () => {
  it("calls agentScrollIntoView with ctrl, tab_id, ref", async () => {
    mockBm.agentScrollIntoView.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_scroll_into_view", { tab_id: "tab-1", ref: "o5" }), makeCtx());
    expect(mockBm.agentScrollIntoView).toHaveBeenCalledWith(mockCtrl, "tab-1", "o5");
  });
});

describe("browser_checkbox", () => {
  it("calls agentCheckbox with ctrl, tab_id, ref, checked=true", async () => {
    mockBm.agentCheckbox.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_checkbox", { tab_id: "tab-1", ref: "i3", checked: true }), makeCtx());
    expect(mockBm.agentCheckbox).toHaveBeenCalledWith(mockCtrl, "tab-1", "i3", true);
  });
  it("calls agentCheckbox with checked=false", async () => {
    mockBm.agentCheckbox.mockResolvedValue(undefined);
    await executeProjectTool(makeCall("browser_checkbox", { tab_id: "tab-1", ref: "i3", checked: false }), makeCtx());
    expect(mockBm.agentCheckbox).toHaveBeenCalledWith(mockCtrl, "tab-1", "i3", false);
  });
});

describe("browser_upload_file", () => {
  it("rejects files outside project root", async () => {
    const r = await executeProjectTool(
      makeCall("browser_upload_file", { tab_id: "tab-1", ref: "i4", file_path: "/etc/passwd" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
    expect(r.result.errorCode).toBe("ACCESS_DENIED");
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(
      makeCall("browser_upload_file", { tab_id: "tab-1", ref: "i4", file_path: "/project/file.txt" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
    expect(r.result.errorCode).toBe("ACCESS_DENIED");
  });
});

describe("browser_get_media", () => {
  it("calls agentGetMedia and returns count", async () => {
    const media = [{ ref: "media-video-1", elementTag: "video", srcRedacted: "", paused: true, muted: false, volume: 1, currentTime: 0, duration: 60, readyState: 4, visible: true }];
    mockBm.agentGetMedia.mockResolvedValue(media);
    const r = await executeProjectTool(makeCall("browser_get_media", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(true);
    expect((r.result as { ok: true; data: { count: number } }).data.count).toBe(1);
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(makeCall("browser_get_media", { tab_id: "tab-1" }), makeCtx());
    expect(r.result.ok).toBe(false);
  });
});

describe("browser_control_media", () => {
  it("calls agentControlMedia and returns ok", async () => {
    mockBm.agentControlMedia.mockResolvedValue({ ok: true });
    const r = await executeProjectTool(
      makeCall("browser_control_media", { tab_id: "tab-1", action: "pause" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(true);
    expect(mockBm.agentControlMedia).toHaveBeenCalledWith(mockCtrl, "tab-1", "pause", undefined, undefined);
  });
  it("passes ref and value when provided", async () => {
    mockBm.agentControlMedia.mockResolvedValue({ ok: true });
    await executeProjectTool(
      makeCall("browser_control_media", { tab_id: "tab-1", action: "set_volume", ref: "media-video-1", value: 0.5 }),
      makeCtx(),
    );
    expect(mockBm.agentControlMedia).toHaveBeenCalledWith(mockCtrl, "tab-1", "set_volume", "media-video-1", 0.5);
  });
});

describe("browser_handle_dialog", () => {
  it("calls resolvePendingDialog and returns ok", async () => {
    mockBm.resolvePendingDialog.mockReturnValue(true);
    const r = await executeProjectTool(
      makeCall("browser_handle_dialog", { tab_id: "tab-1", dialog_id: "dialog-123", action: "accept" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(true);
    expect(mockBm.resolvePendingDialog).toHaveBeenCalledWith("tab-1", "dialog-123", "accept", undefined);
  });
  it("returns error when dialog not found", async () => {
    mockBm.resolvePendingDialog.mockReturnValue(false);
    const r = await executeProjectTool(
      makeCall("browser_handle_dialog", { tab_id: "tab-1", dialog_id: "no-such", action: "dismiss" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
    expect(r.result.errorCode).toBe("DIALOG_NOT_FOUND");
  });
  it("returns error when no agent control", async () => {
    mockBm.getAgentControlByRequestId.mockReturnValue(null);
    const r = await executeProjectTool(
      makeCall("browser_handle_dialog", { tab_id: "tab-1", dialog_id: "d1", action: "accept" }),
      makeCtx(),
    );
    expect(r.result.ok).toBe(false);
  });
});