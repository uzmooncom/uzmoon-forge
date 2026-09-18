import React, { useCallback, useEffect, useState } from "react";
import type { BrowserBookmark } from "@shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function BookmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 2h8a1 1 0 011 1v9l-5-2.5L2 12V3a1 1 0 011-1z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1.5 3h9M4 3V2h4v1M5 5.5v3M7 5.5v3M2 3l.5 7.5h7L10 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M5 2H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7.5 1h2.5v2.5M10 1L6 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

interface BookmarksPanelProps {
  profileId: string | null;
  onNavigate: (url: string) => void;
}

export function BookmarksPanel({ profileId, onNavigate }: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const loadBookmarks = useCallback(async () => {
    if (!profileId) { setBookmarks([]); return; }
    setLoading(true);
    try {
      const bmarks = await window.forgeApi.browser.listBookmarks(profileId);
      setBookmarks(bmarks.sort((a, b) => b.createdAt - a.createdAt));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.forgeApi.browser.removeBookmark(id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const handleOpen = useCallback((url: string) => {
    onNavigate(url);
  }, [onNavigate]);

  const filtered = bookmarks.filter((b) => {
    const q = searchQuery.toLowerCase();
    return !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
  });

  if (!profileId) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/20 text-sm">
        No browser profile active
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <BookmarkIcon />
          <span className="text-sm font-medium text-white/70">Bookmarks</span>
          {bookmarks.length > 0 && (
            <span className="ml-auto text-xs text-white/30">{bookmarks.length}</span>
          )}
        </div>
        <input
          type="text"
          placeholder="Search bookmarks…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-xs text-white/70 placeholder-white/25 focus:outline-none focus:border-white/15 transition-colors"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-20 text-white/20 text-xs">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-white/20">
            <BookmarkIcon />
            <span className="text-xs">
              {searchQuery ? "No bookmarks match" : "No bookmarks yet"}
            </span>
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((b) => (
              <BookmarkItem
                key={b.id}
                bookmark={b}
                onOpen={handleOpen}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BookmarkItem({
  bookmark,
  onOpen,
  onDelete,
}: {
  bookmark: BrowserBookmark;
  onOpen: (url: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  let hostname = bookmark.url;
  try { hostname = new URL(bookmark.url).hostname; } catch { /* noop */ }

  return (
    <li
      className="group flex items-center gap-2 px-4 py-2 hover:bg-white/4 cursor-pointer transition-colors"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpen(bookmark.url)}
    >
      {/* Favicon placeholder */}
      <div className="w-4 h-4 rounded flex-shrink-0 bg-white/8 flex items-center justify-center text-white/30">
        {bookmark.favicon ? (
          <img src={bookmark.favicon} alt="" className="w-4 h-4 rounded" />
        ) : (
          <span className="text-[8px]">🌐</span>
        )}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white/75 truncate leading-tight">{bookmark.title}</p>
        <p className="text-[10px] text-white/30 truncate leading-tight">{hostname}</p>
      </div>

      {/* Actions */}
      <div className={`flex items-center gap-1 transition-opacity ${hovered ? "opacity-100" : "opacity-0"}`}>
        <button
          className="p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpen(bookmark.url); }}
          title="Open"
        >
          <ExternalLinkIcon />
        </button>
        <button
          className="p-1 rounded hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors"
          onClick={(e) => onDelete(bookmark.id, e)}
          title="Delete"
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}
