import { memo } from "react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ToolCallCard } from "./ToolCallCard";
import { ImageViewer } from "./ImageViewer";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props {
  message: ChatMessage;
}

function MessageItemImpl({ message }: Props) {
  const [viewingImage, setViewingImage] = useState<{ src: string; alt: string } | null>(null);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    return <ToolCallCard message={message} />;
  }

  return (
    <>
      <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[85%] rounded-lg px-4 py-2 ${
            isUser ? "bg-gb-accent text-white" : "bg-gb-surface text-gb-text"
          }`}
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
                    className="my-2 max-h-48 cursor-pointer rounded-lg border border-gb-border"
                    onClick={() =>
                      typeof src === "string" &&
                      setViewingImage({ src, alt: alt || "" })
                    }
                  />
                ),
              }}
            >
              {message.content || ""}
            </ReactMarkdown>
          </div>
          {message.streaming && (
            <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-gb-accent" />
          )}
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
