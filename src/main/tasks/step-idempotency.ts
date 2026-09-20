/**
 * step-idempotency.ts — Idempotency guard for task step dispatch.
 *
 * Prevents double-dispatch of the same step within a single task run.
 * Uses a module-level registry keyed by (taskId, stepId, attemptCount).
 *
 * This is a lightweight, in-process guard — not a distributed lock.
 * It survives across function calls within one app lifecycle but is cleared on restart.
 */

/** Unique key for a step dispatch attempt */
type StepDispatchKey = string;

function makeKey(taskId: string, stepId: string, attemptCount: number): StepDispatchKey {
  return `${taskId}::${stepId}::${attemptCount}`;
}

/** Set of in-flight or completed dispatch keys in this process lifetime */
const _dispatchedSteps = new Set<StepDispatchKey>();

/**
 * Check whether this step/attempt combination has already been dispatched.
 * Returns true if it's a duplicate (already dispatched).
 */
export function isStepAlreadyDispatched(
  taskId: string,
  stepId: string,
  attemptCount: number
): boolean {
  return _dispatchedSteps.has(makeKey(taskId, stepId, attemptCount));
}

/**
 * Mark a step/attempt as dispatched.
 * Call this BEFORE starting the agent loop to prevent concurrent double-dispatch.
 */
export function markStepDispatched(
  taskId: string,
  stepId: string,
  attemptCount: number
): void {
  _dispatchedSteps.add(makeKey(taskId, stepId, attemptCount));
}

/**
 * Remove the dispatch record for a step (called after terminal result recorded).
 * Allows the same step to be re-dispatched on resume after an `interrupted` state.
 */
export function clearStepDispatch(
  taskId: string,
  stepId: string,
  attemptCount: number
): void {
  _dispatchedSteps.delete(makeKey(taskId, stepId, attemptCount));
}

/**
 * Clear all dispatch records for a task (on cancel or terminal task state).
 * Iterates the full set — only used on low-frequency terminal transitions.
 */
export function clearTaskDispatches(taskId: string): void {
  const prefix = `${taskId}::`;
  for (const key of _dispatchedSteps) {
    if (key.startsWith(prefix)) {
      _dispatchedSteps.delete(key);
    }
  }
}

/** For test teardown only */
export function _resetIdempotencyRegistryForTest(): void {
  _dispatchedSteps.clear();
}