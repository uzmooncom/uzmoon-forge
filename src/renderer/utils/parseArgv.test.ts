/**
 * parseArgv.test.ts — Unit tests for the safe argv parser.
 */
import { describe, it, expect } from "vitest";
import { parseArgv } from "./parseArgv.js";

describe("parseArgv — valid inputs", () => {
  it("parses a simple command with no args", () => {
    const result = parseArgv("pnpm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("pnpm");
    expect(result.args).toEqual([]);
  });

  it("parses command with args", () => {
    const result = parseArgv("pnpm test --reporter=verbose");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("pnpm");
    expect(result.args).toEqual(["test", "--reporter=verbose"]);
  });

  it("trims leading and trailing whitespace", () => {
    const result = parseArgv("  node --version  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("node");
    expect(result.args).toEqual(["--version"]);
  });

  it("handles multiple args", () => {
    const result = parseArgv("python3 -m pytest tests/ -v --tb=short");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("python3");
    expect(result.args).toEqual(["-m", "pytest", "tests/", "-v", "--tb=short"]);
  });

  it("allows path separators (forward slash) in args", () => {
    const result = parseArgv("cat src/index.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("cat");
    expect(result.args).toEqual(["src/index.ts"]);
  });

  it("allows hyphens and underscores", () => {
    const result = parseArgv("my-tool --some-flag some_value");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("my-tool");
    expect(result.args).toEqual(["--some-flag", "some_value"]);
  });

  it("allows dots in args (file extensions)", () => {
    const result = parseArgv("node scripts/check.js");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("node");
    expect(result.args).toEqual(["scripts/check.js"]);
  });

  it("allows = in args (--key=value form)", () => {
    const result = parseArgv("vitest --reporter=dot --coverage");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toContain("--reporter=dot");
  });

  it("allows numbers in executable and args", () => {
    const result = parseArgv("python3 -m pytest");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe("python3");
  });
});

describe("parseArgv — rejected inputs (shell operators)", () => {
  const shellOps = [
    "|",
    ";",
    "&",
    ">",
    "<",
    "`",
    "$",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    "*",
    "?",
    "\\",
  ];

  for (const op of shellOps) {
    it(`rejects input containing shell operator: ${JSON.stringify(op)}`, () => {
      const result = parseArgv(`pnpm test ${op} other`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorMessage).toContain("not allowed");
    });
  }

  it("rejects pipe composition (ls | grep)", () => {
    const result = parseArgv("ls | grep foo");
    expect(result.ok).toBe(false);
  });

  it("rejects command chaining (npm install && npm test)", () => {
    const result = parseArgv("npm install && npm test");
    expect(result.ok).toBe(false);
  });

  it("rejects output redirection (echo foo > file.txt)", () => {
    const result = parseArgv("echo foo > file.txt");
    expect(result.ok).toBe(false);
  });

  it("rejects backtick subshell", () => {
    const result = parseArgv("echo `whoami`");
    expect(result.ok).toBe(false);
  });

  it("rejects dollar-sign variable expansion", () => {
    const result = parseArgv("echo $HOME");
    expect(result.ok).toBe(false);
  });

  it("rejects glob patterns", () => {
    const result = parseArgv("cat src/*.ts");
    expect(result.ok).toBe(false);
  });
});

describe("parseArgv — empty inputs", () => {
  it("rejects empty string", () => {
    const result = parseArgv("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorMessage).toBeTruthy();
  });

  it("rejects whitespace-only string", () => {
    const result = parseArgv("   ");
    expect(result.ok).toBe(false);
  });

  it("error message is user-friendly for shell ops", () => {
    const result = parseArgv("ls | grep");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorMessage.length).toBeGreaterThan(0);
  });
});