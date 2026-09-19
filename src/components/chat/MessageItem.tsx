import {
  memo,
  useState,
  useCallback,
  useMemo,
  createContext,
  useContext,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PluggableList } from "unified";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PLAIN_PLUGINS, useRehypePlugins } from "./useHighlight";
import { ToolCallCard } from "./ToolCallCard";
import { ImageViewer } from "./ImageViewer";
import { CodeBlock } from "./CodeBlock";
import { LazyDiffViewer as DiffViewer } from "./LazyDiffViewer";
import { MessageReactions } from "./MessageReactions";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

// react-markdown v9's sync `Markdown` component has NO internal memoization:
// every render calls createProcessor() (rebuilding the whole unified pipeline)
// and then parse() + runSync() over the entire document. These must be
// module-scoped constants — inline literals hand react-markdown a fresh plugin
// identity per render and defeat every cache downstream of it.
const REMARK_PLUGINS = [remarkGfm];

// Codex-style conversation blocks:
//   - user messages render as a right-aligned superellipse bubble whose
//     width is min(70%, 456px) of the thread viewport
//   - assistant messages render full-width without a bubble
// Hoisted: an inline style object is a new identity every render.
const USER_BUBBLE_STYLE: CSSProperties = {
  width: "fit-content",
  maxWidth: "min(70%, 456px)",
  // Superellipse-ish: bigger corner radius on the user side, smaller on the
  // side that faces the avatar, giving the Codex "squircle" look.
  borderRadius: "18px 18px 4px 18px",
};

const noopImageClick = () => {};

/** Per-message image-viewer opener.
 *
 *  The markdown `components` map below is a module-level constant so rendered
 *  trees can be cached and shared across messages. Anything instance-specific
 *  therefore has to arrive by context, not by closure — otherwise a cache hit
 *  would wire message B's thumbnail to message A's viewer. */
const ImageClickContext = createContext<(src: string, alt: string) => void>(noopImageClick);

function dispatchApplyCode(code: string, language?: string): void {
  // Dispatch a DOM event so the parent (App / session plumbing) can decide
  // how to apply the patch — e.g. via the agent or by writing files.
  window.dispatchEvent(new CustomEvent("grok:apply-code", { detail: { code, language } }));
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const onImageClick = useContext(ImageClickContext);
  return (
    <img
      src={typeof src === "string" ? src : ""}
      alt={alt || ""}
      className="my-2 max-h-48 cursor-pointer rounded-md"
      onClick={() => typeof src === "string" && onImageClick(src, alt || "")}
    />
  );
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  // Replace the default <pre> rendering with our enhanced CodeBlock.
  return <>{children}</>;
}

function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const match = /language-(\w+)/.exec(className || "");
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = match?.[1]?.toLowerCase();
  if (lang) {
    // Render unified-diff fences inline via DiffViewer.
    if (lang === "diff" || lang === "patch") return <InlineDiff diffText={text} />;
    return <CodeBlock code={text} language={lang} onApply={dispatchApplyCode} />;
  }
  // Unlabelled multi-line fences are prose-like code, without the rich toolbar.
  if (text.includes("\n")) {
    return (
      <pre className="overflow-x-auto rounded bg-black/25 p-3 font-mono text-[12px] text-gb-text">
        <code {...rest}>{children}</code>
      </pre>
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
}

/** Module constant — identity-stable, so it is safe to share cached trees. */
const MD_COMPONENTS = {
  img: MarkdownImage,
  pre: MarkdownPre,
  code: MarkdownCode,
} as never;

/** LRU of already-rendered markdown, keyed by exact source text.
 *
 *  Settled messages re-render constantly for reasons unrelated to their
 *  content: scrolling, toggling a reaction, opening the image viewer, a sibling
 *  message streaming. Each of those used to rebuild the unified processor and
 *  re-parse the whole document. Cached elements are pure (no per-instance
 *  closure state — see ImageClickContext), so sharing them is safe and React
 *  bails out of reconciling the subtree entirely. */
const MD_CACHE_LIMIT = 200;
const mdCache = new Map<string, ReactElement>();

function cachedMarkdown(key: string, build: () => ReactElement): ReactElement {
  const hit = mdCache.get(key);
  if (hit) {
    // Refresh recency (Map iterates in insertion order).
    mdCache.delete(key);
    mdCache.set(key, hit);
    return hit;
  }
  const el = build();
  mdCache.set(key, el);
  if (mdCache.size > MD_CACHE_LIMIT) {
    const oldest = mdCache.keys().next();
    if (!oldest.done) mdCache.delete(oldest.value);
  }
  return el;
}

/** Test-only hook: drop the rendered-markdown cache. */
export function __clearMarkdownCache(): void {
  mdCache.clear();
}

interface BodyProps {
  content: string;
  /** Empty until the deferred grammars load, and while the message streams. */
  plugins: PluggableList;
}

/** The markdown subtree, isolated so a parent state change (reactions, image
 *  viewer) can never trigger a re-parse. */
const MarkdownBody = memo(function MarkdownBody({ content, plugins }: BodyProps) {
  const [viewingImage, setViewingImage] = useState<{ src: string; alt: string } | null>(null);

  const handleImageClick = useCallback((src: string, alt: string) => {
    setViewingImage({ src, alt });
  }, []);
  const closeImage = useCallback(() => setViewingImage(null), []);

  // Streaming content is unique per flush, so it never hits the cache and would
  // only evict settled entries. The plugin set is part of the key because the
  // same source renders to a different tree once highlighting arrives.
  const cacheKey = `${content}\u0000${plugins === PLAIN_PLUGINS ? "p" : "h"}`;
  const tree = cachedMarkdown(cacheKey, () => (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={plugins}
      components={MD_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  ));

  return (
    <ImageClickContext.Provider value={handleImageClick}>
      <div className="prose prose-sm prose-invert max-w-none">{tree}</div>
      {viewingImage && (
        <ImageViewer src={viewingImage.src} alt={viewingImage.alt} onClose={closeImage} />
      )}
    </ImageClickContext.Provider>
  );
});

function MessageItemImpl({ message }: Props) {
  const isUser = message.role === "user";
  // Deferred grammars: empty until highlight.js finishes loading in the
  // background. While streaming we skip highlighting entirely — the growing
  // message re-renders on every ~50 ms flush, and re-highlighting its code
  // blocks was the dominant render cost. The settled render highlights.
  const available = useRehypePlugins();
  const plugins = message.streaming ? PLAIN_PLUGINS : available;

  if (message.role === "tool") return <ToolCallCard message={message} />;

  return (
    <div
      id={`msg-${message.id}`}
      className={`group flex gap-3 animate-fade-in ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      <div
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-medium ${
          isUser ? "bg-gb-accent text-gb-bg" : "bg-gb-surface-hover text-gb-text-secondary"
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
              ? "gb-user-bubble px-3.5 py-2 text-[14px] leading-relaxed text-gb-text"
              : "px-0 py-0 text-[14px] leading-relaxed text-gb-text"
          }
          style={isUser ? USER_BUBBLE_STYLE : undefined}
        >
          <MarkdownBody content={message.content || ""} plugins={plugins} />
          {message.streaming && (
            <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-gb-accent" />
          )}
          {!message.streaming && <MessageReactions message={message} />}
        </div>
      </div>
    </div>
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

/** Memoized: splitting + diffing is quadratic-ish, and a `diff` fence inside a
 *  streaming message used to be recomputed on every 50 ms flush. */
const InlineDiff = memo(function InlineDiff({ diffText }: { diffText: string }) {
  const { oldContent, newContent } = useMemo(() => splitUnifiedDiff(diffText), [diffText]);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-gb-border/10">
      <DiffViewer oldContent={oldContent} newContent={newContent} />
    </div>
  );
});
