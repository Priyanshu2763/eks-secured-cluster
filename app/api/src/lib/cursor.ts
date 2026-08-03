import { badRequest } from "./errors.js";

/**
 * Cursor pagination.
 *
 * DynamoDB has no OFFSET. A Query returns LastEvaluatedKey, and you hand it
 * back as ExclusiveStartKey to continue. This is not a limitation to work
 * around — offset pagination is O(n) and gets slower the deeper you page,
 * while this is O(1) at any depth.
 *
 * The key is base64url-encoded rather than returned raw for two reasons:
 * it keeps the internal key structure (gsi1pk/gsi1sk naming) out of the public
 * API, and it signals to clients that the value is opaque and must not be
 * constructed by hand.
 *
 * Note this is ENCODING, not signing. A determined client can decode and edit
 * a cursor. That is acceptable here because the worst outcome is starting a
 * scan from an arbitrary key within data the caller may already read — it
 * grants no access it did not have. If items were ever scoped per-owner, the
 * owner filter must be re-applied server-side on every page rather than
 * trusted from the cursor.
 */
export type DynamoKey = Record<string, unknown>;

export function encodeCursor(key: DynamoKey | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): DynamoKey | undefined {
  if (!cursor) return undefined;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor is not an object");
    }
    return parsed as DynamoKey;
  } catch {
    // Never echo the offending value back — it is attacker-controlled.
    throw badRequest("Invalid cursor");
  }
}
