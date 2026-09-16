import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ToolCallCard } from "./ToolCallCard";
import { ImageViewer } from "./ImageViewer";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

function MessageItemImpl({ message }: Props) {
  const [viewingImage, setViewingImage] = useState<{ src: string; alt: string } | null>(null);
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

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
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                components={{ img: ({ src, alt }) => <img src={typeof src === "string" ? src : ""} alt={alt || ""} className="my-2 max-h-48 cursor-pointer rounded-md" onClick={() => typeof src === "string" && setViewingImage({ src, alt: alt || "" })} /> }}>
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
