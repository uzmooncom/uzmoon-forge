/**
 * Permission Center V1 — public API.
 *
 * Import from this barrel, not from individual files.
 */
export {
  resolvePermission,
  grantSession,
  revokeSession,
  getSessionGrants,
  clearAllSessionGrants,
  setGlobalPolicy,
  clearGlobalPolicy,
  setProjectPolicy,
  clearProjectPolicy,
  setPreset,
  clearPreset,
  resetGlobalPolicies,
  resetProjectPolicies,
  getRecentChecks,
  _resetPermissionEngineForTest,
} from "./permission-engine.js";

export {
  getAllCapabilities,
  getCapability,
  isKnownCapability,
  getCapabilitiesByCategory,
} from "./capability-registry.js";

export {
  loadStore,
  saveStore,
  resetStore,
} from "./permission-store.js";