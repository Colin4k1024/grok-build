import ReactDiffViewer from "react-diff-viewer-continued";

interface Props {
  oldContent: string;
  newContent: string;
}

export function DiffViewer({ oldContent, newContent }: Props) {
  return (
    <div className="overflow-auto rounded text-xs">
      <ReactDiffViewer
        oldValue={oldContent}
        newValue={newContent}
        splitView={false}
        hideLineNumbers={false}
        useDarkTheme={true}
        styles={{
          variables: {
            // Codex-aligned palette: neutral #1c1c1c surface (not GitHub's
            // blue-tinted dark) with green=additions / red=deletions per
            // codex-rs/tui/styles.md.
            dark: {
              diffViewerBackground: "#1c1c1c",
              diffViewerColor: "#d6d6d6",
              addedBackground: "rgba(52, 211, 153, 0.10)",
              removedBackground: "rgba(248, 113, 113, 0.10)",
              addedColor: "#34d399",
              removedColor: "#f87171",
              wordAddedBackground: "rgba(52, 211, 153, 0.22)",
              wordRemovedBackground: "rgba(248, 113, 113, 0.22)",
            },
            light: {
              diffViewerBackground: "#fafaf9",
              diffViewerColor: "#282828",
              addedBackground: "rgba(52, 211, 153, 0.12)",
              removedBackground: "rgba(248, 113, 113, 0.12)",
              addedColor: "#0f9d6e",
              removedColor: "#dc5a5a",
              wordAddedBackground: "rgba(52, 211, 153, 0.24)",
              wordRemovedBackground: "rgba(248, 113, 113, 0.24)",
            },
          },
        }}
      />
    </div>
  );
}
