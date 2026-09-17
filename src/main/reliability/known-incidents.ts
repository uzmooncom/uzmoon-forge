/**
 * known-incidents.ts — Bundled Known Incident Registry.
 *
 * This file is DATA ONLY — no logic, no imports from production code.
 * It defines fingerprints for incident classes that have been:
 *   - Diagnosed
 *   - Fixed (with version reference)
 *   - Or have known safe mitigations
 *
 * Schema: KNOWN_INCIDENTS_SCHEMA_VERSION = 1
 *
 * Per §77: Old incompatible derived artifacts may be migrated minimally
 * or discarded where safe. Do not make user source dependent on this schema.
 *
 * Per §95: Architecture goal — future maintainer adds entries here after
 * confirming a fix, so users running the fixed version never hit the same class.
 *
 * Fingerprint values are derived from computeFingerprint() with:
 *   { invariantId, failureCode, category, structuralKey? }
 * Use `node -e "const {computeFingerprint} = require('./...'); ..."` to derive them.
 */

import type { KnownIncidentEntry } from "./fingerprint.js";

export const KNOWN_INCIDENTS_SCHEMA_VERSION = 1;

/**
 * All known incidents bundled with this version of Forge.
 * Ordered newest-first (most recent fixes at top).
 */
export const KNOWN_INCIDENTS: KnownIncidentEntry[] = [
  {
    // V0.8: Navigation resilience — stale hydration overwriting live STREAM_START
    // Fixed in V0.8 by adding lastHydratedRevisionRef bump to MAX_SAFE_INTEGER
    fingerprint: "d8a1c4e2f019",
    invariantId: "NO_STALE_HYDRATION_OVERWRITE",
    title: "Stale hydration overwrites live streaming state on navigation",
    description:
      "When navigating away and back quickly while a run is starting, " +
      "a pending getRuntimeState IPC response could overwrite the live STREAM_START state.",
    status: "fixed",
    fixedInVersion: "0.8",
    regressionTestId: "navigation-resilience.test.ts:Req 6",
  },
  {
    // V0.7: PROPOSAL_READ_TARGET used only contextRefs — autonomous agent reads not resolved
    // Fixed in V0.7 by canonical resource resolver (resolveImmutableFileResource)
    fingerprint: "a2f9e84bc301",
    invariantId: "RESOURCE_OWNERSHIP_CLEAN",
    title: "Edit proposal base resolution fails for autonomous agent reads",
    description:
      "PROPOSAL_READ_TARGET searched only manual contextRefs but not ledger.agentReadRefs. " +
      "Autonomous reads that formed the edit base were not resolvable.",
    status: "fixed",
    fixedInVersion: "0.7",
    regressionTestId: "concurrent-isolation.test.ts:test 5",
  },
  {
    // V0.7: Concurrent StreamingBubble cross-contamination
    // Fixed in V0.7 by streamId prop filter
    fingerprint: "c7e3a19d450b",
    invariantId: "NO_CROSS_RUN_CONTAMINATION",
    title: "Concurrent StreamingBubble receives tool events from other stream",
    description:
      "When two conversations were running concurrently, tool events from one run " +
      "appeared in the other conversation's StreamingBubble.",
    status: "fixed",
    fixedInVersion: "0.7",
    regressionTestId: "concurrent-isolation.test.ts:test 1",
  },
  {
    // V0.6: activityCaption dead code — onActivityText subscription never fired
    // Fixed in V0.6 acceptance audit by removing dead binding
    fingerprint: "b9f2d67e1a04",
    invariantId: "NO_PROTOCOL_LEAK",
    title: "Dead onActivityText preload binding never used by renderer",
    description:
      "window.forgeApi.agentTools.onActivityText was defined in preload but no renderer " +
      "component subscribed to it. Dead code removed in V0.6 acceptance audit.",
    status: "fixed",
    fixedInVersion: "0.6",
  },
  {
    // V0.6: Protocol recovery on simple conversational questions in project mode
    // Partially addressed in V0.6 system prompt; further clarified in V0.9
    fingerprint: "e5a8c31f7d92",
    invariantId: "SIMPLE_FINAL_WITHOUT_TOOLS",
    title: "Protocol recovery exhausted on simple conversational requests in project mode",
    description:
      "In project mode, a simple question like 'adın ne' (what is your name) may trigger " +
      "protocol recovery exhaustion if the system prompt does not make clear that forge_final " +
      "is valid without prior tool calls. System prompt clarified in V0.9.",
    status: "fixed",
    fixedInVersion: "0.9",
    mitigation:
      "forge_agent_protocol block now explicitly states forge_final is valid on first turn without tools.",
    regressionTestId: "agent-runtime.test.ts:simple_final_without_tools",
  },
  {
    // V0.5: Intermediate narration persisted as chat message
    // Fixed in V0.5 by per-turn buffer
    fingerprint: "f1b4e69c2a83",
    invariantId: "TERMINAL_TURN_ONLY",
    title: "Intermediate agent narration persisted as visible chat message",
    description:
      "agent-loop.ts forwarded every streamed chunk to onChunk, including intermediate " +
      "planning narration from non-terminal turns. Fixed in V0.5 by per-turn buffer.",
    status: "fixed",
    fixedInVersion: "0.5",
  },
  {
    // V0.3: forge_capability directive not injected for project convs without file context
    // Fixed in V0.3 capability bridge
    fingerprint: "8c2b5f7e9d14",
    invariantId: "SIMPLE_FINAL_WITHOUT_TOOLS",
    title: "Project conversation without file context never received capability directive",
    description:
      "forgeSystemPrompt was only injected when contextRefs.length > 0, so project " +
      "conversations without attached files never knew about the editing capability.",
    status: "fixed",
    fixedInVersion: "0.3",
  },
];

/**
 * Look up a known incident by fingerprint.
 * Returns undefined if not found (unrecognized incident class).
 */
export function lookupKnownIncident(fingerprint: string): KnownIncidentEntry | undefined {
  return KNOWN_INCIDENTS.find((e) => e.fingerprint === fingerprint);
}