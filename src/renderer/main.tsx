import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import App from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

document.documentElement.classList.add("dark");

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

const TopLevelFallback = (
  <div className="flex h-full flex-col items-center justify-center bg-[#0d0d0f] text-white/60 gap-3 p-6">
    <div className="text-sm font-medium text-white/80">Something went wrong</div>
    <div className="text-xs text-center">
      An unexpected error occurred. Please reload the app.
    </div>
    <button
      className="mt-2 px-4 py-1.5 rounded-lg bg-[#1a1a1e] text-xs hover:bg-[#262629] transition-colors"
      onClick={() => window.location.reload()}
    >
      Reload
    </button>
  </div>
);

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary fallback={TopLevelFallback}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);