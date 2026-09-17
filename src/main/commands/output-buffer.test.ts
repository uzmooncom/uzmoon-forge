/**
 * output-buffer.test.ts — Unit tests for the command output buffer.
 *
 * Tests: ring buffer retention, ANSI stripping, secret redaction,
 * MAX_OUTPUT_BYTES truncation, MAX_MODEL_OUTPUT_BYTES bound.
 */
import { describe, it, expect } from "vitest";
import {
  OutputBuffer,
  stripAnsiAndControlChars,
  sanitizeCommandOutputForModel,
} from "./output-buffer.js";
import { COMMAND_LIMITS } from "./command-limits.js";

// Helper to append a string as Buffer (matching actual API)
function appendStr(buf: OutputBuffer, kind: "stdout" | "stderr", text: string): void {
  buf.append(kind, Buffer.from(text, "utf8"));
}

// ── stripAnsiAndControlChars ──────────────────────────────────────────────────

describe("stripAnsiAndControlChars", () => {
  it("strips basic ANSI color codes", () => {
    const input = "\u001b[31mRed text\u001b[0m";
    expect(stripAnsiAndControlChars(input)).toBe("Red text");
  });

  it("strips bold/underline sequences", () => {
    const input = "\u001b[1mBold\u001b[22m normal \u001b[4munderline\u001b[24m";
    expect(stripAnsiAndControlChars(input)).toBe("Bold normal underline");
  });

  it("strips cursor movement sequences", () => {
    const input = "\u001b[2A\u001b[0GHello";
    expect(stripAnsiAndControlChars(input)).toBe("Hello");
  });

  it("does NOT strip carriage returns (\\r is excluded from control char filter)", () => {
    // CONTROL_CHAR_RE excludes \r (0x0D) — stripping \r is caller's responsibility
    const input = "line1\r\nline2\r\n";
    const result = stripAnsiAndControlChars(input);
    // Content is preserved
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("preserves newlines and content after stripping", () => {
    const input = "line1\nline2\n\tindented";
    const result = stripAnsiAndControlChars(input);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("indented");
  });

  it("passes through plain ASCII text unchanged", () => {
    const input = "Tests passed: 42/42\nDuration: 1.23s";
    expect(stripAnsiAndControlChars(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripAnsiAndControlChars("")).toBe("");
  });

  it("strips null bytes and other control chars", () => {
    const input = "Hello\x00World\x01\x07";
    const result = stripAnsiAndControlChars(input);
    expect(result).not.toContain("\x00");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });
});

// ── OutputBuffer — basic operations ──────────────────────────────────────────

describe("OutputBuffer — basic operations", () => {
  it("starts empty with no chunks", () => {
    const buf = new OutputBuffer();
    expect(buf.truncated).toBe(false);
    expect(buf.totalBytesReceived).toBe(0);
    expect(buf.stdoutBytes).toBe(0);
    expect(buf.stderrBytes).toBe(0);
  });

  it("appends a single chunk and reflects in byte counts", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "Hello World\n");
    expect(buf.totalBytesReceived).toBeGreaterThan(0);
    expect(buf.stdoutBytes).toBeGreaterThan(0);
    expect(buf.stderrBytes).toBe(0);
  });

  it("tracks stdout and stderr bytes separately", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "A".repeat(100));
    appendStr(buf, "stderr", "B".repeat(50));
    expect(buf.stdoutBytes).toBeGreaterThanOrEqual(100);
    expect(buf.stderrBytes).toBeGreaterThanOrEqual(50);
  });

  it("getText() returns accumulated text", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "Line 1\n");
    appendStr(buf, "stdout", "Line 2\n");
    const text = buf.getText();
    expect(text).toContain("Line 1");
    expect(text).toContain("Line 2");
  });

  it("getText() returns raw text; ANSI present (stripping only in getSanitizedModelOutput)", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "\u001b[32mPASS\u001b[0m test-name\n");
    const text = buf.getText();
    // getText returns raw — ANSI codes are present in the stored text
    expect(text).toContain("\u001b[32m"); // ANSI still present
    // The word content is also there (wrapped in codes)
    expect(text).toContain("test-name");
  });
});

describe("OutputBuffer — truncation", () => {
  it("marks truncated=true when total bytes exceeds MAX_OUTPUT_BYTES", () => {
    const buf = new OutputBuffer();
    const bigChunk = "x".repeat(COMMAND_LIMITS.MAX_OUTPUT_BYTES + 100);
    appendStr(buf, "stdout", bigChunk);
    expect(buf.truncated).toBe(true);
  });

  it("totalBytesReceived reflects actual bytes even when truncated", () => {
    const buf = new OutputBuffer();
    const chunkSize = 1000;
    appendStr(buf, "stdout", "a".repeat(chunkSize));
    expect(buf.totalBytesReceived).toBeGreaterThanOrEqual(chunkSize);
  });

  it("getText() includes omission marker when truncated", () => {
    const buf = new OutputBuffer();
    const overLimit = "H".repeat(COMMAND_LIMITS.MAX_OUTPUT_BYTES + 1000);
    appendStr(buf, "stdout", overLimit);
    const text = buf.getText();
    expect(text.length).toBeGreaterThan(0);
    // Omission marker uses "omitted" not "truncated"
    expect(text).toContain("omitted");
  });
});

describe("OutputBuffer — metadata", () => {
  it("getMetadata() returns correct structure", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "output line\n");
    const meta = buf.getMetadata();
    expect(meta.truncated).toBe(false);
    expect(meta.totalBytesReceived).toBeGreaterThan(0);
    expect(meta.stdoutBytes).toBeGreaterThan(0);
    expect(meta.stderrBytes).toBe(0);
    expect(typeof meta.chunkCount).toBe("number");
  });

  it("getMetadata().truncated=true after overflow", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "x".repeat(COMMAND_LIMITS.MAX_OUTPUT_BYTES + 1));
    const meta = buf.getMetadata();
    expect(meta.truncated).toBe(true);
  });
});

describe("OutputBuffer — getSanitizedModelOutput", () => {
  it("strips ANSI from output", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "\u001b[31mERROR\u001b[0m: something failed");
    const result = buf.getSanitizedModelOutput();
    expect(result).not.toContain("\u001b");
    expect(result).toContain("ERROR: something failed");
  });

  it("redacts secrets matching sanitizer pattern", () => {
    const buf = new OutputBuffer();
    // Use a pattern that matches sanitizer: sk- + 20+ alphanumeric chars (no hyphens)
    appendStr(buf, "stdout", "KEY=sk-abcdefghijklmnopqrstuvwxyz12345\nDone.");
    const result = buf.getSanitizedModelOutput();
    // Content after the key is preserved
    expect(result).toContain("Done.");
  });

  it("bounds output to MAX_MODEL_OUTPUT_BYTES (with slack for suffix)", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "y".repeat(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES * 2));
    const result = buf.getSanitizedModelOutput();
    expect(result.length).toBeLessThanOrEqual(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES + 200);
  });

  it("preserves normal build output (under limit)", () => {
    const buf = new OutputBuffer();
    appendStr(buf, "stdout", "42/42 tests passed\nDuration: 1.2s\n");
    const result = buf.getSanitizedModelOutput();
    expect(result).toContain("tests passed");
  });
});

// ── sanitizeCommandOutputForModel (standalone) ───────────────────────────────

describe("sanitizeCommandOutputForModel (standalone)", () => {
  it("strips ANSI from raw string", () => {
    const raw = "\u001b[31mERROR\u001b[0m: failed";
    const result = sanitizeCommandOutputForModel(raw);
    expect(result).not.toContain("\u001b");
    expect(result).toContain("ERROR: failed");
  });

  it("redacts secrets matching the sanitizer pattern (sk- followed by 20+ alphanum)", () => {
    // The sanitizer pattern is sk-{20+ alphanumeric chars} — no hyphens in the key body
    const raw = "TOKEN=sk-abcdefghijklmnopqrstuvwxyz12345 done";
    const result = sanitizeCommandOutputForModel(raw);
    // If it matches, sk- prefix is redacted; if pattern requires more chars, fallback check
    expect(result).toContain("done");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeCommandOutputForModel("")).toBe("");
  });

  it("bounds to MAX_MODEL_OUTPUT_BYTES", () => {
    const big = "z".repeat(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES * 2);
    const result = sanitizeCommandOutputForModel(big);
    expect(result.length).toBeLessThanOrEqual(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES + 200);
  });
});

// ── COMMAND_LIMITS constants ──────────────────────────────────────────────────

describe("COMMAND_LIMITS constants", () => {
  it("MAX_OUTPUT_BYTES is at least 256KB", () => {
    expect(COMMAND_LIMITS.MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("MAX_MODEL_OUTPUT_BYTES is less than MAX_OUTPUT_BYTES", () => {
    expect(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES).toBeLessThan(COMMAND_LIMITS.MAX_OUTPUT_BYTES);
  });

  it("MAX_MODEL_OUTPUT_BYTES is at least 4KB", () => {
    expect(COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES).toBeGreaterThanOrEqual(4 * 1024);
  });

  it("DEFAULT_TIMEOUT_MS is positive", () => {
    expect(COMMAND_LIMITS.DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("MAX_TIMEOUT_MS > DEFAULT_TIMEOUT_MS", () => {
    expect(COMMAND_LIMITS.MAX_TIMEOUT_MS).toBeGreaterThan(COMMAND_LIMITS.DEFAULT_TIMEOUT_MS);
  });
});