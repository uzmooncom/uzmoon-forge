/**
 * task-classifier.test.ts — Unit tests for task-classifier.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import { classifyMessage, isTaskRuntimeEnabled } from "./task-classifier.js";

// ── isTaskRuntimeEnabled ───────────────────────────────────────────────────

describe("isTaskRuntimeEnabled", () => {
  const origEnv = process.env["FORGE_TASKS_ENABLED"];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env["FORGE_TASKS_ENABLED"];
    } else {
      process.env["FORGE_TASKS_ENABLED"] = origEnv;
    }
  });

  it("returns true when FORGE_TASKS_ENABLED=1", () => {
    process.env["FORGE_TASKS_ENABLED"] = "1";
    expect(isTaskRuntimeEnabled()).toBe(true);
  });

  it("returns true when FORGE_TASKS_ENABLED=true", () => {
    process.env["FORGE_TASKS_ENABLED"] = "true";
    expect(isTaskRuntimeEnabled()).toBe(true);
  });

  it("returns false when FORGE_TASKS_ENABLED is unset", () => {
    delete process.env["FORGE_TASKS_ENABLED"];
    expect(isTaskRuntimeEnabled()).toBe(false);
  });

  it("returns false when FORGE_TASKS_ENABLED=0", () => {
    process.env["FORGE_TASKS_ENABLED"] = "0";
    expect(isTaskRuntimeEnabled()).toBe(false);
  });

  it("returns false when FORGE_TASKS_ENABLED=false", () => {
    process.env["FORGE_TASKS_ENABLED"] = "false";
    expect(isTaskRuntimeEnabled()).toBe(false);
  });
});

// ── classifyMessage — Short messages ─────────────────────────────────────

describe("classifyMessage — short messages", () => {
  it("returns conversation for very short messages", () => {
    expect(classifyMessage("Hi", false)).toBe("conversation");
    expect(classifyMessage("Hello there", false)).toBe("conversation");
    expect(classifyMessage("Yes", false)).toBe("conversation");
  });

  it("returns conversation for pure questions", () => {
    expect(classifyMessage("What is TypeScript?", false)).toBe("conversation");
    expect(classifyMessage("How does React work?", false)).toBe("conversation");
    expect(classifyMessage("Can you explain this to me?", false)).toBe("conversation");
  });
});

// ── classifyMessage — Non-project mode ───────────────────────────────────

describe("classifyMessage — non-project mode", () => {
  it("returns conversation for simple action in global chat", () => {
    expect(classifyMessage("Fix the bug", false)).toBe("conversation");
  });

  it("returns conversation for single task indicator", () => {
    // Low word count + single task keyword → conversation in global mode
    expect(classifyMessage("Implement this feature please", false)).toBe("conversation");
  });

  it("returns task for strongly multi-step messages", () => {
    // Multiple task patterns → task
    const msg = "Implement a REST API endpoint, write tests for it, and then deploy to staging";
    expect(classifyMessage(msg, false)).toBe("task");
  });

  it("returns task for compound research goals with high word count", () => {
    const msg = "Research the best approaches for implementing a CI/CD pipeline and summarize your findings for me";
    expect(classifyMessage(msg, false)).toBe("task");
  });
});

// ── classifyMessage — Project mode ───────────────────────────────────────

describe("classifyMessage — project mode", () => {
  it("returns conversation for short messages below MIN_TASK_WORD_COUNT", () => {
    // 3 words < MIN_TASK_WORD_COUNT=6, no SIMPLE_ACTION_PATTERNS match → conversation
    expect(classifyMessage("Fix the bug", true)).toBe("conversation");
    expect(classifyMessage("Add a button", true)).toBe("conversation");
  });

  it("returns simple_action for 'Open the browser' (matches SIMPLE_ACTION_PATTERNS[0])", () => {
    // /^(open|close|show|hide|navigate|go to|browse to|open the browser)\b/
    expect(classifyMessage("Open the browser now", true)).toBe("simple_action");
  });

  it("returns task for multi-step instructions", () => {
    const msg = "Implement the user authentication flow, add tests, and update the documentation";
    expect(classifyMessage(msg, true)).toBe("task");
  });

  it("returns task for multi-sentence project request", () => {
    const msg = "Refactor the database layer. Make sure all tests still pass. Update the migration scripts.";
    expect(classifyMessage(msg, true)).toBe("task");
  });

  it("returns task for long action verb sentences in project mode", () => {
    const msg = "Implement the entire authentication system including login, registration, and password reset functionality";
    expect(classifyMessage(msg, true)).toBe("task");
  });

  it("returns conversation for a simple question in project mode", () => {
    expect(classifyMessage("What does this function do?", true)).toBe("conversation");
  });

  it("returns conversation for very short message in project mode", () => {
    expect(classifyMessage("Run tests", true)).toBe("conversation");
  });
});

// ── classifyMessage — Edge cases ─────────────────────────────────────────

describe("classifyMessage — edge cases", () => {
  it("handles messages with just whitespace as short", () => {
    expect(classifyMessage("   ", false)).toBe("conversation");
  });

  it("is case-insensitive", () => {
    const lower = classifyMessage("implement the user auth flow with tests and docs", true);
    const upper = classifyMessage("IMPLEMENT THE USER AUTH FLOW WITH TESTS AND DOCS", true);
    expect(lower).toBe(upper);
  });
});