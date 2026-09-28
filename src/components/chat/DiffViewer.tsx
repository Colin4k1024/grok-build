import { memo } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { useSettingsStore } from "../../stores/settingsStore";

interface Props {
  oldContent: string;
  newContent: string;
}

// Hoisted: react-diff-viewer deep-merges `styles` into its theme on every
// render, and an inline literal gave it a new identity each time. This panel
// re-renders on every 50 ms stream flush while a diff fence is growing.
//
// Token-driven palette (R4-01 #234): CSS variables resolve per element, so a
// single variable set adapts to both themes — no hardcoded rgba palettes.
const DIFF_VARS = {
  diffViewerBackground: "rgb(var(--gb-sidebar))",
  diffViewerColor: "rgb(var(--gb-text-secondary))",
  addedBackground: "rgb(var(--gb-success) / 0.10)",
  removedBackground: "rgb(var(--gb-danger) / 0.10)",
  addedColor: "rgb(var(--gb-success-text))",
  removedColor: "rgb(var(--gb-danger-text))",
  wordAddedBackground: "rgb(var(--gb-success) / 0.22)",
  wordRemovedBackground: "rgb(var(--gb-danger) / 0.22)",
} as const;

const DIFF_STYLES = {
  variables: {
    dark: DIFF_VARS,
    light: DIFF_VARS,
  },
} as const;

/** Resolve the effective theme for the library's remaining base styles. */
function usePrefersLight(): boolean {
  const mode = useSettingsStore((s) => s.theme);
  if (mode === "light") return true;
  if (mode === "dark") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

/** Memoized: diffing is the most expensive thing in the message tree and the
 *  inputs are immutable once a turn settles. */
export const DiffViewer = memo(function DiffViewer({ oldContent, newContent }: Props) {
  const light = usePrefersLight();
  return (
    <div className="overflow-auto rounded text-xs">
      <ReactDiffViewer
        oldValue={oldContent}
        newValue={newContent}
        splitView={false}
        hideLineNumbers={false}
        useDarkTheme={!light}
        styles={DIFF_STYLES}
      />
    </div>
  );
});
