/**
 * parseArgv.ts — Safe argument string parser for the terminal input.
 *
 * Splits a raw user string like `pnpm test --reporter=verbose` into
 * { executable, args }. Shell operators are rejected immediately — they
 * are never accepted, silently ignored, or stripped.
 */

/** Characters that are never allowed in the safe terminal input. */
const SHELL_OP_CHARS = /[|;&><`$(){}[\]*?\\]/;

export interface ParseArgvResult {
  ok: true;
  executable: string;
  args: string[];
}

export interface ParseArgvError {
  ok: false;
  errorMessage: string;
}

/**
 * Parse a raw command string into executable + args.
 *
 * Rules:
 * - Shell operators are rejected with a user-visible error
 * - Leading/trailing whitespace trimmed
 * - Empty input returns an error
 * - First token is the executable; remaining are args
 * - Quoted strings are split naively (no escape-sequence processing)
 */
export function parseArgv(raw: string): ParseArgvResult | ParseArgvError {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, errorMessage: "Please enter a command." };
  }

  if (SHELL_OP_CHARS.test(trimmed)) {
    const found = trimmed.match(SHELL_OP_CHARS)?.[0] ?? "";
    return {
      ok: false,
      errorMessage: `Shell operators are not allowed (found '${found}'). Use separate arguments instead.`,
    };
  }

  // Simple whitespace split — no shell quoting needed since operators are banned
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, errorMessage: "Please enter a command." };
  }

  const [executable, ...args] = tokens;

  if (!executable) {
    return { ok: false, errorMessage: "Please enter a command." };
  }

  return { ok: true, executable, args };
}