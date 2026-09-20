/**
 * permission-store.ts — Persistence for CapabilityPolicyStore.
 *
 * Uses the existing AppSettings infrastructure in db.ts.
 * CapabilityPolicyStore is stored as appSettings.capabilityPolicies.
 *
 * Session grants are NEVER stored here — they are in-memory only.
 */
import type { CapabilityPolicyStore } from "../../shared/types.js";
import { DEFAULT_CAPABILITY_POLICY_STORE } from "../../shared/types.js";
import * as db from "../database/db.js";

/**
 * Load the current CapabilityPolicyStore from persistent storage.
 * Returns a mutable clone — caller owns the returned object.
 */
export function loadStore(): CapabilityPolicyStore {
  const settings = db.getAppSettings(true);
  const stored = (settings as unknown as Record<string, unknown>).capabilityPolicies as
    | CapabilityPolicyStore
    | undefined;

  if (!stored) {
    return structuredClone(DEFAULT_CAPABILITY_POLICY_STORE);
  }

  // Defensive migration: ensure required fields exist
  return {
    ...(stored.preset !== undefined && { preset: stored.preset }),
    globalPolicies: stored.globalPolicies ?? {},
    projectOverrides: stored.projectOverrides ?? {},
  };
}

/**
 * Save a CapabilityPolicyStore to persistent storage.
 */
export function saveStore(store: CapabilityPolicyStore): void {
  // Save via existing setAppSettings mechanism — capabilityPolicies is part of AppSettings
  db.setAppSettings(true, { capabilityPolicies: store });
}

/**
 * Reset to defaults (preserves all other app settings).
 */
export function resetStore(): void {
  saveStore(structuredClone(DEFAULT_CAPABILITY_POLICY_STORE));
}