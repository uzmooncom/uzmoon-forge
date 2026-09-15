import React from "react";
import { MarkdownContent } from "./MarkdownContent.js";

function TypingDots() {
  return (
    <div className="flex gap-1 items-center h-4">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

export function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3 py-2">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white mt-0.5">
        A
      </div>
      <div className="max-w-[75%] min-w-0 rounded-2xl rounded-tl-sm bg-[#1a1a26] border border-white/6 px-4 py-3 text-sm text-gray-100 leading-relaxed">
        {text ? <MarkdownContent content={text} /> : <TypingDots />}
      </div>
    </div>
  );
}