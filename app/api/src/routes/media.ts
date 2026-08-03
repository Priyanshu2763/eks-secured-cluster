import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { recordAudit } from "../lib/audit.js";
import { conflict, notFound } from "../lib/errors.js";
import { mediaTypeOf, newMediaId } from "../lib/ids.js";
import { actorOf, sourceIpOf } from "../lib/request.js";
import { deleteObject, headObject, presignDownload } from "../lib/s3.js";
import { body, params, query, validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  deleteMedia,
  getMedia,
  indexKeys,
  listMedia,
  putMedia,
  updateMedia,
} from "../repo/mediaRepo.js";
import { consumeTicket, getTicket, isExpired } from "../repo/uploadRepo.js";
import {
  CreateMediaRequest,
  IdParam,
  ListMediaQuery,
  UpdateMediaRequest,
} from "../schemas/media.js";
import type { MediaItem } from "../types.js";

export const mediaRouter: Router = Router();

/**
 * POST /api/media  -  confirm an upload and create the row.
 *
 * This is the security-critical handler in the service. It runs four checks,
 * and each one closes a specific hole:
 *
 *   1. The ticket exists            - the client cannot invent an uploadId.
 *   2. The ticket is not expired    - TTL deletion lags by up to 48h, so
 *                                     absence is not a validity check.
 *   3. The object really is in S3   - HeadObject on the key FROM THE TICKET,
 *                                     never from the request body. Without
 *                                     this, a client could register a key it
 *                                     never uploaded, including someone
 *                                     else's.
 *   4. Size and type match          - what was signed is what was stored.
 *
 * Then the ticket is consumed with a conditional write, which makes it
 * single-use even under concurrent requests.
 */
mediaRouter.post(
  "/",
  validateBody(CreateMediaRequest),
  async (req: Request, res: Response) => {
    const input = body<CreateMediaRequest>(req);
    const actor = actorOf(req);
    const sourceIp = sourceIpOf(req);

    const ticket = await getTicket(input.uploadId);
    if (!ticket) throw notFound("Upload ticket not found or already expired");

    if (isExpired(ticket)) {
      throw conflict("Upload ticket has expired; request a new upload URL");
    }
    if (ticket.consumed) {
      throw conflict("Upload ticket has already been used");
    }

    // Note the key comes from the TICKET. This is the whole point.
    const facts = await headObject(ticket.s3Key);
    if (!facts) {
      recordAudit({
        mediaId: input.uploadId,
        action: "UPLOAD_REJECTED",
        actor,
        sourceIp,
        detail: { reason: "object_missing" },
      });
      throw conflict("No uploaded object found for this ticket");
    }

    if (facts.sizeBytes > ticket.maxBytes) {
      recordAudit({
        mediaId: input.uploadId,
        action: "UPLOAD_REJECTED",
        actor,
        sourceIp,
        detail: { reason: "size_mismatch", actual: facts.sizeBytes, allowed: ticket.maxBytes },
      });
      // The object is not ours to keep - it was never legitimately registered.
      await deleteObject(ticket.s3Key);
      throw conflict("Uploaded object is larger than the size that was authorised");
    }

    if (facts.contentType !== ticket.contentType) {
      recordAudit({
        mediaId: input.uploadId,
        action: "UPLOAD_REJECTED",
        actor,
        sourceIp,
        detail: { reason: "type_mismatch", actual: facts.contentType },
      });
      await deleteObject(ticket.s3Key);
      throw conflict("Uploaded object content type does not match the authorised type");
    }

    // Single-use enforcement. Two concurrent confirms race here and exactly
    // one wins; the loser gets a 409 rather than creating a duplicate row.
    const won = await consumeTicket(input.uploadId);
    if (!won) throw conflict("Upload ticket has already been used");

    const now = new Date().toISOString();
    const mediaType = mediaTypeOf(ticket.contentType);
    const item: MediaItem = {
      mediaId: newMediaId(),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      s3Key: ticket.s3Key,
      contentType: ticket.contentType,
      mediaType,
      sizeBytes: facts.sizeBytes,
      ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
      status: "ready",
      ownerId: actor,
      originalFilename: ticket.originalFilename,
      createdAt: now,
      updatedAt: now,
      ...indexKeys("ready", mediaType, now),
    };

    await putMedia(item);

    recordAudit({
      mediaId: item.mediaId,
      action: "UPLOAD_CONFIRMED",
      actor,
      sourceIp,
      detail: { uploadId: input.uploadId, sizeBytes: facts.sizeBytes },
    });

    res.status(201).json({ item: toPublic(item) });
  },
);

/**
 * GET /api/media  -  the table view.
 *
 * Cursor-paginated. Clients must follow nextCursor until it is null rather
 * than assuming an empty page means the end: when `q` is set, DynamoDB filters
 * AFTER reading, so a page can legitimately return zero items and still have
 * more to come.
 */
mediaRouter.get(
  "/",
  validateQuery(ListMediaQuery),
  async (req: Request, res: Response) => {
    const q = query<ListMediaQuery>(req);
    const result = await listMedia(q);
    res.json({
      items: result.items,
      nextCursor: result.nextCursor,
    });
  },
);

/**
 * GET /api/media/:id  -  one item plus a short-lived playback URL.
 *
 * The URL is minted per request rather than stored, so revoking access is a
 * matter of waiting out the expiry rather than hunting down copies.
 */
mediaRouter.get(
  "/:id",
  validateParams(IdParam),
  async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const item = await getMedia(id);
    if (!item) throw notFound("Media not found");

    const downloadUrl = await presignDownload(item.s3Key);

    res.json({
      item: toPublic(item),
      downloadUrl,
      expiresIn: config.PRESIGN_GET_TTL_SECONDS,
    });
  },
);

/** PUT /api/media/:id  -  patch title/description. */
mediaRouter.put(
  "/:id",
  validateParams(IdParam),
  validateBody(UpdateMediaRequest),
  async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const patch = body<UpdateMediaRequest>(req);

    const updated = await updateMedia(id, patch);

    recordAudit({
      mediaId: id,
      action: "UPDATE",
      actor: actorOf(req),
      sourceIp: sourceIpOf(req),
      detail: { fields: Object.keys(patch) },
    });

    res.json({ item: toPublic(updated) });
  },
);

/**
 * DELETE /api/media/:id
 *
 * Order is deliberate: S3 object FIRST, then the DynamoDB row.
 *
 * There is no transaction spanning S3 and DynamoDB, so a crash between the two
 * steps is possible and the question is only which inconsistent state you
 * prefer. Deleting S3 first can leave a row pointing at a missing object,
 * which is visible in the UI and trivially cleaned up. The reverse leaves an
 * object with no row referencing it - invisible, unattributable, and billed
 * for indefinitely.
 *
 * When you cannot be atomic, fail toward the state you can detect.
 */
mediaRouter.delete(
  "/:id",
  validateParams(IdParam),
  async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);

    const item = await getMedia(id);
    if (!item) throw notFound("Media not found");

    await deleteObject(item.s3Key);
    await deleteMedia(id);

    recordAudit({
      mediaId: id,
      action: "DELETE",
      actor: actorOf(req),
      sourceIp: sourceIpOf(req),
      detail: { s3Key: item.s3Key },
    });

    res.status(204).send();
  },
);

/**
 * Strip internal fields before returning an item.
 *
 * s3Key and the gsi* attributes are implementation detail. Exposing s3Key in
 * particular would let a client learn the key layout, which is exactly the
 * information the server-generated-key design is meant to withhold.
 */
function toPublic(item: MediaItem) {
  const { s3Key, gsi1pk, gsi1sk, gsi2pk, gsi2sk, ...rest } = item;
  void s3Key;
  void gsi1pk;
  void gsi1sk;
  void gsi2pk;
  void gsi2sk;
  return rest;
}
