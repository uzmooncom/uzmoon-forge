/**
 * ContextChips — displays staged project context files in the chat composer.
 * Each chip shows filename, optional line range, size, and a remove button.
 */
import React from "react";
import type { ContextChip } from "../../shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function RemoveIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FileContextIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 9h4M6 11.5h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function chipLabel(chip: ContextChip): string {
  const filename = chip.displayName.split("/").pop() ?? chip.displayName;
  if (chip.lineStart !== undefined && chip.lineEnd !== undefined) {
    return `${filename}:${chip.lineStart}-${chip.lineEnd}`;
  }
  if (chip.lineStart !== undefined) {
    return `${filename}:${chip.lineStart}+`;
  }
  return filename;
}

function chipTitle(chip: ContextChip): string {
  let title = chip.relativePath;
  if (chip.lineStart !== undefined) {
    title += ` (lines ${chip.lineStart}-${chip.lineEnd ?? "end"})`;
  }
  title += ` — ${formatSize(chip.size)}`;
  return title;
}

function chipStatusClass(status: ContextChip["status"]): string {
  switch (status) {
    case "ready": return "bg-blue-600/15 border-blue-600/20 text-blue-300/80";
    case "sensitive": return "bg-amber-500/10 border-amber-500/20 text-amber-400/70";
    case "too_large": return "bg-red-500/10 border-red-500/20 text-red-400/70";
    case "missing": return "bg-white/5 border-white/10 text-white/30";
    case "unsupported": return "bg-white/5 border-white/10 text-white/30";
    default: return "bg-white/5 border-white/10 text-white/40";
  }
}

// ── Component ──────────────────────────────────────────────────────────────

interface ContextChipsProps {
  chips: ContextChip[];
  onRemove: (chipId: string) => void;
  onChipClick?: (chip: ContextChip) => void;
}

export function ContextChips({ chips, onRemove, onChipClick }: ContextChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {chips.map((chip) => (
        <div
          key={chip.id}
          className={`group flex items-center gap-1 pl-2 pr-1 py-[3px] rounded-lg border text-[11px] font-medium
            max-w-[200px] cursor-pointer transition-colors
            ${chipStatusClass(chip.status)}
          `}
          title={chipTitle(chip)}
          onClick={() => onChipClick?.(chip)}
        >
          {/* Icon */}
          <span className="flex-shrink-0 opacity-60">
            {chip.status === "sensitive" ? (
              <LockIcon size={10} />
            ) : (
              <FileContextIcon size={11} />
            )}
          </span>

          {/* Label */}
          <span className="truncate max-w-[130px]">{chipLabel(chip)}</span>

          {/* Size */}
          {chip.status === "ready" && (
            <span className="text-[10px] opacity-40 flex-shrink-0">
              {formatSize(chip.size)}
            </span>
          )}

          {/* Status badges */}
          {chip.status === "sensitive" && (
            <span className="text-[10px] opacity-60 flex-shrink-0">sensitive</span>
          )}
          {chip.status === "too_large" && (
            <span className="text-[10px] opacity-60 flex-shrink-0">too large</span>
          )}
          {chip.status === "missing" && (
            <span className="text-[10px] opacity-60 flex-shrink-0">missing</span>
          )}

          {/* Remove */}
          <button
            className="flex-shrink-0 p-0.5 rounded opacity-40 hover:opacity-90 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onRemove(chip.id); }}
            title="Remove from context"
          >
            <RemoveIcon size={9} />
          </button>
        </div>
      ))}
    </div>
  );
}