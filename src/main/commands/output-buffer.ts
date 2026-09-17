/**
 * output-buffer.ts — Bounded command output ring buffer.
 *
 * Strategy:
 * - Retain first OUTPUT_HEAD_BYTES + last OUTPUT_TAIL_BYTES of raw output.
 * - Mark truncated=true when total exceeds MAX_OUTPUT_BYTES.
 * - stdout and stderr tracked separately for byte counts.
 * - sanitizeCommandOutputForModel(): secrets redacted, ANSI stripped, bounded to MAX_MODEL_OUTPUT_BYTES.
 *
 * Output preview strategy (spec §111):
 * - Agent needs compiler/test error tail — errors are almost always at the end.
 * - We retain both head (first lines showing context) and tail (last lines showing errors).
 * - When output fits within head+tail without overlap, we retain everything.
 * - When truncated: head [2KB] + "...<N bytes omitted>..." + tail [8KB].
 *
 * ANSI/control character safety:
 * - Strips ANSI escape sequences (CSI, OSC, etc.) before model sees output.
 * - Strips C0 control chars except \t \n \r.
 * - Prevents terminal injection, OSC hyperlink injection, and rendering issues.
 */
import { createHash } from "crypto";
import { COMMAND_LIMITS } from "./command-limits.js";
import { redactSecrets } from "../reliability/sanitizer.js";

// ── ANSI strip ──────────────────────────────────────────────────────────────

// Matches ANSI/VT100 escape sequences:
// - CSI sequences: ESC [ ... m (colors, cursor movement)
// - OSC sequences: ESC ] ... ST (hyperlinks, title set)
// - Other ESC sequences
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([AB]|[^[\]()A-Za-z]?[A-Za-z])/g;

// C0 control characters excluding \t (0x09) \n (0x0A) \r (0x0D)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsiAndControlChars(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}

// ── Output buffer ───────────────────────────────────────────────────────────

interface Chunk {
  kind: "stdout" | "stderr";
  text: string;
}

export class OutputBuffer {
  private headChunks: Chunk[] = [];
  private tailChunks: Chunk[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private _totalBytesReceived = 0;
  private _stdoutBytes = 0;
  private _stderrBytes = 0;
  private _truncated = false;

  /** true if total output exceeded MAX_OUTPUT_BYTES */
  get truncated(): boolean { return this._truncated; }
  get totalBytesReceived(): number { return this._totalBytesReceived; }
  get stdoutBytes(): number { return this._stdoutBytes; }
  get stderrBytes(): number { return this._stderrBytes; }

  /**
   * Append a chunk of output data to the buffer.
   * Maintains head region (first HEAD_BYTES) and tail region (last TAIL_BYTES).
   * Total accepted bytes limited to MAX_OUTPUT_BYTES.
   */
  append(kind: "stdout" | "stderr", data: Buffer): void {
    if (_terminated(this)) return;

    const text = data.toString("utf8");
    const byteLen = Buffer.byteLength(text, "utf8");

    this._totalBytesReceived += byteLen;
    if (kind === "stdout") this._stdoutBytes += byteLen;
    else this._stderrBytes += byteLen;

    if (this._totalBytesReceived > COMMAND_LIMITS.MAX_OUTPUT_BYTES) {
      this._truncated = true;
      // Stop accepting new data into buffer once we've exceeded max
      // (we've already counted the bytes for metadata)
      return;
    }

    const chunk: Chunk = { kind, text };

    // Try to fit in head region first
    if (this.headBytes < COMMAND_LIMITS.OUTPUT_HEAD_BYTES) {
      const remaining = COMMAND_LIMITS.OUTPUT_HEAD_BYTES - this.headBytes;
      if (byteLen <= remaining) {
        this.headChunks.push(chunk);
        this.headBytes += byteLen;
      } else {
        // Partial fit in head
        const headText = truncateToBytes(text, remaining);
        const tailText = text.slice(Buffer.byteLength(headText, "utf8") / 1); // rest to tail
        if (headText) {
          this.headChunks.push({ kind, text: headText });
          this.headBytes += Buffer.byteLength(headText, "utf8");
        }
        if (tailText) {
          this._appendToTail({ kind, text: tailText });
        }
      }
    } else {
      // Head region full — all new chunks go to tail
      this._appendToTail(chunk);
    }
  }

  private _appendToTail(chunk: Chunk): void {
    const byteLen = Buffer.byteLength(chunk.text, "utf8");
    this.tailChunks.push(chunk);
    this.tailBytes += byteLen;

    // Prune oldest tail chunks when tail exceeds limit
    while (this.tailBytes > COMMAND_LIMITS.OUTPUT_TAIL_BYTES && this.tailChunks.length > 0) {
      const oldest = this.tailChunks.shift()!;
      this.tailBytes -= Buffer.byteLength(oldest.text, "utf8");
    }
  }

  /**
   * Get the full retained text (head + omission marker + tail).
   * Safe for renderer display after ANSI stripping.
   */
  getText(): string {
    const headText = this.headChunks.map((c) => c.text).join("");
    const tailText = this.tailChunks.map((c) => c.text).join("");

    if (!this._truncated) {
      // No truncation — head contains everything (tail is empty or minimal overlap)
      return headText + tailText;
    }

    const omitted = this._totalBytesReceived - this.headBytes - this.tailBytes;
    const marker = omitted > 0
      ? `\n... <${formatBytes(omitted)} of output omitted> ...\n`
      : "\n... <output truncated> ...\n";

    return headText + marker + tailText;
  }

  /**
   * Get raw text (no ANSI stripping) for hash computation.
   */
  getRawText(): string {
    return this.getText();
  }

  /**
   * Compute SHA-256 of the sanitized model output.
   * Returns hex string.
   */
  computeOutputHash(): string {
    const sanitized = this.getSanitizedModelOutput();
    return createHash("sha256").update(sanitized, "utf8").digest("hex");
  }

  /**
   * Get metadata object for CommandExecution.outputMetadata.
   */
  getMetadata() {
    return {
      totalBytesReceived: this._totalBytesReceived,
      truncated: this._truncated,
      stdoutBytes: this._stdoutBytes,
      stderrBytes: this._stderrBytes,
      chunkCount: this.headChunks.length + this.tailChunks.length,
    };
  }

  /**
   * Get the sanitized, bounded output string for model consumption.
   * - ANSI and control chars stripped
   * - Secrets redacted via existing sanitizer
   * - Bounded to MAX_MODEL_OUTPUT_BYTES
   */
  getSanitizedModelOutput(): string {
    const raw = this.getText();
    const stripped = stripAnsiAndControlChars(raw);
    const redacted = redactSecrets(stripped);
    return truncateToBytes(redacted, COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _terminated(_buf: OutputBuffer): boolean {
  // Buffer itself doesn't track terminated state — caller decides when to stop appending
  return false;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes. */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  // Truncate at byte boundary — then find valid UTF-8 boundary
  const slice = buf.slice(0, maxBytes);
  return slice.toString("utf8").replace(/\uFFFD/g, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * sanitizeCommandOutputForModel — convenience wrapper.
 * Given raw combined output text, returns redacted + ANSI-stripped + bounded string.
 * Used when re-sanitizing historical output.
 */
export function sanitizeCommandOutputForModel(raw: string): string {
  const stripped = stripAnsiAndControlChars(raw);
  const redacted = redactSecrets(stripped);
  return truncateToBytes(redacted, COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES);
}