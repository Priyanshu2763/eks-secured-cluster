import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import { ddb } from "../lib/aws.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { notFound } from "../lib/errors.js";
import type { ListMediaQuery } from "../schemas/media.js";
import type { MediaItem, MediaListEntry, MediaStatus, MediaType } from "../types.js";

/**
 * All DynamoDB access for the items table.
 *
 * Note there is no scan() anywhere in this file, and that is enforced twice
 * over: the data-account IAM role does not grant dynamodb:Scan, so a stray
 * Scan fails with AccessDenied rather than quietly costing money. The IAM
 * policy and the data model agree with each other on purpose.
 */

/** Derive the index key material. Never set these by hand at a call site. */
export function indexKeys(status: MediaStatus, mediaType: MediaType, createdAt: string) {
  return {
    gsi1pk: `FEED#${status}`,
    gsi1sk: createdAt,
    gsi2pk: `TYPE#${mediaType}`,
    gsi2sk: createdAt,
  };
}

export async function putMedia(item: MediaItem): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.TABLE_ITEMS,
      Item: item,
      // Refuse to silently overwrite. We generate the id, so a collision means
      // something is badly wrong and should surface loudly.
      ConditionExpression: "attribute_not_exists(mediaId)",
    }),
  );
}

export async function getMedia(mediaId: string): Promise<MediaItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: config.TABLE_ITEMS, Key: { mediaId } }),
  );
  return (res.Item as MediaItem | undefined) ?? null;
}

export interface ListResult {
  items: MediaListEntry[];
  nextCursor: string | null;
}

/**
 * The table view.
 *
 * Index selection is driven entirely by whether a type filter is present:
 *   no type  -> GSI1, partitioned by status  ("newest ready items")
 *   type set -> GSI2, partitioned by media type
 *
 * ScanIndexForward:false walks the sort key descending, i.e. newest first.
 * There is no sort option because the index defines the order — that is the
 * trade DynamoDB makes, and pretending otherwise would mean sorting in memory
 * over a page, which is worse than not offering it.
 */
export async function listMedia(query: ListMediaQuery): Promise<ListResult> {
  const usingTypeIndex = query.type !== undefined;

  const input: QueryCommandInput = {
    TableName: config.TABLE_ITEMS,
    IndexName: usingTypeIndex ? config.GSI_TYPE : config.GSI_FEED,
    KeyConditionExpression: usingTypeIndex ? "gsi2pk = :pk" : "gsi1pk = :pk",
    ExpressionAttributeValues: {
      ":pk": usingTypeIndex ? `TYPE#${query.type}` : `FEED#${query.status}`,
    },
    ScanIndexForward: false,
    Limit: query.limit,
    ExclusiveStartKey: decodeCursor(query.cursor),
  };

  /**
   * Optional title search.
   *
   * Be clear-eyed about what this is: a FilterExpression runs AFTER items are
   * read, so you pay read capacity for everything examined and a page can come
   * back with fewer than `limit` items — or zero items but a non-null cursor.
   * That is correct behaviour, not a bug, and clients must keep following the
   * cursor until it is null.
   *
   * Only `title` is filterable because it is the one text attribute projected
   * into the GSIs. Real search means OpenSearch; this is honest for a demo.
   */
  if (query.q) {
    input.FilterExpression = "contains(#title, :q)";
    input.ExpressionAttributeNames = { "#title": "title" };
    input.ExpressionAttributeValues = {
      ...input.ExpressionAttributeValues,
      ":q": query.q,
    };
  }

  const res = await ddb.send(new QueryCommand(input));

  return {
    items: (res.Items ?? []) as MediaListEntry[],
    nextCursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/**
 * Patch title/description.
 *
 * The expression is built from a fixed allowlist of field names, never from
 * object keys supplied by the caller. Attribute NAMES go through
 * ExpressionAttributeNames and VALUES through ExpressionAttributeValues, so
 * nothing user-controlled is ever concatenated into the expression string.
 *
 * ConditionExpression turns "update something that does not exist" into a
 * clean 404 instead of DynamoDB helpfully creating the row for you — an
 * upsert-by-accident is a real and surprising failure mode of UpdateItem.
 */
export async function updateMedia(
  mediaId: string,
  patch: { title?: string; description?: string },
): Promise<MediaItem> {
  const sets = ["#updatedAt = :updatedAt"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": new Date().toISOString() };

  if (patch.title !== undefined) {
    sets.push("#title = :title");
    names["#title"] = "title";
    values[":title"] = patch.title;
  }
  if (patch.description !== undefined) {
    sets.push("#description = :description");
    names["#description"] = "description";
    values[":description"] = patch.description;
  }

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: config.TABLE_ITEMS,
        Key: { mediaId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(mediaId)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return res.Attributes as MediaItem;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      throw notFound("Media not found");
    }
    throw err;
  }
}

export async function deleteMedia(mediaId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: config.TABLE_ITEMS, Key: { mediaId } }),
  );
}

/**
 * Cheap connectivity + permission probe for the readiness endpoint. A GetItem
 * on a key that will never exist costs half a read unit and proves three
 * things at once: the network path works, the AssumeRole hop succeeded, and
 * the IAM policy actually permits reads on this table.
 */
export async function probe(): Promise<void> {
  await ddb.send(
    new GetCommand({
      TableName: config.TABLE_ITEMS,
      Key: { mediaId: "__readiness_probe__" },
    }),
  );
}
