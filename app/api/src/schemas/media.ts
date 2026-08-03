import { z } from "zod";
import { config } from "../config.js";

/**
 * Every request body and query string is parsed through one of these. Nothing
 * downstream ever touches req.body directly.
 *
 * .strict() is deliberate: unknown keys are rejected rather than ignored. If a
 * client sends { title, s3Key } hoping s3Key gets used, it gets a 400 instead
 * of silently succeeding while we wonder later how a row acquired a key nobody
 * issued.
 */

const title = z
  .string()
  .trim()
  .min(1, "title is required")
  .max(200, "title must be 200 characters or fewer");

const description = z
  .string()
  .trim()
  .max(2000, "description must be 2000 characters or fewer")
  .optional();

/** A UUID we generated. Validating shape here turns a malformed id into a
 *  clean 400 rather than a wasted DynamoDB round trip. */
export const IdParam = z.object({
  id: z.string().uuid("id must be a UUID"),
});

export const PresignRequest = z
  .object({
    filename: z.string().trim().min(1).max(500),
    contentType: z
      .string()
      .trim()
      .refine((v) => config.ALLOWED_CONTENT_TYPES.includes(v), {
        message: `contentType must be one of: ${config.ALLOWED_CONTENT_TYPES.join(", ")}`,
      }),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(
        config.MAX_UPLOAD_BYTES,
        `file exceeds the maximum of ${config.MAX_UPLOAD_BYTES} bytes`,
      ),
  })
  .strict();

export const CreateMediaRequest = z
  .object({
    uploadId: z.string().uuid("uploadId must be a UUID"),
    title,
    description,
    // Optional client-probed duration. Cosmetic only — never trusted for
    // anything that matters, so a wrong value is a cosmetic bug, not a hole.
    durationSec: z.number().nonnegative().max(86_400).optional(),
  })
  .strict();

export const UpdateMediaRequest = z
  .object({
    title: title.optional(),
    description,
  })
  .strict()
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: "provide at least one of: title, description",
  });

export const ListMediaQuery = z
  .object({
    type: z.enum(["video", "audio"]).optional(),
    status: z.enum(["pending", "ready", "failed"]).default("ready"),
    q: z.string().trim().max(200).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(config.MAX_PAGE_SIZE)
      .default(config.DEFAULT_PAGE_SIZE),
  })
  .strict();

export type PresignRequest = z.infer<typeof PresignRequest>;
export type CreateMediaRequest = z.infer<typeof CreateMediaRequest>;
export type UpdateMediaRequest = z.infer<typeof UpdateMediaRequest>;
export type ListMediaQuery = z.infer<typeof ListMediaQuery>;
