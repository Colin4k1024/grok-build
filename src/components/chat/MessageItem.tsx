import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props {
  message: ChatMessage;
}

export function MessageItem({ message }: Props) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    return (
      <div className="my-2 rounded border border-gb-border bg-gb-surface/50 p-3">
        <div className="flex items-center gap-2 text-xs text-gb-muted">
          <span className="font-mono">🔧 {message.toolName || "tool"}</span>
          {message.toolSuccess === false && (
            <span className="text-gb-red">✗ failed</span>
          )}
          {message.toolSuccess === true && (
            <span className="text-gb-green">✓</span>
          )}
        </div>
        {message.content && (
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-gb-bg p-2 text-xs text-gb-muted">
            <code>{message.content}</code>
          </pre>
        )}
      </div>
    );
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
