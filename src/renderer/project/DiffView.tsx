/**
 * DiffView.tsx — side-by-side unified diff renderer for file edit proposals.
 * Renders a line-by-line diff between base content and proposed content.
 */
import React, { useMemo } from "react";

// ── Simple line diff ────────────────────────────────────────────────────────

type LineOp = "equal" | "add" | "remove";

interface DiffLine {
  op: LineOp;
  text: string;
  baseLineNo?: number;
  propLineNo?: number;
}

/**
 * Compute a simple patience-style line diff.
 * Not a full LCS — uses a greedy matching approach that handles
 * most real code changes well.
 */
function computeLineDiff(base: string, proposed: string): DiffLine[] {
  const baseLines = base.split("\n");
  const propLines = proposed.split("\n");

  // Build LCS table (standard DP)
  const m = baseLines.length;
  const n = propLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (baseLines[i] === propLines[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }

  // Traceback
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let baseLineNo = 1;
  let propLineNo = 1;

  while (i < m || j < n) {
    if (i < m && j < n && baseLines[i] === propLines[j]) {
      result.push({ op: "equal", text: baseLines[i]!, baseLineNo: baseLineNo++, propLineNo: propLineNo++ });
      i++;
      j++;
    } else if (j < n && (i >= m || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      result.push({ op: "add", text: propLines[j]!, propLineNo: propLineNo++ });
      j++;
    } else {
      result.push({ op: "remove", text: baseLines[i]!, baseLineNo: baseLineNo++ });
      i++;
    }
  }

  return result;
}

// ── Stats ───────────────────────────────────────────────────────────────────

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

function getDiffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "remove") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function LineNoCell({ no }: { no: number | undefined }) {
  return (
    <td
      className="select-none text-right text-[11px] text-white/20 px-2 py-px align-top tabular-nums w-10 min-w-[2.5rem]"
      style={{ fontFamily: "ui-monospace, monospace", lineHeight: "1.6" }}
    >
      {no !== undefined ? no : ""}
    </td>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bgClass =
    line.op === "add"
      ? "bg-green-950/60"
      : line.op === "remove"
        ? "bg-red-950/60"
        : "";

  const prefixColor =
    line.op === "add"
      ? "text-green-400/70"
      : line.op === "remove"
        ? "text-red-400/70"
        : "text-white/10";

  const textColor =
    line.op === "add"
      ? "text-green-200/90"
      : line.op === "remove"
        ? "text-red-200/80"
        : "text-gray-300/80";

  return (
    <tr className={bgClass}>
      <LineNoCell no={line.baseLineNo} />
      <LineNoCell no={line.propLineNo} />
      <td className={`px-0.5 text-[11px] select-none w-3 ${prefixColor}`} style={{ fontFamily: "ui-monospace, monospace", lineHeight: "1.6" }}>
        {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
      </td>
      <td
        className={`px-2 py-px text-[11.5px] whitespace-pre break-all ${textColor}`}
        style={{ fontFamily: "ui-monospace, monospace", lineHeight: "1.6" }}
      >
        {line.text}
      </td>
    </tr>
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface DiffViewProps {
  baseContent: string;
  proposedContent: string;
  /** If set, show a header with the file path */
  filePath: string | undefined;
  /** Max lines to show (virtual truncation) */
  maxLines: number | undefined;
}

// ── Component ───────────────────────────────────────────────────────────────

export function DiffView({ baseContent, proposedContent, filePath, maxLines: maxLinesProp }: DiffViewProps) {
  const maxLines = maxLinesProp ?? 500;
  const lines = useMemo(
    () => computeLineDiff(baseContent, proposedContent),
    [baseContent, proposedContent]
  );
  const stats = useMemo(() => getDiffStats(lines), [lines]);
  const displayLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const truncated = lines.length > maxLines;

  return (
    <div className="flex flex-col min-w-0">
      {/* File header */}
      {filePath && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-white/4 border-b border-white/8 rounded-t">
          <span
            className="text-[11px] text-white/50 truncate"
            style={{ fontFamily: "ui-monospace, monospace" }}
          >
            {filePath}
          </span>
          <div className="flex items-center gap-2 text-[11px] shrink-0 ml-3">
            <span className="text-green-400/70">+{stats.added}</span>
            <span className="text-red-400/70">−{stats.removed}</span>
          </div>
        </div>
      )}

      {/* Diff table */}
      <div className="overflow-x-auto overflow-y-auto max-h-[420px] bg-[#0d0e11] rounded-b border border-white/8">
        <table className="w-full border-collapse">
          <tbody>
            {displayLines.map((line, idx) => (
              <DiffLineRow key={idx} line={line} />
            ))}
            {truncated && (
              <tr>
                <td colSpan={4} className="text-center text-[11px] text-white/30 py-2 italic">
                  ... {lines.length - maxLines} more lines not shown
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { getDiffStats };