/**
 * Playwright Global Setup — build the Electron app before running e2e tests.
 */
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

export default async function globalSetup() {
  const root = path.join(__dirname, "..");
  const mainEntry = path.join(root, "dist/main/main/main.js");

  // Only rebuild if the build is stale (or missing)
  const srcMtime = getLatestMtime(path.join(root, "src"));
  const buildExists = fs.existsSync(mainEntry);
  const buildMtime = buildExists ? fs.statSync(mainEntry).mtimeMs : 0;

  if (!buildExists || srcMtime > buildMtime) {
    console.log("[e2e] Building Electron app…");
    execSync("pnpm build", { cwd: root, stdio: "inherit" });
    console.log("[e2e] Build complete.");
  } else {
    console.log("[e2e] Using cached build.");
  }
}

function getLatestMtime(dir: string): number {
  let latest = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        latest = Math.max(latest, getLatestMtime(full));
      } else {
        latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    }
  } catch { /* ignore permission errors */ }
  return latest;
}