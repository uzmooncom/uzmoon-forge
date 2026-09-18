/**
 * Browser Action Policy — deterministic risk classification.
 * No LLM is used as the security policy engine.
 */

import type { BrowserActionRisk, BrowserActionDecision, BrowserAgentAccessPolicy } from "../../shared/types.js";

// ── Risk classification per tool ───────────────────────────────────────────

/** Map browser tool names to their risk class. */
const TOOL_RISK_MAP: Record<string, BrowserActionRisk> = {
  browser_list_sessions:      "READ",
  browser_create_session:     "NAVIGATION",
  browser_new_tab:            "NAVIGATION",
  browser_switch_tab:         "NAVIGATION",
  browser_close_tab:          "NAVIGATION",
  browser_open_url:           "NAVIGATION",
  browser_back:               "NAVIGATION",
  browser_forward:            "NAVIGATION",
  browser_reload:             "NAVIGATION",
  browser_stop:               "NAVIGATION",
  browser_read_page:          "READ",
  browser_find_text:          "READ",
  browser_click:              "INTERACTION",
  browser_type:               "INTERACTION",
  browser_fill:               "INTERACTION",
  browser_select:             "INTERACTION",
  browser_press_key:          "INTERACTION",
  browser_scroll:             "INTERACTION",
  browser_screenshot:         "READ",
  browser_get_console:        "READ",
  browser_get_network_summary:"READ",
};

/** Extra risk overrides based on URL/action context. */
function refineRisk(
  baseRisk: BrowserActionRisk,
  opts: { url?: string; formAction?: string; inputName?: string },
): BrowserActionRisk {
  const url = opts.url?.toLowerCase() ?? "";
  const name = opts.inputName?.toLowerCase() ?? "";

  // Detect form submit to auth endpoints
  if (baseRisk === "INTERACTION") {
    if (name === "password" || name === "token" || name === "secret") {
      return "AUTHENTICATION";
    }
    const formAction = opts.formAction?.toLowerCase() ?? "";
    if (formAction.includes("login") || formAction.includes("signin") || formAction.includes("auth")) {
      return "AUTHENTICATION";
    }
  }

  // Detect external protocols in URLs
  if (opts.url) {
    try {
      const u = new URL(opts.url);
      if (!["http:", "https:", "about:"].includes(u.protocol)) {
        return "EXTERNAL_PROTOCOL";
      }
    } catch {
      return "UNKNOWN";
    }
  }

  // Detect destructive patterns by URL keywords
  if (url.includes("/delete") || url.includes("/remove") || url.includes("/destroy")) {
    return "DESTRUCTIVE";
  }
  if (url.includes("/download") || url.includes(".zip") || url.includes(".exe")) {
    return "DOWNLOAD";
  }

  return baseRisk;
}

export interface PolicyContext {
  toolName: string;
  url?: string;
  formAction?: string;
  inputName?: string;
}

/** Classify the risk of a browser action. Pure function. */
export function classifyBrowserActionRisk(ctx: PolicyContext): BrowserActionRisk {
  const base = TOOL_RISK_MAP[ctx.toolName] ?? "UNKNOWN";
  return refineRisk(base, ctx);
}

/**
 * Evaluate whether the agent is allowed to perform a browser action.
 *
 * Decision matrix:
 * - agent access "off"     → block all non-read actions
 * - agent access "ask"     → READ/NAVIGATION → allow; INTERACTION+ → ask
 * - agent access "allowed" → READ/NAVIGATION/INTERACTION → allow; high-risk → ask
 * - EXTERNAL_PROTOCOL      → always block
 * - DESTRUCTIVE            → always ask regardless of policy
 * - AUTHENTICATION         → always ask
 * - DOWNLOAD               → always ask
 * - UPLOAD                 → always ask
 * - ACCOUNT_CHANGE         → always ask
 */
export function evaluateBrowserPolicy(
  risk: BrowserActionRisk,
  agentPolicy: BrowserAgentAccessPolicy,
): BrowserActionDecision {
  // EXTERNAL_PROTOCOL is always blocked — deterministic
  if (risk === "EXTERNAL_PROTOCOL") return "block";

  if (agentPolicy === "off") {
    // Only allow read operations when policy is off (passive observation — disabled for V1)
    return "block";
  }

  // High-risk actions always require approval regardless of policy level
  const alwaysAsk: BrowserActionRisk[] = [
    "AUTHENTICATION",
    "FORM_SUBMISSION",
    "DOWNLOAD",
    "UPLOAD",
    "ACCOUNT_CHANGE",
    "DESTRUCTIVE",
    "UNKNOWN",
  ];
  if (alwaysAsk.includes(risk)) return "ask";

  if (agentPolicy === "ask") {
    // READ and NAVIGATION are auto-allowed; everything else requires approval
    if (risk === "READ" || risk === "NAVIGATION") return "allow";
    return "ask";
  }

  // agentPolicy === "allowed"
  // READ, NAVIGATION, and normal INTERACTION are auto-allowed
  if (risk === "READ" || risk === "NAVIGATION" || risk === "INTERACTION") return "allow";
  return "ask";
}

/** Combined: classify + evaluate in one call. */
export function assessBrowserAction(
  ctx: PolicyContext,
  agentPolicy: BrowserAgentAccessPolicy,
): { risk: BrowserActionRisk; decision: BrowserActionDecision } {
  const risk = classifyBrowserActionRisk(ctx);
  const decision = evaluateBrowserPolicy(risk, agentPolicy);
  return { risk, decision };
}