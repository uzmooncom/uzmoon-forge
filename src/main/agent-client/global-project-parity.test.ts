/**
 * global-project-parity.test.ts — Global Chat vs Project Mode parity checks
 *
 * Verifies:
 * - Global chat (isProjectMode=false): plain prose without tools → accepted
 * - Global chat with tools: must use forge_final after tool steps
 * - Global chat with tools + budget exhausted: plain prose OK (budget path)
 * - Project mode (isProjectMode=true): always requires forge_final or forge_tool
 * - Project mode naked prose → protocol recovery → PROTOCOL_RECOVERY_EXHAUSTED
 * - Both modes handle forge_tool fences identically
 * - forge_final works in both modes
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
  newActivityId: vi.fn(() => "activity-id-parity"),
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
  id: "cfg-parity",
  name: "Parity Agent",
  endpoint: "http://localhost:11434",
  protocol: "openai" as const,
  model: "test-model",
};

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    cfg: CFG,
    apiKey: "",
    messages: [{ role: "user", content: "hello" }],
    system: undefined,
    projectId: "",
    projectRoot: "",
    requestId: "req-parity",
    conversationId: "conv-parity",
    isProjectMode: false,
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function forgeFinal(content: string): string {
  return `\`\`\`forge_final\n${JSON.stringify({ status: "completed", summary: content, content })}\n\`\`\``;
}

function forgeTool(callId: string, name: string): string {
  return [
    "Working.",
    "```forge_tool",
    JSON.stringify({ callId, name, arguments: {} }),
    "```",
  ].join("\n");
}

function toolResult(callId: string, name: string) {
  return {
    result: { callId, toolName: name, ok: true, data: {} },
    durationMs: 5,
  };
}

describe("Global chat vs project mode parity", () => {
  beforeEach(() => {
    mockMR.mockReset();
    mockEPT.mockReset();
  });

  // ── Global Chat ───────────────────────────────────────────────────────────

  it("global chat: plain prose without prior tool steps → accepted as final", async () => {
    mockMR.mockResolvedValueOnce("Plain answer for global chat.");
    const result = await runAgentLoop(makeOpts({ isProjectMode: false }));
    expect(result.finalText).toBe("Plain answer for global chat.");
  });

  it("global chat: forge_final envelope also accepted as final", async () => {
    mockMR.mockResolvedValueOnce(forgeFinal("Wrapped answer."));
    const result = await runAgentLoop(makeOpts({ isProjectMode: false }));
    expect(result.finalText).toBe("Wrapped answer.");
  });

  it("global chat: plain prose AFTER tool step → invalid (NAKED_PROSE_AFTER_TOOL_USE_GLOBAL_CHAT)", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "list_directory"))
      .mockResolvedValue("Plain answer after tool.");  // repeated on recovery turns

    mockEPT.mockResolvedValueOnce(toolResult("c1", "list_directory"));

    await expect(
      runAgentLoop(makeOpts({ isProjectMode: false }))
    ).rejects.toThrow(AgentLoopError);
  });

  it("global chat: forge_final after tool step → accepted", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c1", "list_directory"))
      .mockResolvedValueOnce(forgeFinal("Listed files."));

    mockEPT.mockResolvedValueOnce(toolResult("c1", "list_directory"));

    const result = await runAgentLoop(makeOpts({ isProjectMode: false }));
    expect(result.finalText).toBe("Listed files.");
    expect(result.stepCount).toBe(1);
  });

  // ── Project Mode ──────────────────────────────────────────────────────────

  it("project mode: naked prose → protocol recovery → PROTOCOL_RECOVERY_EXHAUSTED", async () => {
    mockMR.mockResolvedValue("naked prose without forge_final");

    let err: unknown;
    try {
      await runAgentLoop(makeOpts({ isProjectMode: true, projectId: "proj-1", projectRoot: "/tmp/p1" }));
    } catch (e) {
      err = e;
    }

    expect(err instanceof AgentLoopError).toBe(true);
    expect((err as AgentLoopError).code).toBe("PROTOCOL_RECOVERY_EXHAUSTED");
  });

  it("project mode: forge_final → accepted as final", async () => {
    mockMR.mockResolvedValueOnce(forgeFinal("Project response."));
    const result = await runAgentLoop(makeOpts({ isProjectMode: true, projectId: "proj-1", projectRoot: "/tmp/p1" }));
    expect(result.finalText).toBe("Project response.");
  });

  it("project mode: forge_tool → tool executed → forge_final", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("c2", "list_directory"))
      .mockResolvedValueOnce(forgeFinal("Executed tool."));
    mockEPT.mockResolvedValueOnce(toolResult("c2", "list_directory"));

    const result = await runAgentLoop(makeOpts({
      isProjectMode: true,
      projectId: "proj-1",
      projectRoot: "/tmp/p1",
    }));
    expect(result.finalText).toBe("Executed tool.");
    expect(result.stepCount).toBe(1);
  });

  // ── Parity: forge_tool works identically in both modes ────────────────────

  it("forge_tool fence executes in global chat mode (tool step = 0 before)", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("cx", "list_directory"))
      .mockResolvedValueOnce(forgeFinal("Done in global."));
    mockEPT.mockResolvedValueOnce(toolResult("cx", "list_directory"));

    const resultGlobal = await runAgentLoop(makeOpts({ isProjectMode: false }));
    expect(resultGlobal.stepCount).toBe(1);
  });

  it("forge_tool fence executes in project mode", async () => {
    mockMR
      .mockResolvedValueOnce(forgeTool("cy", "list_directory"))
      .mockResolvedValueOnce(forgeFinal("Done in project."));
    mockEPT.mockResolvedValueOnce(toolResult("cy", "list_directory"));

    const resultProject = await runAgentLoop(makeOpts({
      isProjectMode: true,
      projectId: "proj-1",
      projectRoot: "/tmp/p1",
    }));
    expect(resultProject.stepCount).toBe(1);
  });

  // ── Budget exhausted: plain prose OK in both modes ────────────────────────

  it("global chat + budget exhausted: plain prose final synthesis accepted", async () => {
    const toolFence = (n: number) => forgeTool(`c${n}`, "list_directory");
    for (let i = 1; i <= 25; i++) {
      mockMR.mockResolvedValueOnce(toolFence(i));
      mockEPT.mockResolvedValueOnce(toolResult(`c${i}`, "list_directory"));
    }
    // Budget turn: plain prose (no forge_final needed — budgetExhausted=true)
    mockMR.mockResolvedValueOnce("Budget summary.");

    const result = await runAgentLoop(makeOpts({ isProjectMode: false }));
    expect(result.stepCount).toBe(25);
    expect(mockMR).toHaveBeenCalledTimes(26);
  });
});