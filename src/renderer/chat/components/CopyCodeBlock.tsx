import React, { useState, useRef, useMemo } from "react";
import { CopyIcon, CheckIcon } from "../icons.js";

export function CopyCodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Extract language label from child code element's className
  const lang = useMemo(() => {
    const arr = React.Children.toArray(children);
    const el = arr.find(
      (c): c is React.ReactElement =>
        React.isValidElement(c) && c.type === "code"
    );
    if (!el) return null;
    const cls: string = (el.props as { className?: string }).className ?? "";
    const match = /language-(\w+)/.exec(cls);
    return match ? match[1] : null;
  }, [children]);

  const handle = () => {
    const text = preRef.current?.textContent ?? "";
    window.forgeApi.copyText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="relative group/code my-2">
      {lang && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-[#0d0d14] rounded-t-xl border border-b-0 border-white/8">
          <span className="text-[10px] text-white/30 font-mono uppercase tracking-widest">
            {lang}
          </span>
          <button
            onClick={handle}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/70 transition-colors"
          >
            {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
      <pre
        ref={preRef}
        className={`overflow-x-auto text-[12px] !bg-[#0d0d14] border border-white/8 p-4 leading-relaxed ${
          lang
            ? "rounded-b-xl rounded-t-none !pt-3 pr-4"
            : "rounded-xl pr-16"
        }`}
      >
        {children}
      </pre>
      {!lang && (
        <button
          onClick={handle}
          className="absolute top-2.5 right-2.5 flex items-center gap-1 text-[10px] text-white/35 hover:text-white/80 bg-white/5 hover:bg-white/12 border border-white/8 px-2 py-1 rounded-md transition-all"
        >
          {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
          {copied ? "Copied!" : "Copy"}
        </button>
      )}
    </div>
  );
}