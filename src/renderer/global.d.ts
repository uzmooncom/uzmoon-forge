import type { ForgeApi } from "../preload/index.js";

declare global {
  interface Window {
    forgeApi: ForgeApi;
  }
}