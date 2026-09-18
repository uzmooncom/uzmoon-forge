/**
 * Browser App Tools Tests
 *
 * Verifies:
 *   1. browser_open calls openBrowserWindow when window is closed
 *   2. browser_open calls requestShowBrowser when window is already open
 *   3. browser_close calls closeBrowserWindow when window is open
 *   4. browser_close is a no-op when window is already closed
 *   5. is_browser_open returns correct status
 *   6. get_browser_status returns structured status
 *   7. browser_close is in KNOWN_TOOL_NAMES set
 *   8. browser_close validates correctly (no args required)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockOpenBrowserWindow = vi.fn();
const mockCloseBrowserWindow = vi.fn();
const mockRequestShowBrowser = vi.fn();
const mockIsBrowserWindowOpen = vi.fn(() => false);
const mockGetBrowserStatus = vi.fn(() => ({ open: false, sessions: 0 }));

vi.mock("../browser/browser-manager.js", () => ({
  requestShowBrowser: mockRequestShowBrowser,
  isBrowserWindowOpen: mockIsBrowserWindowOpen,
  getBrowserStatus: mockGetBrowserStatus,
}));

vi.mock("../browser/browser-window-controller.js", () => ({
  openBrowserWindow: mockOpenBrowserWindow,
  closeBrowserWindow: mockCloseBrowserWindow,
}));

vi.mock("../reliability/index.js", () => ({
  assertInvariant: vi.fn(),
  assertInvariantStrict: vi.fn(),
  tryGetTraceRecorder: () => null,
  tryGetIncidentRecorder: () => null,
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { validateToolCall, KNOWN_TOOL_NAMES } from "../agent-client/tool-types.js";
import { executeProjectTool } from "../project-files/tool-executor.js";

function makeCtx() {
  return {
    projectId: "p1",
    projectRoot: "/tmp/test-project",
    requestId: "req-1",
    conversationId: "conv-1",
    readBytesUsed: 0,
    toolStepCount: 0,
    commandsRunThisRequest: 0,
    signal: new AbortController().signal,
  };
}

function makeCall(name: string) {
  return { callId: `call-${name}`, name, arguments: {} };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Browser App Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBrowserWindowOpen.mockReturnValue(false);
    mockGetBrowserStatus.mockReturnValue({ open: false, sessions: 0 });
  });

  // ── 1. browser_close is in KNOWN_TOOL_NAMES ────────────────────────────────
  it("browser_close is in KNOWN_TOOL_NAMES", () => {
    expect(KNOWN_TOOL_NAMES.has("browser_close")).toBe(true);
  });

  // ── 2. browser_close validates with no args ────────────────────────────────
  it("browser_close validates successfully with empty args", () => {
    const result = validateToolCall({ callId: "c1", name: "browser_close", arguments: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolName).toBe("browser_close");
  });

  // ── 3. browser_open calls openBrowserWindow when window is closed ──────────
  it("browser_open calls openBrowserWindow when window is not open", async () => {
    mockIsBrowserWindowOpen.mockReturnValue(false);
    const result = await executeProjectTool(makeCall("browser_open"), makeCtx());
    expect(result.result.ok).toBe(true);
    expect(mockOpenBrowserWindow).toHaveBeenCalledTimes(1);
    expect(mockRequestShowBrowser).not.toHaveBeenCalled();
    expect((result.result as { data: { alreadyOpen: boolean } }).data.alreadyOpen).toBe(false);
  });

  // ── 4. browser_open calls requestShowBrowser when window already open ──────
  it("browser_open calls requestShowBrowser when window is already open", async () => {
    mockIsBrowserWindowOpen.mockReturnValue(true);
    const result = await executeProjectTool(makeCall("browser_open"), makeCtx());
    expect(result.result.ok).toBe(true);
    expect(mockRequestShowBrowser).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowserWindow).not.toHaveBeenCalled();
    expect((result.result as { data: { alreadyOpen: boolean } }).data.alreadyOpen).toBe(true);
  });

  // ── 5. browser_close calls closeBrowserWindow when window is open ──────────
  it("browser_close calls closeBrowserWindow when window is open", async () => {
    mockIsBrowserWindowOpen.mockReturnValue(true);
    const result = await executeProjectTool(makeCall("browser_close"), makeCtx());
    expect(result.result.ok).toBe(true);
    expect(mockCloseBrowserWindow).toHaveBeenCalledTimes(1);
    expect((result.result as { data: { closed: boolean } }).data.closed).toBe(true);
  });

  // ── 6. browser_close is no-op when window already closed ──────────────────
  it("browser_close is no-op when window is already closed", async () => {
    mockIsBrowserWindowOpen.mockReturnValue(false);
    const result = await executeProjectTool(makeCall("browser_close"), makeCtx());
    expect(result.result.ok).toBe(true);
    expect(mockCloseBrowserWindow).not.toHaveBeenCalled();
    expect((result.result as { data: { closed: boolean } }).data.closed).toBe(false);
  });

  // ── 7. is_browser_open returns correct status ──────────────────────────────
  it("is_browser_open returns correct isOpen status", async () => {
    mockIsBrowserWindowOpen.mockReturnValue(true);
    const result = await executeProjectTool(makeCall("is_browser_open"), makeCtx());
    expect(result.result.ok).toBe(true);
    expect((result.result as { data: { isOpen: boolean } }).data.isOpen).toBe(true);
  });

  // ── 8. get_browser_status returns structured data ──────────────────────────
  it("get_browser_status returns structured browser status", async () => {
    const fakeStatus = { open: true, sessions: 2, tabs: 3 };
    mockGetBrowserStatus.mockReturnValue(fakeStatus);
    const result = await executeProjectTool(makeCall("get_browser_status"), makeCtx());
    expect(result.result.ok).toBe(true);
    const data = (result.result as { data: typeof fakeStatus }).data;
    expect(data.open).toBe(true);
    expect(data.sessions).toBe(2);
  });

  // ── 9. browser_open result includes durationMs ────────────────────────────
  it("browser_open result includes durationMs", async () => {
    const result = await executeProjectTool(makeCall("browser_open"), makeCtx());
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── 10. browser_close result includes durationMs ──────────────────────────
  it("browser_close result includes durationMs", async () => {
    const result = await executeProjectTool(makeCall("browser_close"), makeCtx());
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});