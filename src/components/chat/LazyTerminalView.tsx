import { lazy, Suspense, memo } from "react";

// @xterm/xterm is ~282 KB of the renderer bundle and is only ever needed once
// a bash tool card is expanded. Loading it eagerly made every cold start parse
// a full terminal emulator before the first message was painted.
const TerminalViewInner = lazy(() =>
  import("./TerminalView").then((m) => ({ default: m.TerminalView }))
);

/** Same footprint as the real terminal so the card doesn't jump on load. */
function TerminalPlaceholder() {
  return (
    <div className="flex h-48 w-full items-center justify-center rounded bg-gb-terminal text-[10px] text-white/25">
      加载终端…
    </div>
  );
}

export const LazyTerminalView = memo(function LazyTerminalView({
  content,
}: {
  content: string;
}) {
  return (
    <Suspense fallback={<TerminalPlaceholder />}>
      <TerminalViewInner content={content} />
    </Suspense>
  );
});
