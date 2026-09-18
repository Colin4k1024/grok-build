import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { PtySession } from "../../lib/tauri";

interface Props {
  session: PtySession;
  onClosed: (exitCode: number) => void;
}

/**
 * Live xterm.js view over a ptyctl WebSocket session (ISS-075, ADR 0002).
 * Protocol: binary frames carry raw PTY bytes both ways; text frames from
 * the server are JSON control messages ({"type":"closed"} on exit). Resize
 * rides the same socket as {"type":"resize","cols":N,"rows":N}.
 */
export function InteractiveTerminal({ session, onClosed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(13);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);

  const handleZoom = useCallback((delta: number) => {
    setFontSize((prev) => Math.min(28, Math.max(8, prev + delta)));
  }, []);

  useEffect(() => {
    termRef.current?.options.fontSize !== undefined &&
      (termRef.current.options.fontSize = fontSize);
    try {
      fitRef.current?.fit();
    } catch {
      /* pre-mount */
    }
  }, [fontSize]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: false, // the PTY speaks CRLF itself
      fontSize,
      fontFamily: "SF Mono, Monaco, Menlo, monospace",
      theme: {
        background: "#1c1c1c",
        foreground: "#d6d6d6",
        cursor: "#d6d6d6",
      },
      scrollback: 5000,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    const ws = new WebSocket(`ws://127.0.0.1:${session.port}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      const sendResize = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      };
      sendResize();
      (ws as WebSocket & { _sendResize?: () => void })._sendResize = sendResize;
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { type?: string; exit_code?: number };
          if (msg.type === "closed") {
            setExitCode(msg.exit_code ?? 0);
            onClosed(msg.exit_code ?? 0);
          }
        } catch {
          /* ignore malformed control frames */
        }
        return;
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => {
      setConnected(false);
    };
    ws.onerror = () => setConnected(false);

    // Keystrokes → PTY as raw binary frames.
    const dataHook = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        (ws as WebSocket & { _sendResize?: () => void })._sendResize?.();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

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
        setFontSize(13);
      }
    };
    containerRef.current.addEventListener("keydown", keyHandler);
    containerRef.current.tabIndex = 0;

    return () => {
      resizeObserver.disconnect();
      containerRef.current?.removeEventListener("keydown", keyHandler);
      dataHook.dispose();
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // One session per mount — restarting remounts with a fresh session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <div className="relative h-full">
      <div ref={containerRef} className="h-full w-full overflow-hidden rounded outline-none" />
      <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-black/50 px-1 py-0.5 text-[9px] text-white/70">
        <button onClick={() => handleZoom(-1)} className="rounded px-1 hover:bg-white/10" title="缩小 (⌘-)">A−</button>
        <span className="px-0.5 tabular-nums">{fontSize}px</span>
        <button onClick={() => handleZoom(1)} className="rounded px-1 hover:bg-white/10" title="放大 (⌘=)">A+</button>
      </div>
      {exitCode !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[10px] text-gb-muted">
          会话已结束（exit {exitCode}）— 点击 Restart 重开
        </div>
      )}
      {exitCode === null && !connected && (
        <div className="pointer-events-none absolute right-1 bottom-1 rounded bg-gb-yellow/20 px-1.5 py-0.5 text-[9px] text-gb-yellow">
          连接中…
        </div>
      )}
    </div>
  );
}
