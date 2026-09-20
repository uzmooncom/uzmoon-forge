import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const gitHash = (() => {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
})();
const buildTime = new Date().toISOString();

export default defineConfig({
  define: {
    __FORGE_BUILD_HASH__: JSON.stringify(gitHash),
    __FORGE_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [react(), tailwindcss()],
  base: "./",
  root: "src/renderer",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/renderer/index.html"),
        browser: path.resolve(__dirname, "src/renderer/browser-app/browser-app.html"),
      },
    },
  },
  server: {
    port: 5173,
  },
});