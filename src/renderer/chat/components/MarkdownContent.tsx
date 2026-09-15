import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyCodeBlock } from "./CopyCodeBlock.js";

const MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <CopyCodeBlock>{children}</CopyCodeBlock>
  ),
  code: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="bg-white/10 rounded px-1 py-0.5 text-[11px] text-blue-300 font-mono">
        {children}
      </code>
    ),
  a: ({
    href,
    children,
  }: {
    href?: string;
    children?: React.ReactNode;
  }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
    >
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse w-full text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-white/10 px-2 py-1.5 text-left font-semibold bg-white/5">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-white/10 px-2 py-1">{children}</td>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-blue-500/40 pl-3 my-2 text-white/60 italic">
      {children}
    </blockquote>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1.5">{children}</ol>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-base font-bold mt-3 mb-1 border-b border-white/10 pb-1">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-sm font-bold mt-2.5 mb-1 text-white/90">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-semibold mt-2 mb-0.5 text-white/80">
      {children}
    </h3>
  ),
  hr: () => <hr className="border-white/10 my-3" />,
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1 leading-relaxed">{children}</p>
  ),
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose-custom">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={MD_COMPONENTS as Record<string, unknown>}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}