import { useState, useEffect, useCallback } from "react";

interface ImageViewerProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageViewer({ src, alt, onClose }: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.25, Math.min(5, z - e.deltaY * 0.001)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  }, [offset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
      onWheel={handleWheel}
    >
      <div className="absolute right-4 top-4 flex gap-2">
        <button
          className="rounded bg-gb-surface/80 px-2 py-1 text-xs text-gb-text hover:bg-gb-surface"
          onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.min(5, z + 0.25)); }}
        >
          +
        </button>
        <button
          className="rounded bg-gb-surface/80 px-2 py-1 text-xs text-gb-text hover:bg-gb-surface"
          onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.max(0.25, z - 0.25)); }}
        >
          −
        </button>
        <button
          className="rounded bg-gb-surface/80 px-2 py-1 text-xs text-gb-text hover:bg-gb-surface"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setOffset({ x: 0, y: 0 }); }}
        >
          Reset
        </button>
        <button
          className="rounded bg-gb-surface/80 px-2 py-1 text-xs text-gb-text hover:bg-gb-surface"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] select-none rounded-lg object-contain"
        style={{
          transform: `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`,
          cursor: dragging ? "grabbing" : "grab",
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        draggable={false}
      />
    </div>
  );
}
