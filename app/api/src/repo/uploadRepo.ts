import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import { ddb } from "../lib/aws.js";
import type { UploadTicket } from "../types.js";

/**
 * Upload tickets.
 *
 * A ticket records the S3 key that the SERVER chose for a given upload. It is
 * the reason the upload flow is safe: because the client is handed an opaque
 * uploadId rather than a key, it never gets to say which object a media row
 * should point at. Combined with the HeadObject check at confirm time, a
 * client cannot register an object it did not upload, nor one belonging to
 * somebody else.
 *
 * The table is TTL-expired on `expiresAt`, so abandoned uploads disappear on
 * their own with no cron job and no cost.
 */

export async function putTicket(ticket: UploadTicket): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: config.TABLE_UPLOADS, Item: ticket }),
  );
}

export async function getTicket(uploadId: string): Promise<UploadTicket | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: config.TABLE_UPLOADS, Key: { uploadId } }),
  );
  return (res.Item as UploadTicket | undefined) ?? null;
}

/**
 * Mark a ticket used, atomically.
 *
 * The ConditionExpression is what makes a ticket single-use. Two concurrent
 * confirmations for the same uploadId both read `consumed: false`, both try to
 * write, and exactly one wins — the loser gets
 * ConditionalCheckFailedException, which the caller surfaces as a 409.
 *
 * Doing this as a read-then-write in application code would leave a race that
 * lets one upload create two media rows. Conditional writes are how you get
 * correctness here; DynamoDB has no transactions you could lean on across the
 * S3 call anyway.
 *
 * Returns false when the ticket was already consumed.
 */
export async function consumeTicket(uploadId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: config.TABLE_UPLOADS,
        Key: { uploadId },
        UpdateExpression: "SET #consumed = :true",
        ConditionExpression: "attribute_exists(uploadId) AND #consumed = :false",
        ExpressionAttributeNames: { "#consumed": "consumed" },
        ExpressionAttributeValues: { ":true": true, ":false": false },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

/**
 * DynamoDB TTL deletes expired items "within 48 hours", not instantly. So the
 * presence of a ticket says nothing about its validity and every read path
 * must check the timestamp itself. Treating TTL as a correctness mechanism
 * rather than a cleanup mechanism is a common and quiet mistake.
 */
export function isExpired(ticket: UploadTicket, now = Date.now()): boolean {
  return ticket.expiresAt * 1000 <= now;
}

export function ticketExpiry(now = Date.now()): number {
  return Math.floor(now / 1000) + config.UPLOAD_TICKET_TTL_SECONDS;
}
