import React, { useState, useEffect } from "react";
import type { Attachment } from "../../../shared/types.js";
import { blobUrlCache } from "../types.js";
import { SpinnerIcon } from "../icons.js";

export function Lightbox({
  att,
  onClose,
}: {
  att: Attachment;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(blobUrlCache.get(att.id) ?? null);

  useEffect(() => {
    if (blobUrlCache.has(att.id)) return;
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (res.ok) {
        const dataUrl = `data:${res.mimeType};base64,${res.data}`;
        blobUrlCache.set(att.id, dataUrl);
        setSrc(dataUrl);
      }
    });
  }, [att.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors text-2xl w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
      >
        ✕
      </button>
      {src ? (
        <img
          src={src}
          alt={att.filename}
          className="max-w-[90vw] max-h-[90vh] rounded-xl shadow-2xl object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <SpinnerIcon size={32} />
      )}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/50 text-sm">
        {att.filename}
      </div>
    </div>
  );
}