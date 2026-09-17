import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";

export interface ShortcutHandlers {
  onNewSession: () => void;
  onCloseActiveThread: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onAddProject: () => void;
  onToggleTerminal: () => void;
}

interface ShortcutDef {
  id: string;
  /** Human-readable combo for the cheat sheet, e.g. "⌘B". */
  combo: string;
  test: (e: KeyboardEvent) => boolean;
  run: (e: KeyboardEvent) => void;
}

/**
 * Codex-aligned keyboard map, registry-driven so the ⌘/ cheat sheet and the
 * handlers can never drift:
 *   ⌘N/⌘⇧O new · ⌘W close · ⌘1-9 jump to thread · ⌘B sidebar ·
 *   ⌘J terminal · ⌘O add project · ⌘G search · ⌘, settings ·
 *   ⌘⇧[/⌘⇧] cycle threads (registered in App) · ⌘K/⌘⇧P palette (palette)
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

    const shortcuts: ShortcutDef[] = [
      { id: "new", combo: "⌘N / ⌘⇧O", test: (e) => mod(e) && e.key.toLowerCase() === "n", run: () => handlers.onNewSession() },
      { id: "new-alt", combo: "⌘N / ⌘⇧O", test: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "o", run: () => handlers.onNewSession() },
      { id: "close", combo: "⌘W", test: (e) => mod(e) && e.key.toLowerCase() === "w", run: () => handlers.onCloseActiveThread() },
      { id: "sidebar", combo: "⌘B", test: (e) => mod(e) && e.key.toLowerCase() === "b", run: () => handlers.onToggleSidebar() },
      { id: "terminal", combo: "⌘J", test: (e) => mod(e) && e.key.toLowerCase() === "j", run: () => handlers.onToggleTerminal() },
      { id: "project", combo: "⌘O", test: (e) => mod(e) && e.key.toLowerCase() === "o", run: () => handlers.onAddProject() },
      { id: "search", combo: "⌘G", test: (e) => mod(e) && e.key.toLowerCase() === "g", run: () => handlers.onOpenSearch() },
      { id: "settings", combo: "⌘,", test: (e) => mod(e) && e.key === ",", run: () => handlers.onOpenSettings() },
      {
        id: "jump", combo: "⌘1-9",
        test: (e) => mod(e) && /^[1-9]$/.test(e.key),
        run: (e) => {
          const num = parseInt(e.key, 10);
          const tab = useSessionStore.getState().tabs[num - 1];
          if (tab) useSessionStore.getState().setActiveSession(tab.id);
        },
      },
    ];

    const handler = (e: KeyboardEvent) => {
      // Don't hijack text editing inside inputs.
      const target = e.target as HTMLElement | null;
      if (mod(e) && target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        // Allow the shortcut anyway — none of these conflict with editing.
      }
      for (const s of shortcuts) {
        if (s.test(e)) {
          e.preventDefault();
          s.run(e);
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handlers]);
}
