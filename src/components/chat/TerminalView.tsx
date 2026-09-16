import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface Props {
  content: string;
}

const BASE_FONT_SIZE = 13;
const MIN_FONT = 8;
const MAX_FONT = 28;

export function TerminalView({ content }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [fontSize, setFontSize] = useState(BASE_FONT_SIZE);

  // Cmd/Ctrl+= / Cmd/Ctrl+- to zoom the terminal font. Pure state update;
  // the xterm mutation happens in a separate effect that watches fontSize.
  const handleZoom = useCallback((delta: number) => {
    setFontSize((prev) => Math.min(MAX_FONT, Math.max(MIN_FONT, prev + delta)));
  }, []);

  // Apply fontSize changes to the live xterm instance, then refit.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* noop */
    }
  }, [fontSize]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: true,
      fontSize,
      fontFamily: "SF Mono, Monaco, Menlo, monospace",
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
      },
      disableStdin: true,
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    if (content) {
      term.write(content);
    }

    termRef.current = term;
    fitRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    // Track Cmd/Ctrl +/- zoom while the terminal is focused.
    const keyHandler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        handleZoom(1);
      } else if (e.key === "-") {
        e.preventDefault();
        handleZoom(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        setFontSize(BASE_FONT_SIZE);
        if (termRef.current) {
          termRef.current.options.fontSize = BASE_FONT_SIZE;
          try {
            fitRef.current?.fit();
          } catch {
            /* noop */
          }
        }
      }
    };
    containerRef.current.addEventListener("keydown", keyHandler);
    containerRef.current.tabIndex = 0; // make focusable for key events

    return () => {
      resizeObserver.disconnect();
      containerRef.current?.removeEventListener("keydown", keyHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Re-creating the terminal per content dump is intentional: we render
    // historical output, not an interactive session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-48 w-full overflow-hidden rounded outline-none" />
      <div className="absolute right-1 top-1 flex gap-0.5 rounded bg-black/50 px-1 py-0.5 text-[9px] text-white/70">
        <button
          onClick={() => handleZoom(-1)}
          className="rounded px-1 hover:bg-white/10"
          aria-label="Zoom out terminal font"
          title="Zoom out (⌘-)"
        >
          A−
        </button>
        <span className="px-0.5 tabular-nums">{fontSize}px</span>
        <button
          onClick={() => handleZoom(1)}
          className="rounded px-1 hover:bg-white/10"
          aria-label="Zoom in terminal font"
          title="Zoom in (⌘=)"
        >
          A+
        </button>
      </div>
    </div>
  );
}
