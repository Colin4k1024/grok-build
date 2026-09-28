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

// One shared observer for every terminal card. Each card used to own a
// ResizeObserver, so a thread with N bash calls refit N xterm instances on
// every layout shift — each refit forces a synchronous measure.
let sharedResizeObserver: ResizeObserver | null = null;
const resizeTargets = new WeakMap<Element, () => void>();

function observeResize(el: Element, onResize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cb = resizeTargets.get(entry.target);
        if (cb) {
          try {
            cb();
          } catch {
            /* a fit() during teardown is harmless */
          }
        }
      }
    });
  }
  resizeTargets.set(el, onResize);
  sharedResizeObserver.observe(el);
  return () => {
    resizeTargets.delete(el);
    sharedResizeObserver?.unobserve(el);
  };
}

/** True while the card is near the viewport.
 *
 *  xterm allocates a real terminal (1000-line scrollback, DOM renderer, canvas
 *  measurement) per instance. With the message window at 150 items, a
 *  bash-heavy thread held dozens of live terminals that were all off-screen.
 *  Cards now mount their terminal on approach and dispose it on departure. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(
    // No IntersectionObserver (jsdom / older runtimes): stay always-mounted so
    // behaviour is unchanged rather than silently blank.
    () => typeof IntersectionObserver === "undefined"
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setNear(e.isIntersecting);
      },
      // Generous margin: the terminal is ready before it scrolls into view.
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return near;
}

export function TerminalView({ content }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Content already written into the live instance, so a content change can
   *  append instead of tearing the whole terminal down. */
  const writtenRef = useRef("");
  const [fontSize, setFontSize] = useState(BASE_FONT_SIZE);
  const near = useNearViewport(hostRef);

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
  }, [fontSize, near]);

  // Create/destroy the terminal with visibility, not with every content dump.
  useEffect(() => {
    if (!near) return;
    const host = containerRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontSize,
      fontFamily: "SF Mono, Monaco, Menlo, monospace",
      theme: {
        // Codex TUI terminal colors — neutral #1c1c1c, not GitHub dark.
        background: "#1c1c1c",
        foreground: "#d6d6d6",
        cursor: "#d6d6d6",
      },
      disableStdin: true,
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try {
      fitAddon.fit();
    } catch {
      /* host has no layout yet — the resize observer refits */
    }

    termRef.current = term;
    fitRef.current = fitAddon;
    writtenRef.current = "";

    const unobserve = observeResize(host, () => fitAddon.fit());

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
    host.addEventListener("keydown", keyHandler);
    host.tabIndex = 0; // make focusable for key events

    return () => {
      unobserve();
      host.removeEventListener("keydown", keyHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = "";
    };
    // fontSize is applied by the effect above; recreating the terminal on a
    // zoom would throw away the scrollback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, handleZoom]);

  // Feed content into the live instance. Append-only growth (the common case
  // for a streaming tool result) writes just the new suffix; anything else
  // resets and rewrites.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !near) return;
    const written = writtenRef.current;
    if (content === written) return;
    if (written && content.startsWith(written)) {
      term.write(content.slice(written.length));
    } else {
      term.reset();
      term.write(content);
    }
    writtenRef.current = content;
  }, [content, near]);

  return (
    <div className="relative" ref={hostRef}>
      <div ref={containerRef} className="h-48 w-full overflow-hidden rounded outline-none" />
      {/* Off-screen placeholder keeps the zoom affordance without an xterm. */}
      {!near && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-[#1c1c1c] text-[10px] text-white/25">
          终端输出
        </div>
      )}
      <div className="absolute right-1 top-1 flex gap-0.5 rounded bg-black/50 px-1 py-0.5 text-[9px] text-white/70">
        <button
          onClick={() => handleZoom(-1)}
          className="rounded px-1 hover:bg-white/10"
          aria-label="缩小终端字体"
          title="缩小 (⌘-)"
        >
          A−
        </button>
        <span className="px-0.5 tabular-nums">{fontSize}px</span>
        <button
          onClick={() => handleZoom(1)}
          className="rounded px-1 hover:bg-white/10"
          aria-label="放大终端字体"
          title="放大 (⌘=)"
        >
          A+
        </button>
      </div>
    </div>
  );
}
