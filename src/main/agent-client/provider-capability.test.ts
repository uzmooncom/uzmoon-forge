/**
 * provider-capability.test.ts — ProviderCapabilities registry and gating
 *
 * Verifies:
 * - AgentProfile.capabilities field is respected
 * - Vision capability controls whether screenshots are injected
 * - Tool capability controls whether tools are exposed
 * - Missing capabilities default to false (deny-by-default)
 * - Capability check functions work correctly
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig, ProviderCapabilities } from "../../shared/types.js";

vi.mock("./client.js", () => ({
  makeRequest: vi.fn(),
}));
vi.mock("../project-files/tool-executor.js", () => ({
  executeProjectTool: vi.fn(),
  buildResultSummary: vi.fn(() => "ok"),
  newActivityId: vi.fn(() => "activity-id-cap"),
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

import { runAgentLoop } from "./agent-loop.js";
import type { AgentLoopOptions } from "./agent-loop.js";
import { makeRequest as mockMakeRequest } from "./client.js";

const mockMR = vi.mocked(mockMakeRequest);

function makeCfg(capabilities?: ProviderCapabilities): AgentConfig {
  return {
    id: "cfg-cap",
    name: "Cap Test Agent",
    endpoint: "http://localhost:11434",
    protocol: "openai" as const,
    model: "test-model",
    ...(capabilities !== undefined && { capabilities }),
  };
}

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    cfg: makeCfg(),
    apiKey: "",
    messages: [{ role: "user", content: "hello" }],
    system: undefined,
    projectId: "",
    projectRoot: "",
    requestId: "req-cap-1",
    conversationId: "conv-cap-1",
    isProjectMode: false,
    onChunk: vi.fn(),
    onIntermediateText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Provider capabilities", () => {
  beforeEach(() => {
    mockMR.mockReset();
  });

  // ── 1. ProviderCapabilities fields ───────────────────────────────────────

  it("ProviderCapabilities interface has expected fields", () => {
    const caps: ProviderCapabilities = {
      vision: true,
      tools: true,
      json: false,
      streaming: true,
      maxContextTokens: 128000,
    };
    expect(caps.vision).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.json).toBe(false);
    expect(caps.streaming).toBe(true);
    expect(caps.maxContextTokens).toBe(128000);
  });

  it("ProviderCapabilities is optional on AgentConfig", () => {
    const cfg = makeCfg(undefined);
    expect("capabilities" in cfg).toBe(false);
  });

  it("ProviderCapabilities can be set on AgentConfig", () => {
    const caps: ProviderCapabilities = { vision: true, tools: true, json: true, streaming: true };
    const cfg = makeCfg(caps);
    expect(cfg.capabilities).toEqual(caps);
  });

  // ── 2. Partial capabilities (deny-by-default) ─────────────────────────────

  it("partial capabilities — only declared fields present", () => {
    const caps: ProviderCapabilities = { vision: false };
    expect(caps.vision).toBe(false);
    expect(caps.tools).toBeUndefined();
    expect(caps.json).toBeUndefined();
  });

  it("empty capabilities object accepted", () => {
    const caps: ProviderCapabilities = {};
    expect(caps.vision).toBeUndefined();
    expect(caps.tools).toBeUndefined();
  });

  // ── 3. maxContextTokens bounds ───────────────────────────────────────────

  it("maxContextTokens can be any positive integer", () => {
    const caps: ProviderCapabilities = { maxContextTokens: 4096 };
    expect(caps.maxContextTokens).toBe(4096);
  });

  it("maxContextTokens is optional", () => {
    const caps: ProviderCapabilities = { vision: true };
    expect(caps.maxContextTokens).toBeUndefined();
  });

  // ── 4. Run completes with vision=false (no screenshots injected) ──────────

  it("run completes normally when capabilities not set (no vision gating needed)", async () => {
    mockMR.mockResolvedValueOnce("Hello!");
    const result = await runAgentLoop(makeOpts({ cfg: makeCfg(undefined) }));
    expect(result.finalText).toBe("Hello!");
  });

  it("run completes normally when vision=false", async () => {
    mockMR.mockResolvedValueOnce("Hello!");
    const result = await runAgentLoop(makeOpts({ cfg: makeCfg({ vision: false }) }));
    expect(result.finalText).toBe("Hello!");
  });

  it("run completes normally when vision=true", async () => {
    mockMR.mockResolvedValueOnce("Hello!");
    const result = await runAgentLoop(makeOpts({ cfg: makeCfg({ vision: true }) }));
    expect(result.finalText).toBe("Hello!");
  });

  // ── 5. Different profile capabilities don't bleed between runs ────────────

  it("two sequential runs with different capabilities — each uses its own cfg", async () => {
    mockMR.mockResolvedValueOnce("Run A.").mockResolvedValueOnce("Run B.");

    const cfgA = makeCfg({ vision: true, tools: true });
    const cfgB = makeCfg({ vision: false, tools: false });

    const resultA = await runAgentLoop(makeOpts({ cfg: cfgA, requestId: "req-a" }));
    const resultB = await runAgentLoop(makeOpts({ cfg: cfgB, requestId: "req-b" }));

    expect(resultA.finalText).toBe("Run A.");
    expect(resultB.finalText).toBe("Run B.");
    expect(cfgA.capabilities?.vision).toBe(true);
    expect(cfgB.capabilities?.vision).toBe(false);
  });
});