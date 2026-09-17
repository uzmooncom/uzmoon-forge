/**
 * command-limits.ts — Re-exports COMMAND_LIMITS from shared/types.ts.
 *
 * All command size/timing/concurrency bounds must come from this single source.
 * No magic numbers are allowed in any command subsystem file.
 */
export { COMMAND_LIMITS } from "../../shared/types.js";