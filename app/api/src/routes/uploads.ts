import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { recordAudit } from "../lib/audit.js";
import { buildObjectKey, newUploadId, safeDisplayName } from "../lib/ids.js";
import { presignUpload } from "../lib/s3.js";
import { fixedWindowLimiter } from "../middleware/rateLimit.js";
import { body, validateBody } from "../middleware/validate.js";
import { putTicket, ticketExpiry } from "../repo/uploadRepo.js";
import { PresignRequest } from "../schemas/media.js";
import type { UploadTicket } from "../types.js";
import { actorOf, sourceIpOf } from "../lib/request.js";

export const uploadsRouter: Router = Router();

/**
 * POST /api/uploads/presign
 *
 * Hands the browser a URL it can PUT bytes to directly. Media never transits
 * this service — which is not merely an optimisation here, it is forced: API
 * Gateway caps request payloads at 10 MB and integrations at 30 seconds, so a
 * 200 MB video could not be proxied through even if we wanted to.
 *
 * What this endpoint is really doing is minting a narrowly scoped, short-lived
 * capability. So it is rate limited: it is the endpoint that creates the
 * ability to consume storage.
 */
uploadsRouter.post(
  "/presign",
  fixedWindowLimiter({
    limit: config.RATE_LIMIT_PRESIGN_PER_MIN,
    windowMs: 60_000,
  }),
  validateBody(PresignRequest),
  async (req: Request, res: Response) => {
    const input = body<PresignRequest>(req);

    // contentType and sizeBytes were already checked against the allowlist and
    // the size ceiling by the schema, so by here they are known-good.
    const key = buildObjectKey(config.UPLOAD_PREFIX, input.contentType);
    const uploadId = newUploadId();
    const originalFilename = safeDisplayName(input.filename);

    const presigned = await presignUpload({
      key,
      contentType: input.contentType,
      contentLength: input.sizeBytes,
      originalFilename,
    });

    /**
     * Persist the ticket BEFORE returning the URL.
     *
     * Ordering matters: if the write fails we must not hand out a URL, because
     * an upload against a key we have no record of can never be confirmed and
     * becomes an orphaned object. Failing here costs the user a retry; the
     * other order costs storage nobody can account for.
     */
    const ticket: UploadTicket = {
      uploadId,
      s3Key: key,
      contentType: input.contentType,
      maxBytes: input.sizeBytes,
      originalFilename,
      ownerId: actorOf(req),
      issuedAt: new Date().toISOString(),
      expiresAt: ticketExpiry(),
      consumed: false,
    };
    await putTicket(ticket);

    recordAudit({
      mediaId: uploadId,
      action: "UPLOAD_ISSUED",
      actor: ticket.ownerId,
      sourceIp: sourceIpOf(req),
      detail: { contentType: input.contentType, sizeBytes: input.sizeBytes },
    });

    // The response contains a live credential. It is returned to the caller and
    // must never be logged - see the redact list in logger.ts.
    res.status(201).json({
      uploadId,
      uploadUrl: presigned.uploadUrl,
      key,
      expiresIn: presigned.expiresIn,
      // Echo back exactly what the browser must send, because these values are
      // part of the signature and a mismatch produces SignatureDoesNotMatch.
      requiredHeaders: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.sizeBytes),
      },
    });
  },
);
