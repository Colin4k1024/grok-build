import { useState, useCallback, useEffect } from "react";

export interface PastedImage {
  id: string;
  dataUrl: string;  // base64 data URL for preview
  base64: string;   // raw base64 without prefix
  mimeType: string;
  name: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:image/png;base64,<data>
      const base64 = result.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function useImagePaste() {
  const [images, setImages] = useState<PastedImage[]>([]);

  const addBlob = useCallback(async (blob: Blob, name?: string) => {
    if (!blob.type.startsWith("image/")) return;
    const base64 = await blobToBase64(blob);
    const dataUrl = await dataUrlFromBlob(blob);
    const img: PastedImage = {
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      dataUrl,
      base64,
      mimeType: blob.type,
      name: name || `pasted-image-${Date.now()}.png`,
    };
    setImages((prev) => [...prev, img]);
  }, []);

  // Clipboard paste handler
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            addBlob(blob, blob.name);
          }
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addBlob]);

  // Drag-and-drop handler
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith("image/")) {
        addBlob(file, file.name);
      }
    }
  }, [addBlob]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  return { images, onDrop, onDragOver, removeImage, clearImages, addBlob };
}
