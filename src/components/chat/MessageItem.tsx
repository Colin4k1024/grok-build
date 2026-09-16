import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ToolCallCard } from "./ToolCallCard";
import { ImageViewer } from "./ImageViewer";
import { CodeBlock } from "./CodeBlock";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

function MessageItemImpl({ message }: Props) {
  const [viewingImage, setViewingImage] = useState<{ src: string; alt: string } | null>(null);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  const handleApplyCode = useCallback((code: string, language?: string) => {
    // Dispatch a DOM event so the parent (App / session plumbing) can decide
    // how to apply the patch — e.g. via the agent or by writing files.
    window.dispatchEvent(
      new CustomEvent("grok:apply-code", { detail: { code, language } })
    );
  }, []);

  if (isTool) return <ToolCallCard message={message} />;

  return (
    <>
      <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"} animate-fade-in`}>
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-medium ${isUser ? "bg-gb-accent text-white" : "bg-gb-surface-hover text-gb-text-secondary"}`}>
          {isUser ? "U" : "G"}
        </div>
        <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
          <div className={`rounded-lg px-3.5 py-2 text-[13px] leading-relaxed ${isUser ? "bg-gb-surface text-gb-text" : "text-gb-text"}`}>
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  img: ({ src, alt }) => (
                    <img
                      src={typeof src === "string" ? src : ""}
                      alt={alt || ""}
                      className="my-2 max-h-48 cursor-pointer rounded-md"
                      onClick={() =>
                        typeof src === "string" && setViewingImage({ src, alt: alt || "" })
                      }
                    />
                  ),
                  // Replace the default <pre> rendering with our enhanced CodeBlock.
                  pre: ({ children }) => <>{children}</>,
                  code: ({ className, children, ...rest }) => {
                    const match = /language-(\w+)/.exec(className || "");
                    const text = String(children ?? "").replace(/\n$/, "");
                    const isBlock = Boolean(match) || text.includes("\n");
                    if (isBlock) {
                      return (
                        <CodeBlock
                          code={text}
                          language={match?.[1]}
                          onApply={handleApplyCode}
                        />
                      );
                    }
                    return (
                      <code
                        className="rounded bg-gb-bg-secondary px-1 py-0.5 font-mono text-[12px] text-gb-accent"
                        {...rest}
                      >
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {message.content || ""}
              </ReactMarkdown>
            </div>
            {message.streaming && <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-gb-accent" />}
          </div>
        </div>
      </div>
      {viewingImage && <ImageViewer src={viewingImage.src} alt={viewingImage.alt} onClose={() => setViewingImage(null)} />}
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);
