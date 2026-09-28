import { useEffect, useRef, type ReactNode } from "react";

/**
 * AppShell (R4-03 #236): the stable four-region desktop shell.
 *
 *   primary rail -> contextual sidebar -> main workspace -> optional inspector
 *
 * The shell stays mounted across destination switches — only the workspace
 * slot changes — so navigation never destroys panel state or causes layout
 * jumps. Landmarks: nav (rail), main (workspace), complementary (inspector).
 */

export interface AppShellProps {
  /** Current top-level destination; focus moves to the workspace on change. */
  destination: string;
  rail: ReactNode;
  /** Contextual sidebar for the active destination (never top-level links). */
  sidebar?: ReactNode;
  titlebar: ReactNode;
  workspace: ReactNode;
  /** Optional inspector; collapsible without unmounting the workspace. */
  inspector?: ReactNode;
  statusbar?: ReactNode;
}

export function AppShell({
  destination,
  rail,
  sidebar,
  titlebar,
  workspace,
  inspector,
  statusbar,
}: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // Focus follows navigation: switching destinations moves keyboard focus to
  // the workspace landmark so the new context is announced and reachable.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [destination]);

  return (
    <div className="flex h-full overflow-hidden text-gb-text">
      <a
        href="#gb-workspace"
        className="sr-only focus:not-sr-only focus:absolute focus:left-14 focus:top-2 focus:z-gb-modal focus:rounded-gb-md focus:bg-gb-accent focus:px-3 focus:py-1.5 focus:text-gb-accent-fg"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        跳到工作区
      </a>
      {rail}
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {titlebar}
        <div className="flex min-h-0 flex-1">
          <main
            ref={mainRef}
            id="gb-workspace"
            tabIndex={-1}
            aria-label="工作区"
            className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
          >
            {workspace}
          </main>
          {inspector}
        </div>
        {statusbar}
      </div>
    </div>
  );
}
