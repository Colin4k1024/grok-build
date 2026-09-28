import { useSyncExternalStore } from "react";
import type { PluggableList } from "unified";

/**
 * Deferred syntax highlighting.
 *
 * `rehype-highlight` drags in highlight.js — ~377 KB of the renderer bundle,
 * the single largest dependency — and it was parsed before the first message
 * could paint. Highlighting is a pure progressive enhancement (the app already
 * skips it while a message is streaming), so the grammar set now loads in the
 * background and messages upgrade in place once it lands.
 */

/** Shared empty list — identity-stable so react-markdown keeps its caches. */
export const PLAIN_PLUGINS: PluggableList = [];

let highlightPlugins: PluggableList | null = null;
let requested = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return highlightPlugins !== null;
}

/** Start the dynamic import once, scheduled so it never competes with the
 *  first paint. Safe to call from every mount. */
export function requestHighlight(): void {
  if (requested) return;
  requested = true;

  const load = () => {
    import("rehype-highlight")
      .then((m) => {
        highlightPlugins = [m.default as never];
        emit();
      })
      .catch(() => {
        // Cosmetic only — stay unhighlighted rather than surfacing an error.
      });
  };

  const ric = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }
  ).requestIdleCallback;
  if (typeof ric === "function") ric(load, { timeout: 3000 });
  else setTimeout(load, 600);
}

/** The rehype plugin list to render with: empty until the grammars load. */
export function useRehypePlugins(): PluggableList {
  const ready = useSyncExternalStore(subscribe, getSnapshot, () => false);
  return ready && highlightPlugins ? highlightPlugins : PLAIN_PLUGINS;
}

/** Test-only: reset the deferred-highlight module state. */
export function __resetHighlight(): void {
  highlightPlugins = null;
  requested = false;
  listeners.clear();
}
