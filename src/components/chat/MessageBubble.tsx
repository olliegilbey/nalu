"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "@/i18n";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex w-full justify-end animate-message-in">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-wave-blue-2 text-foreground px-3.5 py-2 text-[15px] leading-relaxed">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full animate-message-in">
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="h-1 w-1 rounded-full bg-sakura-pink"
          style={{ background: "var(--sakura-pink)" }}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
          {t<string>("app.name")}
        </span>
      </div>
      <div
        className="prose prose-invert prose-sm max-w-none text-[15px] leading-[1.65]
        prose-p:my-2 prose-p:text-foreground/90
        prose-headings:font-medium prose-headings:tracking-tight prose-headings:text-foreground
        prose-h1:text-[20px] prose-h1:mt-4 prose-h1:mb-2
        prose-h2:text-[17px] prose-h2:mt-4 prose-h2:mb-2
        prose-h3:text-[15px] prose-h3:mt-3 prose-h3:mb-1.5 prose-h3:text-fuji-gray prose-h3:uppercase prose-h3:tracking-wider prose-h3:font-mono prose-h3:text-[12px]
        prose-strong:text-foreground prose-strong:font-medium
        prose-em:text-foreground/85
        prose-a:text-crystal prose-a:no-underline hover:prose-a:underline
        prose-code:font-mono prose-code:text-[0.86em] prose-code:text-carp prose-code:bg-sumi-3 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-sumi-2 prose-pre:border prose-pre:border-sumi-4 prose-pre:text-foreground/90 prose-pre:rounded-xl prose-pre:p-3 prose-pre:my-3
        prose-pre:prose-code:bg-transparent prose-pre:prose-code:text-foreground/90 prose-pre:prose-code:p-0
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:text-foreground/85 prose-li:marker:text-fuji-gray
        prose-hr:my-4 prose-hr:border-sumi-4
        prose-blockquote:border-l-2 prose-blockquote:border-sakura-pink/60 prose-blockquote:text-foreground/80 prose-blockquote:not-italic prose-blockquote:pl-3 prose-blockquote:my-3
        prose-table:my-3 prose-table:text-[13px]
        prose-th:text-left prose-th:font-medium prose-th:text-foreground prose-th:border-b prose-th:border-sumi-4 prose-th:px-2 prose-th:py-1.5
        prose-td:px-2 prose-td:py-1.5 prose-td:border-b prose-td:border-sumi-4/60 prose-td:text-foreground/85
        prose-img:rounded-xl prose-img:border prose-img:border-sumi-4"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            input: (props) =>
              props.type === "checkbox" ? (
                <input
                  {...props}
                  disabled
                  className="mr-1.5 h-3 w-3 rounded-sm align-middle accent-[var(--crystal-blue)]"
                />
              ) : (
                <input {...props} />
              ),
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export function TypingBubble() {
  return (
    <div className="w-full animate-message-in">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="h-1 w-1 rounded-full" style={{ background: "var(--sakura-pink)" }} />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
          {t<string>("app.name")}
        </span>
      </div>
      <WaveSpinner />
    </div>
  );
}

function WaveSpinner() {
  // Two curling wave "swooshes" with foam tips, arranged yin-yang style.
  // Each swoosh: a J-shaped arc + a foam droplet at its crest.
  return (
    <div className="flex items-center h-7" aria-label="nalu is thinking" role="status">
      <svg
        viewBox="0 0 40 40"
        className="h-7 w-7 wave-spin"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
      >
        {/* Wave 1 — crystal blue: arcs from lower-left up to a curling crest on the right */}
        <path
          d="M6 30 C 6 14, 16 6, 28 10"
          stroke="var(--crystal-blue)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <path
          d="M28 10 C 32 11.5, 32 16, 28 16"
          stroke="var(--crystal-blue)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx="26.5" cy="16" r="1.6" fill="var(--crystal-blue)" />

        {/* Wave 2 — sakura pink: mirrored 180° */}
        <g transform="rotate(180 20 20)">
          <path
            d="M6 30 C 6 14, 16 6, 28 10"
            stroke="var(--sakura-pink)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <path
            d="M28 10 C 32 11.5, 32 16, 28 16"
            stroke="var(--sakura-pink)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <circle cx="26.5" cy="16" r="1.6" fill="var(--sakura-pink)" />
        </g>
      </svg>
    </div>
  );
}
