/**
 * FileExplorer — lazy-loading project file tree.
 *
 * Renders one directory level at a time; expands on click.
 * Files can be clicked (preview) or added as context via button/drag.
 * No direct filesystem access — all calls go through window.forgeApi.projectFiles.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectFileEntry, ContextChip } from "../../shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function FolderIcon({ open, size = 14 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      {open ? (
        <path d="M1.5 4.5h13l-1.5 7h-11L1.5 4.5zM1.5 4.5l1.5-2h4l1 2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      ) : (
        <path d="M1.5 3.5A1 1 0 012.5 2.5h3.793a1 1 0 01.707.293L7.707 3.5H13.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-11a1 1 0 01-1-1V3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function FileIcon({ extension, size = 14 }: { extension?: string; size?: number }) {
  const color = extensionColor(extension);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SpinnerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="10" strokeLinecap="round" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extensionColor(ext?: string): string {
  if (!ext) return "#8b8fa8";
  const map: Record<string, string> = {
    ts: "#3b82f6", tsx: "#3b82f6", js: "#eab308", jsx: "#eab308",
    mts: "#3b82f6", cts: "#3b82f6", mjs: "#eab308", cjs: "#eab308",
    py: "#22c55e", rb: "#ef4444", go: "#06b6d4", rs: "#f97316",
    java: "#f97316", kt: "#8b5cf6", swift: "#f97316",
    css: "#8b5cf6", scss: "#ec4899", html: "#f97316", svg: "#22c55e",
    json: "#eab308", yaml: "#06b6d4", yml: "#06b6d4", toml: "#f97316",
    md: "#94a3b8", mdx: "#94a3b8", txt: "#94a3b8",
    sh: "#22c55e", bash: "#22c55e",
    sql: "#06b6d4", graphql: "#e11d48",
    env: "#f59e0b",
  };
  return map[ext] ?? "#8b8fa8";
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface FileExplorerProps {
  projectId: string;
  /** Already-staged context chips */
  stagedChips: ContextChip[];
  onPreviewFile: (projectId: string, relativePath: string) => void;
  onAddContext: (projectId: string, relativePath: string) => void;
  onAddFolderContext: (projectId: string, relativePath: string) => void;
  onRemoveContext: (chipId: string) => void;
}

interface TreeNode {
  entry: ProjectFileEntry;
  children: TreeNode[] | null; // null = not yet loaded; [] = empty dir
  expanded: boolean;
  loading: boolean;
  error?: string;
}

// ── Single tree node row ───────────────────────────────────────────────────

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  projectId: string;
  isStaged: boolean;
  onToggle: (node: TreeNode) => void;
  onPreview: (node: TreeNode) => void;
  onAddCtx: (node: TreeNode) => void;
  onAddFolderCtx: (node: TreeNode) => void;
}

const TreeRow = React.memo(function TreeRow({
  node,
  depth,
  projectId: _projectId,
  isStaged,
  onToggle,
  onPreview,
  onAddCtx,
  onAddFolderCtx,
}: TreeRowProps) {
  const { entry } = node;
  const isDir = entry.kind === "directory";
  const isSensitive = entry.isSensitive === true;

  const indent = depth * 12 + 8;

  const handleClick = () => {
    if (isDir) onToggle(node);
    else if (!isSensitive) onPreview(node);
  };

  return (
    <div
      className={`group flex items-center gap-1 py-[2px] pr-2 cursor-pointer select-none
        ${isStaged ? "bg-blue-600/10" : "hover:bg-white/4"}
        ${isSensitive ? "opacity-50" : ""}
      `}
      style={{ paddingLeft: indent }}
      onClick={handleClick}
      title={entry.relativePath}
    >
      {/* Expand arrow (dirs only) */}
      <span className={`flex-shrink-0 w-3 text-white/30 transition-transform ${node.expanded ? "rotate-90" : ""}`}>
        {isDir ? <ChevronRightIcon size={10} /> : null}
      </span>

      {/* Icon */}
      <span className="flex-shrink-0">
        {isDir ? (
          <span className={node.expanded ? "text-amber-400/70" : "text-white/40"}>
            <FolderIcon open={node.expanded} size={13} />
          </span>
        ) : (
          isSensitive ? (
            <span className="text-amber-500/60"><LockIcon size={12} /></span>
          ) : (
            <FileIcon {...(entry.extension !== undefined && { extension: entry.extension })} size={13} />
          )
        )}
      </span>

      {/* Name */}
      <span className={`flex-1 min-w-0 text-[12px] truncate ${isDir ? "text-white/70" : "text-white/55"}`}>
        {entry.name}
      </span>

      {/* Loading spinner */}
      {node.loading && <span className="text-white/30"><SpinnerIcon size={10} /></span>}

      {/* Size (files only) */}
      {!isDir && entry.size !== undefined && (
        <span className="text-[10px] text-white/20 flex-shrink-0 hidden group-hover:inline">
          {formatSize(entry.size)}
        </span>
      )}

      {/* Add context button — files */}
      {!isDir && !isSensitive && (
        <button
          className={`flex-shrink-0 p-0.5 rounded transition-colors
            ${isStaged
              ? "text-blue-400/70 bg-blue-600/20"
              : "text-white/0 group-hover:text-white/40 group-hover:bg-white/8 hover:!text-blue-400"
            }`}
          title={isStaged ? "Already in context" : "Add to context"}
          onClick={(e) => { e.stopPropagation(); onAddCtx(node); }}
        >
          <AddContextIcon size={11} />
        </button>
      )}

      {/* Add folder context button — directories */}
      {isDir && (
        <button
          className="flex-shrink-0 p-0.5 rounded transition-colors text-white/0 group-hover:text-white/40 group-hover:bg-white/8 hover:!text-amber-400"
          title="Add folder files to context"
          onClick={(e) => { e.stopPropagation(); onAddFolderCtx(node); }}
        >
          <AddContextIcon size={11} />
        </button>
      )}
    </div>
  );
});

// ── Root component ─────────────────────────────────────────────────────────

export function FileExplorer({
  projectId,
  stagedChips,
  onPreviewFile,
  onAddContext,
  onAddFolderContext,
  onRemoveContext: _onRemoveContext,
}: FileExplorerProps) {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(true);
  const [rootError, setRootError] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  const stagedPaths = new Set(stagedChips.map((c) => c.relativePath));

  const loadDir = useCallback(async (relativePath: string): Promise<TreeNode[]> => {
    const res = await window.forgeApi.projectFiles.listDirectory(projectId, relativePath);
    if (!res.ok) throw new Error(res.error);
    return res.entries.map((entry): TreeNode => ({
      entry,
      children: entry.kind === "directory" ? null : [],
      expanded: false,
      loading: false,
    }));
  }, [projectId]);

  // Load root on mount / project change
  useEffect(() => {
    setRootLoading(true);
    setRootError(null);
    setRootNodes([]);
    loadedRef.current.clear();
    loadDir("").then((nodes) => {
      setRootNodes(nodes);
      setRootLoading(false);
    }).catch((err) => {
      setRootError(err instanceof Error ? err.message : "Failed to load files");
      setRootLoading(false);
    });
    // Also kick off index build
    void window.forgeApi.projectFiles.buildIndex(projectId);
  }, [projectId, loadDir]);

  const handleToggle = useCallback(async (targetNode: TreeNode) => {
    if (targetNode.entry.kind !== "directory") return;

    // Recursive state update helper
    const updateNode = (nodes: TreeNode[], path: string): TreeNode[] =>
      nodes.map((n) => {
        if (n.entry.relativePath === path) {
          if (n.expanded) {
            return { ...n, expanded: false };
          }
          // Need to expand — if children already loaded, just expand
          if (n.children !== null && n.children.length >= 0 && !n.loading) {
            return { ...n, expanded: true };
          }
          // Trigger load
          return { ...n, expanded: true, loading: true };
        }
        if (n.children) {
          return { ...n, children: updateNode(n.children, path) };
        }
        return n;
      });

    const path = targetNode.entry.relativePath;
    const alreadyLoaded = loadedRef.current.has(path);

    if (targetNode.expanded) {
      setRootNodes((prev) => updateNode(prev, path));
      return;
    }

    setRootNodes((prev) => updateNode(prev, path));

    if (!alreadyLoaded) {
      try {
        const children = await loadDir(path);
        loadedRef.current.add(path);
        // Insert children into tree
        const insertChildren = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.entry.relativePath === path) {
              return { ...n, children, loading: false };
            }
            if (n.children) return { ...n, children: insertChildren(n.children) };
            return n;
          });
        setRootNodes((prev) => insertChildren(prev));
      } catch {
        const setError = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.entry.relativePath === path) return { ...n, loading: false, error: "Load failed" };
            if (n.children) return { ...n, children: setError(n.children) };
            return n;
          });
        setRootNodes((prev) => setError(prev));
      }
    }
  }, [loadDir]);

  const handlePreview = useCallback((node: TreeNode) => {
    onPreviewFile(projectId, node.entry.relativePath);
  }, [projectId, onPreviewFile]);

  const handleAddCtx = useCallback((node: TreeNode) => {
    onAddContext(projectId, node.entry.relativePath);
  }, [projectId, onAddContext]);

  const handleAddFolderCtx = useCallback((node: TreeNode) => {
    onAddFolderContext(projectId, node.entry.relativePath);
  }, [projectId, onAddFolderContext]);

  // Flatten tree for rendering
  function flattenNodes(nodes: TreeNode[], depth: number): Array<{ node: TreeNode; depth: number }> {
    const flat: Array<{ node: TreeNode; depth: number }> = [];
    for (const node of nodes) {
      flat.push({ node, depth });
      if (node.expanded && node.children) {
        flat.push(...flattenNodes(node.children, depth + 1));
      }
    }
    return flat;
  }

  const flatList = flattenNodes(rootNodes, 0);

  if (rootLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-white/30 text-[12px]">
        <SpinnerIcon size={12} />
        <span>Loading files…</span>
      </div>
    );
  }

  if (rootError) {
    return (
      <div className="px-3 py-4 text-[12px] text-amber-400/60">
        {rootError}
      </div>
    );
  }

  if (flatList.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-white/20">
        No files in this project.
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-y-auto">
      {flatList.map(({ node, depth }) => (
        <TreeRow
          key={node.entry.relativePath}
          node={node}
          depth={depth}
          projectId={projectId}
          isStaged={stagedPaths.has(node.entry.relativePath)}
          onToggle={handleToggle}
          onPreview={handlePreview}
          onAddCtx={handleAddCtx}
          onAddFolderCtx={handleAddFolderCtx}
        />
      ))}
    </div>
  );
}