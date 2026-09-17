# Uzmoon Forge — Reliability Subsystem

> Version: V0.9 (addendum finalised Sept 2026)

This document describes the reliability hardening architecture introduced in V0.9.
It covers invariant monitoring, incident recording, trace collection, self-healing,
replay testing, edit IR safety, and the stability gate CLI.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Module Map](#2-module-map)
3. [Invariant Monitor](#3-invariant-monitor)
4. [Incident Recorder](#4-incident-recorder)
5. [Trace Recorder](#5-trace-recorder)
6. [Self-Healing Engine](#6-self-healing-engine)
7. [Replay Harness](#7-replay-harness)
8. [Edit IR Safety Gate](#8-edit-ir-safety-gate)
9. [Sanitizer](#9-sanitizer)
10. [Fingerprinting](#10-fingerprinting)
11. [Known Incidents Manifest](#11-known-incidents-manifest)
12. [Stability Gate CLI](#12-stability-gate-cli)
13. [Test Coverage](#13-test-coverage)
14. [IPC Channels](#14-ipc-channels)
15. [Data Layout](#15-data-layout)
16. [Operational Runbook](#16-operational-runbook)
17. [Human Approval Boundary](#17-human-approval-boundary)

---

## 1. Design Principles

**Core invariant:** MODEL DOES NOT CONTROL APPLICATION STATE.

The reliability subsystem enforces this and 25 other invariants at runtime.
Every violation is recorded, sanitized, fingerprinted, and stored locally.
No data is sent anywhere automatically — sharing requires explicit user opt-in.

**Five rules that cannot be broken:**

1. Forge never auto-applies code changes. All code edits require human approval.
2. Invariant assertions never throw in production paths — violations are recorded and
   execution continues with best-effort behavior.
3. Sanitizer runs before any incident payload is stored or shared.
4. Absolute paths and secrets must not appear in any persisted incident data.
5. The stability gate is the single authoritative pass/fail signal for CI.

---

## 2. Module Map

All reliability modules live in `src/main/reliability/`:

| File | Purpose |
|---|---|
| `invariants.ts` | 26 `InvariantDef` definitions, `assertInvariant()`, `assertInvariantStrict()` |
| `sanitizer.ts` | `redactSecrets()`, `redactAbsolutePaths()`, `sanitizeState()`, `buildGitHubIssuePayload()` |
| `fingerprint.ts` | `computeFingerprint()`, `buildDedupeKey()` — 12-hex SHA-256 truncated |
| `incident.ts` | `IncidentRecorder` — ring buffer (200 max, 7-day TTL), dedup, stability gate |
| `trace.ts` | `TraceRecorder` — per-request event streams (500 events/trace, 50 stored) |
| `known-incidents.ts` | Bundled manifest of 7 known/fixed incidents with regression test IDs |
| `self-healing.ts` | `SelfHealingEngine` — healing levels 1–4, `ImprovementCandidate` lifecycle |
| `replay.ts` | `ReplayHarness` — 11 regression fixtures (A–K), `validateResult()` |
| `index.ts` | `initReliabilityEngine()`, `tryGetIncidentRecorder()`, `tryGetTraceRecorder()` |
| `stateful-generator.ts` | Seeded PRNG-driven stateful scenario generator for fuzz tests |

---

## 3. Invariant Monitor

### Defined Invariants (26)

Invariants are grouped into 10 categories. The full list:

**protocol** — agent/model protocol correctness
- `ONE_RUN_ONE_VISIBLE_FAILURE`
- `TERMINAL_TURN_ONLY`
- `RECOVERY_BOUNDED`
- `STATE_TRANSITIONS_VALID`
- `TOOL_BUDGET_ENFORCED`
- `SIMPLE_FINAL_WITHOUT_TOOLS`
- `NAKED_PROSE_PROJECT_MODE_BLOCKED`

**concurrency** — stream isolation
- `NO_CROSS_RUN_CONTAMINATION`
- `STREAM_ID_FILTER_ENFORCED`

**navigation** — hydration safety
- `NAVIGATION_STATE_RESTORED`
- `NO_STALE_HYDRATION_OVERWRITE`

**persistence** — message and queue integrity
- `1_USER_1_ASSISTANT`
- `NO_PROTOCOL_LEAK`
- `STREAM_EVENT_ROUTING`

**resources** — snapshot lifecycle
- `SNAPSHOT_IMMUTABLE`
- `ORPHANED_SNAPSHOTS_CLEANED`
- `RESOURCE_OWNERSHIP_CLEAN`

**editing** — safe file editing
- `INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES`
- `STALE_BASE_PROTECTION`
- `APPLY_REQUIRES_APPROVAL`
- `EDIT_AMBIGUITY_BLOCKED`
- `ROLLBACK_CORRECTNESS`

**provider** — external connection
- `PROVIDER_DISCONNECT_HANDLED`

**privacy** — data hygiene
- `NO_SECRET_IN_INCIDENT`
- `NO_ABSOLUTE_PATH_IN_REPORT`
- `NO_PROMPT_IN_REPORT`

**safety** — self-modification guard
- `NO_AUTO_CRITICAL_SELF_MODIFICATION`

### Healing Levels

Each invariant definition includes a `maxHealingLevel` (1–4):

| Level | Behavior |
|---|---|
| 1 | Log-only — record incident, no other action |
| 2 | Log + user notification via IPC event |
| 3 | Log + bounded automatic retry (existing budgets: recovery turns, continuation) |
| 4 | Log + predefined low-risk recovery (orphan GC, queue unpause) |

### Usage

```typescript
import { assertInvariant, assertInvariantStrict } from "./reliability/index.js";

// Production path — never throws
assertInvariant("1_USER_1_ASSISTANT", {
  observedState: { roleSequence: ["user", "user"] },
  requestId: "req-abc",
});

// Test-only path — throws on violation
assertInvariantStrict("1_USER_1_ASSISTANT", { observedState: { roles: [...] } });
```

---

## 4. Incident Recorder

### Storage

- Location: `dataDir/incidents/incidents.json`
- Ring buffer: 200 incidents maximum
- Retention: 7 days (`MAX_INCIDENT_AGE_MS`)
- Schema version: 1

### Deduplication

Incidents are deduplicated by fingerprint (12-hex SHA-256 of
`invariantId|failureCode|category|structuralKey`). Repeated violations
increment `occurrenceCount` rather than creating new entries.

### ForgeIncident Shape

```typescript
interface ForgeIncident {
  id: string;                    // UUID
  fingerprint: string;           // 12-hex dedup key
  invariantId: string;
  title: string;
  description: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  firstSeen: number;             // epoch ms
  lastSeen: number;              // epoch ms
  occurrenceCount: number;
  forgeVersion: string;
  runtimeSchemaVersion: number;
  observedState: Record<string, unknown>;  // sanitized
  failureCode?: ForgeFailureCode;
  traceId?: string;
  structuralKey?: string;
}
```

### Stability Gate

`recorder.checkStabilityGate()` returns a `string[]` of blocking violation descriptions.
An empty array means the gate passes. This is the source of truth for `scripts/stability-gate.ts`.

Blocking criteria (as of V0.9):
- Any `critical` severity incident in the past 7 days
- Any `high` severity incident that has occurred 3 or more times
- Any `NO_SECRET_IN_INCIDENT` or `NO_ABSOLUTE_PATH_IN_REPORT` violation

---

## 5. Trace Recorder

### Storage

- Location: `dataDir/traces/` (one JSON file per completed trace)
- Per-trace limit: 500 events (`MAX_EVENTS_PER_TRACE`) — excess marked `truncated: true`
- Stored traces: 50 most recent (`MAX_STORED_TRACES`)
- Schema version: 1

### Event Kinds

All event kinds are UPPERCASE. The full union:

```
RUN_CREATED, RUN_STATE_CHANGED, PROVIDER_REQUEST_STARTED,
PROVIDER_RESPONSE_NORMALIZED, TOOL_REQUESTED, TOOL_STARTED,
TOOL_COMPLETED, TOOL_FAILED, FILE_READ, SNAPSHOT_CAPTURED,
LEDGER_UPDATED, PROTOCOL_RECOVERY, FINAL_NORMALIZED,
PROPOSAL_CREATED, QUEUE_STATE_CHANGED, NAVIGATION_REHYDRATED,
RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED, INVARIANT_VIOLATION
```

### Usage

```typescript
import { tryGetTraceRecorder } from "./reliability/index.js";

const tracer = tryGetTraceRecorder();
if (tracer) {
  const traceId = tracer.startTrace({ requestId, conversationId, projectId });
  tracer.emit(requestId, "TOOL_STARTED", { toolName: "read_file" });
  tracer.endTrace(requestId, "completed");

  // After endTrace, trace is in completedTraces — still retrievable:
  const trace = tracer.getTraceByRequestId(requestId); // not undefined
}
```

---

## 6. Self-Healing Engine

The `SelfHealingEngine` handles incidents by selecting and executing the
appropriate healing action. It also manages `ImprovementCandidate` objects
for human review.

### Human Approval Boundary (§78)

**Forge MAY automatically:**
- Detect violations (InvariantMonitor)
- Record incidents (IncidentRecorder)
- Classify and fingerprint
- Replay regression fixtures
- Run torture/regression tests
- Suggest improvements (ImprovementCandidate)
- Execute predefined level-4 low-risk actions (orphan cleanup, queue unpause)

**Forge MAY NOT autonomously:**
- Rewrite its own runtime source code
- Rewrite security checks or invariants
- Merge arbitrary patches
- Download and execute external fixes
- Disable safety invariants
- Modify user project files outside the Safe File Editing approval flow

### ImprovementCandidate Lifecycle

```
createImprovementCandidate() → approvalState: "pending"
         ↓                              ↓
  approveCandidate()             rejectCandidate()
  approvalState: "approved"      approvalState: "rejected"
         ↓
  [Human takes action manually]   (no auto-apply ever)
```

`approveCandidate()` on a rejected candidate returns `false` — re-approval is not allowed.

---

## 7. Replay Harness

11 regression fixtures (A–K) cover the critical protocol scenarios:

| ID | Name | Expected Outcome |
|---|---|---|
| A | `regression_simple_final` | completed |
| B | `regression_protocol_recovery_then_final` | completed |
| C | `regression_recovery_exhausted` | failed |
| D | `regression_provider_disconnect` | failed |
| E | `regression_multi_block_proposal` | completed |
| F | `regression_tool_budget_exhausted` | completed |
| G | `regression_global_chat_prose` | completed |
| H | `regression_malformed_final_envelope` | failed |
| I | `regression_multiple_final_envelopes` | failed |
| J | `regression_empty_final_content` | failed |
| K | `regression_provider_ignores_then_recovers` | completed |

Fixtures use `ReplayHarness.run(fixture)` → `ReplayResult`. Results are
validated with `harness.validateResult(result, fixture)`.

`REPLAY_SCHEMA_VERSION = 1` — increment when the fixture format changes.

---

## 8. Edit IR Safety Gate

`src/main/project-files/edit-ir.ts` implements `forge_structured_edit_proposal` fences.
Two operation types:

- `full_content` — replaces the entire file
- `exact_text_replace` — replaces an exact occurrence; guards with `expectedOccurrences`

**Ambiguity guard:** If `actualOccurrences !== expectedOccurrences`, the operation
returns `{ ambiguous: true }` — the edit is BLOCKED entirely. No partial writes.
This enforces the `EDIT_AMBIGUITY_BLOCKED` invariant structurally.

```typescript
// applyExactTextReplace never throws — returns ambiguous on mismatch
const result = applyExactTextReplace(op, baseContent);
if (result.ambiguous) {
  // EDIT_AMBIGUITY_BLOCKED — do not write
}
```

---

## 9. Sanitizer

`src/main/reliability/sanitizer.ts`

All incidents are sanitized before persistence. The sanitizer pipeline:

1. `redactSecrets(str)` — replaces `sk-{20+}` alphanumeric patterns with `"<secret-redacted>"`
2. `redactAbsolutePaths(str)` — replaces `/absolute/paths` with `"<path-redacted>"`
3. `sanitizeString(str)` — applies both above
4. `sanitizeValue(v)` — recursively sanitizes nested objects/arrays
5. `sanitizeState(obj)` — per-top-level-key sanitization via `sanitizeValue`

**Critical behavior:** `sanitizeState` calls `sanitizeValue(v)` per top-level value.
Top-level state keys are NOT matched against `SENSITIVE_KEYS` — only nested object
keys inside values are redacted (e.g., `{ apiKey: "..." }` inside a value).

**Testing:**
```typescript
import { detectResidualSecrets, hasNoAbsolutePaths } from "./sanitizer.js";

const residual = detectResidualSecrets(JSON.stringify(sanitized));
expect(residual).toHaveLength(0);
expect(hasNoAbsolutePaths(JSON.stringify(sanitized))).toBe(true);
```

---

## 10. Fingerprinting

`src/main/reliability/fingerprint.ts`

Deduplication key: 12-hex SHA-256 truncated of:

```
invariantId|failureCode|category|structuralKey
```

All lowercase. Output is always exactly 12 hexadecimal characters.

`fingerprintsMatch(a, b)` — strict `===` equality; case-sensitive.

```typescript
const fp = computeFingerprint({
  invariantId: "NO_PROTOCOL_LEAK",
  failureCode: "PROTOCOL_RECOVERY_EXHAUSTED",
  category: "protocol",
  structuralKey: "project-mode-naked-prose",
});
// → "3f7a2c..." (12 hex chars)
```

---

## 11. Known Incidents Manifest

`src/main/reliability/known-incidents.ts`

Bundled manifest of 7 known/fixed incidents. Used by `lookupKnownIncident(fingerprint)`
to annotate incidents with known fix information.

Schema: `KNOWN_INCIDENTS_SCHEMA_VERSION = 1`

Each entry has: `fingerprint`, `invariantId`, `title`, `description`, `status`,
and optionally `fixedInVersion`, `mitigation`, `regressionTestId`.

| Invariant | Fixed In | Regression Test |
|---|---|---|
| `NO_STALE_HYDRATION_OVERWRITE` | V0.8 | `nav-res-10` |
| `RESOURCE_OWNERSHIP_CLEAN` | V0.7 | `ci-5` |
| `NO_CROSS_RUN_CONTAMINATION` | V0.7 | `ci-1` |
| `NO_PROTOCOL_LEAK` | V0.6 | `int-prot-1` |
| `SIMPLE_FINAL_WITHOUT_TOOLS` (V0.9) | V0.9 | `rt-6` |
| `TERMINAL_TURN_ONLY` | V0.5 | `ar-15` |
| `SIMPLE_FINAL_WITHOUT_TOOLS` (V0.3) | V0.3 | `es-audit-3` |

---

## 12. Stability Gate CLI

`scripts/stability-gate.ts` — evaluates the incident store and exits non-zero on failure.

### Usage

```bash
# Standard check
DATA_DIR=$HOME/.uzmoon-forge-v01 pnpm tsx scripts/stability-gate.ts

# Machine-readable JSON output
DATA_DIR=... pnpm tsx scripts/stability-gate.ts --json

# Verbose (print all incidents)
DATA_DIR=... pnpm tsx scripts/stability-gate.ts --verbose

# Clear incident store on pass
DATA_DIR=... pnpm tsx scripts/stability-gate.ts --reset-on-pass

# CI analysis mode (never exit non-zero)
DATA_DIR=... pnpm tsx scripts/stability-gate.ts --dry-run
```

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Gate passed — zero blocking violations |
| 1 | Gate failed — one or more blocking violations |
| 2 | Error — data directory not found, store unreadable |

### JSON Output Shape

```json
{
  "passed": false,
  "blockingViolations": ["critical: NO_PROTOCOL_LEAK (3×)"],
  "totalIncidents": 12,
  "evaluatedAt": "2026-09-17T12:00:00.000Z",
  "forgeVersion": "0.9.0",
  "dataDir": "/Users/user/.uzmoon-forge-v01"
}
```

---

## 13. Test Coverage

As of V0.9 addendum, the reliability test suite covers:

| File | Tests | What it covers |
|---|---|---|
| `invariants.test.ts` | 27 | Registry, assertInvariant, assertInvariantStrict, pending buffer |
| `sanitizer.test.ts` | 30 | redactSecrets, redactAbsolutePaths, sanitizeState, detectResidual* |
| `fingerprint.test.ts` | 17 | computeFingerprint, buildDedupeKey, fingerprintsMatch, collisions |
| `incident.test.ts` | 20 | Ring buffer, dedup, TTL, stability gate, clear |
| `trace.test.ts` | 22 | startTrace, emit, endTrace, MAX_STORED_TRACES cap |
| `known-incidents.test.ts` | 14 | Manifest integrity, lookupKnownIncident, schema version |
| `replay.test.ts` | 31 | All 11 fixtures, validateResult, schema version |
| `edit-ir.test.ts` | 32 | parseStructuredEditProposal, applyExactTextReplace, ambiguity |
| `torture.test.ts` | 33 | Random scenarios (8 seeds), fault injection (6 cases) |
| `reliability-fast.test.ts` | ~40 | Fast invariant/sanitizer/fingerprint/incident subset |
| `reliability-deep.test.ts` | ~35 | 200 protocol fuzz inputs, 20 seeds × 25 steps |
| `improvement-candidate.test.ts` | ~40 | SelfHealingEngine, ImprovementCandidate lifecycle |
| `long-run-stress.test.ts` | 7 | 100 sequential runs, 50 interleaved, TraceRecorder cap |
| `trace-replay-bridge.test.ts` | 10 | Trace→Fixture roundtrip, ALL_FIXTURES roundtrip |

Queue-level reliability tests:

| File | Tests | What it covers |
|---|---|---|
| `concurrency-torture.test.ts` | ~18 | Concurrent run isolation, stream ID filtering |
| `navigation-torture.test.ts` | ~21 | Nav-away hydration under load |
| `queue-torture.test.ts` | ~24 | pause/resume/skip/cancel under load |
| `listener-leak.test.ts` | ~24 | IPC listener cleanup, destroyed sender |
| `resource-lifecycle.test.ts` | ~24 | Snapshot immutability, orphan sweep |
| `wiring.test.ts` | 15 | Production wiring (trace events, invariant hooks) |

---

## 14. IPC Channels

### Reliability IPC (`RELIABILITY_IPC`)

| Channel | Direction | Description |
|---|---|---|
| `reliability:incidentsList` | renderer→main | `listIncidents()` |
| `reliability:incidentGet` | renderer→main | `getIncident(id)` |
| `reliability:incidentSharePayload` | renderer→main | `getSharePayload(id)` — returns null if sharing disabled |
| `reliability:incidentsClear` | renderer→main | `clearIncidents()` |
| `reliability:metricsGet` | renderer→main | `getMetrics()` |
| `reliability:incidentRecorded` | main→renderer | Push event on new incident |

### Settings IPC (`SETTINGS_IPC`)

| Channel | Direction | Description |
|---|---|---|
| `settings:get` | renderer→main | `getSettings()` → `AppSettings` |
| `settings:set` | renderer→main | `setSettings(patch)` → `AppSettings` |

### Renderer Access

```typescript
// Incidents
const incidents = await window.forgeApi.reliability.listIncidents();
const payload = await window.forgeApi.reliability.getSharePayload(id); // null if sharing off

// Settings
const settings = await window.forgeApi.settings.getSettings();
await window.forgeApi.settings.setSettings({ incidentSharingEnabled: true });

// Live feed
const unsub = window.forgeApi.reliability.onIncidentRecorded((inc) => { ... });
```

---

## 15. Data Layout

```
$HOME/.uzmoon-forge-v01/
├── forge.json                   ← Main DB (conversations, projects, settings)
├── incidents/
│   └── incidents.json           ← IncidentRecorder ring buffer (200 max, 7d TTL)
├── traces/
│   └── <traceId>.json           ← Per-request trace files (50 max)
├── snapshots/
│   └── <uuid>.txt               ← Immutable file snapshots (context refs)
├── proposals/
│   └── <proposalId>/<editId>.txt ← Edit proposal target snapshots
├── backups/
│   └── <appliedEditId>.txt      ← Pre-apply file backups
└── index-cache/
    └── <projectId>.json         ← File index cache (invalidated by fs.watch)
```

**AppSettings** is stored inside `forge.json` under the `appSettings` key.
Default value: `{ incidentSharingEnabled: false }`.

---

## 16. Operational Runbook

### Clearing stuck incidents

```bash
# List current incidents
DATA_DIR=$HOME/.uzmoon-forge-v01 pnpm tsx scripts/stability-gate.ts --json --verbose

# Clear all incidents (requires manual file deletion or CLI)
DATA_DIR=$HOME/.uzmoon-forge-v01 pnpm tsx scripts/stability-gate.ts --reset-on-pass
# (only clears if gate passes — if gate fails, incidents remain)
```

To force-clear when gate is failing:
```bash
rm $HOME/.uzmoon-forge-v01/incidents/incidents.json
```

### Investigating a specific incident

1. Open the app → Settings → (Reliability panel, if wired)
2. Or use the stability gate JSON output to get the incident fingerprint
3. Check `known-incidents.ts` — if the fingerprint matches a known entry, the fix
   version is documented there

### Running regression replay

```bash
cd uzfor
pnpm vitest run src/main/reliability/replay.test.ts
```

All 11 fixtures must pass. If any fail, a known-good protocol path has regressed.

### Benchmarking reliability overhead

```bash
pnpm vitest bench benchmarks/reliability-perf.bench.ts
```

Key targets:
- `computeFingerprint()` < 5ms/call
- `sanitizeString(1KB)` < 1ms/call
- `IncidentRecorder.record()` < 5ms/call
- `TraceRecorder.emit()` < 1ms/event

---

## 17. Human Approval Boundary

This section restates §78 of the V0.9 spec for operational clarity.

**The boundary is structurally enforced, not policy-enforced.**

There is no `autoApply()` method on `SelfHealingEngine`. There is no code path
that reads an `ImprovementCandidate` and writes source files. `approveCandidate()`
returns a `boolean` — it has no side effects beyond setting `approvalState`.

When Forge creates a candidate, it describes a change in human-readable prose
(`proposedChange: string`). A human reads it, decides whether to implement it,
and makes the code change manually (or through the existing Safe File Editing
approval flow for user project files).

**Level 4 automatic actions** (the only automatic recovery Forge performs) are:
- `sweepOrphanedSnapshots()` — deletes snapshot files with no live references
- Queue unpause — resumes a paused queue after a connection recovery
- Bounded protocol recovery turns — injects `FORGE_PROTOCOL_CORRECTION` up to 3 times

None of these modify source code. All are reversible or idempotent.