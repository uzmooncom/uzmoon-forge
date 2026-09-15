/**
 * QuickOpen — Cmd+P style fuzzy file picker for project files.
 * Opens a floating palette over the workspace.
 * Allows selecting a file to preview or add to context.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ProjectFileEntry } from "../../shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function FileIcon({ extension, size = 13 }: { extension?: string; size?: number }) {
  const color = extColor(extension);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function AddContextIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function extColor(ext?: string): string {
  const map: Record<string, string> = {
    ts: "#3b82f6", tsx: "#3b82f6", js: "#eab308", jsx: "#eab308",
    py: "#22c55e", go: "#06b6d4", rs: "#f97316", rb: "#ef4444",
    css: "#8b5cf6", scss: "#ec4899", html: "#f97316", json: "#eab308",
    md: "#94a3b8", yaml: "#06b6d4", yml: "#06b6d4", sh: "#22c55e",
  };
  return map[ext ?? ""] ?? "#6b7280";
}

// ── Component ──────────────────────────────────────────────────────────────

interface QuickOpenProps {
  projectId: string;
  onPreview: (projectId: string, relativePath: string) => void;
  onAddContext: (projectId: string, relativePath: string) => void;
  onClose: () => void;
}

export function QuickOpen({ projectId, onPreview, onAddContext, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectFileEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setSearching(false); return; }
    setSearching(true);
    try {
      const found = await window.forgeApi.projectFiles.searchFiles(projectId, q, 30);
      setResults(found);
      setSelected(0);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [projectId]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(q); }, 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const file = results[selected];
      if (file) { onPreview(projectId, file.relativePath); onClose(); }
      return;
    }
  };

  const renderPath = (relativePath: string) => {
    const parts = relativePath.split("/");
    const filename = parts.pop() ?? relativePath;
    const dir = parts.join("/");
    return { filename, dir };
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Palette */}
      <div className="fixed inset-x-0 top-[15%] z-50 flex justify-center pointer-events-none">
        <div
          className="w-full max-w-[560px] mx-4 bg-[#16161e] border border-white/10 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/8">
            <span className="text-white/30 flex-shrink-0"><SearchIcon size={14} /></span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleQueryChange}
              onKeyDown={handleKeyDown}
              placeholder="Search project files…"
              className="flex-1 bg-transparent text-white/80 text-[13px] outline-none placeholder:text-white/20"
            />
            {searching && (
              <span className="text-white/20 text-[11px]">Searching…</span>
            )}
            <kbd className="text-[10px] text-white/20 bg-white/5 px-1.5 py-0.5 rounded font-mono">ESC</kbd>
          </div>

          {/* Results */}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {results.length === 0 && query.trim() && !searching && (
              <div className="px-4 py-3 text-[12px] text-white/25">No files match "{query}"</div>
            )}
            {results.length === 0 && !query.trim() && (
              <div className="px-4 py-3 text-[12px] text-white/20">Start typing to search files…</div>
            )}
            {results.map((file, i) => {
              const { filename, dir } = renderPath(file.relativePath);
              const isActive = i === selected;
              return (
                <div
                  key={file.relativePath}
                  className={`group flex items-center gap-2 px-4 py-2 cursor-pointer
                    ${isActive ? "bg-white/6" : "hover:bg-white/4"}
                  `}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => { onPreview(projectId, file.relativePath); onClose(); }}
                >
                  <span className="flex-shrink-0 opacity-70">
                    <FileIcon {...(file.extension !== undefined && { extension: file.extension })} size={13} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[12px] text-white/75 font-medium">{filename}</span>
                    {dir && <span className="text-[11px] text-white/25 ml-2">{dir}</span>}
                  </div>
                  {file.size !== undefined && (
                    <span className="text-[10px] text-white/20 hidden group-hover:inline">
                      {file.size < 1024 ? `${file.size}B` : `${(file.size / 1024).toFixed(0)}KB`}
                    </span>
                  )}
                  <button
                    className="flex-shrink-0 p-1 rounded-lg text-white/0 group-hover:text-white/40 hover:!text-blue-400 hover:bg-blue-600/20 transition-colors"
                    title="Add to context"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddContext(projectId, file.relativePath);
                      onClose();
                    }}
                  >
                    <AddContextIcon size={11} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Footer hints */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-white/5 text-[10px] text-white/20">
            <span><kbd className="font-mono bg-white/5 px-1 py-0.5 rounded">↵</kbd> Preview</span>
            <span><kbd className="font-mono bg-white/5 px-1 py-0.5 rounded">+</kbd> Add to context</span>
            <span><kbd className="font-mono bg-white/5 px-1 py-0.5 rounded">↑↓</kbd> Navigate</span>
          </div>
        </div>
      </div>
    </>
  );
}