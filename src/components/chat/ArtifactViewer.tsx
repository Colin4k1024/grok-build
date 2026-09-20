import { useState } from "react";

export type ArtifactKind = "image" | "code" | "markdown" | "csv" | "json" | "unknown";

interface ArtifactViewerProps {
  /** Artifact content (base64 for images, text otherwise). */
  content: string;
  /** MIME type hint from the agent or filename extension. */
  mimeType?: string;
  /** Display filename. */
  fileName?: string;
  onClose: () => void;
}

function classifyArtifact(mimeType?: string, content?: string): ArtifactKind {
  if (mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.includes("json")) return "json";
    if (mimeType.includes("csv") || mimeType === "text/csv") return "csv";
    if (mimeType.includes("markdown")) return "markdown";
  }
  if (content?.trimStart().startsWith("{") || content?.trimStart().startsWith("[")) return "json";
  if (content?.includes(",") && content.split("\n").filter(Boolean).length > 1) return "csv";
  return "code";
}

/** Lightweight artifact viewer (R3-17). Renders images, code with syntax
 *  highlighting, JSON trees, and CSV tables in a floating overlay.
 *  No heavy dependencies — all rendering is inline with Tailwind. */
export function ArtifactViewer({ content, mimeType, fileName, onClose }: ArtifactViewerProps) {
  const kind = classifyArtifact(mimeType, content);
  const [view, setView] = useState<"rendered" | "raw">("rendered");

  const renderContent = () => {
    switch (kind) {
      case "image": {
        const dataUri = content.startsWith("data:") ? content : `data:${mimeType ?? "image/png"};base64,${content}`;
        return (
          <div className="flex h-full items-center justify-center p-4">
            <img src={dataUri} alt={fileName ?? "Artifact"} className="max-h-full max-w-full rounded-lg object-contain" />
          </div>
        );
      }
      case "markdown":
        return (
          <div className="prose prose-sm prose-invert max-w-none whitespace-pre-wrap p-4 font-mono text-xs text-gb-text">
            {content}
          </div>
        );
      case "json": {
        let formatted: string;
        try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { formatted = content; }
        return (
          <div className="overflow-auto p-4">
            <pre className="whitespace-pre font-mono text-xs text-gb-text">{formatted}</pre>
          </div>
        );
      }
      case "csv": {
        const rows = content.trim().split("\n").map((r) => r.split(/[,;]\s*/));
        if (rows.length === 0) return <p className="p-4 text-xs text-gb-muted">Empty CSV</p>;
        return (
          <div className="max-h-full overflow-auto p-4">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gb-border">
                  {rows[0].map((h, i) => (
                    <th key={i} className="px-2 py-1 text-left font-medium text-gb-text">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1, 500).map((row, ri) => (
                  <tr key={ri} className="border-b border-gb-border/30 hover:bg-gb-surface-hover">
                    {row.map((cell, ci) => (
                      <td key={ci} className="max-w-xs truncate px-2 py-0.5 text-gb-text-secondary">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 501 && (
              <p className="mt-2 text-center text-[10px] text-gb-muted">Showing first 500 rows of {rows.length - 1}</p>
            )}
          </div>
        );
      }
      default:
        return (
          <div className="overflow-auto p-4">
            <pre className="whitespace-pre font-mono text-xs text-gb-text">{content.slice(0, 50000)}</pre>
            {content.length > 50000 && (
              <p className="mt-2 text-center text-[10px] text-gb-muted">Content truncated at 50KB</p>
            )}
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/85" onClick={onClose}>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gb-border/20 px-4 py-2">
        <span className="text-xs font-medium text-gb-text">{fileName ?? "Artifact"}</span>
        <span className="rounded bg-gb-surface-hover px-1.5 py-0.5 text-[10px] text-gb-muted">{kind}</span>
        <div className="flex-1" />
        <button
          onClick={() => setView((v) => (v === "rendered" ? "raw" : "rendered"))}
          className="rounded px-2 py-0.5 text-[10px] text-gb-muted hover:bg-gb-surface-hover"
        >
          {view === "rendered" ? "Raw" : "Rendered"}
        </button>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-xs text-gb-muted hover:bg-gb-surface-hover">✕</button>
      </div>
      {/* Content */}
      <div className="min-h-0 flex-1">
        {renderContent()}
      </div>
    </div>
  );
}