import React, { useState, useEffect, useRef } from "react";
import type { Conversation } from "../../../shared/types.js";
import { DotsIcon, PencilIcon, PinIcon, UnpinIcon, DownloadIcon, ArchiveIcon, TrashIcon } from "../icons.js";

export function ConversationItem({
  conv,
  active,
  isStreaming,
  onClick,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onExport,
}: {
  conv: Conversation;
  active: boolean;
  isStreaming?: boolean;
  onClick: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onArchive: (id: string) => void;
  onExport: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const commitRename = () => {
    const v = renameValue.trim();
    if (v && v !== conv.title) onRename(conv.id, v);
    setRenaming(false);
  };

  return (
    <div
      className={`group relative flex items-center rounded-lg px-3 py-2 cursor-pointer transition-colors text-sm ${
        active
          ? "bg-white/10 text-white"
          : "text-white/60 hover:bg-white/5 hover:text-white/90"
      }`}
      onClick={() => { if (!renaming) onClick(); }}
    >
      {conv.pinnedAt && (
        <span className="mr-1.5 opacity-40 flex-shrink-0">
          <PinIcon size={10} />
        </span>
      )}

      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setRenameValue(conv.title); setRenaming(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent outline-none border-b border-white/30 text-white text-sm"
        />
      ) : (
        <span className="flex-1 truncate flex items-center gap-1.5">
          {conv.title}
          {isStreaming && (
            <span className="inline-flex gap-0.5 items-center ml-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1 h-1 rounded-full bg-blue-400/70 animate-bounce"
                  style={{ animationDelay: `${i * 100}ms` }}
                />
              ))}
            </span>
          )}
        </span>
      )}

      {!renaming && (
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className="ml-1 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-white/50 hover:text-white rounded transition-all"
        >
          <DotsIcon size={14} />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-8 z-30 bg-[#1e1e2e] border border-white/10 rounded-lg shadow-xl py-1 min-w-[148px]"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={<PencilIcon size={13} />}
            label="Rename"
            onClick={() => { setMenuOpen(false); setRenameValue(conv.title); setRenaming(true); }}
          />
          <MenuItem
            icon={conv.pinnedAt ? <UnpinIcon size={13} /> : <PinIcon size={13} />}
            label={conv.pinnedAt ? "Unpin" : "Pin"}
            onClick={() => { setMenuOpen(false); onPin(conv.id); }}
          />
          <MenuItem
            icon={<DownloadIcon size={13} />}
            label="Export"
            onClick={() => { setMenuOpen(false); onExport(conv.id); }}
          />
          <MenuItem
            icon={<ArchiveIcon size={13} />}
            label="Archive"
            onClick={() => { setMenuOpen(false); onArchive(conv.id); }}
          />
          <div className="h-px bg-white/8 my-1" />
          <MenuItem
            icon={<TrashIcon size={13} />}
            label="Delete"
            onClick={() => { setMenuOpen(false); onDelete(conv.id); }}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm transition-colors ${
        danger
          ? "text-red-400 hover:text-red-300 hover:bg-red-900/20"
          : "text-white/70 hover:text-white hover:bg-white/5"
      }`}
    >
      <span className="flex-shrink-0 opacity-70">{icon}</span>
      {label}
    </button>
  );
}