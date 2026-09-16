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
            dark: {
              diffViewerBackground: "#0d1117",
              diffViewerColor: "#e6edf3",
              addedBackground: "#1a3a1a",
              removedBackground: "#3a1a1a",
              addedColor: "#3fb950",
              removedColor: "#f85149",
              wordAddedBackground: "#2a5a2a",
              wordRemovedBackground: "#5a2a2a",
            },
          },
        }}
      />
    </div>
  );
}
