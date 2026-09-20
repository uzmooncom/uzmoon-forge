/**
 * command-manager.integration.test.ts
 *
 * Integration tests for the CommandManager module.
 * Uses FakeProcessAdapter — no real OS processes.
 *
 * Key policy facts (from command-policy.ts):
 *   - All commands default to "ask" (awaiting_approval) unless a trust rule matches
 *   - BLOCK always wins: remote_execution, shell_interpreter, source_write_bypass, etc.
 *   - Trust rules turn "ask" → "queued" (auto-approved) for exact spec matches
 *
 * Coverage:
 * - User-initiated command reaches succeeded (source="user" gets auto-approval in some flows)
 * - ASK path: propose → awaiting_approval, user approves (once) → queued → succeeded
 * - ASK path: propose → awaiting_approval, user rejects → cancelled
 * - BLOCK path: blocked command (npx) never runs
 * - Trust rule: approve(trust) creates rule; next identical cmd auto-runs
 * - Cancel while running → cancelled
 * - Cancel on terminal state is a no-op
 * - Restart reconciliation: running/queued commands cancelled on reconcileOnStartup
 * - Command budget: 11th run_command in same ctx is rejected (budget = 10)
 * - Cross-project isolation: read_command_output rejects wrong projectId
 * - list_project_commands: filters by state and conversationId
 * - Double-approve idempotency
 * - CWD containment: escape rejected, root accepted
 */
import os from "os";
import path from "path";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock permission engine so run_command tests don't hang waiting for approval.
// The CommandManager itself handles the actual approval flow — permission engine
// should not block these integration tests.
vi.mock("../permissions/index.js", () => ({
  resolvePermission: vi.fn().mockReturnValue({ decision: "ALLOW", source: "default", reason: "test" }),
  requestPermissionApproval: vi.fn().mockResolvedValue({ decision: "ALLOW", approvalId: "test" }),
  recordCheck: vi.fn(),
}));
import {
  propose,
  approveCommand,
  rejectCommand,
  cancelCommand,
  getCommand,
  listCommands,
  reconcileOnStartup,
  drainCommandManagerForTest,
  _resetCommandManagerForTest,
  _setTestAdapter,
  _setTestSender,
} from "./command-manager.js";
import { FakeProcessAdapter } from "./process-adapter.js";
import { getDb, resetDb } from "../database/db.js";
import * as db from "../database/db.js";
import type { Project } from "../../shared/types.js";
import { COMMAND_LIMITS, COMMAND_TERMINAL_STATES } from "../../shared/types.js";
import { executeProjectTool } from "../project-files/tool-executor.js";
import type { ToolExecutionContext } from "../project-files/tool-executor.js";
import type { ForgeToolCall } from "../../shared/types.js";
import { randomUUID } from "crypto";

// ── Test scaffolding ────────────────────────────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), "forge-cmd-test-" + Date.now());
const PROJECT_ROOT = TMP_DIR;
const PROJECT_ID = "proj-test-1";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: "Test Project",
    workingDirectory: PROJECT_ROOT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeToolCall(name: string, args: Record<string, unknown>): ForgeToolCall {
  return {
    callId: randomUUID(),
    name,
    arguments: args,
  };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    projectId: PROJECT_ID,
    projectRoot: PROJECT_ROOT,
    requestId: randomUUID(),
    conversationId: randomUUID(),
    readBytesUsed: 0,
    commandsRunThisRequest: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Poll until condition is true or maxMs exceeded */
async function pollUntil(
  condition: () => boolean,
  maxMs = 4000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("pollUntil timed out");
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

beforeEach(async () => {
  await drainCommandManagerForTest();
  _resetCommandManagerForTest();
  resetDb();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  getDb(TMP_DIR);
  db.createProject(true, makeProject());
});

afterEach(async () => {
  await drainCommandManagerForTest();
  _resetCommandManagerForTest();
  resetDb();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helper ──────────────────────────────────────────────────────────────────

function initFake(scenarios: ConstructorParameters<typeof FakeProcessAdapter>[0]) {
  const adapter = new FakeProcessAdapter(scenarios);
  _setTestAdapter(adapter);
  _setTestSender(null);
  return adapter;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CommandManager — policy (all default to ask)", () => {
  it("pnpm test → awaiting_approval (verification class still requires human approval)", () => {
    initFake([]);
    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });
    // Default policy: all risk classes require approval (no trust rule)
    expect(record.state).toBe("awaiting_approval");
    expect(record.policyDecision.riskClass).toBe("verification");
    expect(record.authorizationState).toBe("pending");
  });
});

describe("CommandManager — ASK path (user approval)", () => {
  it("approve(once): awaiting_approval → queued → succeeded", async () => {
    initFake([{ kind: "success", stdoutChunks: ["OK\n"], exitCode: 0 }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    expect(record.state).toBe("awaiting_approval");

    const approved = approveCommand(record.id, "once");
    expect(approved?.state).toBe("queued");
    expect(approved?.authorizationState).toBe("approved_once");

    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));
    expect(getCommand(record.id)?.state).toBe("succeeded");
    expect(getCommand(record.id)?.exitCode).toBe(0);
  });

  it("approve(once): non-zero exit → failed", async () => {
    initFake([{ kind: "nonzero", exitCode: 1 }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    approveCommand(record.id, "once");
    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));
    expect(getCommand(record.id)?.state).toBe("failed");
    expect(getCommand(record.id)?.exitCode).toBe(1);
  });

  it("reject: awaiting_approval → cancelled", async () => {
    initFake([]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    expect(record.state).toBe("awaiting_approval");

    const rejected = rejectCommand(record.id);
    expect(rejected?.state).toBe("cancelled");
    expect(rejected?.authorizationState).toBe("rejected");
  });

  it("double-approve: second call after state moves is a no-op", async () => {
    initFake([{ kind: "success", exitCode: 0 }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    approveCommand(record.id, "once");

    // Wait until running or terminal
    await pollUntil(() => {
      const s = getCommand(record.id)?.state;
      return s === "running" || COMMAND_TERMINAL_STATES.has(s ?? "proposed");
    });

    // Second approve after state has moved — should not re-queue
    const second = approveCommand(record.id, "once");
    expect(second?.state).not.toBe("queued");
  });
});

describe("CommandManager — BLOCK path", () => {
  it("npx (remote_execution) → blocked immediately, no process spawned", () => {
    initFake([]);
    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "npx", args: ["create-react-app", "my-app"], cwdRelative: "" },
      source: "agent",
    });
    expect(record.state).toBe("blocked");
    expect(record.authorizationState).toBe("blocked_by_policy");
    expect(record.completedAt).toBeUndefined();
  });
});

describe("CommandManager — Trust rules", () => {
  it("approve(trust) creates rule; next identical spec auto-runs (queued+trusted)", async () => {
    initFake([
      { kind: "success", exitCode: 0 },
      { kind: "success", exitCode: 0 },
    ]);

    const spec = { executable: "pnpm", args: ["test"], cwdRelative: "" };

    const first = propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec, source: "agent" });
    expect(first.state).toBe("awaiting_approval");
    approveCommand(first.id, "trust");

    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(first.id)?.state ?? "proposed"));

    // Trust rule should now exist for this project
    const rules = db.listTrustRules(true, PROJECT_ID);
    expect(rules.length).toBeGreaterThanOrEqual(1);

    // Second propose with identical spec → trusted → queued automatically
    const second = propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec, source: "agent" });
    expect(second.state).toBe("queued");
    expect(second.authorizationState).toBe("trusted");

    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(second.id)?.state ?? "proposed"));
    expect(getCommand(second.id)?.state).toBe("succeeded");
  });
});

describe("CommandManager — Cancel", () => {
  it("cancel while running → cancelled", async () => {
    initFake([{ kind: "hang" }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    // Approve so it starts running
    approveCommand(record.id, "once");
    await pollUntil(() => getCommand(record.id)?.state === "running");

    cancelCommand(record.id);
    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));
    expect(getCommand(record.id)?.state).toBe("cancelled");
  });

  it("cancel on succeeded is a no-op — returns existing record unchanged", async () => {
    initFake([{ kind: "success", exitCode: 0 }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    approveCommand(record.id, "once");
    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));
    expect(getCommand(record.id)?.state).toBe("succeeded");

    const result = cancelCommand(record.id);
    expect(result?.state).toBe("succeeded");
  });
});

describe("CommandManager — Restart reconciliation", () => {
  it("reconcileOnStartup cancels running and queued commands", () => {
    // Insert a command then manually update state to "running" (simulating a crash)
    const cmd1 = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });
    db.updateCommand(true, cmd1.id, { state: "running", startedAt: Date.now() });

    // Insert another, move to "queued"
    const cmd2 = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["build"], cwdRelative: "" },
      source: "agent",
    });
    db.updateCommand(true, cmd2.id, { state: "queued" });

    // Reset module state — simulates a fresh main-process start
    _resetCommandManagerForTest();

    reconcileOnStartup();

    expect(db.getCommand(true, cmd1.id)?.state).toBe("cancelled");
    expect(db.getCommand(true, cmd2.id)?.state).toBe("cancelled");
  });

  it("reconcileOnStartup leaves terminal commands untouched", () => {
    const cmd = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });
    db.updateCommand(true, cmd.id, { state: "succeeded", completedAt: Date.now() });

    _resetCommandManagerForTest();
    reconcileOnStartup();

    // Still succeeded — not touched
    expect(db.getCommand(true, cmd.id)?.state).toBe("succeeded");
  });
});

describe("CommandManager — spawn error", () => {
  it("spawn error → failed state", async () => {
    initFake([{ kind: "spawn_error", message: "executable not found" }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    // Approve so it runs
    approveCommand(record.id, "once");
    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));

    expect(getCommand(record.id)?.state).toBe("failed");
  });
});

describe("CommandManager — CWD containment", () => {
  it("rejects cwdRelative that escapes project root", () => {
    initFake([]);
    expect(() => {
      propose({
        projectId: PROJECT_ID,
        projectRoot: PROJECT_ROOT,
        spec: { executable: "ls", args: [], cwdRelative: "../../etc" },
        source: "agent",
      });
    }).toThrow();
  });

  it("accepts cwdRelative = '' (project root)", () => {
    initFake([]);
    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });
    // Regardless of state, it should not throw and should return a valid command
    expect(record.id).toBeTruthy();
    expect(record.state).not.toBe("blocked");
  });
});

describe("CommandManager — listCommands and getCommand", () => {
  it("listCommands returns all commands for a project", () => {
    initFake([]);
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["test"], cwdRelative: "" }, source: "agent" });
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["build"], cwdRelative: "" }, source: "agent" });

    const all = listCommands(PROJECT_ID);
    expect(all.length).toBe(2);
  });

  it("listCommands with conversationId filters results", () => {
    initFake([]);
    const convA = "conv-a";
    const convB = "conv-b";

    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["test"], cwdRelative: "" }, source: "agent", conversationId: convA });
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["build"], cwdRelative: "" }, source: "agent", conversationId: convB });

    expect(listCommands(PROJECT_ID, convA).length).toBe(1);
    expect(listCommands(PROJECT_ID, convB).length).toBe(1);
    expect(listCommands(PROJECT_ID).length).toBe(2);
  });

  it("getCommand returns null for unknown id", () => {
    expect(getCommand("does-not-exist")).toBeNull();
  });
});

describe("Agent tool — command budget enforcement", () => {
  it("rejects run_command when budget is exhausted", async () => {
    const ctx = makeCtx({ commandsRunThisRequest: COMMAND_LIMITS.MAX_COMMANDS_PER_AGENT_RUN });

    const call = makeToolCall("run_command", {
      executable: "pnpm",
      args: ["test"],
      cwd_relative: "",
    });

    const result = await executeProjectTool(call, ctx);
    expect(result.result.ok).toBe(false);
    expect(result.result.errorCode).toBe("COMMAND_BUDGET_EXCEEDED");
  });

  it("budget counter increments on each run_command call", async () => {
    initFake([{ kind: "success", exitCode: 0 }]);

    const ctx = makeCtx({ commandsRunThisRequest: 0 });

    const call = makeToolCall("run_command", {
      executable: "pnpm",
      args: ["test"],
      cwd_relative: "",
    });

    // Budget check happens before propose, so counter increments even if command awaits approval
    await executeProjectTool(call, ctx);
    expect(ctx.commandsRunThisRequest).toBe(1);
  });
});

describe("Agent tool — list_project_commands", () => {
  it("returns commands for the active project", async () => {
    initFake([]);
    propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    const ctx = makeCtx();
    const call = makeToolCall("list_project_commands", { limit: 10 });
    const result = await executeProjectTool(call, ctx);

    expect(result.result.ok).toBe(true);
    const data = result.result.data as Record<string, unknown>;
    expect(data["count"]).toBe(1);
  });

  it("filters by state — only awaiting_approval commands returned", async () => {
    initFake([]);
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["test"], cwdRelative: "" }, source: "agent" });
    // This one is blocked immediately
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "npx", args: ["cowsay"], cwdRelative: "" }, source: "agent" });

    const ctx = makeCtx();
    const call = makeToolCall("list_project_commands", { state: "awaiting_approval" });
    const result = await executeProjectTool(call, ctx);

    expect(result.result.ok).toBe(true);
    const data = result.result.data as Record<string, unknown>;
    const cmds = data["commands"] as unknown[];
    expect(cmds.length).toBe(1);
    expect((cmds[0] as Record<string, unknown>)["state"]).toBe("awaiting_approval");
  });

  it("filters by conversationId", async () => {
    initFake([]);
    const convA = "conv-a";
    const convB = "conv-b";
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["test"], cwdRelative: "" }, source: "agent", conversationId: convA });
    propose({ projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, spec: { executable: "pnpm", args: ["build"], cwdRelative: "" }, source: "agent", conversationId: convB });

    const ctx = makeCtx();
    const call = makeToolCall("list_project_commands", { conversation_id: convA });
    const result = await executeProjectTool(call, ctx);

    const data = result.result.data as Record<string, unknown>;
    expect(data["count"]).toBe(1);
  });
});

describe("Agent tool — read_command_output", () => {
  it("returns output for a completed command", async () => {
    initFake([{ kind: "success", stdoutChunks: ["test passed\n"], exitCode: 0 }]);

    const record = propose({
      projectId: PROJECT_ID,
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    // Approve and wait for completion
    approveCommand(record.id, "once");
    await pollUntil(() => COMMAND_TERMINAL_STATES.has(getCommand(record.id)?.state ?? "proposed"));

    const ctx = makeCtx();
    const call = makeToolCall("read_command_output", { command_id: record.id });
    const result = await executeProjectTool(call, ctx);

    expect(result.result.ok).toBe(true);
    const data = result.result.data as Record<string, unknown>;
    expect(data["commandId"]).toBe(record.id);
    expect(typeof data["text"]).toBe("string");
  });

  it("returns NOT_FOUND for unknown commandId", async () => {
    const ctx = makeCtx();
    const call = makeToolCall("read_command_output", { command_id: "nonexistent-id" });
    const result = await executeProjectTool(call, ctx);

    expect(result.result.ok).toBe(false);
    expect(result.result.errorCode).toBe("NOT_FOUND");
  });

  it("returns ACCESS_DENIED for command from different project", async () => {
    initFake([]);
    const otherProject: Project = {
      id: "other-project",
      name: "Other",
      workingDirectory: PROJECT_ROOT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.createProject(true, otherProject);

    const record = propose({
      projectId: "other-project",
      projectRoot: PROJECT_ROOT,
      spec: { executable: "pnpm", args: ["test"], cwdRelative: "" },
      source: "agent",
    });

    // Access attempt from PROJECT_ID context (different project)
    const ctx = makeCtx({ projectId: PROJECT_ID });
    const call = makeToolCall("read_command_output", { command_id: record.id });
    const result = await executeProjectTool(call, ctx);

    expect(result.result.ok).toBe(false);
    expect(result.result.errorCode).toBe("ACCESS_DENIED");
  });
});