/**
 * browser-policy.test.ts — Browser policy risk classification (30 tests)
 */
import { describe, it, expect } from "vitest";
import {
  classifyBrowserActionRisk,
  evaluateBrowserPolicy,
  assessBrowserAction,
} from "./browser-policy.js";

// ── classifyBrowserActionRisk ─────────────────────────────────────────────

describe("classifyBrowserActionRisk — base risk from tool name", () => {
  it("browser_read_page → READ", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_read_page" })).toBe("READ");
  });

  it("browser_screenshot → READ", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_screenshot" })).toBe("READ");
  });

  it("browser_find_text → READ", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_find_text" })).toBe("READ");
  });

  it("browser_get_console → READ", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_get_console" })).toBe("READ");
  });

  it("browser_get_network_summary → READ", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_get_network_summary" })).toBe("READ");
  });

  it("browser_open_url → NAVIGATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_open_url" })).toBe("NAVIGATION");
  });

  it("browser_back → NAVIGATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_back" })).toBe("NAVIGATION");
  });

  it("browser_new_tab → NAVIGATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_new_tab" })).toBe("NAVIGATION");
  });

  it("browser_click → INTERACTION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_click" })).toBe("INTERACTION");
  });

  it("browser_type → INTERACTION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_type" })).toBe("INTERACTION");
  });

  it("browser_fill → INTERACTION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_fill" })).toBe("INTERACTION");
  });

  it("browser_scroll → INTERACTION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_scroll" })).toBe("INTERACTION");
  });

  it("unknown tool → UNKNOWN", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_do_unknown_thing" })).toBe("UNKNOWN");
  });
});

describe("classifyBrowserActionRisk — risk refinement", () => {
  it("INTERACTION + password inputName → AUTHENTICATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_fill", inputName: "password" })).toBe("AUTHENTICATION");
  });

  it("INTERACTION + token inputName → AUTHENTICATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_fill", inputName: "token" })).toBe("AUTHENTICATION");
  });

  it("INTERACTION + login formAction → AUTHENTICATION", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_fill", formAction: "/login" })).toBe("AUTHENTICATION");
  });

  it("any tool + file:// url → EXTERNAL_PROTOCOL", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_open_url", url: "file:///etc/passwd" })).toBe("EXTERNAL_PROTOCOL");
  });

  it("any tool + javascript: url → EXTERNAL_PROTOCOL", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_open_url", url: "javascript:alert(1)" })).toBe("EXTERNAL_PROTOCOL");
  });

  it("INTERACTION + /delete url → DESTRUCTIVE", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_click", url: "https://app.example.com/delete/user" })).toBe("DESTRUCTIVE");
  });

  it("INTERACTION + .zip download url → DOWNLOAD", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_click", url: "https://example.com/app.zip" })).toBe("DOWNLOAD");
  });

  it("https:// url with normal path → base risk unchanged", () => {
    expect(classifyBrowserActionRisk({ toolName: "browser_read_page", url: "https://example.com/page" })).toBe("READ");
  });
});

// ── evaluateBrowserPolicy ────────────────────────────────────────────────

describe("evaluateBrowserPolicy — 'off' policy blocks everything", () => {
  it("blocks READ when off", () => {
    expect(evaluateBrowserPolicy("READ", "off")).toBe("block");
  });

  it("blocks NAVIGATION when off", () => {
    expect(evaluateBrowserPolicy("NAVIGATION", "off")).toBe("block");
  });

  it("blocks INTERACTION when off", () => {
    expect(evaluateBrowserPolicy("INTERACTION", "off")).toBe("block");
  });
});

describe("evaluateBrowserPolicy — EXTERNAL_PROTOCOL always blocked", () => {
  it("blocks EXTERNAL_PROTOCOL with 'allowed' policy", () => {
    expect(evaluateBrowserPolicy("EXTERNAL_PROTOCOL", "allowed")).toBe("block");
  });

  it("blocks EXTERNAL_PROTOCOL with 'ask' policy", () => {
    expect(evaluateBrowserPolicy("EXTERNAL_PROTOCOL", "ask")).toBe("block");
  });
});

describe("evaluateBrowserPolicy — 'ask' policy", () => {
  it("READ → allow", () => {
    expect(evaluateBrowserPolicy("READ", "ask")).toBe("allow");
  });

  it("NAVIGATION → allow", () => {
    expect(evaluateBrowserPolicy("NAVIGATION", "ask")).toBe("allow");
  });

  it("INTERACTION → ask (requires approval)", () => {
    expect(evaluateBrowserPolicy("INTERACTION", "ask")).toBe("ask");
  });

  it("AUTHENTICATION → ask (always ask)", () => {
    expect(evaluateBrowserPolicy("AUTHENTICATION", "ask")).toBe("ask");
  });

  it("DESTRUCTIVE → ask (always ask)", () => {
    expect(evaluateBrowserPolicy("DESTRUCTIVE", "ask")).toBe("ask");
  });

  it("UNKNOWN → ask (unknown always ask)", () => {
    expect(evaluateBrowserPolicy("UNKNOWN", "ask")).toBe("ask");
  });
});

describe("evaluateBrowserPolicy — 'allowed' policy", () => {
  it("READ → allow", () => {
    expect(evaluateBrowserPolicy("READ", "allowed")).toBe("allow");
  });

  it("NAVIGATION → allow", () => {
    expect(evaluateBrowserPolicy("NAVIGATION", "allowed")).toBe("allow");
  });

  it("INTERACTION → allow (allowed policy permits normal interaction)", () => {
    expect(evaluateBrowserPolicy("INTERACTION", "allowed")).toBe("allow");
  });

  it("AUTHENTICATION → ask (always ask even with allowed policy)", () => {
    expect(evaluateBrowserPolicy("AUTHENTICATION", "allowed")).toBe("ask");
  });

  it("DESTRUCTIVE → ask (always ask even with allowed policy)", () => {
    expect(evaluateBrowserPolicy("DESTRUCTIVE", "allowed")).toBe("ask");
  });
});

// ── assessBrowserAction ───────────────────────────────────────────────────

describe("assessBrowserAction — combined classify + evaluate", () => {
  it("read_page with 'ask' policy → { risk: READ, decision: allow }", () => {
    const result = assessBrowserAction({ toolName: "browser_read_page" }, "ask");
    expect(result.risk).toBe("READ");
    expect(result.decision).toBe("allow");
  });

  it("fill password field with 'allowed' policy → { risk: AUTHENTICATION, decision: ask }", () => {
    const result = assessBrowserAction(
      { toolName: "browser_fill", inputName: "password" },
      "allowed",
    );
    expect(result.risk).toBe("AUTHENTICATION");
    expect(result.decision).toBe("ask");
  });

  it("navigate to file:// → { risk: EXTERNAL_PROTOCOL, decision: block }", () => {
    const result = assessBrowserAction(
      { toolName: "browser_open_url", url: "file:///etc/passwd" },
      "allowed",
    );
    expect(result.risk).toBe("EXTERNAL_PROTOCOL");
    expect(result.decision).toBe("block");
  });
});