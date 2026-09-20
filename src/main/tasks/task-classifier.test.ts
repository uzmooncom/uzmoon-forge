/**
 * task-classifier.test.ts — Unit tests for task-classifier.ts
 *
 * Classification is intent/capability/context based — NOT word-count based.
 * Short action-intent messages MUST be classified as task in project mode.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { classifyMessage, isTaskRuntimeEnabled } from "./task-classifier.js";

// ── isTaskRuntimeEnabled ───────────────────────────────────────────────────

describe("isTaskRuntimeEnabled", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env["FORGE_TASKS_ENABLED"];
  });

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

  it("default (no env var set) is false — task runtime is opt-in", () => {
    delete process.env["FORGE_TASKS_ENABLED"];
    expect(isTaskRuntimeEnabled()).toBe(false);
  });
});

// ── Pure questions / conversational openers — always conversation ─────────

describe("classifyMessage — conversational messages", () => {
  it("pure question with ? → conversation", () => {
    expect(classifyMessage("What is TypeScript?", false)).toBe("conversation");
    expect(classifyMessage("How does React work?", false)).toBe("conversation");
    expect(classifyMessage("Can you explain this to me?", false)).toBe("conversation");
    expect(classifyMessage("What is TypeScript?", true)).toBe("conversation");
  });

  it("conversational openers → conversation", () => {
    expect(classifyMessage("Hi", false)).toBe("conversation");
    expect(classifyMessage("Hello there", false)).toBe("conversation");
    expect(classifyMessage("Yes", false)).toBe("conversation");
    expect(classifyMessage("Thanks!", true)).toBe("conversation");
    expect(classifyMessage("Sounds good", true)).toBe("conversation");
    expect(classifyMessage("Ok", true)).toBe("conversation");
  });

  it("'explain' / 'describe' without action → conversation", () => {
    expect(classifyMessage("Explain how this function works", false)).toBe("conversation");
    expect(classifyMessage("Describe the architecture", false)).toBe("conversation");
  });

  it("what-is / how-does without ? → still conversation (pattern match)", () => {
    expect(classifyMessage("What is the purpose of this module", false)).toBe("conversation");
    expect(classifyMessage("How does authentication work here", false)).toBe("conversation");
  });

  it("simple question in project mode → conversation", () => {
    expect(classifyMessage("What does this function do?", true)).toBe("conversation");
    expect(classifyMessage("How do I run the tests?", true)).toBe("conversation");
  });
});

// ── Short action-intent messages — must be task in project mode ───────────

describe("classifyMessage — short action-intent messages in project mode", () => {
  it('"Fix the bug" → task (action verb + object)', () => {
    expect(classifyMessage("Fix the bug", true)).toBe("task");
  });

  it('"Fix this" → task (action verb + object)', () => {
    expect(classifyMessage("Fix this", true)).toBe("task");
  });

  it('"Find and fix the issue" → task', () => {
    expect(classifyMessage("Find and fix the issue", true)).toBe("task");
  });

  it('"Check the design" → task (check implies verify, modify)', () => {
    expect(classifyMessage("Check the design", true)).toBe("task");
  });

  it('"Add a button" → task', () => {
    expect(classifyMessage("Add a button", true)).toBe("task");
  });

  it('"Remove the modal" → task', () => {
    expect(classifyMessage("Remove the modal", true)).toBe("task");
  });

  it('"Refactor this" → task', () => {
    expect(classifyMessage("Refactor this", true)).toBe("task");
  });

  it('"Debug the crash" → task', () => {
    expect(classifyMessage("Debug the crash", true)).toBe("task");
  });

  it('"Update the README" → task', () => {
    expect(classifyMessage("Update the README", true)).toBe("task");
  });

  it('"Implement the login flow" → task', () => {
    expect(classifyMessage("Implement the login flow", true)).toBe("task");
  });
});

// ── Simple actions in project mode ────────────────────────────────────────

describe("classifyMessage — simple actions in project mode", () => {
  it('"Run the project" → simple_action (matches SIMPLE_ACTION_PATTERNS)', () => {
    expect(classifyMessage("Run the project", true)).toBe("simple_action");
  });

  it('"Open the browser" → simple_action', () => {
    expect(classifyMessage("Open the browser now", true)).toBe("simple_action");
  });

  it('"Run the tests" → simple_action', () => {
    expect(classifyMessage("Run the tests", true)).toBe("simple_action");
  });

  it('"Take a screenshot" → simple_action', () => {
    expect(classifyMessage("Take a screenshot", true)).toBe("simple_action");
  });
});

// ── Multi-step / compound tasks ───────────────────────────────────────────

describe("classifyMessage — multi-step tasks", () => {
  it("multi-step instruction → task in project mode", () => {
    const msg = "Implement the user authentication flow, add tests, and update the documentation";
    expect(classifyMessage(msg, true)).toBe("task");
  });

  it("multi-sentence project request → task", () => {
    const msg = "Refactor the database layer. Make sure all tests still pass. Update the migration scripts.";
    expect(classifyMessage(msg, true)).toBe("task");
  });

  it("compound global chat task → task (2+ TASK_PATTERNS)", () => {
    const msg = "Implement a REST API endpoint, write tests for it, and then deploy to staging";
    expect(classifyMessage(msg, false)).toBe("task");
  });

  it("research + compound goal (global) → task", () => {
    const msg = "Research the best approaches for implementing a CI/CD pipeline and summarize your findings for me";
    expect(classifyMessage(msg, false)).toBe("task");
  });
});

// ── Non-project mode — conservative ──────────────────────────────────────

describe("classifyMessage — non-project mode (conservative)", () => {
  it("single task keyword with low word count → conversation in global mode", () => {
    expect(classifyMessage("Implement this please", false)).toBe("conversation");
  });

  it("short fix request in global mode → conversation (not project context)", () => {
    // Global mode is conservative — even "Fix the bug" stays conversation
    // without project context for safety
    expect(classifyMessage("Fix the bug", false)).toBe("conversation");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe("classifyMessage — edge cases", () => {
  it("empty message → conversation", () => {
    expect(classifyMessage("", false)).toBe("conversation");
    expect(classifyMessage("   ", false)).toBe("conversation");
  });

  it("is case-insensitive", () => {
    const lower = classifyMessage("implement the user auth flow with tests and docs", true);
    const upper = classifyMessage("IMPLEMENT THE USER AUTH FLOW WITH TESTS AND DOCS", true);
    expect(lower).toBe(upper);
  });

  it("classifier errors fall back to conversation (never crashes)", () => {
    // Should never throw
    expect(() => classifyMessage("any message", true)).not.toThrow();
    expect(() => classifyMessage("any message", false)).not.toThrow();
  });
});