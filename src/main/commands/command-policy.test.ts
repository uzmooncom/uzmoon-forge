/**
 * command-policy.test.ts — Unit tests for the command policy engine.
 *
 * Tests: risk class mapping, BLOCK/ASK decisions, trust rule matching,
 * BLOCK-always-wins, remote execution always blocked.
 */
import { describe, it, expect } from "vitest";
import { classifyRisk, evaluatePolicy, normalizeSpec } from "./command-policy.js";
import type { CommandSpec, CommandTrustRule } from "../../shared/types.js";

function spec(executable: string, args: string[] = [], cwdRelative = ""): CommandSpec {
  return { executable, args, cwdRelative };
}

function trustRule(executable: string, args: string[], cwdRelative = ""): CommandTrustRule {
  return {
    id: "rule-1",
    projectId: "proj-1",
    normalizedSpec: normalizeSpec({ executable, args, cwdRelative }),
    createdAt: Date.now(),
    useCount: 0,
  };
}

// ── classifyRisk ──────────────────────────────────────────────────────────────

describe("classifyRisk — verification tools", () => {
  it("pnpm test → verification", () => {
    expect(classifyRisk(spec("pnpm", ["test"]))).toBe("verification");
  });

  it("vitest → verification (no firstArg required)", () => {
    expect(classifyRisk(spec("vitest", ["run"]))).toBe("verification");
  });

  it("jest → verification", () => {
    expect(classifyRisk(spec("jest"))).toBe("verification");
  });

  it("tsc → verification", () => {
    expect(classifyRisk(spec("tsc", ["--noEmit"]))).toBe("verification");
  });

  it("eslint → verification", () => {
    expect(classifyRisk(spec("eslint", ["src/"]))).toBe("verification");
  });

  it("prettier → verification", () => {
    expect(classifyRisk(spec("prettier", ["--check", "."]))).toBe("verification");
  });
});

describe("classifyRisk — shell interpreters (always blocked)", () => {
  it("bash → shell_interpreter", () => {
    expect(classifyRisk(spec("bash"))).toBe("shell_interpreter");
  });

  it("sh -c → shell_interpreter", () => {
    expect(classifyRisk(spec("sh", ["-c", "rm -rf /"]))).toBe("shell_interpreter");
  });

  it("node → shell_interpreter (arbitrary code execution risk)", () => {
    // node is in SHELL_INTERPRETERS unconditionally
    expect(classifyRisk(spec("node", ["--version"]))).toBe("shell_interpreter");
  });

  it("python3 → shell_interpreter", () => {
    // python3 is in SHELL_INTERPRETERS unconditionally
    expect(classifyRisk(spec("python3", ["-m", "pytest"]))).toBe("shell_interpreter");
  });

  it("node -e → shell_interpreter (eval flag)", () => {
    expect(classifyRisk(spec("node", ["-e", "process.exit()"]))).toBe("shell_interpreter");
  });

  it("powershell → shell_interpreter", () => {
    expect(classifyRisk(spec("powershell"))).toBe("shell_interpreter");
  });

  it("bun eval flag → shell_interpreter", () => {
    // bun is in SHELL_INTERPRETERS
    expect(classifyRisk(spec("bun", ["eval", "1+1"]))).toBe("shell_interpreter");
  });
});

describe("classifyRisk — project scripts", () => {
  it("pnpm run lint → project_script", () => {
    expect(classifyRisk(spec("pnpm", ["run", "lint"]))).toBe("project_script");
  });

  it("npm run build → project_script or verification", () => {
    // npm run is in both project_script and verification composites
    const rc = classifyRisk(spec("npm", ["run", "build"]));
    expect(["project_script", "verification"]).toContain(rc);
  });
});

describe("classifyRisk — source-write bypass", () => {
  it("sed -i → source_write_bypass", () => {
    expect(classifyRisk(spec("sed", ["-i", "s/foo/bar/g", "file.ts"]))).toBe("source_write_bypass");
  });

  it("awk -i → source_write_bypass", () => {
    expect(classifyRisk(spec("awk", ["-i", "inplace", "{print}", "file.ts"]))).toBe("source_write_bypass");
  });

  it("patch → source_write_bypass", () => {
    expect(classifyRisk(spec("patch", ["file.patch"]))).toBe("source_write_bypass");
  });
});

describe("classifyRisk — destructive", () => {
  it("rm -rf → destructive", () => {
    expect(classifyRisk(spec("rm", ["-rf", "dist"]))).toBe("destructive");
  });

  it("rmdir → destructive", () => {
    expect(classifyRisk(spec("rmdir", ["old-dir"]))).toBe("destructive");
  });
});

describe("classifyRisk — remote execution", () => {
  it("npx → remote_execution", () => {
    expect(classifyRisk(spec("npx", ["create-react-app", "myapp"]))).toBe("remote_execution");
  });

  it("bunx → remote_execution", () => {
    expect(classifyRisk(spec("bunx", ["some-cli"]))).toBe("remote_execution");
  });

  it("pnpm dlx → remote_execution", () => {
    expect(classifyRisk(spec("pnpm", ["dlx", "tool"]))).toBe("remote_execution");
  });

  it("degit → remote_execution", () => {
    expect(classifyRisk(spec("degit", ["user/repo"]))).toBe("remote_execution");
  });
});

describe("classifyRisk — network", () => {
  it("curl → network", () => {
    expect(classifyRisk(spec("curl", ["https://example.com"]))).toBe("network");
  });

  it("wget → network", () => {
    expect(classifyRisk(spec("wget", ["https://example.com"]))).toBe("network");
  });
});

describe("classifyRisk — package install", () => {
  it("pnpm add → package_install", () => {
    expect(classifyRisk(spec("pnpm", ["add", "lodash"]))).toBe("package_install");
  });

  it("npm install → package_install", () => {
    expect(classifyRisk(spec("npm", ["install"]))).toBe("package_install");
  });

  it("pip install → package_install", () => {
    expect(classifyRisk(spec("pip", ["install", "requests"]))).toBe("package_install");
  });

  it("cargo install → package_install", () => {
    expect(classifyRisk(spec("cargo", ["install", "ripgrep"]))).toBe("package_install");
  });
});

describe("classifyRisk — git", () => {
  it("git log → git class", () => {
    expect(classifyRisk(spec("git", ["log"]))).toBe("git");
  });

  it("git push → git class", () => {
    expect(classifyRisk(spec("git", ["push"]))).toBe("git");
  });

  it("gh → git class", () => {
    expect(classifyRisk(spec("gh", ["pr", "list"]))).toBe("git");
  });
});

describe("classifyRisk — unknown", () => {
  it("unknown binary → unknown", () => {
    expect(classifyRisk(spec("my-custom-tool", ["--flag"]))).toBe("unknown");
  });

  it("cat → unknown (not in any known set)", () => {
    expect(classifyRisk(spec("cat", ["package.json"]))).toBe("unknown");
  });

  it("ls → unknown", () => {
    expect(classifyRisk(spec("ls", ["-la"]))).toBe("unknown");
  });
});

// ── evaluatePolicy — block/ask/allow decisions ────────────────────────────────

describe("evaluatePolicy — block decisions", () => {
  it("shell_interpreter → block regardless of trust rules", () => {
    const trust = [trustRule("bash", [])];
    const result = evaluatePolicy(spec("bash"), trust);
    expect(result.decision).toBe("block");
    expect(result.riskClass).toBe("shell_interpreter");
  });

  it("source_write_bypass → block", () => {
    const result = evaluatePolicy(spec("sed", ["-i", "s/x/y/", "file.ts"]), []);
    expect(result.decision).toBe("block");
    expect(result.riskClass).toBe("source_write_bypass");
  });

  it("remote_execution (npx) → block", () => {
    const result = evaluatePolicy(spec("npx", ["cowsay"]), []);
    expect(result.decision).toBe("block");
    expect(result.riskClass).toBe("remote_execution");
  });

  it("destructive (rm -rf) → block", () => {
    const result = evaluatePolicy(spec("rm", ["-rf", "/"]), []);
    expect(result.decision).toBe("block");
    expect(result.riskClass).toBe("destructive");
  });

  it("git → block in V1", () => {
    const result = evaluatePolicy(spec("git", ["push"]), []);
    expect(result.decision).toBe("block");
    expect(result.riskClass).toBe("git");
  });

  it("block wins over matching trust rule (shell_interpreter)", () => {
    const trust = [trustRule("bash", [])];
    const result = evaluatePolicy(spec("bash"), trust);
    expect(result.decision).toBe("block");
  });

  it("block wins over matching trust rule (remote_execution)", () => {
    const trust = [trustRule("npx", ["something"])];
    const result = evaluatePolicy(spec("npx", ["something"]), trust);
    expect(result.decision).toBe("block");
  });
});

describe("evaluatePolicy — ask decisions", () => {
  it("verification tool without trust rule → ask", () => {
    const result = evaluatePolicy(spec("pnpm", ["test"]), []);
    expect(result.decision).toBe("ask");
    expect(result.riskClass).toBe("verification");
    expect(result.reasonCode).toBe("ASK_VERIFICATION");
  });

  it("package_install with no trust rule → ask", () => {
    const result = evaluatePolicy(spec("pnpm", ["add", "lodash"]), []);
    expect(result.decision).toBe("ask");
    expect(result.riskClass).toBe("package_install");
    expect(result.reasonCode).toBe("ASK_PACKAGE_INSTALL");
  });

  it("network → ask", () => {
    const result = evaluatePolicy(spec("curl", ["https://api.example.com"]), []);
    expect(result.decision).toBe("ask");
    expect(result.riskClass).toBe("network");
    expect(result.reasonCode).toBe("ASK_NETWORK");
  });

  it("unknown binary with no trust → ask", () => {
    const result = evaluatePolicy(spec("my-custom-tool"), []);
    expect(result.decision).toBe("ask");
    expect(result.riskClass).toBe("unknown");
    expect(result.reasonCode).toBe("ASK_UNKNOWN");
  });
});

describe("evaluatePolicy — allow decisions (trust rules)", () => {
  it("trusted package_install → allow", () => {
    const trust = [trustRule("pnpm", ["add", "lodash"])];
    const result = evaluatePolicy(spec("pnpm", ["add", "lodash"]), trust);
    expect(result.decision).toBe("allow");
    expect(result.reasonCode).toBe("TRUSTED_EXACT_MATCH");
  });

  it("trusted network command → allow", () => {
    const trust = [trustRule("curl", ["https://api.example.com"])];
    const result = evaluatePolicy(spec("curl", ["https://api.example.com"]), trust);
    expect(result.decision).toBe("allow");
    expect(result.reasonCode).toBe("TRUSTED_EXACT_MATCH");
  });

  it("mismatched args → not trusted (ask)", () => {
    const trust = [trustRule("pnpm", ["add", "lodash"])];
    // Different args — no match
    const result = evaluatePolicy(spec("pnpm", ["add", "react"]), trust);
    expect(result.decision).toBe("ask");
  });

  it("trust rule for different cwd → no match (ask)", () => {
    const trust = [trustRule("pnpm", ["test"], "packages/core")];
    // Same command, different cwd
    const result = evaluatePolicy(spec("pnpm", ["test"], "packages/ui"), trust);
    expect(result.decision).toBe("ask");
  });
});

describe("evaluatePolicy — reasonCode", () => {
  it("BLOCKED_SHELL_INTERPRETER for bash", () => {
    const result = evaluatePolicy(spec("bash"), []);
    expect(result.reasonCode).toBe("BLOCKED_SHELL_INTERPRETER");
  });

  it("BLOCKED_GIT for git commit", () => {
    const result = evaluatePolicy(spec("git", ["commit"]), []);
    expect(result.reasonCode).toBe("BLOCKED_GIT");
  });

  it("BLOCKED_REMOTE_EXECUTION for npx", () => {
    const result = evaluatePolicy(spec("npx", ["something"]), []);
    expect(result.reasonCode).toBe("BLOCKED_REMOTE_EXECUTION");
  });

  it("BLOCKED_SOURCE_WRITE_BYPASS for sed -i", () => {
    const result = evaluatePolicy(spec("sed", ["-i", "s/foo/bar/", "f.ts"]), []);
    expect(result.reasonCode).toBe("BLOCKED_SOURCE_WRITE_BYPASS");
  });

  it("reasonCode is always defined on every decision", () => {
    const cases = [
      spec("pnpm", ["test"]),
      spec("curl", ["https://example.com"]),
      spec("my-tool"),
      spec("bash"),
      spec("git", ["log"]),
      spec("rm", ["-rf", "."]),
    ];
    for (const s of cases) {
      const result = evaluatePolicy(s, []);
      expect(result.reasonCode).toBeDefined();
    }
  });
});