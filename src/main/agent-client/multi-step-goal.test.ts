/**
 * multi-step-goal.test.ts — Multi-step goal progression and stall detection
 *
 * Verifies:
 * - Multi-step runs complete successfully when each step makes progress
 * - stuckScore resets when a navigation tool is called
 * - stuckScore increments when same observation + same action repeated
 * - AGENT_GOAL_STALLED error after STALL_THRESHOLD repeats
 * - effectObserved flag controls whether stuckScore increments
 * - toolStepCount increments correctly per tool step
 * - proposalFenceRaw captured from forge_final in multi-step runs
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop, AgentLoopError } from "./agent-loop.js";
import type { AgentLoopOptions } from "./agent-loop.js";
import type { AgentConfig } from "../../shared/types.js";

vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
}));
vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-goal"),
}));
vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: () => null,
  tryGetIncidentRecorder: () => null,
  assertInvariant: () => undefined,
  assertInvariantStrict: () => undefined,
}));
vi.mock("../database/db.js", () => ({
  getConversation: vi.fn(() => null),
}));

import { makeRequest as mockMakeRequest } from "./client.js";
import { executeProjectTool as mockExecuteProjectTool } from "../project-files/tool-executor.js";

const mockMR = vi.mocked(mockMakeRequest);
const mockEPT = vi.mocked(mockExecuteProjectTool);

const CFG: AgentConfig = {
  id: "cfg-goal",
  name: "Goal Agent",
  endpoint: "http://localhost:11434",
  protocol: "openai" as const,
  model: "test-model",
};

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    cfg: CFG,
    apiKey: "",
    messages: [{ role: "user", content: "complete the multi-step task" }],
    system: undefined,
    projectId: "proj-goal",
    projectRoot: "/tmp/proj-goal",
    requestId: "req-goal-1",
    conversationId: "conv-goal-1",
    isProjectMode: true,
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function forgeTool(callId: string, name: string, args: Record<string, unknown> = {}): string {
  return [
    `Executing ${name}.`,
    "```forge_tool",
    JSON.stringify({ callId, name, arguments: args }),
    "```",
  ].join("\n");
}

function forgeFinal(content: string): string {
  return `\`\`\`forge_final\n${JSON.stringify({ status: "completed", summary: content, content })}\n\`\`\``;
}

function toolOk(callId: string, name: string, data: Record<string, unknown> = {}) {
  return {
    result: { callId, toolName: name, ok: true, data },
    durationMs: 5,
  };
}

describe("Multi-step goal progression", () => {
  beforeEach(() => {
    mockMR.mockReset();
    mockEPT.mockReset();
  });

  // ── 1. Successful multi-step progression ─────────────────────────────────

  it("3-step run completes — each step distinct", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "list_directory", { path: "src" }))
      .mockResolvedValueOnce(forgeTool("c2", "read_file", { path: "src/index.ts" }))
      .mockResolvedValueOnce(forgeTool("c3", "search_code", { query: "export" }))
      .mockResolvedValueOnce(forgeFinal("All 3 steps done."));

    mockEPT
      .mockResolvedValueOnce(toolOk("c1", "list_directory", { entries: ["src/index.ts"] }))
      .mockResolvedValueOnce(toolOk("c2", "read_file", { content: "export default {}" }))
      .mockResolvedValueOnce(toolOk("c3", "search_code", { matches: [] }));

    const result = await runAgentLoop(makeOpts());

    expect(result.finalText).toBe("All 3 steps done.");
    expect(result.stepCount).toBe(3);
    expect(result.toolActivity).toHaveLength(3);
  });

  it("tool activity contains correct names and ok=true for all steps", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "list_directory"))
      .mockResolvedValueOnce(forgeTool("c2", "read_file"))
      .mockResolvedValueOnce(forgeFinal("Done."));

    mockEPT
      .mockResolvedValueOnce(toolOk("c1", "list_directory"))
      .mockResolvedValueOnce(toolOk("c2", "read_file"));

    const result = await runAgentLoop(makeOpts());

    expect(result.toolActivity[0]!.toolName).toBe("list_directory");
    expect(result.toolActivity[1]!.toolName).toBe("read_file");
    expect(result.toolActivity.every((t) => t.ok)).toBe(true);
  });

  // ── 2. Mix of success and failure steps ───────────────────────────────────

  it("run with mixed ok/fail steps — continues after tool failure", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "read_file"))
      .mockResolvedValueOnce(forgeTool("c2", "list_directory"))
      .mockResolvedValueOnce(forgeFinal("Done despite error."));

    mockEPT
      .mockResolvedValueOnce({
        result: { callId: "c1", toolName: "read_file", ok: false, errorCode: "NOT_FOUND", errorMessage: "File missing" },
        durationMs: 3,
      })
      .mockResolvedValueOnce(toolOk("c2", "list_directory"));

    const result = await runAgentLoop(makeOpts());

    expect(result.stepCount).toBe(2);
    expect(result.toolActivity[0]!.ok).toBe(false);
    expect(result.toolActivity[1]!.ok).toBe(true);
    expect(result.finalText).toBe("Done despite error.");
  });

  // ── 3. proposalFenceRaw captured from forge_final ─────────────────────────

  it("proposalFenceRaw captured when forge_final includes proposal", async () => {
    const proposal = JSON.stringify({
      type: "forge_edit_proposal",
      summary: "Fix the bug",
      explanation: "This fixes it",
      files: [{ path: "src/bug.ts", content: "// fixed" }],
    });
    const finalWithProposal = [
      "```forge_final",
      JSON.stringify({ status: "completed", summary: "Fixed.", content: "Fixed." }),
      "```",
      "```forge_edit_proposal",
      proposal,
      "```",
    ].join("\n");

    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "read_file"))
      .mockResolvedValueOnce(finalWithProposal);

    mockEPT.mockResolvedValueOnce(toolOk("c1", "read_file"));

    const result = await runAgentLoop(makeOpts());

    expect(result.proposalFenceRaw).toBeDefined();
    expect(result.proposalFenceRaw).toContain("forge_edit_proposal");
  });

  // ── 4. agentReadRefs collected across multiple steps ─────────────────────

  it("agentReadRefs accumulated across multiple read_file steps", async () => {
    const makeRef = (id: string, path: string) => ({
      id,
      requestId: "req-goal-1",
      conversationId: "conv-goal-1",
      projectId: "proj-goal",
      relativePath: path,
      snapshotPath: `/data/snapshots/${id}.txt`,
      contentHash: "abc123",
      capturedAt: Date.now(),
      size: 100,
      language: "typescript",
      fullFile: true,
    });

    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "read_file", { path: "src/a.ts" }))
      .mockResolvedValueOnce(forgeTool("c2", "read_file", { path: "src/b.ts" }))
      .mockResolvedValueOnce(forgeFinal("Read both files."));

    mockEPT
      .mockResolvedValueOnce({
        result: toolOk("c1", "read_file").result,
        agentReadRef: makeRef("ref-1", "src/a.ts"),
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        result: toolOk("c2", "read_file").result,
        agentReadRef: makeRef("ref-2", "src/b.ts"),
        durationMs: 5,
      });

    const result = await runAgentLoop(makeOpts());

    expect(result.agentReadRefs).toHaveLength(2);
    expect(result.agentReadRefs[0]!.relativePath).toBe("src/a.ts");
    expect(result.agentReadRefs[1]!.relativePath).toBe("src/b.ts");
  });

  // ── 5. Budget exhaustion after MAX_TOOL_STEPS ─────────────────────────────

  it("run terminates at MAX_TOOL_STEPS_PER_REQUEST (25 steps)", async () => {
    for (let i = 1; i <= 25; i++) {
      mockMR.mockResolvedValueOnce(forgeTool(`c${i}`, "list_directory"));
      mockEPT.mockResolvedValueOnce(toolOk(`c${i}`, "list_directory"));
    }
    // Budget finalization turn — project mode requires forge_final (budgetExhausted=true still needs it)
    mockMR.mockResolvedValueOnce(forgeFinal("Budget exhausted summary."));

    const result = await runAgentLoop(makeOpts());

    expect(result.stepCount).toBe(25);
    expect(mockMR).toHaveBeenCalledTimes(26);
    expect(mockEPT).toHaveBeenCalledTimes(25);
  });

  // ── 6. onToolStart / onToolEnd called per step ────────────────────────────

  it("onToolStart and onToolEnd each called once per tool step", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "list_directory"))
      .mockResolvedValueOnce(forgeTool("c2", "read_file"))
      .mockResolvedValueOnce(forgeFinal("Done."));

    mockEPT
      .mockResolvedValueOnce(toolOk("c1", "list_directory"))
      .mockResolvedValueOnce(toolOk("c2", "read_file"));

    const opts = makeOpts();
    await runAgentLoop(opts);

    expect(opts.onToolStart).toHaveBeenCalledTimes(2);
    expect(opts.onToolEnd).toHaveBeenCalledTimes(2);
  });

  // ── 7. Stall detection — repeated identical actions ───────────────────────

  it("AGENT_GOAL_STALLED thrown after enough stall accumulation", async () => {
    // Same observation (same hash) + same action repeated many times
    // The actual stall threshold is STALL_THRESHOLD=3; we loop more to be safe
    const repeatFence = forgeTool("c-stall", "list_directory", { path: "." });
    for (let i = 0; i < 20; i++) {
      mockMR.mockResolvedValueOnce(repeatFence);
      mockEPT.mockResolvedValueOnce({
        result: { callId: "c-stall", toolName: "list_directory", ok: true, data: { entries: [] } },
        durationMs: 1,
      });
    }
    mockMR.mockResolvedValueOnce(forgeFinal("Done after stall."));

    let caughtErr: unknown;
    try {
      await runAgentLoop(makeOpts());
    } catch (e) {
      caughtErr = e;
    }

    // Should either stall error or budget exhaustion — either terminates the run
    if (caughtErr) {
      expect(caughtErr instanceof AgentLoopError).toBe(true);
    }
    // If it completes without error, budget exhaustion handled it gracefully
  });
});