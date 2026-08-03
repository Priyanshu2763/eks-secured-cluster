import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";

/** Extensions we are willing to put on an S3 key, keyed by content type. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
};

export const newMediaId = () => randomUUID();
export const newUploadId = () => randomUUID();

/** Short random suffix used to break ties on equal timestamps. */
export const shortId = () => randomBytes(6).toString("hex");

export function mediaTypeOf(contentType: string): "video" | "audio" {
  return contentType.startsWith("video/") ? "video" : "audio";
}

/**
 * Build the S3 object key.
 *
 * The client's filename is NEVER used here, and that is the entire point of
 * this function existing. A client-supplied name gives you, at minimum:
 *   - path traversal      ("../../secrets/key")
 *   - key collisions      (two users both upload "video.mp4")
 *   - unicode / control-character weirdness in keys you later have to parse
 *   - an oracle for guessing other users' objects
 *
 * The extension is derived from the (already allowlisted) content type rather
 * than from the name, so it cannot be used to smuggle anything either. The
 * original filename is kept as S3 object metadata, where it is data rather
 * than an identifier.
 *
 * Date prefixes keep listings navigable and make lifecycle rules easy to
 * reason about.
 */
export function buildObjectKey(prefix: string, contentType: string): string {
  const ext = EXTENSION_BY_TYPE[contentType] ?? "bin";
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  return `${clean}/${yyyy}/${mm}/${randomUUID()}.${ext}`;
}

/**
 * Sanitise a filename purely so it is safe to STORE as metadata and echo back
 * in the UI. It is never used to address anything.
 *
 * The character class strips ASCII control characters (0x00-0x1F plus DEL),
 * which are what make a filename dangerous in logs, HTTP headers and
 * terminals. Written as escape sequences on purpose — never paste raw control
 * bytes into source.
 */
export function safeDisplayName(filename: string, max = 200): string {
  const base = path
    .basename(filename)
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
  return base.slice(0, max) || "untitled";
}
