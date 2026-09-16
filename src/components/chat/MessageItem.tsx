import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ToolCallCard } from "./ToolCallCard";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props {
  message: ChatMessage;
}

export function MessageItem({ message }: Props) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    return <ToolCallCard message={message} />;
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-2 ${
          isUser
            ? "bg-gb-accent text-white"
            : "bg-gb-surface text-gb-text"
        }`}
      >
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content || ""}
          </ReactMarkdown>
        </div>
        {message.streaming && (
          <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-gb-accent" />
        )}
      </div>
    </div>
  );
}
