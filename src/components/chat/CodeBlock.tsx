import { useState, useCallback, useMemo } from "react";
import { writeText } from "../../lib/desktop";

interface CodeBlockProps {
  /** Raw code text (without fences). */
  code: string;
  /** Language tag from the ```lang fence. */
  language?: string;
  /** Optional: invoked when user clicks "Apply" — e.g. apply as a patch to cwd. */
  onApply?: (code: string, language?: string) => void;
}

/**
 * Codex-style code block: header with language label + line count + copy +
 * apply buttons; collapsible body with line numbers.
 */
export function CodeBlock({ code, language, onApply }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [applyState, setApplyState] = useState<"idle" | "applied" | "failed">("idle");

  const lines = useMemo(() => code.split("\n"), [code]);
  const lineCount = lines.length;
  const langLabel = language?.trim() || "text";

  const handleCopy = useCallback(async () => {
    try {
      await writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // Fall back to the web clipboard API when running outside Tauri.
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (e2) {
        console.error("copy failed:", e, e2);
      }
    }
  }, [code]);

  const handleApply = useCallback(() => {
    if (!onApply) return;
    try {
      onApply(code, language);
      setApplyState("applied");
      setTimeout(() => setApplyState("idle"), 2000);
    } catch (e) {
      console.error("apply failed:", e);
      setApplyState("failed");
      setTimeout(() => setApplyState("idle"), 2000);
    }
  }, [code, language, onApply]);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-gb-border/10 bg-gb-bg-secondary">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gb-border/8 bg-gb-surface/50 px-3 py-1.5">
        <span className="rounded bg-gb-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gb-accent">
          {langLabel}
        </span>
        <span className="text-[10px] text-gb-muted">{lineCount} lines</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="rounded px-1.5 py-0.5 text-[10px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            aria-label={collapsed ? "Expand code" : "Collapse code"}
          >
            {collapsed ? "▸ Expand" : "▾ Collapse"}
          </button>
          {onApply && (
            <button
              onClick={handleApply}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                applyState === "applied"
                  ? "text-gb-green"
                  : applyState === "failed"
                    ? "text-gb-red"
                    : "text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
              }`}
            >
              {applyState === "applied" ? "✓ Applied" : applyState === "failed" ? "✗ Failed" : "Apply"}
            </button>
          )}
          <button
            onClick={handleCopy}
            className="rounded px-1.5 py-0.5 text-[10px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            aria-label="复制代码"
          >
            {copied ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </div>

      {/* Body with line numbers */}
      {!collapsed && (
        <div className="overflow-x-auto">
          <pre className="flex text-[12px] leading-5">
            <span
              aria-hidden
              className="select-none border-r border-gb-border/8 bg-gb-bg-secondary px-2 py-2 text-right text-[10px] text-gb-muted/60"
            >
              {lines.map((_, i) => (
                <span key={i} className="block">
                  {i + 1}
                </span>
              ))}
            </span>
            <code className="flex-1 px-3 py-2 font-mono text-gb-text">{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
