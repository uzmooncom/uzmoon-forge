import React, { useState, useEffect } from "react";
import { MarkdownContent } from "./MarkdownContent.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function SpinnerIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="animate-spin"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckSmallIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ErrorSmallIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v5M8 11.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1 items-center h-4">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

// ── Tool activity row ──────────────────────────────────────────────────────

interface LiveToolEntry {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  done: boolean;
}

function toolHumanLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_directory": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      return `Listing directory${p ? `: ${p}` : ""}`;
    }
    case "search_files": {
      const q = typeof args["query"] === "string" ? args["query"] : "";
      return `Searching files: ${q}`;
    }
    case "search_code": {
      const q = typeof args["query"] === "string" ? args["query"] : "";
      return `Searching code: ${q}`;
    }
    case "read_file": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      return `Reading: ${p}`;
    }
    case "read_file_range": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      const start = typeof args["lineStart"] === "number" ? args["lineStart"] : "?";
      const end = typeof args["lineEnd"] === "number" ? args["lineEnd"] : "?";
      return `Reading ${p} (lines ${start}–${end})`;
    }
    default:
      return name;
  }
}

function ToolActivityRow({ entry }: { entry: LiveToolEntry }) {
  const label = toolHumanLabel(entry.name, entry.arguments);
  const elapsed = entry.durationMs !== undefined
    ? `${entry.durationMs}ms`
    : `${Date.now() - entry.startedAt}ms`;

  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span className={`flex-shrink-0 ${entry.done ? (entry.ok ? "text-white/35" : "text-red-400/60") : "text-blue-400/70"}`}>
        {entry.done
          ? (entry.ok ? <CheckSmallIcon size={10} /> : <ErrorSmallIcon size={10} />)
          : <SpinnerIcon size={10} />}
      </span>
      <span className={`text-[11px] font-mono truncate ${entry.done ? "text-white/35" : "text-white/55"}`}>
        {label}
      </span>
      {entry.done && (
        <span className="text-[10px] text-white/20 ml-auto flex-shrink-0">{elapsed}</span>
      )}
    </div>
  );
}

// ── StreamingBubble ────────────────────────────────────────────────────────

export function StreamingBubble({ text }: { text: string }) {
  const [toolEntries, setToolEntries] = useState<LiveToolEntry[]>([]);

  useEffect(() => {
    // Subscribe to tool activity events
    const unsubStart = window.forgeApi.agentTools.onToolStart((payload) => {
      const { call } = payload;
      setToolEntries((prev) => {
        // Avoid duplicates
        if (prev.find((e) => e.callId === call.callId)) return prev;
        return [...prev, {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          startedAt: Date.now(),
          done: false,
        }];
      });
    });

    const unsubEnd = window.forgeApi.agentTools.onToolEnd((payload) => {
      const { call, result, durationMs } = payload;
      setToolEntries((prev) => prev.map((e) =>
        e.callId === call.callId
          ? { ...e, done: true, ok: result.ok, durationMs }
          : e
      ));
    });

    return () => {
      unsubStart();
      unsubEnd();
    };
  }, []);

  return (
    <div className="group flex flex-col gap-0 py-3 px-1">
      {/* Forge identity row (matches MessageBubble document-style) */}
      <div className="flex items-center gap-2 mb-1">
        <div className="w-4 h-4 rounded flex items-center justify-center bg-white/8 flex-shrink-0">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 10V3.5L5.5 2h3L11 3.5V10H2z" stroke="white" strokeWidth="1" strokeLinejoin="round" />
            <path d="M5 10V7.5h2V10" stroke="white" strokeWidth="1" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="text-[11px] text-white/35 font-medium">Forge</span>
      </div>

      {/* Live tool activity */}
      {toolEntries.length > 0 && (
        <div className="mb-2 ml-1 border-l border-white/8 pl-3 flex flex-col gap-0">
          {toolEntries.map((entry) => (
            <ToolActivityRow key={entry.callId} entry={entry} />
          ))}
        </div>
      )}

      {/* Streamed text */}
      <div className="text-sm leading-relaxed text-gray-100/90">
        {text ? <MarkdownContent content={text} /> : <TypingDots />}
      </div>
    </div>
  );
}