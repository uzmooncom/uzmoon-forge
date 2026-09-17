/**
 * sanitizer.ts — Incident Sanitizer.
 *
 * Sanitizes incident data BEFORE persistence and BEFORE sharing.
 * Security requirements (§80, §98):
 *   - No secrets (API keys, passwords, tokens)
 *   - No absolute filesystem paths
 *   - No raw user prompts or file content by default
 *   - No cross-project data leakage
 *   - No remote executable payload
 *
 * This module is self-contained with no external dependencies
 * (other than homedir resolution).
 */

import os from "os";

// ── Known secret patterns ─────────────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: "api_key_assignment", pattern: /api[_\s-]?key[\s:=]+["']?[A-Za-z0-9\-_]{16,}["']?/gi },
  { name: "sk_live_key", pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "password_assignment", pattern: /password[\s:=]+["']?[^\s"']{4,}["']?/gi },
  { name: "token_assignment", pattern: /token[\s:=]+["']?[A-Za-z0-9\-_.]{16,}["']?/gi },
  { name: "authorization_header", pattern: /authorization:\s*[^\s\n]{8,}/gi },
  { name: "x_api_key_header", pattern: /x-api-key:\s*[^\s\n]{8,}/gi },
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "generic_secret", pattern: /secret[\s:=]+["']?[A-Za-z0-9\-_]{8,}["']?/gi },
];

const HOME_DIR = os.homedir();

// ── Path pattern ──────────────────────────────────────────────────────────────

/** Matches absolute Unix-style paths with user home component */
const ABS_PATH_PATTERN = new RegExp(HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\\s\"'\\],}]*", "g");

/** Matches generic absolute paths (starts with / followed by a word char) */
const GENERIC_ABS_PATH = /\/(?:Users|home|var|tmp|etc|usr|opt|private)[/][^\s"'\\,}]*/g;

// ── Sanitization functions ────────────────────────────────────────────────────

/**
 * Redact secrets from a string value.
 * Returns the redacted string.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Redact absolute filesystem paths from a string value.
 * Replaces home-containing paths with <path-redacted>.
 */
export function redactAbsolutePaths(text: string): string {
  // Home-rooted paths first (more specific)
  let result = text.replace(ABS_PATH_PATTERN, "<path-redacted>");
  // Generic system absolute paths
  result = result.replace(GENERIC_ABS_PATH, "<path-redacted>");
  return result;
}

/**
 * Sanitize a string for inclusion in a report.
 * Applies both secret and path redaction.
 */
export function sanitizeString(text: string): string {
  return redactAbsolutePaths(redactSecrets(text));
}

/**
 * Sanitize a JSON-serializable value recursively.
 * Objects and arrays are traversed. Strings are sanitized.
 * Non-primitive, non-string leaves are kept as-is.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[truncated-deep]";
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop high-sensitivity keys entirely
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Object keys that are always fully redacted */
const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "apiKey",
  "password",
  "secret",
  "token",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "sessiontoken",
  "session_token",
]);

/**
 * Sanitize an observedState/expectedState record for incident storage.
 * - Redacts secrets
 * - Redacts absolute paths
 * - Drops known sensitive keys
 * - Does NOT include raw prompt/file content (use the content-omit flag)
 */
export function sanitizeState(
  state: Record<string, unknown>,
  opts: { omitContent?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    const keyLower = k.toLowerCase();

    // Drop raw content unless explicitly allowed
    if (
      opts.omitContent &&
      (keyLower === "content" ||
        keyLower === "rawcontent" ||
        keyLower === "filechunk" ||
        keyLower === "prompt" ||
        keyLower === "systemprompt" ||
        keyLower === "message" ||
        keyLower === "usertext")
    ) {
      out[k] = "[omitted]";
      continue;
    }

    out[k] = sanitizeValue(v);
  }
  return out;
}

/**
 * Build a sanitized GitHub issue payload from an incident.
 * This is the ONLY artifact safe for external sharing.
 * It strips: API keys, absolute paths, raw prompts, file content.
 *
 * Per §94: This generates the payload; actual GitHub API submission
 * requires authorized integration. This module never calls GitHub.
 */
export function buildGitHubIssuePayload(opts: {
  invariantId: string;
  failureCode: string;
  category: string;
  severity: string;
  fingerprint: string;
  forgeVersion: string;
  runtimeSchemaVersion: number;
  observedState: Record<string, unknown>;
  traceId?: string;
  occurrenceCount?: number;
}): {
  title: string;
  labels: string[];
  body: string;
  fingerprint: string;
} {
  const sanitizedState = sanitizeState(opts.observedState, { omitContent: true });

  const title = `[${opts.category}] ${opts.invariantId} — ${opts.failureCode}`;

  const labels = [
    `category:${opts.category.toLowerCase()}`,
    `severity:${opts.severity}`,
    `invariant:${opts.invariantId.toLowerCase().replace(/_/g, "-")}`,
    "automated-report",
  ];

  const body = [
    `## Incident Report`,
    ``,
    `**Invariant**: \`${opts.invariantId}\``,
    `**Failure Code**: \`${opts.failureCode}\``,
    `**Category**: ${opts.category}`,
    `**Severity**: ${opts.severity}`,
    `**Fingerprint**: \`${opts.fingerprint}\``,
    `**Forge Version**: ${opts.forgeVersion}`,
    `**Runtime Schema**: v${opts.runtimeSchemaVersion}`,
    ...(opts.occurrenceCount !== undefined
      ? [`**Occurrences**: ${opts.occurrenceCount}`]
      : []),
    ...(opts.traceId ? [`**Trace ID**: \`${opts.traceId}\``] : []),
    ``,
    `### Observed State`,
    `\`\`\`json`,
    JSON.stringify(sanitizedState, null, 2),
    `\`\`\``,
    ``,
    `---`,
    `*This report was generated by Forge Reliability Subsystem.*`,
    `*Sensitive data (API keys, file paths, prompts) has been automatically redacted.*`,
  ].join("\n");

  return { title, labels, body, fingerprint: opts.fingerprint };
}

/**
 * Verify no secrets remain in a payload string.
 * Returns list of detected pattern names (empty = clean).
 * Used by tests to assert sanitization completeness.
 */
export function detectResidualSecrets(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    // Clone pattern to reset lastIndex for /g patterns
    const clone = new RegExp(pattern.source, pattern.flags);
    if (clone.test(text)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Verify no absolute paths remain in a payload string.
 * Returns true if clean.
 */
export function hasNoAbsolutePaths(text: string): boolean {
  const homeClone = new RegExp(ABS_PATH_PATTERN.source, ABS_PATH_PATTERN.flags);
  const genericClone = new RegExp(GENERIC_ABS_PATH.source, GENERIC_ABS_PATH.flags);
  return !homeClone.test(text) && !genericClone.test(text);
}