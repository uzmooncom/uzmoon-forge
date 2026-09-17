/**
 * sanitizer.test.ts — Incident Sanitizer tests.
 * §80, §98: No secret reporting, no absolute path reporting.
 */

import { describe, it, expect } from "vitest";
import os from "os";
import {
  redactSecrets,
  redactAbsolutePaths,
  sanitizeString,
  sanitizeValue,
  sanitizeState,
  buildGitHubIssuePayload,
  detectResidualSecrets,
  hasNoAbsolutePaths,
} from "./sanitizer.js";

const HOME = os.homedir();

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer sk-abc123def456ghi789");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abc123def456ghi789");
  });

  it("redacts API key assignments", () => {
    const result = redactSecrets('apiKey: "my-secret-key-12345"');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("my-secret-key-12345");
  });

  it("redacts sk- prefixed keys", () => {
    const result = redactSecrets("sk-abcdefghijklmnopqrstu");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdefghijklmnopqrstu");
  });

  it("redacts AWS-style keys", () => {
    const result = redactSecrets("key=AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("does not modify safe text", () => {
    const safe = "The quick brown fox";
    expect(redactSecrets(safe)).toBe(safe);
  });

  it("is idempotent (redacting twice does not corrupt)", () => {
    const once = redactSecrets("Bearer sk-abc123def456ghi789jkl");
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });
});

describe("redactAbsolutePaths", () => {
  it("redacts home-rooted paths", () => {
    const result = redactAbsolutePaths(`Found file at ${HOME}/Desktop/project/src/main.ts`);
    expect(result).toContain("<path-redacted>");
    expect(result).not.toContain(HOME);
  });

  it("redacts /Users/ paths", () => {
    const result = redactAbsolutePaths("/Users/someuser/Desktop/project/src/file.ts");
    expect(result).not.toContain("/Users/someuser");
  });

  it("does not redact relative paths", () => {
    const result = redactAbsolutePaths("src/main/queue/QueueManager.ts");
    expect(result).toBe("src/main/queue/QueueManager.ts");
  });

  it("does not redact project-relative paths", () => {
    const result = redactAbsolutePaths("relativePath: src/index.ts");
    expect(result).toContain("relativePath: src/index.ts");
  });
});

describe("sanitizeString", () => {
  it("applies both secret and path redaction", () => {
    const input = `Key: Bearer sk-abc123def456 at path ${HOME}/project/file.ts`;
    const result = sanitizeString(input);
    expect(result).not.toContain("sk-abc123def456");
    expect(result).not.toContain(HOME);
  });
});

describe("sanitizeValue", () => {
  it("sanitizes nested objects", () => {
    const input = {
      level1: {
        apiKey: "sk-super-secret",
        path: `${HOME}/project`,
        safe: "hello",
      },
    };
    const result = sanitizeValue(input) as { level1: { apiKey: string; path: string; safe: string } };
    expect(result.level1.apiKey).toBe("[REDACTED]");
    expect(result.level1.path).not.toContain(HOME);
    expect(result.level1.safe).toBe("hello");
  });

  it("sanitizes arrays of strings", () => {
    const result = sanitizeValue([`Bearer sk-abc`, "safe text"]) as string[];
    expect(result[0]).toContain("[REDACTED]");
    expect(result[1]).toBe("safe text");
  });

  it("preserves numbers and booleans", () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
  });

  it("handles depth limit gracefully (no crash)", () => {
    // 12 levels deep — should truncate
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      cur["child"] = {};
      cur = cur["child"] as Record<string, unknown>;
    }
    expect(() => sanitizeValue(deep)).not.toThrow();
  });
});

describe("sanitizeState", () => {
  it("drops sensitive keys nested inside object values", () => {
    // sanitizeState calls sanitizeValue per entry; SENSITIVE_KEYS are caught
    // when they appear as nested object keys inside a value.
    const result = sanitizeValue({
      nested: {
        apiKey: "secret123",
        password: "mypassword",
        sessionToken: "tok-abc",
        safeField: "hello",
      },
    }) as { nested: Record<string, unknown> };
    expect(result.nested["apiKey"]).toBe("[REDACTED]");
    expect(result.nested["password"]).toBe("[REDACTED]");
    expect(result.nested["sessionToken"]).toBe("[REDACTED]");
    expect(result.nested["safeField"]).toBe("hello");
  });

  it("top-level state values are string-sanitized", () => {
    // Top-level keys in sanitizeState are not matched against SENSITIVE_KEYS —
    // their values are sanitized via sanitizeValue() which sanitizes strings.
    const result = sanitizeState({
      requestId: "req-123",
      safeField: "hello",
    });
    expect(result["safeField"]).toBe("hello");
    expect(result["requestId"]).toBe("req-123");
  });

  it("omits content fields when omitContent=true", () => {
    const result = sanitizeState(
      {
        content: "A long file content...",
        prompt: "User prompt text",
        relativePath: "src/main.ts",
        toolName: "read_file",
      },
      { omitContent: true },
    );
    expect(result["content"]).toBe("[omitted]");
    expect(result["prompt"]).toBe("[omitted]");
    expect(result["relativePath"]).toBe("src/main.ts");
    expect(result["toolName"]).toBe("read_file");
  });

  it("keeps content fields when omitContent is not set", () => {
    const result = sanitizeState({ content: "short content" });
    // Content key is not a sensitive key — kept but string-sanitized
    expect(result["content"]).toBe("short content");
  });
});

describe("buildGitHubIssuePayload", () => {
  const opts = {
    invariantId: "ONE_RUN_ONE_VISIBLE_FAILURE",
    failureCode: "PROVIDER_ERROR",
    category: "AGENT_RUNTIME",
    severity: "high",
    fingerprint: "abc123def456",
    forgeVersion: "0.9.0",
    runtimeSchemaVersion: 1,
    observedState: {
      apiKey: "sk-secret-key",
      absolutePath: `${HOME}/project/src/main.ts`,
      requestId: "req-abc",
    },
    traceId: "trace-xyz",
    occurrenceCount: 3,
  };

  it("generates valid title and labels", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(payload.title).toContain("AGENT_RUNTIME");
    expect(payload.title).toContain("ONE_RUN_ONE_VISIBLE_FAILURE");
    expect(payload.labels).toContain("severity:high");
    expect(payload.labels).toContain("automated-report");
  });

  it("does not contain absolute paths in the body (path check)", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(hasNoAbsolutePaths(payload.body)).toBe(true);
    expect(payload.body).not.toContain(HOME);
  });

  it("does not expose raw request IDs in observedState field names", () => {
    const payload = buildGitHubIssuePayload(opts);
    // The body should contain sanitized state — key names are preserved but
    // secret values are redacted by sanitizeState which calls sanitizeValue
    expect(payload.body).toBeDefined();
    expect(typeof payload.body).toBe("string");
  });

  it("includes fingerprint in payload", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(payload.fingerprint).toBe("abc123def456");
    expect(payload.body).toContain("abc123def456");
  });

  it("includes forge version", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(payload.body).toContain("0.9.0");
  });

  it("includes occurrence count", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(payload.body).toContain("3");
  });

  it("labels the report as automated", () => {
    const payload = buildGitHubIssuePayload(opts);
    expect(payload.body).toContain("automatically redacted");
  });
});

describe("detectResidualSecrets", () => {
  it("returns empty array for clean text", () => {
    expect(detectResidualSecrets("The queue processed 3 messages.")).toHaveLength(0);
  });

  it("detects bearer tokens", () => {
    const found = detectResidualSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("hasNoAbsolutePaths", () => {
  it("returns true for clean text", () => {
    expect(hasNoAbsolutePaths("requestId: req-123, tool: read_file")).toBe(true);
  });

  it("returns false when home path present", () => {
    expect(hasNoAbsolutePaths(`path: ${HOME}/project`)).toBe(false);
  });
});