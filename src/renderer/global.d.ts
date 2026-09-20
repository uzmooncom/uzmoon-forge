import type { ForgeApi } from "../preload/index.js";

declare global {
  interface Window {
    forgeApi: ForgeApi;
    /** Injected by preload — true unless FORGE_TASKS_ENABLED=0 */
    __forgeTasksEnabled: boolean;
  }
  /** Git commit hash injected at build time by Vite */
  const __FORGE_BUILD_HASH__: string;
  /** ISO build timestamp injected at build time by Vite */
  const __FORGE_BUILD_TIME__: string;
}