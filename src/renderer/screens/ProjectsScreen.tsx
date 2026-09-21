import React, { useState, useEffect, useCallback, useRef } from "react";
import type { Project, DirectoryStatus } from "../../shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 3.5A1 1 0 012.5 2.5h3.793a1 1 0 01.707.293L7.707 3.5H13.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-11a1 1 0 01-1-1V3.5z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none"
      />
    </svg>
  );
}

function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoreIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M5 4V3h6v1M6 7v5M10 7v5M4 4l.5 9h7l.5-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M11.5 2.5a1.414 1.414 0 012 2L5 13l-3.5 1 1-3.5L11.5 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function RevealIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M7 3H3a1 1 0 00-1 1v9a1 1 0 001 1h10a1 1 0 001-1V9M9 2h5v5M13.5 2.5L8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14.5 13.5H1.5L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 7v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

interface ProjectWithStatus extends Project {
  dirStatus?: DirectoryStatus;
}

interface ProjectsScreenProps {
  onOpenProject: (project: Project) => void;
  onOpenSettings: () => void;
}

// ── CreateProjectModal ──────────────────────────────────────────────────────

interface CreateProjectModalProps {
  onClose: () => void;
  onCreate: (project: Project) => void;
}

function CreateProjectModal({ onClose, onCreate }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 80);
  }, []);

  const handlePickDir = async () => {
    setPicking(true);
    try {
      const picked = await window.forgeApi.pickDirectory();
      if (picked) {
        setDir(picked);
        setError(null);
        if (!name.trim()) {
          // Auto-fill name from folder basename
          const parts = picked.replace(/\\/g, "/").split("/");
          setName(parts[parts.length - 1] ?? "");
        }
      }
    } finally {
      setPicking(false);
    }
  };

  const handleCreate = async () => {
    const trimName = name.trim();
    const trimDir = dir.trim();
    if (!trimDir) { setError("Please select a folder for this project."); return; }
    setError(null);
    setCreating(true);
    try {
      const result = await window.forgeApi.createProject({
        name: trimName,
        workingDirectory: trimDir,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreate(result.project);
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleCreate(); }
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-[420px] rounded-2xl border border-white/10 bg-[#13131a] p-6 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-[15px] font-semibold text-white mb-5">New Project</h2>

        {/* Folder picker */}
        <div className="mb-4">
          <label className="block text-xs text-white/40 mb-1.5">Project Folder</label>
          <div className="flex gap-2">
            <div
              className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1a1a24] border border-white/8 text-sm text-white/60 min-w-0 cursor-default"
              title={dir || "No folder selected"}
            >
              <FolderIcon size={14} />
              <span className="truncate flex-1 text-[13px]">
                {dir ? (() => {
                  const parts = dir.replace(/\\/g, "/").split("/");
                  return parts[parts.length - 1] || dir;
                })() : <span className="text-white/25">No folder selected</span>}
              </span>
              {dir && (
                <span className="text-white/20 text-[11px] truncate max-w-[120px]">{dir}</span>
              )}
            </div>
            <button
              onClick={() => void handlePickDir()}
              disabled={picking}
              className="px-3 py-2 rounded-lg bg-[#1a1a24] border border-white/8 text-sm text-white/60 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap disabled:opacity-50"
            >
              {picking ? "…" : "Choose…"}
            </button>
          </div>
        </div>

        {/* Name */}
        <div className="mb-5">
          <label className="block text-xs text-white/40 mb-1.5">Display Name <span className="text-white/20">(optional)</span></label>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Auto-filled from folder name"
            className="w-full px-3 py-2 rounded-lg bg-[#1a1a24] border border-white/8 text-sm text-white/80 placeholder-white/20 outline-none focus:border-[#6366f1]/50 transition-colors"
          />
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2">
            <WarningIcon size={13} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !dir.trim()}
            className="px-5 py-2 rounded-lg text-sm font-medium bg-[#6366f1] text-white hover:bg-[#5558e8] transition-colors disabled:opacity-40"
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RenameModal ─────────────────────────────────────────────────────────────

interface RenameModalProps {
  project: Project;
  onClose: () => void;
  onRenamed: (project: Project) => void;
}

function RenameModal({ project, onClose, onRenamed }: RenameModalProps) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 60);
  }, []);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) { onClose(); return; }
    setSaving(true);
    try {
      const updated = await window.forgeApi.updateProject(project.id, { name: trimmed });
      if (updated) onRenamed(updated);
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
    >
      <div
        className="w-[360px] rounded-2xl border border-white/10 bg-[#13131a] p-5 shadow-2xl"
        onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); if (e.key === "Escape") onClose(); }}
      >
        <h2 className="text-[14px] font-semibold text-white mb-4">Rename Project</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[#1a1a24] border border-white/8 text-sm text-white/80 outline-none focus:border-[#6366f1]/50 mb-4"
        />
        <p className="text-xs text-white/30 mb-4">The folder name and filesystem path remain unchanged.</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-white/40 hover:text-white/70">Cancel</button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-[#6366f1] text-white hover:bg-[#5558e8] disabled:opacity-40"
          >
            {saving ? "Saving…" : "Rename"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RemoveConfirmModal ──────────────────────────────────────────────────────

interface RemoveConfirmModalProps {
  project: Project;
  onClose: () => void;
  onConfirm: () => void;
}

function RemoveConfirmModal({ project, onClose, onConfirm }: RemoveConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
    >
      <div className="w-[380px] rounded-2xl border border-white/10 bg-[#13131a] p-5 shadow-2xl">
        <h2 className="text-[14px] font-semibold text-white mb-2">Remove &quot;{project.name}&quot; from Forge?</h2>
        <p className="text-sm text-white/40 mb-1">
          This removes the project from Uzmoon Forge. Your files remain exactly where they are — nothing is deleted from your computer.
        </p>
        <p className="text-xs text-white/25 mb-5">Conversation history linked to this project will remain in the database.</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-white/40 hover:text-white/70">Cancel</button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-red-600/70 text-white hover:bg-red-600 transition-colors"
          >
            Remove from Forge
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ProjectCard ─────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: ProjectWithStatus;
  onOpen: (p: Project) => void;
  onRename: (p: Project) => void;
  onRemove: (p: Project) => void;
  onReveal: (p: Project) => void;
}

function ProjectCard({ project, onOpen, onRename, onRemove, onReveal }: ProjectCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const shortPath = project.workingDirectory.replace(/\\/g, "/").split("/").slice(-3).join("/");
  const missing = project.dirStatus === "missing";

  return (
    <div
      className="group relative flex flex-col gap-2 p-4 rounded-xl bg-[#111117] border border-white/6 hover:border-white/12 hover:bg-[#14141d] transition-all cursor-pointer"
      onClick={() => onOpen(project)}
    >
      {/* Icon + Title */}
      <div className="flex items-start gap-3">
        <div className={`flex-shrink-0 p-2 rounded-lg ${missing ? "bg-amber-400/8 text-amber-400/60" : "bg-[#6366f1]/10 text-[#6366f1]"}`}>
          <FolderIcon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-white/90 truncate">{project.name}</div>
          <div className={`text-[11px] mt-0.5 truncate ${missing ? "text-amber-400/50" : "text-white/30"}`} title={project.workingDirectory}>
            {missing ? (
              <span className="flex items-center gap-1"><WarningIcon size={11} /> Folder unavailable</span>
            ) : (
              shortPath
            )}
          </div>
        </div>

        {/* More menu button */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
            className="p-1.5 rounded-lg text-white/0 group-hover:text-white/30 hover:!text-white/60 hover:bg-white/5 transition-all"
          >
            <MoreIcon size={14} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-8 z-20 w-44 rounded-xl border border-white/10 bg-[#1a1a24] shadow-xl overflow-hidden">
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(false); onReveal(project); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-white/60 hover:text-white hover:bg-white/5 transition-colors text-left"
              >
                <RevealIcon size={13} /> Reveal in Finder
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRename(project); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-white/60 hover:text-white hover:bg-white/5 transition-colors text-left"
              >
                <PencilIcon size={13} /> Rename
              </button>
              <div className="h-px bg-white/5 mx-2" />
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRemove(project); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-red-400/70 hover:text-red-400 hover:bg-red-400/5 transition-colors text-left"
              >
                <TrashIcon size={13} /> Remove from Forge
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Open chevron */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-white/20">
          {project.lastOpenedAt
            ? `Opened ${timeAgo(project.lastOpenedAt)}`
            : `Created ${timeAgo(project.createdAt)}`}
        </span>
        <span className="text-white/20 group-hover:text-white/40 transition-colors">
          <ChevronRightIcon size={13} />
        </span>
      </div>
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hrs = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── ProjectsScreen ──────────────────────────────────────────────────────────

export default function ProjectsScreen({ onOpenProject, onOpenSettings }: ProjectsScreenProps) {
  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const ps = await window.forgeApi.listProjects();
      // Validate directories in parallel
      const withStatus = await Promise.all(
        ps.map(async (p) => {
          const status = await window.forgeApi.validateProjectDir(p.id);
          return { ...p, dirStatus: status } as ProjectWithStatus;
        })
      );
      setProjects(withStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const handleCreated = (project: Project) => {
    setShowCreate(false);
    setProjects((prev) => [{ ...project, dirStatus: "ok" }, ...prev]);
    // Open immediately after creation
    onOpenProject(project);
  };

  const handleRenamed = (updated: Project) => {
    setRenaming(null);
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
  };

  const handleRemoveConfirm = async () => {
    if (!removing) return;
    const id = removing.id;
    setRemoving(null);
    try {
      await window.forgeApi.removeProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // IPC error — project stays in list; user can retry
    }
  };

  const handleReveal = (p: Project) => {
    void window.forgeApi.revealProjectDir(p.id);
  };

  return (
    <div className="flex flex-col h-full bg-[#0d0d0f]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div>
          <h1 className="text-[15px] font-semibold text-white/90">Projects</h1>
          <p className="text-[11px] text-white/30 mt-0.5">Organize conversations by working directory</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06M2.93 13.07l1.06-1.06M12.01 3.99l1.06-1.06" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#6366f1] text-white text-sm font-medium hover:bg-[#5558e8] transition-colors"
          >
            <PlusIcon size={14} />
            New Project
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-[#6366f1] animate-spin" />
          </div>
        ) : projects.length === 0 ? (
          // Empty state
          <div className="flex flex-col items-center justify-center h-[60vh] text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#6366f1]/10 flex items-center justify-center mb-4 text-[#6366f1]">
              <FolderIcon size={28} />
            </div>
            <h2 className="text-[15px] font-medium text-white/70 mb-2">No projects yet</h2>
            <p className="text-sm text-white/30 max-w-xs mb-6">
              Create a project to group conversations around a working directory. Your files are never modified.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#6366f1] text-white text-sm font-medium hover:bg-[#5558e8] transition-colors"
            >
              <PlusIcon size={14} />
              Create First Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 max-w-2xl">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={onOpenProject}
                onRename={setRenaming}
                onRemove={setRemoving}
                onReveal={handleReveal}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreated}
        />
      )}

      {renaming && (
        <RenameModal
          project={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={handleRenamed}
        />
      )}

      {removing && (
        <RemoveConfirmModal
          project={removing}
          onClose={() => setRemoving(null)}
          onConfirm={() => void handleRemoveConfirm()}
        />
      )}
    </div>
  );
}