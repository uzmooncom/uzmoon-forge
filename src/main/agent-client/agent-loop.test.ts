/**
 * agent-loop.test.ts — Unit tests for the V0.4 agent loop.
 *
 * Tests forge_tool fence extraction/stripping, budget enforcement,
 * and the runAgentLoop multi-turn flow with mocked transport and executor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the transport layer ────────────────────────────────────────────────
vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
  classifyError: vi.fn(() => ({ status: "error", message: "error" })),
}));

// ── Mock the tool executor ──────────────────────────────────────────────────
vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-1"),
}));

import { runAgentLoop } from "./agent-loop.js";
import { makeRequest } from "./client.js";
import { executeProjectTool } from "../project-files/tool-executor.js";

const mockMakeRequest = vi.mocked(makeRequest);
const mockExecuteProjectTool = vi.mocked(executeProjectTool);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeBaseCfg() {
  return {
    id: "agent-1",
    name: "Test Agent",
    endpoint: "https://api.example.com",
    protocol: "openai" as const,
    model: "gpt-test",
  };
}

function makeBaseOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}): Parameters<typeof runAgentLoop>[0] {
  return {
    cfg: makeBaseCfg(),
    apiKey: "test-key",
    messages: [{ role: "user", content: "Hello" }],
    system: undefined,
    projectId: "proj-1",
    projectRoot: "/projects/proj-1",
    requestId: "req-1",
    conversationId: "conv-1",
    isProjectMode: false, // Global Chat — naked prose accepted as final (backward compat)
    onChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ── forge_tool fence extraction (tested via runAgentLoop) ──────────────────

describe("Agent loop — forge_tool fence fallback", () => {
  beforeEach(() => {
    mockMakeRequest.mockReset();
    mockExecuteProjectTool.mockReset();
  });

  it("returns text directly when no tool calls are present", async () => {
    mockMakeRequest.mockResolvedValueOnce("Hello from the model.");

    const result = await runAgentLoop(makeBaseOpts());

    expect(result.finalText).toBe("Hello from the model.");
    expect(result.stepCount).toBe(0);
    expect(result.agentReadRefs).toHaveLength(0);
    expect(result.toolActivity).toHaveLength(0);
    expect(mockMakeRequest).toHaveBeenCalledTimes(1);
  });

  it("executes a forge_tool fence and appends result to next turn", async () => {
    const toolResponseText = [
      "Let me check the directory.",
      "```forge_tool",
      '{"callId":"call-1","name":"list_directory","arguments":{"path":"src"}}',
      "```",
    ].join("\n");

    // First turn: model returns tool call fence
    mockMakeRequest.mockResolvedValueOnce(toolResponseText);

    // Tool executor returns a directory listing
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: {
        callId: "call-1",
        toolName: "list_directory",
        ok: true,
        data: { entries: ["src/a.ts", "src/b.ts"], totalCount: 2 },
      },
      durationMs: 42,
    });

    // Second turn: model gives final answer (forge_final required after tool use)
    mockMakeRequest.mockResolvedValueOnce(
      '```forge_final\n{"status":"completed","summary":"Listed files.","content":"I can see src/a.ts and src/b.ts."}\n```'
    );

    const opts = makeBaseOpts();
    const result = await runAgentLoop(opts);

    expect(result.finalText).toBe("I can see src/a.ts and src/b.ts.");
    expect(result.stepCount).toBe(1);
    expect(mockMakeRequest).toHaveBeenCalledTimes(2);
    expect(mockExecuteProjectTool).toHaveBeenCalledTimes(1);

    // Check onToolStart and onToolEnd were called
    expect(opts.onToolStart).toHaveBeenCalledTimes(1);
    expect(opts.onToolEnd).toHaveBeenCalledTimes(1);
  });

  it("strips forge_tool fences from visible text", async () => {
    const toolResponseText = [
      "Checking the file.",
      "```forge_tool",
      '{"callId":"call-2","name":"read_file","arguments":{"path":"src/index.ts"}}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(toolResponseText);
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: { callId: "call-2", toolName: "read_file", ok: true, data: { content: "export default {};" } },
      durationMs: 10,
    });
    mockMakeRequest.mockResolvedValueOnce(
      '```forge_final\n{"status":"completed","summary":"Read file.","content":"The file exports nothing."}\n```'
    );

    const result = await runAgentLoop(makeBaseOpts());
    expect(result.finalText).toBe("The file exports nothing.");
  });

  it("stops after MAX_TOOL_STEPS_PER_REQUEST and requests final synthesis", async () => {
    // Simulate model always returning a tool call (would loop forever without budget)
    const toolFence = (n: number) => [
      `Step ${n}`,
      "```forge_tool",
      `{"callId":"call-${n}","name":"list_directory","arguments":{}}`,
      "```",
    ].join("\n");

    // Return tool calls for first 25 turns (MAX_TOOL_STEPS_PER_REQUEST)
    for (let i = 1; i <= 25; i++) {
      mockMakeRequest.mockResolvedValueOnce(toolFence(i));
      mockExecuteProjectTool.mockResolvedValueOnce({
        result: { callId: `call-${i}`, toolName: "list_directory", ok: true, data: { entries: [] } },
        durationMs: 5,
      });
    }
    // Budget exhausted: 26th makeRequest (no tools passed), model returns final text
    mockMakeRequest.mockResolvedValueOnce("I have exhausted the tool budget.");

    const result = await runAgentLoop(makeBaseOpts());

    // Budget message appended, then one final turn
    expect(result.stepCount).toBe(25);
    expect(mockExecuteProjectTool).toHaveBeenCalledTimes(25);
    // 25 tool turns + 1 budget-exhausted wrapup turn
    expect(mockMakeRequest).toHaveBeenCalledTimes(26);
  });

  it("respects signal.aborted and throws cancelled before first turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = makeBaseOpts({ signal: controller.signal });

    await expect(runAgentLoop(opts)).rejects.toThrow("cancelled");
    expect(mockMakeRequest).toHaveBeenCalledTimes(0);
  });

  it("respects signal.aborted mid-loop after tool execution", async () => {
    const controller = new AbortController();

    const toolFence = [
      "Checking.",
      "```forge_tool",
      '{"callId":"call-x","name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(toolFence);
    mockExecuteProjectTool.mockImplementationOnce(async () => {
      controller.abort(); // Abort during tool execution
      return {
        result: { callId: "call-x", toolName: "list_directory", ok: true, data: {} },
        durationMs: 1,
      };
    });

    const opts = makeBaseOpts({ signal: controller.signal });
    await expect(runAgentLoop(opts)).rejects.toThrow("cancelled");
  });

  it("collects agentReadRef when read_file tool returns one", async () => {
    const toolFence = [
      "Reading the file.",
      "```forge_tool",
      '{"callId":"call-r","name":"read_file","arguments":{"path":"src/app.ts"}}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(toolFence);
    const fakeRef = {
      id: "ref-1",
      requestId: "req-1",
      conversationId: "conv-1",
      projectId: "proj-1",
      relativePath: "src/app.ts",
      snapshotPath: "/data/snapshots/ref-1.txt",
      contentHash: "abc123",
      capturedAt: Date.now(),
      size: 1024,
      language: "typescript",
      fullFile: true,
    };
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: { callId: "call-r", toolName: "read_file", ok: true, data: { content: "export default {}" } },
      agentReadRef: fakeRef,
      durationMs: 15,
    });

    mockMakeRequest.mockResolvedValueOnce(
      '```forge_final\n{"status":"completed","summary":"Read file.","content":"The file is empty."}\n```'
    );

    const result = await runAgentLoop(makeBaseOpts());

    expect(result.agentReadRefs).toHaveLength(1);
    expect(result.agentReadRefs[0]).toEqual(fakeRef);
    expect(result.toolActivity).toHaveLength(1);
    expect(result.toolActivity[0]!.toolName).toBe("read_file");
    expect(result.toolActivity[0]!.ok).toBe(true);
  });

  it("records tool activity for failed tool calls", async () => {
    const toolFence = [
      "Reading.",
      "```forge_tool",
      '{"callId":"call-fail","name":"read_file","arguments":{"path":"nonexistent.ts"}}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(toolFence);
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: {
        callId: "call-fail",
        toolName: "read_file",
        ok: false,
        errorCode: "NOT_FOUND",
        errorMessage: "File not found",
      },
      durationMs: 5,
    });

    mockMakeRequest.mockResolvedValueOnce(
      '```forge_final\n{"status":"completed","summary":"Read failed.","content":"The file does not exist."}\n```'
    );

    const result = await runAgentLoop(makeBaseOpts());

    expect(result.toolActivity).toHaveLength(1);
    expect(result.toolActivity[0]!.ok).toBe(false);
    expect(result.toolActivity[0]!.errorCode).toBe("NOT_FOUND");
  });

  it("handles multiple sequential tool calls across turns", async () => {
    const listFence = [
      "Step 1.",
      "```forge_tool",
      '{"callId":"c1","name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");
    const searchFence = [
      "Step 2.",
      "```forge_tool",
      '{"callId":"c2","name":"search_code","arguments":{"query":"useState"}}',
      "```",
    ].join("\n");

    mockMakeRequest
      .mockResolvedValueOnce(listFence)
      .mockResolvedValueOnce(searchFence)
      .mockResolvedValueOnce(
        '```forge_final\n{"status":"completed","summary":"Done.","content":"Done."}\n```'
      );

    mockExecuteProjectTool
      .mockResolvedValueOnce({
        result: { callId: "c1", toolName: "list_directory", ok: true, data: {} },
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        result: { callId: "c2", toolName: "search_code", ok: true, data: {} },
        durationMs: 10,
      });

    const result = await runAgentLoop(makeBaseOpts());

    expect(result.finalText).toBe("Done.");
    expect(result.stepCount).toBe(2);
    expect(result.toolActivity).toHaveLength(2);
    expect(result.toolActivity[0]!.toolName).toBe("list_directory");
    expect(result.toolActivity[1]!.toolName).toBe("search_code");
  });

  it("passes system prompt conditionally (undefined → not passed)", async () => {
    mockMakeRequest.mockResolvedValueOnce("Answer.");

    await runAgentLoop(makeBaseOpts({ system: undefined }));

    const callArgs = mockMakeRequest.mock.calls[0]![0];
    expect("system" in callArgs).toBe(false);
  });

  it("passes system prompt when provided", async () => {
    mockMakeRequest.mockResolvedValueOnce("Answer.");

    await runAgentLoop(makeBaseOpts({ system: "You are a helpful assistant." }));

    const callArgs = mockMakeRequest.mock.calls[0]![0];
    expect(callArgs.system).toBe("You are a helpful assistant.");
  });
});