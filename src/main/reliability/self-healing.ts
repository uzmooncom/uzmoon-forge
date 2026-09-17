/**
 * self-healing.ts — SelfHealingEngine.
 *
 * PERMANENT DESIGN PRINCIPLE (§78):
 *
 * Forge MAY automatically:
 *   - detect (InvariantMonitor)
 *   - record (IncidentRecorder)
 *   - classify (fingerprint)
 *   - replay (ReplayHarness)
 *   - test (torture/regression)
 *   - suggest (ImprovementCandidate)
 *   - perform predefined low-risk recovery (level 4 actions, listed explicitly)
 *
 * Forge MAY NOT autonomously:
 *   - rewrite its own runtime code
 *   - rewrite security checks
 *   - merge arbitrary patches
 *   - download and execute external fixes
 *   - disable safety invariants
 *   - modify user source files outside the existing Safe File Editing approval flow
 *
 * Self-healing levels:
 *   1 = log-only (record incident, no action)
 *   2 = log + user notification (push IPC event to renderer)
 *   3 = log + bounded automatic retry (existing patterns: CONTINUATION_BUDGET, recovery turns)
 *   4 = log + predefined low-risk recovery (orphan cleanup, paused queue unpause, etc.)
 *
 * ImprovementCandidate: a structured suggestion (never auto-applied).
 *   Requires HUMAN APPROVAL before any code change.
 */

import type { ForgeIncident } from "../../shared/types.js";
import { getInvariant } from "./invariants.js";

// ── Healing levels ────────────────────────────────────────────────────────────

export type HealingLevel = 1 | 2 | 3 | 4;

export interface HealingAction {
  level: HealingLevel;
  actionId: string;
  description: string;
  /** If true, this action may safely be executed automatically. */
  automatic: boolean;
  /** If automatic, this function performs the action. */
  execute?: () => Promise<void>;
}

// ── ImprovementCandidate ──────────────────────────────────────────────────────

export type ImprovementKind =
  | "system_prompt_clarification"
  | "protocol_constraint_tightening"
  | "retry_budget_adjustment"
  | "test_corpus_addition"
  | "known_incident_registration";

export interface ImprovementCandidate {
  id: string;
  kind: ImprovementKind;
  title: string;
  description: string;
  rationale: string;
  /** The specific code location or config that should change */
  targetLocation?: string;
  /** Human-readable proposed change — NOT code to auto-apply */
  proposedChange: string;
  /** The invariant(s) this improvement addresses */
  invariantIds: string[];
  incidentFingerprints: string[];
  createdAt: number;
  /** Human approval state — never auto-approved by Forge */
  approvalState: "pending" | "approved" | "rejected";
  /** GitHub issue payload if submitted */
  githubPayload?: Record<string, unknown>;
}

// ── SelfHealingEngine ─────────────────────────────────────────────────────────

export type NotifyUserFn = (opts: {
  incidentId: string;
  invariantId: string;
  severity: string;
  recoveryApplied?: string;
}) => void;

export class SelfHealingEngine {
  private notifyUser: NotifyUserFn | null = null;
  private candidates: ImprovementCandidate[] = [];
  private executedActions = new Set<string>(); // actionId — idempotency

  setNotifyUser(fn: NotifyUserFn): void {
    this.notifyUser = fn;
  }

  /**
   * Handle an incident: determine the appropriate healing level and act.
   * Returns the healing action taken (or null for level-1 log-only).
   */
  async handleIncident(incident: ForgeIncident): Promise<HealingAction | null> {
    const def = getInvariant(incident.invariantId);
    const maxLevel = def?.maxHealingLevel ?? 1;

    const action = this._selectAction(incident, maxLevel);
    if (!action) return null;

    if (action.automatic && action.execute) {
      try {
        await action.execute();
      } catch {
        // Never throw from healing
      }
    }

    if (maxLevel >= 2 && this.notifyUser) {
      this.notifyUser({
        incidentId: incident.id,
        invariantId: incident.invariantId,
        severity: incident.severity,
        ...(action.automatic && { recoveryApplied: action.description }),
      });
    }

    return action;
  }

  /**
   * Create an ImprovementCandidate for human review.
   * This is a SUGGESTION ONLY — never auto-applied.
   * §78: Human approval boundary is enforced here.
   */
  createImprovementCandidate(opts: Omit<ImprovementCandidate, "id" | "createdAt" | "approvalState">): ImprovementCandidate {
    const candidate: ImprovementCandidate = {
      ...opts,
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      approvalState: "pending",
    };
    this.candidates.push(candidate);
    return candidate;
  }

  /**
   * Mark a candidate as approved by a human.
   * This does NOT auto-apply anything — it's a record of human decision.
   */
  approveCandidate(candidateId: string): boolean {
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c || c.approvalState !== "pending") return false;
    c.approvalState = "approved";
    return true;
  }

  rejectCandidate(candidateId: string): boolean {
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c || c.approvalState !== "pending") return false;
    c.approvalState = "rejected";
    return true;
  }

  getPendingCandidates(): ImprovementCandidate[] {
    return this.candidates.filter((c) => c.approvalState === "pending");
  }

  getAllCandidates(): ImprovementCandidate[] {
    return [...this.candidates];
  }

  private _selectAction(incident: ForgeIncident, maxLevel: number): HealingAction | null {
    if (maxLevel < 1) return null;

    switch (incident.invariantId) {
      case "ORPHANED_SNAPSHOTS_CLEANED":
        if (maxLevel >= 4) {
          return {
            level: 4,
            actionId: "gc_orphaned_snapshots",
            description: "Trigger orphaned snapshot garbage collection",
            automatic: true,
          };
        }
        break;

      case "ONE_RUN_ONE_VISIBLE_FAILURE":
        if (maxLevel >= 2) {
          return {
            level: 2,
            actionId: `notify_${incident.id}`,
            description: "Notify user of duplicate error rendering",
            automatic: false,
          };
        }
        break;

      case "RECOVERY_BOUNDED":
      case "TOOL_BUDGET_ENFORCED":
        if (maxLevel >= 3) {
          return {
            level: 3,
            actionId: `bounded_retry_${incident.id}`,
            description: "Bounded automatic retry already applied by agent-loop",
            automatic: false, // agent-loop handles this inline
          };
        }
        break;

      case "SIMPLE_FINAL_WITHOUT_TOOLS":
        if (maxLevel >= 2) {
          return {
            level: 2,
            actionId: `notify_simple_final_${incident.id}`,
            description: "Notify user: simple request required unexpected recovery",
            automatic: false,
          };
        }
        break;
    }

    // Default: level 1, log only
    return {
      level: 1,
      actionId: `log_${incident.id}`,
      description: "Incident recorded (log-only)",
      automatic: false,
    };
  }
}