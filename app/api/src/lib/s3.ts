import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { s3 } from "./aws.js";

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

/**
 * Create a presigned PUT URL the browser can upload to directly.
 *
 * Two things are signed beyond the usual, and both are load-bearing:
 *
 *   content-type   - so a client cannot claim "video/mp4" to pass validation
 *                    and then upload something else.
 *   content-length - so a client cannot use a URL issued for a 5 MB file to
 *                    upload 5 GB. Without this, "presigned upload URL" really
 *                    means "unmetered write access to my bucket for whoever
 *                    holds this link until it expires".
 *
 * signableHeaders is what forces them into SignedHeaders. By default SigV4
 * query-string signing covers only `host`, so passing ContentType/ContentLength
 * to the command alone would set the headers WITHOUT binding them — the
 * signature would still verify if the client changed them. That subtlety is
 * the whole reason this function exists rather than being inlined.
 *
 * The browser must then send byte-identical values. "video/mp4" vs "video/mp4;"
 * produces SignatureDoesNotMatch, which is an easy hour to lose.
 */
export async function presignUpload(params: {
  key: string;
  contentType: string;
  contentLength: number;
  originalFilename: string;
}): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: config.MEDIA_BUCKET,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
    Metadata: {
      // Metadata values must be ASCII; the original name is already sanitised
      // upstream but encode defensively so a stray byte cannot break the
      // request or smuggle a header.
      "original-filename": encodeURIComponent(params.originalFilename),
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: config.PRESIGN_PUT_TTL_SECONDS,
    signableHeaders: new Set(["content-type", "content-length"]),
  });

  return {
    uploadUrl,
    key: params.key,
    expiresIn: config.PRESIGN_PUT_TTL_SECONDS,
  };
}

/**
 * Short-lived read URL for playback. The <video>/<audio> element streams
 * straight from S3, so media bytes never transit this service.
 */
export async function presignDownload(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }),
    { expiresIn: config.PRESIGN_GET_TTL_SECONDS },
  );
}

export interface ObjectFacts {
  sizeBytes: number;
  contentType: string;
  etag: string | undefined;
}

/**
 * Ask S3 what is actually at this key.
 *
 * This is the server-side verification step, and skipping it undoes every
 * other control in the upload flow. Without it a client can POST /api/media
 * naming any key it likes — one that does not exist, or one belonging to
 * someone else — and we would happily create a database row pointing at it.
 *
 * Returns null when the object is absent, which the caller treats as "the
 * upload never completed" rather than as an error.
 */
export async function headObject(key: string): Promise<ObjectFacts | null> {
  try {
    const res = await s3.send(
      new HeadObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }),
    );
    return {
      sizeBytes: res.ContentLength ?? 0,
      contentType: res.ContentType ?? "application/octet-stream",
      etag: res.ETag,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Delete an object. Treats "already gone" as success, because the caller's
 * intent (this key should not exist) is satisfied either way and a 404 here
 * would strand the DynamoDB row it is trying to clean up.
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }),
    );
  } catch (err) {
    if (isNotFound(err)) {
      logger.warn({ key }, "S3 object already absent during delete");
      return;
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    const status = err.$metadata?.httpStatusCode;
    return status === 404 || err.name === "NotFound" || err.name === "NoSuchKey";
  }
  return false;
}
