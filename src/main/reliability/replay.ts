/**
 * replay.ts — ReplayHarness.
 *
 * Enables deterministic reproduction of failure scenarios without real API calls.
 *
 * A replay fixture captures:
 *   - Provider turn sequences (model responses, tool calls, final answers)
 *   - Initial conditions (conversation mode, tool availability)
 *   - Expected outcome (completed | failed | specific error code)
 *   - Invariants expected to hold or violate
 *
 * Fixtures are SCHEMA-VERSIONED (REPLAY_SCHEMA_VERSION = 1).
 * Old incompatible fixtures are discarded per §77.
 *
 * Provider matrix coverage (§76):
 *   - OpenAI-native tools
 *   - Anthropic-native tools
 *   - Forge fallback protocol (forge_tool / forge_final fences)
 *   - Naked prose in project mode (invalid)
 *   - Truncated control envelope
 *   - Provider disconnect mid-stream
 *   - Provider ignores correction then recovers
 *   - Provider never complies
 */

export const REPLAY_SCHEMA_VERSION = 1;

// ── Provider turn sequence ────────────────────────────────────────────────────

export type ProviderProtocol = "openai_native" | "anthropic_native" | "forge_fallback";

export interface ProviderTurn {
  /** The raw text returned by the provider for this turn */
  text: string;
  /**
   * If provider supports native tool calls, these are returned instead of text fences.
   * Leave undefined to simulate text-only / fence-based responses.
   */
  nativeToolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Simulate a mid-stream disconnect (throw PROVIDER_ERROR) */
  disconnect?: boolean;
}

// ── Replay fixture ────────────────────────────────────────────────────────────

export interface ReplayFixture {
  id: string;
  schemaVersion: number;
  name: string;
  description: string;
  /** What real historical bug does this cover? (maps to KnownIncidentEntry) */
  historicalBugClass?: string;
  /** Which invariant(s) does this regression cover? */
  invariantIds?: string[];

  // Context
  protocol: ProviderProtocol;
  isProjectMode: boolean;
  hasToolContext: boolean;
  userMessage: string;

  // Provider response sequence (ordered)
  turns: ProviderTurn[];

  // Expected outcome
  expectedOutcome: "completed" | "failed" | "cancelled";
  expectedFailureCode?: string;
  /** Expected number of persisted chat messages (user + assistant/error) */
  expectedMessageCount?: number;
  /** Must not appear in persisted message content */
  forbiddenContentPatterns?: string[];
  /** Optional invariant assertions at end of replay */
  expectedInvariantViolations?: string[]; // invariantIds expected to trigger
  /** Expected number of tool steps (TOOL_STARTED events) consumed during replay */
  expectedToolSteps?: number;
  /** Expected number of protocol recovery turns triggered */
  expectedRecoveryCount?: number;
}

// ── Built-in regression fixtures ──────────────────────────────────────────────

/**
 * Fixture A: Simple conversational request in project mode (§84 — "adın ne" bug).
 * Model answers directly with forge_final on first turn — no tools needed.
 * Expected: ONE final assistant message, zero protocol recovery.
 */
export const FIXTURE_SIMPLE_FINAL: ReplayFixture = {
  id: "regression_simple_final",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Simple conversational final without tools",
  description:
    'Project mode: user asks "adın ne" (what is your name). ' +
    "Model must answer with forge_final on first turn — zero tool calls required.",
  historicalBugClass: "e5a8c31f7d92",
  invariantIds: ["SIMPLE_FINAL_WITHOUT_TOOLS", "1_USER_1_ASSISTANT"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "adın ne",
  turns: [
    {
      text: '```forge_final\n{"content": "Ben Forge — Uzmoon tarafından geliştirilen bir yapay zeka asistanıyım."}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
  forbiddenContentPatterns: ["forge_final", "forge_tool", "PROTOCOL_RECOVERY"],
};

/**
 * Fixture B: Naked prose in project mode → bounded recovery → eventual final.
 * Model sends naked prose twice, then complies with forge_final.
 */
export const FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL: ReplayFixture = {
  id: "regression_protocol_recovery_then_final",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Protocol recovery then valid final",
  description: "Provider sends naked prose twice, then forge_final on third turn.",
  invariantIds: ["RECOVERY_BOUNDED", "1_USER_1_ASSISTANT"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: true,
  userMessage: "List files in the project",
  turns: [
    { text: "I will list the files now." }, // naked prose → recovery 1
    { text: "Here are the files you requested." }, // naked prose → recovery 2
    {
      text: '```forge_final\n{"content": "I found the project structure."}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
};

/**
 * Fixture C: Protocol recovery exhausted — provider never complies.
 * Expected: PROTOCOL_RECOVERY_EXHAUSTED, ONE error message.
 */
export const FIXTURE_RECOVERY_EXHAUSTED: ReplayFixture = {
  id: "regression_recovery_exhausted",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Protocol recovery exhausted",
  description:
    "Provider sends naked prose on every turn — recovery budget exhausted after MAX_PROTOCOL_RECOVERY_TURNS.",
  historicalBugClass: "e5a8c31f7d92",
  invariantIds: ["RECOVERY_BOUNDED", "ONE_RUN_ONE_VISIBLE_FAILURE"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "explain the architecture",
  turns: [
    { text: "Let me explain..." },
    { text: "So the architecture is..." },
    { text: "Additionally..." },
    { text: "In summary..." }, // turn 4 → exhausted after 3 recovery turns
  ],
  expectedOutcome: "failed",
  expectedFailureCode: "PROTOCOL_RECOVERY_EXHAUSTED",
  expectedMessageCount: 2, // user message + one error message
  forbiddenContentPatterns: ["forge_tool", "forge_final"],
};

/**
 * Fixture D: Provider disconnect mid-stream.
 * Expected: PROVIDER_ERROR, single error message.
 */
export const FIXTURE_PROVIDER_DISCONNECT: ReplayFixture = {
  id: "regression_provider_disconnect",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Provider disconnects mid-stream",
  description: "Provider returns a disconnect error on first turn.",
  invariantIds: ["PROVIDER_DISCONNECT_HANDLED", "ONE_RUN_ONE_VISIBLE_FAILURE"],
  protocol: "forge_fallback",
  isProjectMode: false,
  hasToolContext: false,
  userMessage: "Hello",
  turns: [{ text: "", disconnect: true }],
  expectedOutcome: "failed",
  expectedFailureCode: "PROVIDER_ERROR",
  expectedMessageCount: 2,
};

/**
 * Fixture E: Multi-block forge_edit_proposal (§83 — truncated/invalid proposal).
 * Expected: no proposal persisted as ready, no filesystem write.
 */
export const FIXTURE_MULTI_BLOCK_PROPOSAL: ReplayFixture = {
  id: "regression_multi_block_proposal",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Multi-block edit proposal rejected",
  description:
    "Provider returns forge_final with two forge_edit_proposal blocks. " +
    "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES: no ready FileEdit must exist.",
  invariantIds: ["INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "Refactor the files",
  turns: [
    {
      text: [
        "```forge_final",
        '{"content": "Here are the changes."}',
        "```",
        "```forge_edit_proposal",
        JSON.stringify({
          summary: "Change A",
          files: [{ path: "src/a.ts", content: "content a" }],
        }),
        "```",
        "```forge_edit_proposal",
        JSON.stringify({
          summary: "Change B",
          files: [{ path: "src/b.ts", content: "content b" }],
        }),
        "```",
      ].join("\n"),
    },
  ],
  expectedOutcome: "completed",
  // Message persisted as plain text (proposal stripped), no ready proposal
  expectedMessageCount: 2,
  forbiddenContentPatterns: ["forge_edit_proposal"],
};

/**
 * Fixture F: Tool budget exhausted — model keeps calling tools.
 * Expected: budget finalization triggered, BUDGET_FINALIZATION_FAILED if finalization also fails.
 */
export const FIXTURE_TOOL_BUDGET_EXHAUSTED: ReplayFixture = {
  id: "regression_tool_budget_exhausted",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Tool budget exhausted then finalized",
  description:
    "Model calls tools 25 times (budget). On finalization turn, provider returns forge_final.",
  invariantIds: ["TOOL_BUDGET_ENFORCED"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: true,
  userMessage: "Search for all usages of X",
  // 25 tool-call turns + 1 finalization turn
  turns: [
    ...Array.from({ length: 25 }, (_, i) => ({
      text:
        "```forge_tool\n" +
        JSON.stringify({ name: "search_files", arguments: { query: `query_${i}` } }) +
        "\n```",
    })),
    {
      text: '```forge_final\n{"content": "Search complete after budget exhaustion."}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
};

/**
 * Fixture G: Global chat — naked prose accepted as final.
 * Expected: ONE assistant message with the prose content.
 */
export const FIXTURE_GLOBAL_CHAT_PROSE: ReplayFixture = {
  id: "regression_global_chat_prose",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Global chat accepts naked prose",
  description:
    "In global chat (isProjectMode=false), naked prose from model is accepted as final. " +
    "No protocol recovery, no forge_final required.",
  invariantIds: ["1_USER_1_ASSISTANT"],
  protocol: "forge_fallback",
  isProjectMode: false,
  hasToolContext: false,
  userMessage: "What is TypeScript?",
  turns: [
    { text: "TypeScript is a statically typed superset of JavaScript." },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
  forbiddenContentPatterns: ["forge_tool", "forge_final"],
};

/**
 * Fixture H: Invalid JSON in forge_final envelope.
 * Expected: recovery (MALFORMED_FINAL_ENVELOPE), bounded, then succeed.
 */
export const FIXTURE_MALFORMED_FINAL_ENVELOPE: ReplayFixture = {
  id: "regression_malformed_final_envelope",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Malformed forge_final JSON",
  description:
    "Provider returns forge_final with invalid JSON. " +
    "Recovery triggered. Second turn returns valid forge_final.",
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "Say hello",
  turns: [
    { text: "```forge_final\n{broken json\n```" }, // malformed → invalid → recovery
    {
      text: '```forge_final\n{"content": "Hello! How can I help you today?"}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
};

/**
 * Fixture I: Multiple forge_final envelopes (non-recoverable).
 * Expected: MULTIPLE_FINAL_ENVELOPES, not recoverable → fail.
 */
export const FIXTURE_MULTIPLE_FINAL_ENVELOPES: ReplayFixture = {
  id: "regression_multiple_final_envelopes",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Multiple forge_final envelopes (non-recoverable)",
  description:
    "Provider returns two forge_final envelopes in one turn. " +
    "This is non-recoverable per spec. Must fail with one error message.",
  invariantIds: ["ONE_RUN_ONE_VISIBLE_FAILURE"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "Hello",
  turns: [
    {
      text: [
        "```forge_final",
        '{"content": "First final."}',
        "```",
        "```forge_final",
        '{"content": "Second final."}',
        "```",
      ].join("\n"),
    },
  ],
  expectedOutcome: "failed",
  expectedMessageCount: 2,
};

/**
 * Fixture J: Empty forge_final content.
 * Expected: EMPTY_FINAL_CONTENT → recovery → valid final.
 */
export const FIXTURE_EMPTY_FINAL_CONTENT: ReplayFixture = {
  id: "regression_empty_final_content",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Empty forge_final content",
  description: "Provider returns forge_final with empty content string. Recovery triggered.",
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "Describe the project",
  turns: [
    { text: '```forge_final\n{"content": ""}\n```' }, // empty → recovery
    {
      text: '```forge_final\n{"content": "This is a TypeScript Electron project."}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
};

/**
 * Fixture K: Provider ignores correction then recovers (one ignore, then forge_final).
 */
export const FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS: ReplayFixture = {
  id: "regression_provider_ignores_then_recovers",
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "Provider ignores correction once then recovers",
  description:
    "Provider sends naked prose on turn 1 (correction injected), " +
    "then returns valid forge_final on turn 2.",
  invariantIds: ["RECOVERY_BOUNDED"],
  protocol: "forge_fallback",
  isProjectMode: true,
  hasToolContext: false,
  userMessage: "Explain the queue system",
  turns: [
    { text: "The queue system handles messages..." }, // naked prose → correction injected
    {
      text: '```forge_final\n{"content": "The QueueManager serializes requests per conversation."}\n```',
    },
  ],
  expectedOutcome: "completed",
  expectedMessageCount: 2,
};

/** All built-in regression fixtures */
export const ALL_FIXTURES: ReplayFixture[] = [
  FIXTURE_SIMPLE_FINAL,
  FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL,
  FIXTURE_RECOVERY_EXHAUSTED,
  FIXTURE_PROVIDER_DISCONNECT,
  FIXTURE_MULTI_BLOCK_PROPOSAL,
  FIXTURE_TOOL_BUDGET_EXHAUSTED,
  FIXTURE_GLOBAL_CHAT_PROSE,
  FIXTURE_MALFORMED_FINAL_ENVELOPE,
  FIXTURE_MULTIPLE_FINAL_ENVELOPES,
  FIXTURE_EMPTY_FINAL_CONTENT,
  FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS,
];

// ── ReplayHarness ──────────────────────────────────────────────────────────────

export interface ReplayResult {
  fixtureId: string;
  outcome: "completed" | "failed" | "cancelled";
  failureCode?: string;
  messagesProduced: number;
  recoveryTriggered: number;
  toolStepsConsumed: number;
  invariantViolations: string[];
  passed: boolean;
  failureReason?: string;
}

/**
 * The ReplayHarness validates that normalizeDecision + the agent-loop state
 * machine produce correct outcomes for each fixture.
 *
 * It does NOT make real API calls — it feeds pre-recorded provider turns
 * through normalizeDecision and validates the decision sequence.
 *
 * Actual integration is done in the test files by mocking makeRequest.
 */
export class ReplayHarness {
  private fixtures: ReplayFixture[];

  constructor(fixtures: ReplayFixture[] = ALL_FIXTURES) {
    this.fixtures = fixtures;
  }

  getFixture(id: string): ReplayFixture | undefined {
    return this.fixtures.find((f) => f.id === id);
  }

  getAllFixtures(): ReplayFixture[] {
    return [...this.fixtures];
  }

  /**
   * Validate a fixture's expected outcome against an actual replay result.
   * Returns the validation result.
   */
  validateResult(
    fixture: ReplayFixture,
    actual: Omit<ReplayResult, "fixtureId" | "passed" | "failureReason">,
  ): ReplayResult {
    const failures: string[] = [];

    if (actual.outcome !== fixture.expectedOutcome) {
      failures.push(
        `Outcome mismatch: expected ${fixture.expectedOutcome}, got ${actual.outcome}`,
      );
    }

    if (
      fixture.expectedFailureCode &&
      actual.failureCode !== fixture.expectedFailureCode
    ) {
      failures.push(
        `FailureCode mismatch: expected ${fixture.expectedFailureCode}, got ${actual.failureCode ?? "none"}`,
      );
    }

    if (
      fixture.expectedMessageCount !== undefined &&
      actual.messagesProduced !== fixture.expectedMessageCount
    ) {
      failures.push(
        `Message count mismatch: expected ${fixture.expectedMessageCount}, got ${actual.messagesProduced}`,
      );
    }

    // Invariant violations — check both expected and unexpected
    {
      const expectedViolations = fixture.expectedInvariantViolations ?? [];
      // Violations that SHOULD have fired
      for (const inv of expectedViolations) {
        if (!actual.invariantViolations.includes(inv)) {
          failures.push(`Expected invariant violation ${inv} did not fire`);
        }
      }
      // Unexpected violations (violations not in the expected list) also fail
      const expectedSet = new Set(expectedViolations);
      for (const inv of actual.invariantViolations) {
        if (!expectedSet.has(inv)) {
          failures.push(`Unexpected invariant violation: ${inv}`);
        }
      }
    }

    return {
      fixtureId: fixture.id,
      ...actual,
      passed: failures.length === 0,
      ...(failures.length > 0 && { failureReason: failures.join("; ") }),
    };
  }
}