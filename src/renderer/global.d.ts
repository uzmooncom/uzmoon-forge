import type { ForgeApi } from "../preload/index.js";

declare global {
  interface Window {
    forgeApi: ForgeApi;
    /** Injected by preload — true when FORGE_TASKS_ENABLED=1|true */
    __forgeTasksEnabled: boolean;
  }
}