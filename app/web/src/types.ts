export type MediaType = "video" | "audio";
export type MediaStatus = "pending" | "ready" | "failed";

/** Row shape returned by GET /api/media (the GSI projection). */
export interface MediaListEntry {
  mediaId: string;
  title: string;
  mediaType: MediaType;
  sizeBytes: number;
  durationSec?: number;
  status: MediaStatus;
  createdAt: string;
}

/** Fuller shape returned by GET /api/media/:id and the write endpoints. */
export interface MediaItem extends MediaListEntry {
  description?: string;
  contentType: string;
  ownerId: string;
  originalFilename: string;
  updatedAt: string;
}

export interface ListResponse {
  items: MediaListEntry[];
  nextCursor: string | null;
}

export interface PresignResponse {
  uploadId: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

export interface DetailResponse {
  item: MediaItem;
  downloadUrl: string;
  expiresIn: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}
