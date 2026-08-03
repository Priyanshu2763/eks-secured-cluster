export type MediaStatus = "pending" | "ready" | "failed";
export type MediaType = "video" | "audio";

/**
 * A row in mediavault-<ENV>-items.
 *
 * The gsi* attributes are duplicated key material, not extra data. DynamoDB
 * indexes can only key off real attributes, so "list newest first" and "list
 * by type" each need a partition/sort pair physically present on the item.
 * They are derived on write (see toItem) and never set by hand.
 */
export interface MediaItem {
  mediaId: string;
  title: string;
  description?: string;
  s3Key: string;
  contentType: string;
  mediaType: MediaType;
  sizeBytes: number;
  durationSec?: number;
  status: MediaStatus;
  ownerId: string;
  originalFilename: string;
  createdAt: string; // ISO-8601 UTC; sorts lexicographically = chronologically
  updatedAt: string;

  gsi1pk: string; // FEED#<status>
  gsi1sk: string; // = createdAt
  gsi2pk: string; // TYPE#<mediaType>
  gsi2sk: string; // = createdAt
}

/**
 * The subset returned by list queries. It is smaller than MediaItem because
 * the GSIs use an INCLUDE projection — s3Key and description are deliberately
 * not projected, so they are simply not available from a list without a second
 * read. The type reflects that rather than lying about it.
 */
export interface MediaListEntry {
  mediaId: string;
  title: string;
  mediaType: MediaType;
  sizeBytes: number;
  durationSec?: number;
  status: MediaStatus;
  createdAt: string;
}

/** A row in mediavault-<ENV>-uploads. Short-lived, TTL-expired. */
export interface UploadTicket {
  uploadId: string;
  s3Key: string;
  contentType: string;
  maxBytes: number;
  originalFilename: string;
  ownerId: string;
  issuedAt: string;
  expiresAt: number; // epoch SECONDS - the TTL attribute
  consumed: boolean;
}

export type AuditAction =
  | "UPLOAD_ISSUED"
  | "UPLOAD_CONFIRMED"
  | "UPLOAD_REJECTED"
  | "UPDATE"
  | "DELETE";

/** A row in mediavault-<ENV>-audit. Append-only. */
export interface AuditEvent {
  entityId: string; // MEDIA#<mediaId>
  eventAt: string; // <ISO-8601>#<random> - timestamp sorts, suffix breaks ties
  action: AuditAction;
  actor: string;
  sourceIp?: string;
  detail?: Record<string, unknown>;
  ttl: number; // epoch seconds
}
