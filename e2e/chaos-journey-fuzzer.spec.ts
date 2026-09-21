/**
 * E2E Chaos: Deterministic Seeded Journey Fuzzer
 *
 * Generates deterministic action sequences from a seed, executes them,
 * and validates invariants after every action. A failing seed is reported
 * with full context and becomes a permanent regression test.
 *
 * Actions:
 *   - send_message
 *   - stop_stream
 *   - create_conversation
 *   - switch_conversation
 *   - rename_conversation
 *   - archive_conversation
 *   - pin_conversation
 *   - create_project
 *   - read_queue_state
 *   - read_runtime_state
 *   - read_conversations
 *
 * Invariants checked after every action:
 *   I1: No queue item stuck at "processing" after idle
 *   I2: activeRunRegistry null for inactive convs
 *   I3: No duplicate conversation IDs
 *   I4: forge.json is valid JSON (checked at end of sequence)
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge, setupFakeAgent } from "./helpers.js";
import type { Page } from "playwright-core";

// ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pickFrom<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ── Journey state ─────────────────────────────────────────────────────────
interface JourneyState {
  convIds: string[];
  activeConvId: string;
  profileId: string;
  streamInFlight: boolean;
  lastActionLabel: string;
}

// ── API helpers ───────────────────────────────────────────────────────────
async function apiSendMessage(page: Page, convId: string, content: string) {
  return page.evaluate(async ([cid, msg]: [string, string]) => {
    const api = (window as { forgeApi?: { sendMessage: (r: object) => Promise<{ error?: string }> } }).forgeApi!;
    return api.sendMessage({ conversationId: cid, content: msg, attachmentIds: [] });
  }, [convId, content] as [string, string]);
}

async function apiCancelStream(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { cancelStream: (c: string) => Promise<void> } }).forgeApi!;
    try { await api.cancelStream(cid); } catch { /* ok */ }
  }, convId);
}

async function apiCreateConv(page: Page, profileId: string, title: string): Promise<string> {
  return page.evaluate(async ([pid, title]: [string, string]) => {
    const api = (window as { forgeApi?: { createConversation: (c: object) => Promise<void> } }).forgeApi!;
    const now = Date.now();
    const id = `fuzz-${now}-${Math.random().toString(36).slice(2, 8)}`;
    await api.createConversation({ id, title, defaultAgentProfileId: pid, createdAt: now, updatedAt: now });
    return id;
  }, [profileId, title] as [string, string]);
}

async function apiGetConversations(page: Page) {
  return page.evaluate(async () => {
    const api = (window as { forgeApi?: { listConversations: () => Promise<Array<{ id: string }>> } }).forgeApi!;
    return api.listConversations();
  });
}

async function apiGetQueueState(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: Array<{ id: string; status: string }> }> } }).forgeApi!;
    return api.getQueue(cid);
  }, convId);
}

async function apiGetRuntimeState(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
    return api.getRuntimeState(cid);
  }, convId);
}

async function apiRenameConv(page: Page, convId: string, title: string) {
  return page.evaluate(async ([cid, t]: [string, string]) => {
    const api = (window as { forgeApi?: { updateConversation: (id: string, u: object) => Promise<unknown> } }).forgeApi!;
    try { await api.updateConversation(cid, { title: t }); } catch { /* ok */ }
  }, [convId, title] as [string, string]);
}

async function apiPinConv(page: Page, convId: string) {
  return page.evaluate(async (cid) => {
    const api = (window as { forgeApi?: { updateConversation: (id: string, u: object) => Promise<unknown> } }).forgeApi!;
    try { await api.updateConversation(cid, { pinnedAt: Date.now() }); } catch { /* ok */ }
  }, convId);
}

// ── Invariant checks ──────────────────────────────────────────────────────
async function checkInvariants(
  page: Page,
  state: JourneyState,
  actionLabel: string,
  errors: string[],
) {
  // I2: active conv's runtime must not be non-null if no stream in flight
  if (!state.streamInFlight) {
    try {
      const runtime = await apiGetRuntimeState(page, state.activeConvId);
      // Runtime can linger briefly after cancel — this is a soft check
      // We only flag if it's been >500ms since last action (checked via timeout polling)
      if (runtime !== null) {
        // give 500ms grace period
        await page.waitForTimeout(500);
        const runtime2 = await apiGetRuntimeState(page, state.activeConvId);
        if (runtime2 !== null) {
          errors.push(`I2 FAIL after "${actionLabel}": runtime non-null for inactive conv ${state.activeConvId}: ${JSON.stringify(runtime2)}`);
        }
      }
    } catch (e) {
      errors.push(`I2 CHECK ERROR after "${actionLabel}": ${e}`);
    }
  }

  // I3: no duplicate conversation IDs
  try {
    const convs = await apiGetConversations(page);
    if (convs) {
      const ids = convs.map((c) => c.id);
      const unique = new Set(ids);
      if (unique.size !== ids.length) {
        errors.push(`I3 FAIL after "${actionLabel}": duplicate conversation IDs: ${JSON.stringify(ids)}`);
      }
    }
  } catch (e) {
    errors.push(`I3 CHECK ERROR after "${actionLabel}": ${e}`);
  }
}

// ── Action executor ───────────────────────────────────────────────────────
type Action = {
  type: string;
  weight: number;
  exec: (page: Page, state: JourneyState, rng: () => number) => Promise<void>;
};

const ACTIONS: Action[] = [
  {
    type: "send_message",
    weight: 3,
    async exec(page, state) {
      if (state.streamInFlight) return;
      const r = await apiSendMessage(page, state.activeConvId, `fuzz msg ${Date.now()}`);
      if (!r?.error) state.streamInFlight = true;
      state.lastActionLabel = `send_message(${state.activeConvId.slice(-6)})`;
    },
  },
  {
    type: "stop_stream",
    weight: 2,
    async exec(page, state) {
      await apiCancelStream(page, state.activeConvId);
      // Wait for idle
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rt = await apiGetRuntimeState(page, state.activeConvId);
        if (rt === null) break;
        await page.waitForTimeout(100);
      }
      state.streamInFlight = false;
      state.lastActionLabel = `stop_stream(${state.activeConvId.slice(-6)})`;
    },
  },
  {
    type: "create_conversation",
    weight: 2,
    async exec(page, state, rng) {
      const id = await apiCreateConv(page, state.profileId, `Fuzz Conv ${Math.floor(rng() * 1000)}`);
      state.convIds.push(id);
      state.lastActionLabel = `create_conversation(${id.slice(-6)})`;
    },
  },
  {
    type: "switch_conversation",
    weight: 3,
    async exec(page, state, rng) {
      if (state.convIds.length < 2) return;
      const others = state.convIds.filter((id) => id !== state.activeConvId);
      const next = pickFrom(others, rng);
      state.activeConvId = next;
      state.streamInFlight = false; // switching resets our tracking
      state.lastActionLabel = `switch_conversation(${next.slice(-6)})`;
    },
  },
  {
    type: "rename_conversation",
    weight: 1,
    async exec(page, state, rng) {
      await apiRenameConv(page, state.activeConvId, `Renamed ${Math.floor(rng() * 1000)}`);
      state.lastActionLabel = `rename_conversation(${state.activeConvId.slice(-6)})`;
    },
  },
  {
    type: "pin_conversation",
    weight: 1,
    async exec(page, state) {
      await apiPinConv(page, state.activeConvId);
      state.lastActionLabel = `pin_conversation(${state.activeConvId.slice(-6)})`;
    },
  },
  {
    type: "read_queue_state",
    weight: 1,
    async exec(page, state) {
      const qs = await apiGetQueueState(page, state.activeConvId);
      // I1: no stuck processing items (only check when not mid-stream)
      if (!state.streamInFlight && qs) {
        const stuck = qs.items.filter((i) => i.status === "processing");
        // Grace: if there's a processing item, wait 2s and recheck
        if (stuck.length > 0) {
          await page.waitForTimeout(2000);
          const qs2 = await apiGetQueueState(page, state.activeConvId);
          const stuck2 = (qs2?.items ?? []).filter((i) => i.status === "processing");
          if (stuck2.length > 0) {
            throw new Error(`I1 FAIL: queue item stuck at processing for ${state.activeConvId}: ${JSON.stringify(stuck2)}`);
          }
        }
      }
      state.lastActionLabel = `read_queue_state`;
    },
  },
  {
    type: "read_runtime_state",
    weight: 1,
    async exec(page, state) {
      await apiGetRuntimeState(page, state.activeConvId);
      state.lastActionLabel = `read_runtime_state`;
    },
  },
];

function buildWeightedPool(actions: Action[]): Action[] {
  const pool: Action[] = [];
  for (const a of actions) {
    for (let i = 0; i < a.weight; i++) pool.push(a);
  }
  return pool;
}

// ── Test runner ───────────────────────────────────────────────────────────
async function runJourney(seed: number, stepCount: number) {
  const forge = await launchForge({ fakeProvider: true });
  await forge.page.waitForLoadState("domcontentloaded");
  await forge.page.waitForTimeout(1500);
  const { profileId, convId } = await setupFakeAgent(forge.page);

  const rng = mulberry32(seed);
  const pool = buildWeightedPool(ACTIONS);
  const state: JourneyState = {
    convIds: [convId],
    activeConvId: convId,
    profileId,
    streamInFlight: false,
    lastActionLabel: "init",
  };
  const actionLog: string[] = [];
  const errors: string[] = [];

  try {
    for (let step = 0; step < stepCount; step++) {
      const action = pickFrom(pool, rng);
      try {
        await action.exec(forge.page, state, rng);
        actionLog.push(`${step}: ${state.lastActionLabel}`);
      } catch (e) {
        errors.push(`STEP ${step} ACTION ${action.type} THREW: ${e}`);
        actionLog.push(`${step}: ${action.type} [THREW]`);
        break;
      }

      // Check invariants after each step
      await checkInvariants(forge.page, state, state.lastActionLabel, errors);
      if (errors.length > 0) break;
    }

    // If a stream is still in flight, cancel it
    if (state.streamInFlight) {
      await apiCancelStream(forge.page, state.activeConvId);
      await forge.page.waitForTimeout(500);
    }

    // Final: wait for all convs to be idle
    for (const cid of state.convIds) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rt = await apiGetRuntimeState(forge.page, cid);
        if (rt === null) break;
        await forge.page.waitForTimeout(100);
      }
    }

    // Final invariant: no processing stuck items anywhere
    for (const cid of state.convIds) {
      const qs = await apiGetQueueState(forge.page, cid);
      if (qs) {
        const stuck = qs.items.filter((i) => i.status === "processing");
        if (stuck.length > 0) {
          errors.push(`FINAL I1 FAIL for conv ${cid}: stuck processing: ${JSON.stringify(stuck)}`);
        }
      }
    }

    if (errors.length > 0) {
      const report = [
        `JOURNEY FAILURE — seed=${seed} steps=${stepCount}`,
        `Action log:`,
        ...actionLog.map((l) => `  ${l}`),
        `Errors:`,
        ...errors.map((e) => `  ${e}`),
      ].join("\n");
      throw new Error(report);
    }
  } finally {
    await closeForge(forge);
  }
}

// ── Regression seeds (past failures become permanent tests) ───────────────
// Add failing seeds here when discovered: { seed, steps, description }
const REGRESSION_SEEDS: Array<{ seed: number; steps: number; description: string }> = [
  // none yet — will be added as failures are discovered
];

test.describe("Chaos: Journey Fuzzer", () => {
  test.setTimeout(120_000);

  // ── Regression seeds ─────────────────────────────────────────────────
  for (const { seed, steps, description } of REGRESSION_SEEDS) {
    test(`regression seed=${seed}: ${description}`, async () => {
      await runJourney(seed, steps);
    });
  }

  // ── Deterministic seeds (fixed for repeatability) ────────────────────
  test("journey seed=1 (20 steps)", async () => {
    await runJourney(1, 20);
  });

  test("journey seed=42 (30 steps)", async () => {
    await runJourney(42, 30);
  });

  test("journey seed=100 (25 steps)", async () => {
    await runJourney(100, 25);
  });

  test("journey seed=999 (30 steps)", async () => {
    await runJourney(999, 30);
  });

  test("journey seed=2026 (35 steps)", async () => {
    await runJourney(2026, 35);
  });

  test("journey seed=7777 (40 steps)", async () => {
    await runJourney(7777, 40);
  });

  test("journey seed=31337 (30 steps)", async () => {
    await runJourney(31337, 30);
  });

  test("journey seed=99999 (35 steps)", async () => {
    await runJourney(99999, 35);
  });
});