import { lazy, Suspense, memo } from "react";

// `diff` + react-diff-viewer-continued are ~248 KB and are only needed when a
// diff is actually on screen (a ```diff fence, the Files panel, the Review
// panel). None of those are part of the first paint.
const DiffViewerInner = lazy(() =>
  import("./DiffViewer").then((m) => ({ default: m.DiffViewer }))
);

function DiffPlaceholder() {
  return (
    <div className="flex h-16 w-full items-center justify-center rounded bg-gb-bg-secondary text-[10px] text-gb-muted">
      加载 diff…
    </div>
  );
}

export const LazyDiffViewer = memo(function LazyDiffViewer({
  oldContent,
  newContent,
}: {
  oldContent: string;
  newContent: string;
}) {
  return (
    <Suspense fallback={<DiffPlaceholder />}>
      <DiffViewerInner oldContent={oldContent} newContent={newContent} />
    </Suspense>
  );
});
