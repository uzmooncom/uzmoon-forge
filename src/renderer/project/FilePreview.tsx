/**
 * FilePreview — read-only file content viewer.
 *
 * Displays file content with syntax-appropriate label.
 * Supports line range selection for adding partial context.
 * No syntax highlighting library — uses monospace font with line numbers.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import type { FileReadResult, FileReadError } from "../../shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function AddContextIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SpinnerIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="10" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="9" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 11V2h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

interface FilePreviewProps {
  projectId: string;
  relativePath: string;
  onClose: () => void;
  onAddContext: (projectId: string, relativePath: string, lineStart?: number, lineEnd?: number) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function FilePreview({ projectId, relativePath, onClose, onAddContext }: FilePreviewProps) {
  const [result, setResult] = useState<FileReadResult | FileReadError | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setResult(null);
    setSelStart(null);
    setSelEnd(null);
    window.forgeApi.projectFiles.readFile(projectId, relativePath)
      .then((r) => { setResult(r); setLoading(false); })
      .catch(() => { setResult({ ok: false, error: "Failed to read file" }); setLoading(false); });
  }, [projectId, relativePath]);

  const filename = relativePath.split("/").pop() ?? relativePath;
  const shortPath = relativePath.length > 50
    ? "…" + relativePath.slice(-47)
    : relativePath;

  const handleCopy = useCallback(() => {
    if (!result?.ok) return;
    void window.forgeApi.copyText(result.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  const handleAddWholeFile = useCallback(() => {
    onAddContext(projectId, relativePath);
  }, [projectId, relativePath, onAddContext]);

  const handleAddSelection = useCallback(() => {
    if (selStart === null || selEnd === null) return;
    const lo = Math.min(selStart, selEnd);
    const hi = Math.max(selStart, selEnd);
    onAddContext(projectId, relativePath, lo, hi);
    setSelStart(null);
    setSelEnd(null);
  }, [projectId, relativePath, selStart, selEnd, onAddContext]);

  const handleLineMouseDown = (lineNum: number) => {
    selectingRef.current = true;
    setSelStart(lineNum);
    setSelEnd(lineNum);
  };

  const handleLineMouseEnter = (lineNum: number) => {
    if (selectingRef.current) setSelEnd(lineNum);
  };

  const handleLineMouseUp = () => {
    selectingRef.current = false;
  };

  const isLineSelected = (lineNum: number) => {
    if (selStart === null || selEnd === null) return false;
    const lo = Math.min(selStart, selEnd);
    const hi = Math.max(selStart, selEnd);
    return lineNum >= lo && lineNum <= hi;
  };

  const hasSelection = selStart !== null && selEnd !== null;

  return (
    <div className="flex flex-col h-full bg-[#0d0d12] overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-white/70 truncate" title={relativePath}>
            {filename}
          </div>
          <div className="text-[10px] text-white/25 truncate">{shortPath}</div>
        </div>

        {/* Language badge */}
        {result?.ok && (
          <span className="text-[10px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">
            {result.language}
          </span>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1">
          {result?.ok && (
            <>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
                title="Copy all"
              >
                <CopyIcon size={11} />
                {copied ? <span className="text-emerald-400">Copied</span> : null}
              </button>
              {hasSelection ? (
                <button
                  onClick={handleAddSelection}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                  title={`Add lines ${Math.min(selStart!, selEnd!)}-${Math.max(selStart!, selEnd!)} to context`}
                >
                  <AddContextIcon size={11} />
                  Lines {Math.min(selStart!, selEnd!)}-{Math.max(selStart!, selEnd!)}
                </button>
              ) : (
                <button
                  onClick={handleAddWholeFile}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
                  title="Add whole file to context"
                >
                  <AddContextIcon size={11} />
                  Add
                </button>
              )}
            </>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto" onMouseUp={handleLineMouseUp}>
        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-white/30 text-[12px]">
            <SpinnerIcon size={13} />
            <span>Loading…</span>
          </div>
        )}

        {!loading && result && !result.ok && (
          <div className="px-4 py-6">
            <div className="text-[12px] text-amber-400/70">{result.error}</div>
            {result.isBinary && (
              <div className="mt-2 text-[11px] text-white/30">Binary files cannot be previewed.</div>
            )}
            {result.isSensitive && (
              <div className="mt-2 text-[11px] text-white/30">This file may contain sensitive data.</div>
            )}
          </div>
        )}

        {!loading && result?.ok && (
          <div className="font-mono text-[11.5px] leading-relaxed">
            {result.truncated && (
              <div className="px-4 py-1 bg-amber-500/10 text-amber-400/70 text-[11px] border-b border-white/5">
                File truncated — showing first {Math.round(result.size / 1024)}KB
              </div>
            )}
            {result.content.split("\n").map((line, i) => {
              const lineNum = i + 1;
              const selected = isLineSelected(lineNum);
              return (
                <div
                  key={i}
                  className={`flex gap-0 group cursor-text select-text
                    ${selected ? "bg-blue-600/15" : "hover:bg-white/3"}
                  `}
                  onMouseDown={() => handleLineMouseDown(lineNum)}
                  onMouseEnter={() => handleLineMouseEnter(lineNum)}
                >
                  <span className="flex-shrink-0 w-10 text-right pr-3 text-white/15 text-[10px] leading-[1.7] select-none pt-[1px]">
                    {lineNum}
                  </span>
                  <span className="text-white/65 whitespace-pre px-2 flex-1 min-w-0 overflow-x-visible">
                    {line || " "}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}