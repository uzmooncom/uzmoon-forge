import { defineConfig } from "@playwright/test";
import path from "path";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1, // Electron tests must run serially
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],

  use: {
    // Electron-specific: no browserName needed — each spec launches its own
    // Electron instance via the helpers.
    screenshot: "on",
    video: "off",
  },

  projects: [
    {
      name: "electron",
      testMatch: /e2e\/.*\.spec\.ts$/,
    },
  ],

  // Build the app before running tests
  globalSetup: path.join(__dirname, "e2e/global-setup.ts"),
});