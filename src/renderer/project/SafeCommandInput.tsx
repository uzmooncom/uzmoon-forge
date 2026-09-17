/**
 * SafeCommandInput.tsx — Terminal command input bar.
 *
 * Validates input client-side (rejects shell operators) and calls onSubmit
 * with parsed executable + args. Never passes raw shell strings anywhere.
 */
import React, { useState, useRef } from "react";
import { parseArgv } from "../utils/parseArgv.js";

interface Props {
  projectId: string;
  onSubmit: (executable: string, args: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SafeCommandInput({ onSubmit, disabled, placeholder }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = parseArgv(value);
    if (!result.ok) {
      setError(result.errorMessage);
      return;
    }
    setError(null);
    setValue("");
    onSubmit(result.executable, result.args);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    // Clear error as user types
    if (error) setError(null);
  }

  return (
    <div className="flex flex-col gap-1">
      <form onSubmit={handleSubmit} className="flex gap-1.5">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 font-mono text-[12px] select-none pointer-events-none">
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleChange}
            disabled={disabled}
            placeholder={placeholder ?? "pnpm test  ·  node scripts/check.js  ·  python3 -m pytest"}
            className="w-full bg-[#0d0d12] border border-white/10 rounded-lg pl-6 pr-3 py-1.5 text-[12px] font-mono text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="px-3 py-1.5 rounded-lg bg-blue-600/70 hover:bg-blue-600 text-white text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
        >
          Run
        </button>
      </form>

      {error && (
        <p className="text-[11px] text-red-400/80 px-1">{error}</p>
      )}
    </div>
  );
}
