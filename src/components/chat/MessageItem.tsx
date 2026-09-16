import { memo, useState, useCallback, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ToolCallCard } from "./ToolCallCard";
import { ImageViewer } from "./ImageViewer";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "./DiffViewer";
import { MessageReactions } from "./MessageReactions";
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

  // Codex-style conversation blocks:
  //   - user messages render as a right-aligned superellipse bubble whose
  //     width is min(70%, 456px) of the thread viewport
  //   - assistant messages render full-width without a bubble
  const userBubbleStyle: CSSProperties = {
    width: "fit-content",
    maxWidth: "min(70%, 456px)",
    // Superellipse-ish: bigger corner radius on the user side, smaller on
    // the side that faces the avatar, giving the Codex "squircle" look.
    borderRadius: "18px 18px 4px 18px",
  };

  return (
    <>
      <div
        id={`msg-${message.id}`}
        className={`group flex gap-3 animate-fade-in ${isUser ? "flex-row-reverse" : "flex-row"}`}
      >
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-medium ${
            isUser
              ? "bg-gb-accent text-white"
              : "bg-gb-surface-hover text-gb-text-secondary"
          }`}
        >
          {isUser ? "U" : "G"}
        </div>
        <div
          className={isUser ? "flex justify-end" : "flex-1 min-w-0"}
          style={isUser ? { flex: "1 1 0%", minWidth: 0 } : undefined}
        >
          <div
            className={
              isUser
                ? "bg-gb-surface px-3.5 py-2 text-[13px] leading-relaxed text-gb-text"
                : "px-0 py-0 text-[13px] leading-relaxed text-gb-text"
            }
            style={isUser ? userBubbleStyle : undefined}
          >
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
                    const lang = match?.[1]?.toLowerCase();
                    const isBlock = Boolean(match) || text.includes("\n");
                    if (isBlock) {
                      // Render unified-diff fences inline via DiffViewer.
                      if (lang === "diff" || lang === "patch") {
                        return <InlineDiff diffText={text} />;
                      }
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
            {message.streaming && (
              <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-gb-accent" />
            )}
            {!message.streaming && <MessageReactions message={message} />}
          </div>
        </div>
      </div>
      {viewingImage && (
        <ImageViewer
          src={viewingImage.src}
          alt={viewingImage.alt}
          onClose={() => setViewingImage(null)}
        />
      )}
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);

/** Split a unified diff into "before" and "after" buffers so we can feed
 *  DiffViewer. Handles the standard - / + / space line prefixes; headers
 *  (diff/---/+++/@@) are stripped. */
function splitUnifiedDiff(diffText: string): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("@@")) {
      continue;
    }
    if (raw.startsWith("-")) {
      oldLines.push(raw.slice(1));
    } else if (raw.startsWith("+")) {
      newLines.push(raw.slice(1));
    } else if (raw.startsWith(" ")) {
      const line = raw.slice(1);
      oldLines.push(line);
      newLines.push(line);
    } else if (raw.trim() === "") {
      oldLines.push("");
      newLines.push("");
    }
  }
  return { oldContent: oldLines.join("\n"), newContent: newLines.join("\n") };
}

function InlineDiff({ diffText }: { diffText: string }) {
  const { oldContent, newContent } = splitUnifiedDiff(diffText);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-gb-border/10">
      <DiffViewer oldContent={oldContent} newContent={newContent} />
    </div>
  );
}
