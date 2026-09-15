import React, { useState, useEffect } from "react";
import type { Attachment } from "../../../shared/types.js";
import { blobUrlCache } from "../types.js";

export function MessageImage({
  att,
  onExpand,
}: {
  att: Attachment;
  onExpand: (att: Attachment) => void;
}) {
  const cached = blobUrlCache.get(att.id);
  const [src, setSrc] = useState<string | null>(cached ?? null);

  useEffect(() => {
    if (blobUrlCache.has(att.id)) return;
    let cancelled = false;
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (!cancelled && res.ok) {
        const dataUrl = `data:${res.mimeType};base64,${res.data}`;
        blobUrlCache.set(att.id, dataUrl);
        setSrc(dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [att.id]);

  if (!src) {
    return (
      <div className="w-24 h-16 rounded-lg bg-white/5 animate-pulse border border-white/10" />
    );
  }

  return (
    <button
      onClick={() => onExpand(att)}
      className="flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500/60 rounded-lg"
    >
      <img
        src={src}
        alt={att.filename}
        className="max-w-[280px] max-h-[200px] rounded-lg object-cover border border-white/10 hover:opacity-90 transition-opacity cursor-zoom-in"
      />
    </button>
  );
}