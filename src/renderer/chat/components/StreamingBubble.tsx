import React, { useState, useEffect, useRef } from "react";
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
  /** Deduplication key — action:path */
  dedupeKey: string;
  done: boolean;
  ok?: boolean;
}

/** Humanize a path for display — strip leading "./" and return basename for long paths */
function humanPath(raw: string | undefined): string {
  if (!raw) return "";
  const p = raw.replace(/^\.\//, "");
  // Use basename for paths with more than one segment
  const parts = p.split("/");
  return parts.length > 2 ? (parts[parts.length - 1] ?? p) : p;
}

function toolHumanLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_directory": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      const hp = humanPath(p);
      return hp ? `Scanning ${hp}` : "Scanning project structure";
    }
    case "search_files": {
      const q = typeof args["query"] === "string" ? args["query"] : "";
      return q ? `Searching for ${q}` : "Searching files";
    }
    case "search_code": {
      const q = typeof args["query"] === "string" ? args["query"] : "";
      return q ? `Searching for \`${q}\`` : "Searching code";
    }
    case "read_file": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      return p ? `Reading ${humanPath(p)}` : "Reading file";
    }
    case "read_file_range": {
      const p = typeof args["path"] === "string" ? args["path"] : "";
      const start = typeof args["lineStart"] === "number" ? args["lineStart"] : "?";
      const end = typeof args["lineEnd"] === "number" ? args["lineEnd"] : "?";
      return p ? `Reading ${humanPath(p)} (lines ${start}–${end})` : "Reading file range";
    }
    default:
      return name;
  }
}

function toolDedupeKey(name: string, args: Record<string, unknown>): string {
  const p = typeof args["path"] === "string" ? args["path"] : "";
  const q = typeof args["query"] === "string" ? args["query"] : "";
  return `${name}:${p || q}`;
}

function ToolActivityRow({ entry }: { entry: LiveToolEntry }) {
  const label = toolHumanLabel(entry.name, entry.arguments);
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span className={`flex-shrink-0 ${entry.done ? (entry.ok ? "text-white/30" : "text-red-400/60") : "text-blue-400/70"}`}>
        {entry.done
          ? (entry.ok ? <CheckSmallIcon size={10} /> : <ErrorSmallIcon size={10} />)
          : <SpinnerIcon size={10} />}
      </span>
      <span className={`text-[11px] font-mono truncate ${entry.done ? "text-white/30" : "text-white/50"}`}>
        {label}
      </span>
    </div>
  );
}

// ── StreamingBubble ────────────────────────────────────────────────────────

export function StreamingBubble({ text }: { text: string }) {
  const [toolEntries, setToolEntries] = useState<LiveToolEntry[]>([]);
  /** Set to track which dedupe keys we've already shown — prevents duplicate rows */
  const seenDedupeKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubStart = window.forgeApi.agentTools.onToolStart((payload) => {
      const { call } = payload;
      const dedupeKey = toolDedupeKey(call.name, call.arguments);

      setToolEntries((prev) => {
        // Skip if we've already shown this call ID (native duplicates) or same action+path
        if (prev.find((e) => e.callId === call.callId)) return prev;
        if (seenDedupeKeys.current.has(dedupeKey)) return prev;
        seenDedupeKeys.current.add(dedupeKey);
        return [...prev, {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          dedupeKey,
          done: false,
        }];
      });
    });

    const unsubEnd = window.forgeApi.agentTools.onToolEnd((payload) => {
      const { call, result } = payload;
      setToolEntries((prev) => prev.map((e) =>
        e.callId === call.callId
          ? { ...e, done: true, ok: result.ok }
          : e
      ));
    });

    return () => {
      unsubStart();
      unsubEnd();
    };
  }, []);

  const hasToolActivity = toolEntries.length > 0;
  const hasText = !!text;

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
      {hasToolActivity && (
        <div className="mb-2 ml-1 border-l border-white/8 pl-3 flex flex-col gap-0">
          {toolEntries.map((entry) => (
            <ToolActivityRow key={entry.callId} entry={entry} />
          ))}

        </div>
      )}

      {/* Streamed text — only shown for the terminal (final) turn */}
      <div className="text-sm leading-relaxed text-gray-100/90">
        {hasText
          ? <MarkdownContent content={text} />
          : <TypingDots />}
      </div>
    </div>
  );
}