/**
 * agent-runtime.test.ts — V0.6 Agent Runtime Core unit tests.
 *
 * Tests:
 * - normalizeDecision() — all cases from spec §64
 * - AgentRun state machine — valid and invalid transitions
 * - Recovery budget — bounded protocol recovery
 * - forge_final envelope — parsing, empty detection, multi-envelope detection
 * - runAgentLoop integration — naked prose recovery, multi-round analysis, DB invariant
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock transport and tool executor ────────────────────────────────────────
vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
  classifyError: vi.fn(() => ({ status: "error", message: "error" })),
}));

vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-1"),
}));

import { normalizeDecision, runAgentLoop, AgentLoopError, stripForgeFences } from "./agent-loop.js";
import { makeRequest } from "./client.js";
import { executeProjectTool } from "../project-files/tool-executor.js";
import type { ForgeToolCall } from "../../shared/types.js";

const mockMakeRequest = vi.mocked(makeRequest);
const mockExecuteProjectTool = vi.mocked(executeProjectTool);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBaseCfg() {
  return {
    id: "agent-1",
    name: "Test Agent",
    endpoint: "https://api.example.com",
    protocol: "openai" as const,
    model: "gpt-test",
  };
}

function makeBaseOpts(
  overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}
): Parameters<typeof runAgentLoop>[0] {
  return {
    cfg: makeBaseCfg(),
    apiKey: "test-key",
    messages: [{ role: "user", content: "Hello" }],
    system: undefined,
    projectId: "proj-1",
    projectRoot: "/projects/proj-1",
    requestId: "req-1",
    conversationId: "conv-1",
    isProjectMode: false, // default: Global Chat (accepts naked prose as final)
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: { aborted: false },
    ...overrides,
  };
}

// ── normalizeDecision() tests ────────────────────────────────────────────────

describe("normalizeDecision — spec §64", () => {
  // ── Native tool calls ───────────────────────────────────────────────────
  it("native tool calls → tool_calls", () => {
    const calls: ForgeToolCall[] = [
      { callId: "c1", name: "list_directory", arguments: {} },
    ];
    const result = normalizeDecision("some text", calls, true, false);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]!.name).toBe("list_directory");
    }
  });

  // ── forge_tool fences ───────────────────────────────────────────────────
  it("forge_tool fence in text → tool_calls", () => {
    const text = [
      "Checking directory.",
      "```forge_tool",
      '{"name":"search_files","arguments":{"query":"auth"}}',
      "```",
    ].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls[0]!.name).toBe("search_files");
    }
  });

  // ── forge_final ─────────────────────────────────────────────────────────
  it("forge_final with content → final", () => {
    const text = [
      "```forge_final",
      '{"content":"Bu proje TypeScript monorepo."}',
      "```",
    ].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.content).toBe("Bu proje TypeScript monorepo.");
    }
  });

  it("forge_final + forge_edit_proposal → final with proposalFenceRaw", () => {
    const text = [
      "```forge_final",
      '{"content":"Auth bugı düzeltildi."}',
      "```",
      "```forge_edit_proposal",
      '{"summary":"Fix auth","files":[{"path":"src/auth.ts","content":"export {}"}]}',
      "```",
    ].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.content).toBe("Auth bugı düzeltildi.");
      expect(result.proposalFenceRaw).toBeDefined();
      expect(result.proposalFenceRaw).toContain("forge_edit_proposal");
    }
  });

  it("empty forge_final content → invalid (EMPTY_FINAL_CONTENT)", () => {
    const text = ["```forge_final", '{"content":""}', "```"].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("EMPTY_FINAL_CONTENT");
      expect(result.recoverable).toBe(true);
    }
  });

  it("malformed forge_final JSON → invalid (MALFORMED_FINAL_ENVELOPE)", () => {
    const text = ["```forge_final", "not json {{", "```"].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("MALFORMED_FINAL_ENVELOPE");
    }
  });

  it("multiple forge_final envelopes → invalid (MULTIPLE_FINAL_ENVELOPES, not recoverable)", () => {
    const text = [
      "```forge_final",
      '{"content":"First answer"}',
      "```",
      "```forge_final",
      '{"content":"Second answer"}',
      "```",
    ].join("\n");
    const result = normalizeDecision(text, [], true, false);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("MULTIPLE_FINAL_ENVELOPES");
      expect(result.recoverable).toBe(false);
    }
  });

  it("naked prose in project mode → invalid (NAKED_PROSE_IN_PROJECT_MODE)", () => {
    const result = normalizeDecision(
      "Birkaç önemli dosyayı daha paralel okuyayım.",
      [],
      true, // isProjectMode
      false
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("NAKED_PROSE_IN_PROJECT_MODE");
      expect(result.recoverable).toBe(true);
    }
  });

  it("empty response in project mode → invalid (EMPTY_RESPONSE)", () => {
    const result = normalizeDecision("", [], true, false);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("EMPTY_RESPONSE");
    }
  });

  it("naked prose in global chat (not project mode) → final", () => {
    const result = normalizeDecision(
      "This is a helpful answer.",
      [],
      false, // NOT project mode
      false
    );
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.content).toBe("This is a helpful answer.");
    }
  });

  it("forge_tool fence ignored when budget exhausted → falls through to forge_final check", () => {
    const text = [
      "```forge_tool",
      '{"name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");
    const result = normalizeDecision(text, [], true, true /* budgetExhausted */);
    // No forge_final → falls to project-mode invalid
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("NAKED_PROSE_IN_PROJECT_MODE");
    }
  });

  it("native tool calls ignored when budget exhausted", () => {
    const calls: ForgeToolCall[] = [{ callId: "c1", name: "read_file", arguments: {} }];
    const result = normalizeDecision("", calls, true, true /* budgetExhausted */);
    // Budget exhausted — native calls ignored, empty text → EMPTY_RESPONSE
    expect(result.kind).toBe("invalid");
  });
});

// ── stripForgeFences() tests ──────────────────────────────────────────────────

describe("stripForgeFences()", () => {
  it("strips forge_tool fences", () => {
    const text = ["Checking.", "```forge_tool", '{"name":"list_directory"}', "```"].join("\n");
    expect(stripForgeFences(text)).toBe("Checking.");
  });

  it("strips forge_tool_result fences", () => {
    const text = ["```forge_tool_result", '{"ok":true}', "```"].join("\n");
    expect(stripForgeFences(text)).toBe("");
  });

  it("strips forge_final fences", () => {
    const text = ["```forge_final", '{"content":"answer"}', "```"].join("\n");
    expect(stripForgeFences(text)).toBe("");
  });

  it("leaves forge_edit_proposal intact (handled by edit-service)", () => {
    const text = [
      "```forge_edit_proposal",
      '{"summary":"fix","files":[]}',
      "```",
    ].join("\n");
    expect(stripForgeFences(text)).toContain("forge_edit_proposal");
  });
});

// ── runAgentLoop — V0.6 integration tests ────────────────────────────────────

describe("Agent loop — V0.6 runtime", () => {
  beforeEach(() => {
    mockMakeRequest.mockReset();
    mockExecuteProjectTool.mockReset();
  });

  // ── Global Chat — backward compatibility ────────────────────────────────
  it("global chat: naked prose accepted as final", async () => {
    mockMakeRequest.mockResolvedValueOnce("Hello from the model.");
    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: false }));
    expect(result.finalText).toBe("Hello from the model.");
    expect(result.stepCount).toBe(0);
    expect(result.agentRun.state).toBe("completed");
  });

  // ── Project mode: forge_final required ──────────────────────────────────
  it("project mode: forge_final accepted as final", async () => {
    const text = ["```forge_final", '{"content":"Proje analizi tamamlandı."}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(text);
    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    expect(result.finalText).toBe("Proje analizi tamamlandı.");
    expect(result.agentRun.state).toBe("completed");
  });

  // ── CORE: naked prose in project mode → recovery → valid forge_final ──
  it("project mode: naked prose triggers recovery, valid forge_final continues run", async () => {
    // Turn 1: naked prose (invalid — should trigger recovery)
    mockMakeRequest.mockResolvedValueOnce(
      "Birkaç önemli dosyayı daha paralel okuyayım."
    );
    // Turn 2: valid forge_final
    const finalText = ["```forge_final", '{"content":"İşte proje analizi."}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(finalText);

    const opts = makeBaseOpts({ isProjectMode: true });
    const result = await runAgentLoop(opts);

    expect(result.finalText).toBe("İşte proje analizi.");
    expect(result.agentRun.recoveryCount).toBe(1);
    expect(result.agentRun.state).toBe("completed");
    // onChunk receives only the final answer, not the naked prose
    expect(opts.onChunk).toHaveBeenCalledTimes(1);
    expect(opts.onChunk).toHaveBeenCalledWith("İşte proje analizi.");
    // onIntermediateText receives the stripped narration (dev/telemetry only)
    expect(opts.onIntermediateText).toHaveBeenCalledWith(
      "Birkaç önemli dosyayı daha paralel okuyayım."
    );
  });

  // ── Recovery budget exhaustion ──────────────────────────────────────────
  it("project mode: naked prose exceeding MAX_PROTOCOL_RECOVERY_TURNS → PROTOCOL_RECOVERY_EXHAUSTED", async () => {
    // 4 consecutive naked prose responses (MAX = 3)
    mockMakeRequest.mockResolvedValue("şimdi dosyaları okuyayım.");

    const opts = makeBaseOpts({ isProjectMode: true });
    await expect(runAgentLoop(opts)).rejects.toThrow(AgentLoopError);

    try {
      await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    } catch (err) {
      expect(err instanceof AgentLoopError).toBe(true);
      if (err instanceof AgentLoopError) {
        expect(err.code).toBe("PROTOCOL_RECOVERY_EXHAUSTED");
      }
    }
  });

  // ── Multi-round analysis test (spec §66) ────────────────────────────────
  it("multi-round: 5 tool steps → forge_final → one complete result", async () => {
    const toolFence = (name: string, idx: number) =>
      ["```forge_tool", `{"callId":"c${idx}","name":"${name}","arguments":{}}`, "```"].join("\n");

    // 5 tool turns
    mockMakeRequest
      .mockResolvedValueOnce(toolFence("list_directory", 1))
      .mockResolvedValueOnce(toolFence("read_file", 2))
      .mockResolvedValueOnce(toolFence("read_file", 3))
      .mockResolvedValueOnce(toolFence("list_directory", 4))
      .mockResolvedValueOnce(toolFence("read_file", 5));

    for (let i = 1; i <= 5; i++) {
      mockExecuteProjectTool.mockResolvedValueOnce({
        result: { callId: `c${i}`, toolName: "list_directory", ok: true, data: { entries: [] } },
        durationMs: 5,
      });
    }

    // Turn 6: forge_final
    const finalText = ["```forge_final", '{"content":"Complete analysis here."}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(finalText);

    const opts = makeBaseOpts({ isProjectMode: true });
    const result = await runAgentLoop(opts);

    expect(result.finalText).toBe("Complete analysis here.");
    expect(result.stepCount).toBe(5);
    expect(result.agentRun.state).toBe("completed");
    expect(result.agentRun.recoveryCount).toBe(0);
    // makeRequest called exactly 6 times (5 tool + 1 final)
    expect(mockMakeRequest).toHaveBeenCalledTimes(6);
    // onChunk called exactly once with the final answer
    expect(opts.onChunk).toHaveBeenCalledTimes(1);
    expect(opts.onChunk).toHaveBeenCalledWith("Complete analysis here.");
  });

  // ── Tool steps then recovery (spec §67) ─────────────────────────────────
  it("tool steps, then 2 invalid turns, then valid forge_final — recovery succeeds", async () => {
    const toolFence = (idx: number) =>
      ["```forge_tool", `{"callId":"c${idx}","name":"list_directory","arguments":{}}`, "```"].join("\n");

    // Turn 1: valid tool call
    mockMakeRequest.mockResolvedValueOnce(toolFence(1));
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: { callId: "c1", toolName: "list_directory", ok: true, data: {} },
      durationMs: 5,
    });

    // Turns 2–3: invalid (naked prose)
    mockMakeRequest.mockResolvedValueOnce("devam edeyim mi?");
    mockMakeRequest.mockResolvedValueOnce("biraz daha bakayım");

    // Turn 4: valid forge_final
    const finalTxt = ["```forge_final", '{"content":"Done."}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(finalTxt);

    const opts = makeBaseOpts({ isProjectMode: true });
    const result = await runAgentLoop(opts);

    expect(result.finalText).toBe("Done.");
    expect(result.stepCount).toBe(1);
    expect(result.agentRun.recoveryCount).toBe(2);
    expect(result.agentRun.state).toBe("completed");
  });

  // ── Empty forge_final → recovery ────────────────────────────────────────
  it("empty forge_final → recovery → valid forge_final", async () => {
    const emptyFinal = ["```forge_final", '{"content":""}', "```"].join("\n");
    const validFinal = ["```forge_final", '{"content":"Real answer."}', "```"].join("\n");

    mockMakeRequest
      .mockResolvedValueOnce(emptyFinal)
      .mockResolvedValueOnce(validFinal);

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    expect(result.finalText).toBe("Real answer.");
    expect(result.agentRun.recoveryCount).toBe(1);
  });

  // ── Multiple forge_final envelopes → unrecoverable fail ─────────────────
  it("multiple forge_final envelopes → PROTOCOL_RECOVERY_EXHAUSTED (unrecoverable)", async () => {
    const multiEnvelope = [
      "```forge_final",
      '{"content":"First"}',
      "```",
      "```forge_final",
      '{"content":"Second"}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(multiEnvelope);

    await expect(
      runAgentLoop(makeBaseOpts({ isProjectMode: true }))
    ).rejects.toThrow(AgentLoopError);
  });

  // ── Cancellation ────────────────────────────────────────────────────────
  it("respects signal.aborted before first turn", async () => {
    const signal = { aborted: true };
    await expect(
      runAgentLoop(makeBaseOpts({ signal }))
    ).rejects.toThrow(AgentLoopError);

    try {
      await runAgentLoop(makeBaseOpts({ signal }));
    } catch (err) {
      expect(err instanceof AgentLoopError && err.code === "CANCELLED").toBe(true);
    }
    expect(mockMakeRequest).not.toHaveBeenCalled();
  });

  it("respects signal.aborted mid-recovery (project mode)", async () => {
    const signal = { aborted: false };
    // First turn: naked prose → triggers recovery
    mockMakeRequest.mockImplementationOnce(async () => {
      signal.aborted = true; // abort during second turn setup
      return "devam ediyorum";
    });

    await expect(
      runAgentLoop(makeBaseOpts({ isProjectMode: true, signal }))
    ).rejects.toThrow(AgentLoopError);
  });

  // ── forge_final + forge_edit_proposal ────────────────────────────────────
  it("forge_final with forge_edit_proposal → result includes proposalFenceRaw", async () => {
    const text = [
      "```forge_final",
      '{"content":"Fix explanation."}',
      "```",
      "```forge_edit_proposal",
      '{"summary":"fix auth","files":[{"path":"src/auth.ts","content":"export {}"}]}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(text);

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));

    expect(result.finalText).toBe("Fix explanation.");
    expect(result.proposalFenceRaw).toBeDefined();
    expect(result.proposalFenceRaw).toContain("forge_edit_proposal");
    expect(result.proposalFenceRaw).toContain("fix auth");
  });

  // ── AgentRun state tracking ──────────────────────────────────────────────
  it("agentRun state is completed on success", async () => {
    const text = ["```forge_final", '{"content":"OK"}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(text);

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    expect(result.agentRun.state).toBe("completed");
    expect(result.agentRun.completedAt).toBeDefined();
    expect(result.agentRun.toolStepCount).toBe(0);
  });

  it("agentRun tracks toolStepCount correctly", async () => {
    const toolFence = ["```forge_tool", '{"callId":"c1","name":"list_directory","arguments":{}}', "```"].join("\n");
    const finalText = ["```forge_final", '{"content":"Done."}', "```"].join("\n");

    mockMakeRequest
      .mockResolvedValueOnce(toolFence)
      .mockResolvedValueOnce(finalText);

    mockExecuteProjectTool.mockResolvedValueOnce({
      result: { callId: "c1", toolName: "list_directory", ok: true, data: {} },
      durationMs: 5,
    });

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    expect(result.agentRun.toolStepCount).toBe(1);
    expect(result.agentRun.state).toBe("completed");
  });

  // ── Intermediate narration not forwarded to onChunk ─────────────────────
  it("intermediate model narration (invalid turns) NOT forwarded to onChunk", async () => {
    // 2 naked-prose turns then valid final
    mockMakeRequest
      .mockResolvedValueOnce("şimdi okuyorum")
      .mockResolvedValueOnce("biraz daha bakayım")
      .mockResolvedValueOnce(
        ["```forge_final", '{"content":"Final answer."}', "```"].join("\n")
      );

    const opts = makeBaseOpts({ isProjectMode: true });
    const result = await runAgentLoop(opts);

    expect(result.finalText).toBe("Final answer.");
    // onChunk called once only — with the final answer
    expect(opts.onChunk).toHaveBeenCalledTimes(1);
    expect(opts.onChunk).toHaveBeenCalledWith("Final answer.");
    // onIntermediateText called for each invalid turn
    expect(opts.onIntermediateText).toHaveBeenCalledTimes(2);
  });

  // ── Budget enforcement with explicit finalization ────────────────────────
  it("respects MAX_TOOL_STEPS_PER_REQUEST and triggers forge_final check", async () => {
    // 25 tool calls (budget limit)
    for (let i = 1; i <= 25; i++) {
      mockMakeRequest.mockResolvedValueOnce(
        ["```forge_tool", `{"callId":"c${i}","name":"list_directory","arguments":{}}`, "```"].join("\n")
      );
      mockExecuteProjectTool.mockResolvedValueOnce({
        result: { callId: `c${i}`, toolName: "list_directory", ok: true, data: { entries: [] } },
        durationMs: 5,
      });
    }

    // After budget: model returns forge_final (budget path: tools not passed)
    const finalText = ["```forge_final", '{"content":"Budget exhausted answer."}', "```"].join("\n");
    mockMakeRequest.mockResolvedValueOnce(finalText);

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: true }));
    expect(result.stepCount).toBe(25);
    expect(result.finalText).toBe("Budget exhausted answer.");
    expect(result.agentRun.state).toBe("completed");
  });

  // ── Global chat backward compat — forge_tool fences still work ───────────
  it("global chat: forge_tool fence still executes correctly", async () => {
    const toolFence = [
      "Let me check.",
      "```forge_tool",
      '{"callId":"c1","name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");

    mockMakeRequest.mockResolvedValueOnce(toolFence);
    mockExecuteProjectTool.mockResolvedValueOnce({
      result: { callId: "c1", toolName: "list_directory", ok: true, data: { entries: [] } },
      durationMs: 5,
    });
    // Global chat: final turn is naked prose
    mockMakeRequest.mockResolvedValueOnce("The project has 5 files.");

    const result = await runAgentLoop(makeBaseOpts({ isProjectMode: false }));
    expect(result.finalText).toBe("The project has 5 files.");
    expect(result.stepCount).toBe(1);
  });
});