/**
 * ProjectWorkspace — three-column IDE layout for a project:
 *   [File Explorer] | [Chat] | [File Preview]
 *
 * Context chips are accumulated here, then passed down to ChatScreen's composer.
 * Context is captured (snapshot) when the user sends a message.
 */
import React, { useEffect, useState, useCallback, useRef } from "react";
import type { Project, DirectoryStatus, ContextChip, ContextRef, FolderContextPreview } from "../../shared/types.js";
import { FileExplorer } from "../project/FileExplorer.js";
import { FilePreview } from "../project/FilePreview.js";
import { QuickOpen } from "../project/QuickOpen.js";
import ChatScreen from "./ChatScreen.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function ChevronLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M1.5 3.5A1 1 0 012.5 2.5h3.793a1 1 0 01.707.293L7.707 3.5H13.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-11a1 1 0 01-1-1V3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14.5 13.5H1.5L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 7v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function FilesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5 8h6M5 10.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Folder context modal ───────────────────────────────────────────────────

interface FolderContextModalProps {
  preview: FolderContextPreview;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}

function FolderContextModal({ preview, onConfirm, onCancel, loading }: FolderContextModalProps) {
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  const skipped = preview.skippedIgnored + preview.skippedBinary + preview.skippedSensitive + preview.skippedTooLarge;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#13131a] border border-white/10 rounded-xl shadow-2xl w-[420px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/8 flex items-center gap-2 flex-shrink-0">
          <FolderIcon size={13} />
          <span className="text-[13px] font-medium text-white/80">Add folder to context</span>
        </div>

        {/* Summary */}
        <div className="px-4 py-3 flex-shrink-0">
          <p className="text-[12px] text-white/55 mb-1">
            <span className="text-white/80 font-medium">{preview.includedFiles.length}</span> file{preview.includedFiles.length !== 1 ? "s" : ""} from{" "}
            <span className="font-mono text-white/60 text-[11px]">{preview.relativePath || "/"}</span>{" "}
            ({formatBytes(preview.totalSize)})
          </p>
          {skipped > 0 && (
            <p className="text-[11px] text-white/30">
              {skipped} skipped ({[
                preview.skippedIgnored > 0 && `${preview.skippedIgnored} ignored`,
                preview.skippedBinary > 0 && `${preview.skippedBinary} binary`,
                preview.skippedSensitive > 0 && `${preview.skippedSensitive} sensitive`,
                preview.skippedTooLarge > 0 && `${preview.skippedTooLarge} too large`,
              ].filter(Boolean).join(", ")})
            </p>
          )}
        </div>

        {/* File list */}
        {preview.includedFiles.length > 0 && (
          <div className="flex-1 min-h-0 overflow-y-auto border-t border-white/5 px-4 py-2">
            {preview.includedFiles.map((f) => (
              <div key={f.relativePath} className="flex items-center gap-1.5 py-[3px] text-[11px]">
                <span className="font-mono text-white/45 truncate flex-1">{f.relativePath}</span>
                {f.size !== undefined && (
                  <span className="text-[10px] text-white/20 flex-shrink-0">{formatBytes(f.size)}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {preview.includedFiles.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-white/30">
            No eligible files found in this folder.
          </div>
        )}

        {/* Actions */}
        <div className="px-4 py-3 border-t border-white/8 flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-[12px] text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || preview.includedFiles.length === 0}
            className="px-3 py-1.5 rounded-lg text-[12px] bg-blue-600/80 hover:bg-blue-600 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Adding…" : `Add ${preview.includedFiles.length} file${preview.includedFiles.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const EXPLORER_DEFAULT_WIDTH = 220;
const EXPLORER_MIN_WIDTH = 160;
const EXPLORER_MAX_WIDTH = 340;
const PREVIEW_DEFAULT_WIDTH = 360;
const PREVIEW_MIN_WIDTH = 240;
const PREVIEW_MAX_WIDTH = 600;

// ── ProjectWorkspace ────────────────────────────────────────────────────────

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
  onOpenSettings: () => void;
}

export default function ProjectWorkspace({ project, onBack, onOpenSettings }: ProjectWorkspaceProps) {
  const [dirStatus, setDirStatus] = useState<DirectoryStatus>("unknown");

  // Panel visibility
  const [showExplorer, setShowExplorer] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);

  // Panel widths (px)
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT_WIDTH);
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_DEFAULT_WIDTH);

  // Preview state
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // Context chips staged in composer
  const [stagedChips, setStagedChips] = useState<ContextChip[]>([]);

  // Captured refs ready to be sent with next message
  const capturedRefsRef = useRef<Map<string, ContextRef>>(new Map()); // chipId → ContextRef

  // Folder context modal state
  const [folderModal, setFolderModal] = useState<{
    preview: FolderContextPreview;
    projectId: string;
    relativePath: string;
  } | null>(null);
  const [folderModalLoading, setFolderModalLoading] = useState(false);

  // Resizer drag state
  const explorerResizing = useRef(false);
  const previewResizing = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    void window.forgeApi.validateProjectDir(project.id).then(setDirStatus);
  }, [project.id]);

  // Keyboard shortcut: Cmd+P → QuickOpen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setShowQuickOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "e") {
        e.preventDefault();
        setShowExplorer((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Resizer handlers ──────────────────────────────────────────────────────

  const startExplorerResize = (e: React.MouseEvent) => {
    explorerResizing.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = explorerWidth;
    e.preventDefault();
  };

  const startPreviewResize = (e: React.MouseEvent) => {
    previewResizing.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = previewWidth;
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (explorerResizing.current) {
        const delta = e.clientX - dragStartX.current;
        setExplorerWidth(Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, dragStartWidth.current + delta)));
      }
      if (previewResizing.current) {
        const delta = dragStartX.current - e.clientX;
        setPreviewWidth(Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, dragStartWidth.current + delta)));
      }
    };
    const onUp = () => { explorerResizing.current = false; previewResizing.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Context management ────────────────────────────────────────────────────

  const handleAddContext = useCallback(async (
    pId: string,
    relativePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => {
    // Check for duplicate
    const existing = stagedChips.find(
      (c) => c.relativePath === relativePath && c.lineStart === lineStart && c.lineEnd === lineEnd
    );
    if (existing) return;

    const chipId = randomId();
    const filename = relativePath.split("/").pop() ?? relativePath;
    const displayName = relativePath;

    // Optimistically add chip as "ready" — we'll capture the snapshot
    const tempChip: ContextChip = {
      id: chipId,
      projectId: pId,
      relativePath,
      displayName,
      ...(lineStart !== undefined && { lineStart }),
      ...(lineEnd !== undefined && { lineEnd }),
      size: 0,
      language: "plaintext",
      status: "ready",
    };
    setStagedChips((prev) => [...prev, tempChip]);

    // Capture snapshot in main process
    try {
      const res = await window.forgeApi.projectFiles.captureSnapshot(pId, relativePath, lineStart, lineEnd);
      if (res.ok) {
        capturedRefsRef.current.set(chipId, { ...res.ref, projectId: pId });
        setStagedChips((prev) =>
          prev.map((c) =>
            c.id === chipId
              ? { ...c, size: res.ref.size, language: res.ref.language, status: "ready", displayName }
              : c
          )
        );
      } else {
        // Determine status from error
        const status: ContextChip["status"] = res.isSensitive ? "sensitive" : "missing";
        setStagedChips((prev) =>
          prev.map((c) => c.id === chipId ? { ...c, status, size: 0 } : c)
        );
      }
    } catch {
      setStagedChips((prev) =>
        prev.map((c) => c.id === chipId ? { ...c, status: "missing" } : c)
      );
    }
    void filename;
  }, [stagedChips]);

  const handleRemoveChip = useCallback((chipId: string) => {
    setStagedChips((prev) => prev.filter((c) => c.id !== chipId));
    capturedRefsRef.current.delete(chipId);
  }, []);

  const handleAddFolderContext = useCallback(async (pId: string, relativePath: string) => {
    try {
      const result = await window.forgeApi.projectFiles.folderContextPreview(pId, relativePath);
      if (!result.ok) return; // silently ignore errors (e.g. path not found)
      setFolderModal({ preview: result, projectId: pId, relativePath });
    } catch {
      // best effort
    }
  }, []);

  const handleFolderModalConfirm = useCallback(async () => {
    if (!folderModal) return;
    setFolderModalLoading(true);
    try {
      // Add each eligible file as a context chip sequentially
      for (const file of folderModal.preview.includedFiles) {
        // Re-use the existing handleAddContext logic by calling it directly
        // We call the raw chip-addition pathway to avoid capturing chips in a stale closure:
        const chipId = Math.random().toString(36).slice(2, 10);
        const displayName = file.relativePath;
        const tempChip: ContextChip = {
          id: chipId,
          projectId: folderModal.projectId,
          relativePath: file.relativePath,
          displayName,
          size: file.size ?? 0,
          language: "plaintext",
          status: "ready",
        };
        setStagedChips((prev) => {
          // Skip if already staged
          const dupe = prev.find((c) => c.relativePath === file.relativePath);
          if (dupe) return prev;
          return [...prev, tempChip];
        });
        // Capture snapshot
        void window.forgeApi.projectFiles.captureSnapshot(
          folderModal.projectId, file.relativePath
        ).then((res) => {
          if (res.ok) {
            capturedRefsRef.current.set(chipId, { ...res.ref, projectId: folderModal.projectId });
            setStagedChips((prev) =>
              prev.map((c) =>
                c.id === chipId ? { ...c, size: res.ref.size, language: res.ref.language, status: "ready" } : c
              )
            );
          } else {
            const status: ContextChip["status"] = res.isSensitive ? "sensitive" : "missing";
            setStagedChips((prev) =>
              prev.map((c) => c.id === chipId ? { ...c, status, size: 0 } : c)
            );
          }
        }).catch(() => {
          setStagedChips((prev) =>
            prev.map((c) => c.id === chipId ? { ...c, status: "missing" } : c)
          );
        });
      }
    } finally {
      setFolderModalLoading(false);
      setFolderModal(null);
    }
  }, [folderModal]);

  const handlePreviewFile = useCallback((pId: string, relativePath: string) => {
    if (pId !== project.id) return;
    setPreviewPath(relativePath);
    setShowPreview(true);
  }, [project.id]);

  const handleClosePreview = useCallback(() => {
    setShowPreview(false);
    setPreviewPath(null);
  }, []);

  // After send: clear chips (ChatScreen calls this via ref)
  const clearStagedContext = useCallback(() => {
    setStagedChips([]);
    capturedRefsRef.current.clear();
  }, []);

  // Build the staged refs list for ChatScreen
  const stagedContextRefs = stagedChips
    .filter((c) => c.status === "ready")
    .map((c) => {
      const ref = capturedRefsRef.current.get(c.id);
      if (!ref) return null;
      return {
        projectId: c.projectId,
        relativePath: c.relativePath,
        ...(c.lineStart !== undefined && { lineStart: c.lineStart }),
        ...(c.lineEnd !== undefined && { lineEnd: c.lineEnd }),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Short path for header
  const shortPath = (() => {
    const parts = project.workingDirectory.replace(/\\/g, "/").split("/");
    return parts.slice(-3).join("/");
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Project header bar */}
      <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-white/5 bg-[#0d0d0f]">
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors text-[12px]"
          title="Back to Projects"
        >
          <ChevronLeftIcon size={13} />
          <span>Projects</span>
        </button>

        <div className="w-px h-3.5 bg-white/8 mx-0.5" />

        {/* Files toggle */}
        <button
          onClick={() => setShowExplorer((v) => !v)}
          className={`p-1.5 rounded-lg transition-colors ${showExplorer ? "text-white/60 bg-white/8" : "text-white/30 hover:text-white/50 hover:bg-white/5"}`}
          title="Toggle file explorer (⌘⇧E)"
        >
          <FilesIcon size={13} />
        </button>

        {/* Quick open */}
        <button
          onClick={() => setShowQuickOpen(true)}
          className="p-1.5 rounded-lg text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
          title="Quick open (⌘P)"
        >
          <SearchIcon size={13} />
        </button>

        <div className="flex items-center gap-1.5 min-w-0 flex-1 ml-1">
          <span className={dirStatus === "missing" ? "text-amber-400/60" : "text-white/30"}>
            <FolderIcon size={13} />
          </span>
          <span className="text-[12px] font-medium text-white/70 truncate">{project.name}</span>
          {dirStatus === "missing" && (
            <span className="flex items-center gap-1 text-[11px] text-amber-400/60 ml-1">
              <WarningIcon size={11} />
              <span>Folder unavailable</span>
            </span>
          )}
          {dirStatus === "ok" && (
            <span className="text-[11px] text-white/20 truncate hidden sm:inline" title={project.workingDirectory}>
              {shortPath}
            </span>
          )}
        </div>
      </div>

      {/* Three-column body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* File Explorer */}
        {showExplorer && (
          <>
            <div
              className="flex-shrink-0 flex flex-col overflow-hidden border-r border-white/5 bg-[#0b0b10]"
              style={{ width: explorerWidth }}
            >
              {/* Explorer header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 flex-shrink-0">
                <span className="text-[11px] font-medium text-white/30 uppercase tracking-wider">Files</span>
                <button
                  onClick={() => setShowExplorer(false)}
                  className="p-0.5 rounded text-white/20 hover:text-white/50 hover:bg-white/5 transition-colors"
                >
                  <CloseIcon size={10} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {dirStatus === "missing" ? (
                  <div className="px-3 py-4 text-[12px] text-amber-400/50">
                    Project folder not found.
                  </div>
                ) : (
                  <FileExplorer
                    projectId={project.id}
                    stagedChips={stagedChips}
                    onPreviewFile={handlePreviewFile}
                    onAddContext={handleAddContext}
                    onAddFolderContext={handleAddFolderContext}
                    onRemoveContext={handleRemoveChip}
                  />
                )}
              </div>
            </div>

            {/* Explorer resize handle */}
            <div
              className="flex-shrink-0 w-[3px] cursor-col-resize hover:bg-blue-500/30 transition-colors bg-transparent"
              onMouseDown={startExplorerResize}
            />
          </>
        )}

        {/* Chat panel */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <ChatScreen
            projectId={project.id}
            onOpenSettings={onOpenSettings}
            stagedContextRefs={stagedContextRefs}
            stagedContextChips={stagedChips}
            onRemoveContextChip={handleRemoveChip}
            onClearContext={clearStagedContext}
          />
        </div>

        {/* Preview resize handle */}
        {showPreview && (
          <div
            className="flex-shrink-0 w-[3px] cursor-col-resize hover:bg-blue-500/30 transition-colors bg-transparent"
            onMouseDown={startPreviewResize}
          />
        )}

        {/* File Preview */}
        {showPreview && previewPath && (
          <div
            className="flex-shrink-0 border-l border-white/5 overflow-hidden"
            style={{ width: previewWidth }}
          >
            <FilePreview
              projectId={project.id}
              relativePath={previewPath}
              onClose={handleClosePreview}
              onAddContext={handleAddContext}
            />
          </div>
        )}
      </div>

      {/* QuickOpen overlay */}
      {showQuickOpen && (
        <QuickOpen
          projectId={project.id}
          onPreview={handlePreviewFile}
          onAddContext={handleAddContext}
          onClose={() => setShowQuickOpen(false)}
        />
      )}

      {/* Folder context preview modal */}
      {folderModal && (
        <FolderContextModal
          preview={folderModal.preview}
          onConfirm={() => void handleFolderModalConfirm()}
          onCancel={() => setFolderModal(null)}
          loading={folderModalLoading}
        />
      )}
    </div>
  );
}