import type { Conversation } from "../../shared/types.js";

export function randomId(): string {
  return crypto.randomUUID();
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

export function formatRelativeDate(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const day = 86400000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(ts));
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ts));
}

export function groupConversationsByDate(
  convs: Conversation[]
): Array<{ label: string; items: Conversation[] }> {
  const pinned = convs.filter((c) => c.pinnedAt);
  const unpinned = convs.filter((c) => !c.pinnedAt);
  const groups: Map<string, Conversation[]> = new Map();
  if (pinned.length > 0) groups.set("📌 Pinned", pinned);
  for (const c of unpinned) {
    const label = formatRelativeDate(c.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(c);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

export function fileEmoji(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word")) return "📝";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "📊";
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) return "📑";
  if (
    mimeType === "application/json" ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml")
  )
    return "🔧";
  if (mimeType.startsWith("text/")) return "📃";
  if (
    mimeType.includes("zip") ||
    mimeType.includes("tar") ||
    mimeType.includes("gzip")
  )
    return "🗜";
  return "📎";
}

export function truncFilename(name: string, max = 20): string {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "";
  return name.slice(0, max - ext.length - 1) + "…" + ext;
}