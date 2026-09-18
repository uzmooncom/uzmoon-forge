import { describe, it, expect, beforeEach } from "vitest";
import { ForgeLogger } from "./logger.js";

describe("ForgeLogger", () => {
  let logger: ForgeLogger;

  beforeEach(() => {
    logger = new ForgeLogger({ minLevel: "trace", devMode: false });
  });

  it("stores structured log entries", () => {
    logger.info("runtime", "RUN_STARTED", { conversationId: "conv-1", requestId: "req-1" });
    const entries = logger.getAll();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.level).toBe("info");
    expect(e.category).toBe("runtime");
    expect(e.event).toBe("RUN_STARTED");
    expect(e.conversationId).toBe("conv-1");
    expect(e.requestId).toBe("req-1");
    expect(e.timestamp).toBeGreaterThan(0);
    expect(e.id).toBe(1);
  });

  it("assigns monotonically increasing IDs", () => {
    logger.info("queue", "A");
    logger.info("queue", "B");
    logger.info("queue", "C");
    const ids = logger.getAll().map((e) => e.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("respects minLevel filter", () => {
    const warnLogger = new ForgeLogger({ minLevel: "warn", devMode: false });
    warnLogger.debug("runtime", "ignored");
    warnLogger.info("runtime", "also-ignored");
    warnLogger.warn("runtime", "kept");
    warnLogger.error("runtime", "also-kept");
    const entries = warnLogger.getAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.event)).toEqual(["kept", "also-kept"]);
  });

  it("captures error message and stack in dev mode", () => {
    const devLogger = new ForgeLogger({ minLevel: "trace", devMode: true });
    const err = new Error("boom");
    devLogger.error("reliability", "TEST_ERROR", { error: err });
    const entry = devLogger.getAll()[0]!;
    expect(entry.errorMessage).toBe("boom");
    expect(entry.errorStack).toContain("boom");
  });

  it("does not capture error stack in prod mode", () => {
    const prodLogger = new ForgeLogger({ minLevel: "info", devMode: false });
    prodLogger.error("reliability", "TEST_ERROR", { error: new Error("no-stack") });
    const entry = prodLogger.getAll()[0]!;
    expect(entry.errorMessage).toBe("no-stack");
    expect(entry.errorStack).toBeUndefined();
  });

  it("query() filters by minLevel", () => {
    logger.debug("runtime", "debug-event");
    logger.warn("runtime", "warn-event");
    logger.error("runtime", "error-event");
    const results = logger.query({ minLevel: "warn" });
    expect(results.map((e) => e.event)).toEqual(["warn-event", "error-event"]);
  });

  it("query() filters by category", () => {
    logger.info("runtime", "runtime-event");
    logger.info("browser", "browser-event");
    logger.info("queue", "queue-event");
    const results = logger.query({ category: "browser" });
    expect(results).toHaveLength(1);
    expect(results[0]!.event).toBe("browser-event");
  });

  it("query() filters by conversationId", () => {
    logger.info("runtime", "A", { conversationId: "conv-1" });
    logger.info("runtime", "B", { conversationId: "conv-2" });
    logger.info("runtime", "C", { conversationId: "conv-1" });
    const results = logger.query({ conversationId: "conv-1" });
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.event)).toEqual(["A", "C"]);
  });

  it("query() text search across event and metadata", () => {
    logger.info("runtime", "RUN_STARTED", { metadata: { goal: "search the web" } });
    logger.info("runtime", "RUN_COMPLETED");
    const results = logger.query({ search: "search" });
    expect(results).toHaveLength(1);
    expect(results[0]!.event).toBe("RUN_STARTED");
  });

  it("query() limits result count", () => {
    for (let i = 0; i < 20; i++) logger.info("queue", `event-${i}`);
    const results = logger.query({ limit: 5 });
    expect(results).toHaveLength(5);
    // should be the 5 most recent
    expect(results[results.length - 1]!.event).toBe("event-19");
  });

  it("clear() empties the buffer", () => {
    logger.info("runtime", "A");
    logger.info("runtime", "B");
    logger.clear();
    expect(logger.getAll()).toHaveLength(0);
    expect(logger.entryCount).toBe(0);
  });

  it("setMinLevel() changes filtering", () => {
    logger.setMinLevel("error");
    logger.info("runtime", "ignored");
    logger.error("runtime", "kept");
    expect(logger.getAll()).toHaveLength(1);
    expect(logger.getAll()[0]!.event).toBe("kept");
  });

  it("redacts API key in metadata", () => {
    logger.info("security", "CONFIG_LOADED", {
      metadata: { apiKey: "sk-live-abc123verylongkey", model: "gpt-4" },
    });
    const entry = logger.getAll()[0]!;
    const serialized = JSON.stringify(entry.metadata);
    // apiKey value should be redacted
    expect(serialized).not.toContain("sk-live-abc123verylongkey");
    // non-sensitive field should remain
    expect(entry.metadata?.["model"]).toBe("gpt-4");
  });

  it("ring buffer overflows after capacity", () => {
    const smallLogger = new ForgeLogger({ capacity: 5, minLevel: "trace", devMode: false });
    for (let i = 0; i < 10; i++) smallLogger.info("queue", `event-${i}`);
    const entries = smallLogger.getAll();
    expect(entries).toHaveLength(5);
    expect(entries[0]!.event).toBe("event-5");
    expect(entries[4]!.event).toBe("event-9");
  });

  it("convenience methods (trace/debug/info/warn/error/fatal) all work", () => {
    logger.trace("runtime", "TRACE");
    logger.debug("runtime", "DEBUG");
    logger.info("runtime", "INFO");
    logger.warn("runtime", "WARN");
    logger.error("runtime", "ERROR");
    logger.fatal("runtime", "FATAL");
    const levels = logger.getAll().map((e) => e.level);
    expect(levels).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
  });
});