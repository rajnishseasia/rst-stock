"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Render an assistant chat message as markdown.
 *
 * The chat backend streams plain markdown (the models output `**bold**`,
 * numbered lists, fenced code blocks, GFM tables, etc.) - previously rendered
 * as `whitespace-pre-wrap` so the user saw the literal asterisks. Citation
 * tokens like `[F1]` / `[N2]` are emitted as plain text and render naturally
 * inside paragraphs without needing custom handling.
 *
 * Memoized because streaming re-renders this on every delta; keeping the
 * markdown AST stable when the content prop hasn't changed avoids reparsing
 * the entire message on each token.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("chat-markdown text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The chat bubble already controls font color / size - let nested
          // elements inherit and only add layout/typography differences.
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => (
            <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          // Inline `code` vs fenced ```code``` - react-markdown 9+ no longer
          // passes `inline`; detect by absence of a newline in the children.
          code: ({ children, className: codeClassName }) => {
            const value = String(children ?? "");
            const isBlock = value.includes("\n") || (codeClassName ?? "").startsWith("language-");
            if (isBlock) {
              return (
                <pre className="my-2 overflow-x-auto rounded-md bg-background/60 p-3 font-mono text-xs leading-relaxed">
                  <code>{value.replace(/\n$/, "")}</code>
                </pre>
              );
            }
            return (
              <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                {value}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b">{children}</thead>,
          th: ({ children }) => (
            <th className="px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border/40 px-2 py-1">{children}</td>,
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
