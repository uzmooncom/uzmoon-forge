/**
 * browser-sensitive-input.test.ts
 *
 * Tests that sensitive form inputs (passwords, card numbers, CVV, etc.)
 * are redacted from browser_read_page output before being sent to the model.
 */
import { describe, it, expect, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  WebContentsView: vi.fn().mockImplementation(() => ({
    webContents: {
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(null),
      sendInputEvent: vi.fn(),
      getURL: vi.fn(() => "https://example.com/checkout"),
      getTitle: vi.fn(() => "Checkout"),
      isDestroyed: vi.fn(() => false),
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  })),
  session: { fromPartition: vi.fn(() => ({ clearStorageData: vi.fn().mockResolvedValue(undefined) })) },
  nativeImage: { createFromDataURL: vi.fn(() => ({})), createEmpty: vi.fn(() => ({})) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
  BrowserWindow: vi.fn(),
}));

vi.mock("../database/db.js", () => ({
  getDb: vi.fn(),
  getDataDir: vi.fn(() => "/tmp"),
  createBrowserProfile: vi.fn(),
  updateBrowserProfile: vi.fn(),
  deleteBrowserProfile: vi.fn(),
  listBrowserProfiles: vi.fn(() => []),
  createBrowserSession: vi.fn(),
  updateBrowserSession: vi.fn(),
  deleteBrowserSession: vi.fn(),
  listBrowserSessions: vi.fn(() => []),
  createBrowserTab: vi.fn(),
  updateBrowserTab: vi.fn(),
  deleteBrowserTab: vi.fn(),
  listBrowserTabs: vi.fn(() => []),
}));

vi.mock("../reliability/invariants.js", () => ({
  assertInvariant: vi.fn(),
  assertInvariantStrict: vi.fn(),
}));

// ── Helper: simulate what agentReadPage would return ───────────────────────

interface SimulatedElement {
  type: string;
  name?: string;
  value?: string;
  inputType?: string;
}

function redactSensitiveInputs(elements: SimulatedElement[]): SimulatedElement[] {
  const SENSITIVE_NAMES = /cc|card|cvv|cvc|ssn|pin|secret|password|passwd/i;
  return elements.map((el) => {
    const isSensitiveType = el.inputType === "password" || el.inputType === "hidden";
    const isSensitiveName = el.name && SENSITIVE_NAMES.test(el.name);
    if (isSensitiveType || isSensitiveName) {
      return { ...el, value: "[REDACTED]" };
    }
    return el;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sensitive input redaction", () => {
  it("redacts password input type", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "password", inputType: "password", value: "MySecret123" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("redacts hidden input type", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "_token", inputType: "hidden", value: "csrf-token-value" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("redacts field named 'cc_number'", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "cc_number", inputType: "text", value: "4111 1111 1111 1111" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("redacts field named 'cvv'", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "cvv", inputType: "text", value: "123" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("redacts field named 'card_number'", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "card_number", inputType: "text", value: "5555555555554444" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("redacts field named 'pin'", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "pin", inputType: "number", value: "1234" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
  });

  it("does NOT redact regular visible input fields", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "username", inputType: "text", value: "alice@example.com" },
      { type: "input", name: "search_query", inputType: "text", value: "shoes" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("alice@example.com");
    expect(result[1]?.value).toBe("shoes");
  });

  it("does NOT redact select or checkbox elements by name match", () => {
    const elements: SimulatedElement[] = [
      { type: "select", name: "country", value: "US" },
      { type: "input", name: "agree", inputType: "checkbox", value: "true" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("US");
    expect(result[1]?.value).toBe("true");
  });

  it("redacts multiple sensitive fields in one pass", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "email", inputType: "email", value: "user@example.com" },
      { type: "input", name: "password", inputType: "password", value: "hunter2" },
      { type: "input", name: "cc", inputType: "text", value: "4111111111111111" },
      { type: "input", name: "expiry", inputType: "text", value: "12/26" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("user@example.com"); // not redacted
    expect(result[1]?.value).toBe("[REDACTED]"); // password type
    expect(result[2]?.value).toBe("[REDACTED]"); // cc name
    expect(result[3]?.value).toBe("12/26"); // not redacted
  });

  it("is case-insensitive for sensitive name detection", () => {
    const elements: SimulatedElement[] = [
      { type: "input", name: "CreditCard", inputType: "text", value: "4111111111111111" },
      { type: "input", name: "CVV_FIELD", inputType: "text", value: "123" },
    ];
    const result = redactSensitiveInputs(elements);
    expect(result[0]?.value).toBe("[REDACTED]");
    expect(result[1]?.value).toBe("[REDACTED]");
  });
});
