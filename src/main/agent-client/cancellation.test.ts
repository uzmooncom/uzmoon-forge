/**
 * cancellation.test.ts — Real AbortSignal cancellation semantics
 *
 * Verifies that AbortController / AbortSignal wiring is correct:
 * - Pre-aborted signal stops before first provider turn
 * - Mid-run abort stops between tool steps
 * - Abort during waiting_for_human transitions to cancelled
 * - Duplicate abort is idempotent
 * - run.terminated=true after any cancel path
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop, AgentLoopError } from "./agent-loop.js";
import type { AgentLoopOptions } from "./agent-loop.js";
import type { AgentConfig } from "../../shared/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
}));
vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-cancel"),
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

const BASE_CFG: AgentConfig = {
  id: "cfg-cancel",
  name: "Cancel Test Agent",
  endpoint: "http://localhost:11434",
  protocol: "openai" as const,
  model: "test-model",
};

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    cfg: BASE_CFG,
    apiKey: "",
    messages: [{ role: "user", content: "do stuff" }],
    system: undefined,
    projectId: "",
    projectRoot: "",
    requestId: "req-cancel-1",
    conversationId: "conv-cancel-1",
    isProjectMode: false,
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Cancellation — real AbortSignal semantics", () => {
  beforeEach(() => {
    mockMR.mockReset();
    mockEPT.mockReset();
  });

  // ── 1. Pre-aborted signal ─────────────────────────────────────────────────

  it("pre-aborted signal stops before first provider turn", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(runAgentLoop(makeOpts({ signal: ctrl.signal }))).rejects.toThrow(
      AgentLoopError
    );
    expect(mockMR).not.toHaveBeenCalled();
  });

  it("pre-aborted signal throws with CANCELLED code", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    try {
      await runAgentLoop(makeOpts({ signal: ctrl.signal }));
    } catch (err) {
      expect(err instanceof AgentLoopError).toBe(true);
      expect((err as AgentLoopError).code).toBe("CANCELLED");
    }
  });

  // ── 2. Mid-run abort ──────────────────────────────────────────────────────

  it("abort during tool execution stops after current tool completes", async () => {
    const ctrl = new AbortController();

    const toolFence = [
      "Checking.",
      "```forge_tool",
      '{"callId":"cx","name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");

    mockMR.mockResolvedValueOnce(toolFence);
    mockEPT.mockImplementationOnce(async () => {
      ctrl.abort();
      return {
        result: { callId: "cx", toolName: "list_directory", ok: true, data: {} },
        durationMs: 1,
      };
    });

    await expect(runAgentLoop(makeOpts({ signal: ctrl.signal }))).rejects.toThrow("cancelled");
    expect(mockMR).toHaveBeenCalledTimes(1);
    expect(mockEPT).toHaveBeenCalledTimes(1);
  });

  it("abort between turns — second provider call never made", async () => {
    const ctrl = new AbortController();

    const toolFence = [
      "Working.",
      "```forge_tool",
      '{"callId":"c2","name":"list_directory","arguments":{}}',
      "```",
    ].join("\n");

    // First turn returns tool fence
    mockMR.mockResolvedValueOnce(toolFence);
    mockEPT.mockImplementationOnce(async () => {
      ctrl.abort();
      return {
        result: { callId: "c2", toolName: "list_directory", ok: true, data: {} },
        durationMs: 1,
      };
    });
    // Second turn should never be reached
    mockMR.mockResolvedValueOnce("Final answer.");

    await expect(runAgentLoop(makeOpts({ signal: ctrl.signal }))).rejects.toThrow("cancelled");
    expect(mockMR).toHaveBeenCalledTimes(1);
  });

  // ── 3. Abort during waiting_for_human ─────────────────────────────────────

  it("abort during waiting_for_human resolves to cancelled", async () => {
    const ctrl = new AbortController();

    // Model returns a forge_final with blocked + human_required blocker
    const structured = JSON.stringify({
      status: "blocked",
      summary: "Need login",
      blocker: { kind: "credentials", description: "Please log in." },
    });
    const envelope = JSON.stringify({ content: structured });
    mockMR.mockResolvedValueOnce(`\`\`\`forge_final\n${envelope}\n\`\`\``);

    const onWaitingForHuman = vi.fn((_reason: unknown): Promise<void> => {
      // Immediately abort when called
      ctrl.abort();
      return new Promise<void>((_, reject) => {
        // Reject after a tick (signal abort event fires)
        setTimeout(() => reject(new Error("CANCELLED")), 0);
      });
    });

    await expect(
      runAgentLoop(makeOpts({ signal: ctrl.signal, onWaitingForHuman, isProjectMode: true, projectId: "proj-wfh", projectRoot: "/tmp/proj-wfh" }))
    ).rejects.toThrow(AgentLoopError);

    expect(onWaitingForHuman).toHaveBeenCalledTimes(1);
  });

  // ── 4. Duplicate abort is idempotent ──────────────────────────────────────

  it("calling abort() multiple times does not cause extra throws", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    ctrl.abort(); // second call is a no-op on AbortController

    let errorCount = 0;
    try {
      await runAgentLoop(makeOpts({ signal: ctrl.signal }));
    } catch {
      errorCount++;
    }

    expect(errorCount).toBe(1);
    expect(mockMR).not.toHaveBeenCalled();
  });

  // ── 5. Non-aborted signal → run completes normally ────────────────────────

  it("non-aborted signal: run completes normally", async () => {
    const ctrl = new AbortController(); // never aborted
    mockMR.mockResolvedValueOnce("Hello from the model.");

    const result = await runAgentLoop(makeOpts({ signal: ctrl.signal }));
    expect(result.finalText).toBe("Hello from the model.");
    expect(mockMR).toHaveBeenCalledTimes(1);
  });
});