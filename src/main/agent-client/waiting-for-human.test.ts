/**
 * waiting-for-human.test.ts — Non-terminal waiting_for_human lifecycle
 *
 * Verifies:
 * - forge_final with blocked + structured blocker → waiting_for_human state
 * - onWaitingForHuman called with correct HumanRequiredReason
 * - Run resumes and continues after onWaitingForHuman resolves
 * - Run cancelled if onWaitingForHuman rejects
 * - blocked without valid structured blocker → recovery (NOT waiting_for_human)
 * - All 7 HumanRequiredKind values are accepted
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop, AgentLoopError } from "./agent-loop.js";
import type { AgentLoopOptions } from "./agent-loop.js";
import type { AgentConfig, HumanRequiredReason } from "../../shared/types.js";

vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
}));
vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-wfh"),
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
  id: "cfg-wfh",
  name: "WFH Test Agent",
  endpoint: "http://localhost:11434",
  protocol: "openai" as const,
  model: "test-model",
};

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    cfg: BASE_CFG,
    apiKey: "",
    messages: [{ role: "user", content: "navigate to the site" }],
    system: undefined,
    projectId: "proj-wfh",
    projectRoot: "/tmp/proj-wfh",
    requestId: "req-wfh-1",
    conversationId: "conv-wfh-1",
    isProjectMode: true,
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function blockedFinal(kind: string, description: string): string {
  // forge_final envelope: outer wrapper has {"content": "<JSON-stringified structured object>"}
  const structured = JSON.stringify({ status: "blocked", summary: description, blocker: { kind, description } });
  const envelope = JSON.stringify({ content: structured });
  return `\`\`\`forge_final\n${envelope}\n\`\`\``;
}

function completedFinal(content: string): string {
  const structured = JSON.stringify({ status: "completed", summary: content });
  const envelope = JSON.stringify({ content: structured });
  return `\`\`\`forge_final\n${envelope}\n\`\`\``;
}

describe("Waiting for human — non-terminal lifecycle", () => {
  beforeEach(() => {
    mockMR.mockReset();
    mockEPT.mockReset();
  });

  // ── 1. Basic blocked + resume ─────────────────────────────────────────────

  it("onWaitingForHuman called when model returns blocked forge_final", async () => {
    mockMR
      .mockResolvedValueOnce(blockedFinal("credentials", "Please log in to the dashboard."))
      .mockResolvedValueOnce(completedFinal("Successfully logged in."));

    let capturedReason: HumanRequiredReason | undefined;
    const onWaitingForHuman = vi.fn(async (reason: HumanRequiredReason) => {
      capturedReason = reason;
      // Resolves → run continues
    });

    const result = await runAgentLoop(makeOpts({ onWaitingForHuman }));

    expect(onWaitingForHuman).toHaveBeenCalledTimes(1);
    expect(capturedReason?.kind).toBe("credentials");
    expect(capturedReason?.description).toBe("Please log in to the dashboard.");
    expect(result.finalText).toBe("Successfully logged in.");
  });

  it("run resumes after onWaitingForHuman resolves and gets a new provider turn", async () => {
    mockMR
      .mockResolvedValueOnce(blockedFinal("captcha", "Solve the captcha."))
      .mockResolvedValueOnce(completedFinal("Captcha solved."));

    let resumed = false;
    const onWaitingForHuman = vi.fn(async () => {
      resumed = true;
    });

    const result = await runAgentLoop(makeOpts({ onWaitingForHuman }));

    expect(resumed).toBe(true);
    expect(result.finalText).toBe("Captcha solved.");
    // Two provider turns: blocked + resumed final
    expect(mockMR).toHaveBeenCalledTimes(2);
  });

  // ── 2. Cancellation during wait ───────────────────────────────────────────

  it("run is cancelled if onWaitingForHuman rejects", async () => {
    mockMR.mockResolvedValueOnce(blockedFinal("mfa", "Enter your 2FA code."));

    const onWaitingForHuman = vi.fn(async () => {
      throw new Error("CANCELLED");
    });

    await expect(runAgentLoop(makeOpts({ onWaitingForHuman }))).rejects.toThrow(AgentLoopError);
    expect(onWaitingForHuman).toHaveBeenCalledTimes(1);
    // No second provider turn
    expect(mockMR).toHaveBeenCalledTimes(1);
  });

  // ── 3. All 7 HumanRequiredKind values accepted ────────────────────────────

  const KINDS = [
    "captcha",
    "mfa",
    "passkey",
    "credentials",
    "browser_permission",
    "explicit_user_takeover",
    "unsupported_human_only_step",
  ] as const;

  for (const kind of KINDS) {
    it(`HumanRequiredKind '${kind}' — onWaitingForHuman called with correct kind`, async () => {
      mockMR
        .mockResolvedValueOnce(blockedFinal(kind, `Test: ${kind}`))
        .mockResolvedValueOnce(completedFinal("Done."));

      let capturedKind: string | undefined;
      const onWaitingForHuman = vi.fn(async (reason: HumanRequiredReason) => {
        capturedKind = reason.kind;
      });

      await runAgentLoop(makeOpts({ onWaitingForHuman }));
      expect(capturedKind).toBe(kind);
    });
  }

  // ── 4. blocked without valid structured blocker → recovery ────────────────

  it("blocked status without structured blocker → recovery (not waiting_for_human)", async () => {
    // forge_final with status=blocked but no blocker field
    const malformed = `\`\`\`forge_final\n${JSON.stringify({ status: "blocked", summary: "Blocked somehow" })}\n\`\`\``;

    // After recovery injections, return a valid final
    mockMR.mockResolvedValue(malformed);

    const onWaitingForHuman = vi.fn();

    await expect(
      runAgentLoop(makeOpts({ onWaitingForHuman }))
    ).rejects.toThrow(AgentLoopError);

    // onWaitingForHuman must NOT be called (it's a protocol error, not a valid block)
    expect(onWaitingForHuman).not.toHaveBeenCalled();
  });

  // ── 5. Multiple sequential blocks in one run ──────────────────────────────

  it("multiple waiting_for_human pauses in one run — each resume continues", async () => {
    mockMR
      .mockResolvedValueOnce(blockedFinal("captcha", "Solve captcha first."))
      .mockResolvedValueOnce(blockedFinal("mfa", "Now enter your 2FA."))
      .mockResolvedValueOnce(completedFinal("All done."));

    const kinds: string[] = [];
    const onWaitingForHuman = vi.fn(async (reason: HumanRequiredReason) => {
      kinds.push(reason.kind);
    });

    const result = await runAgentLoop(makeOpts({ onWaitingForHuman }));

    expect(onWaitingForHuman).toHaveBeenCalledTimes(2);
    expect(kinds).toEqual(["captcha", "mfa"]);
    expect(result.finalText).toBe("All done.");
  });

  // ── 6. No onWaitingForHuman callback → immediate resolve (default) ────────

  it("no onWaitingForHuman callback: run continues immediately on blocked", async () => {
    mockMR
      .mockResolvedValueOnce(blockedFinal("credentials", "Login required."))
      .mockResolvedValueOnce(completedFinal("Proceeded anyway."));

    // No onWaitingForHuman in opts — omit the property entirely
    const result = await runAgentLoop(makeOpts({}));

    expect(result.finalText).toBe("Proceeded anyway.");
  });
});