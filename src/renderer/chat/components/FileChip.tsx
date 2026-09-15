import React from "react";
import { SpinnerIcon } from "../icons.js";
import { fileEmoji, truncFilename } from "../helpers.js";
import type { PendingAttachment } from "../types.js";

export function FileChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = att.mimeType.startsWith("image/");
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs border max-w-[180px] flex-shrink-0 ${
        att.error
          ? "bg-red-900/30 border-red-500/30 text-red-300"
          : "bg-white/8 border-white/10 text-white/80"
      }`}
    >
      {isImage && att.previewUrl ? (
        <img
          src={att.previewUrl}
          alt=""
          className="w-5 h-5 rounded object-cover flex-shrink-0"
        />
      ) : (
        <span className="text-sm leading-none flex-shrink-0">
          {fileEmoji(att.mimeType)}
        </span>
      )}
      <span className="truncate flex-1">
        {att.error ? att.error : truncFilename(att.file.name)}
      </span>
      {att.uploading && <SpinnerIcon size={10} />}
      {!att.uploading && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          ✕
        </button>
      )}
    </div>
  );
}