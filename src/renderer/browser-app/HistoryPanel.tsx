import React, { useCallback, useEffect, useState } from "react";
import type { BrowserHistoryEntry } from "@shared/types.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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

// ── Helpers ────────────────────────────────────────────────────────────────

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function groupByDay(entries: BrowserHistoryEntry[]): { label: string; items: BrowserHistoryEntry[] }[] {
  const grouped = new Map<string, BrowserHistoryEntry[]>();
  for (const entry of entries) {
    const label = dayLabel(entry.visitedAt);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(entry);
  }
  return Array.from(grouped.entries()).map(([label, items]) => ({ label, items }));
}

// ── Component ──────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  profileId: string | null;
  onNavigate: (url: string) => void;
}

export function HistoryPanel({ profileId, onNavigate }: HistoryPanelProps) {
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const loadHistory = useCallback(async () => {
    if (!profileId) { setEntries([]); return; }
    setLoading(true);
    try {
      const hist = await window.forgeApi.browser.listHistory(profileId, 500);
      // Sort newest first
      setEntries([...hist].sort((a, b) => b.visitedAt - a.visitedAt));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleClearAll = useCallback(async () => {
    if (!profileId) return;
    await window.forgeApi.browser.clearHistory(profileId);
    setEntries([]);
  }, [profileId]);

  const filtered = entries.filter((e) => {
    const q = searchQuery.toLowerCase();
    return !q || e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q);
  });

  const groups = groupByDay(filtered);

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
          <HistoryIcon />
          <span className="text-sm font-medium text-white/70">History</span>
          {entries.length > 0 && (
            <button
              className="ml-auto text-xs text-white/25 hover:text-red-400 transition-colors flex items-center gap-1"
              onClick={handleClearAll}
              title="Clear all history"
            >
              <TrashIcon />
              Clear
            </button>
          )}
        </div>
        <input
          type="text"
          placeholder="Search history…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-xs text-white/70 placeholder-white/25 focus:outline-none focus:border-white/15 transition-colors"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-20 text-white/20 text-xs">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-white/20">
            <HistoryIcon />
            <span className="text-xs">
              {searchQuery ? "No results" : "No browsing history"}
            </span>
          </div>
        ) : (
          <div className="py-1">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-white/25 sticky top-0 bg-[#0d0d0f]">
                  {group.label}
                </div>
                <ul>
                  {group.items.map((entry) => (
                    <HistoryItem
                      key={entry.id}
                      entry={entry}
                      onOpen={onNavigate}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryItem({
  entry,
  onOpen,
}: {
  entry: BrowserHistoryEntry;
  onOpen: (url: string) => void;
}) {
  let hostname = entry.url;
  try { hostname = new URL(entry.url).hostname; } catch { /* noop */ }

  return (
    <li
      className="flex items-center gap-2 px-4 py-2 hover:bg-white/4 cursor-pointer transition-colors group"
      onClick={() => onOpen(entry.url)}
    >
      {/* Dot */}
      <div className="w-1.5 h-1.5 rounded-full bg-white/15 flex-shrink-0" />

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white/65 truncate leading-tight">{entry.title || entry.url}</p>
        <p className="text-[10px] text-white/30 truncate leading-tight">{hostname}</p>
      </div>

      {/* Time */}
      <span className="text-[10px] text-white/20 flex-shrink-0">{timeLabel(entry.visitedAt)}</span>
    </li>
  );
}