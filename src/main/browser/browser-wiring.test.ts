/**
 * browser-wiring.test.ts — Browser capability system prompt wiring (10 tests)
 *
 * Verifies that all 20 browser tool names are correctly registered in
 * KNOWN_TOOL_NAMES and appear in the OpenAI/Anthropic tool definition outputs.
 */
import { describe, it, expect } from "vitest";
import {
  KNOWN_TOOL_NAMES,
  buildOpenAIToolDefs,
  buildAnthropicToolDefs,
} from "../../main/agent-client/tool-types.js";

// ── Tool name registration ────────────────────────────────────────────────

describe("Browser tools registered in KNOWN_TOOL_NAMES", () => {
  const browserTools = [
    "browser_list_sessions",
    "browser_new_tab",
    "browser_close_tab",
    "browser_switch_tab",
    "browser_open_url",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_read_page",
    "browser_find_text",
    "browser_click",
    "browser_type",
    "browser_fill",
    "browser_select",
    "browser_press_key",
    "browser_scroll",
    "browser_screenshot",
    "browser_get_console",
    "browser_get_network_summary",
  ] as const;

  for (const toolName of browserTools) {
    it(`${toolName} is in KNOWN_TOOL_NAMES`, () => {
      expect(KNOWN_TOOL_NAMES.has(toolName)).toBe(true);
    });
  }
});

// ── Tool definitions exported via buildOpenAIToolDefs ─────────────────────

describe("Browser tools in buildOpenAIToolDefs output", () => {
  const defs = buildOpenAIToolDefs();
  const defNames = new Set(defs.map((d) => d.function.name));

  it("browser_read_page has an OpenAI tool def", () => {
    expect(defNames.has("browser_read_page")).toBe(true);
  });

  it("browser_open_url has an OpenAI tool def", () => {
    expect(defNames.has("browser_open_url")).toBe(true);
  });

  it("browser_click has an OpenAI tool def", () => {
    expect(defNames.has("browser_click")).toBe(true);
  });

  it("browser_screenshot has an OpenAI tool def", () => {
    expect(defNames.has("browser_screenshot")).toBe(true);
  });

  it("all 20 browser tools have OpenAI tool defs", () => {
    const browserTools = [
      "browser_list_sessions", "browser_new_tab", "browser_close_tab",
      "browser_switch_tab", "browser_open_url", "browser_back", "browser_forward",
      "browser_reload", "browser_stop", "browser_read_page", "browser_find_text",
      "browser_click", "browser_type", "browser_fill", "browser_select",
      "browser_press_key", "browser_scroll", "browser_screenshot",
      "browser_get_console", "browser_get_network_summary",
    ];
    const missing = browserTools.filter((t) => !defNames.has(t));
    expect(missing).toHaveLength(0);
  });

  it("each browser tool def has a non-empty description", () => {
    const browserDefs = defs.filter((d) => d.function.name.startsWith("browser_"));
    for (const def of browserDefs) {
      expect(def.function.description?.length ?? 0, `${def.function.name} description`).toBeGreaterThan(0);
    }
  });
});

// ── Tool definitions exported via buildAnthropicToolDefs ──────────────────

describe("Browser tools in buildAnthropicToolDefs output", () => {
  const defs = buildAnthropicToolDefs();
  const defNames = new Set(defs.map((d) => d.name));

  it("browser_fill has an Anthropic tool def", () => {
    expect(defNames.has("browser_fill")).toBe(true);
  });

  it("browser_screenshot has an Anthropic tool def", () => {
    expect(defNames.has("browser_screenshot")).toBe(true);
  });

  it("all 20 browser tools have Anthropic tool defs", () => {
    const browserTools = [
      "browser_list_sessions", "browser_new_tab", "browser_close_tab",
      "browser_switch_tab", "browser_open_url", "browser_back", "browser_forward",
      "browser_reload", "browser_stop", "browser_read_page", "browser_find_text",
      "browser_click", "browser_type", "browser_fill", "browser_select",
      "browser_press_key", "browser_scroll", "browser_screenshot",
      "browser_get_console", "browser_get_network_summary",
    ];
    const missing = browserTools.filter((t) => !defNames.has(t));
    expect(missing).toHaveLength(0);
  });
});