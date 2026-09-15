export interface PendingAttachment {
  id: string;
  file: File;
  previewUrl: string;
  mimeType: string;
  uploading: boolean;
  error?: string;
  savedId?: string;
}

export interface StreamingState {
  streamId: string;
  text: string;
  conversationId: string;
}

export interface ReplyTarget {
  messageId: string;
  role: string;
  content: string;
}

/** Blob URL cache: savedAttachmentId → objectURL for instant local display */
export const blobUrlCache = new Map<string, string>();

/** Per-conversation draft persistence (in-memory) */
export const draftStore = new Map<string, { input: string }>();