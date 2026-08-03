import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import { ddb } from "./aws.js";
import { logger } from "../logger.js";
import { shortId } from "./ids.js";
import type { AuditAction, AuditEvent } from "../types.js";

/**
 * Append-only audit trail.
 *
 * The sort key is `<ISO-8601>#<random>`. ISO-8601 in UTC sorts
 * lexicographically in the same order it sorts chronologically, so a plain
 * string range query returns events in time order; the random suffix only
 * breaks ties between events written in the same millisecond. This is the
 * canonical DynamoDB one-to-many pattern: partition key identifies the parent,
 * sort key orders the children.
 *
 * Writes are FIRE AND FORGET. An audit failure must never fail the user's
 * request — losing an audit row is bad, but failing a delete that already
 * removed the S3 object is worse, because it leaves the caller unsure what
 * actually happened. Failures are logged at warn so they are still visible.
 */
export function recordAudit(params: {
  mediaId: string;
  action: AuditAction;
  actor: string;
  sourceIp?: string;
  detail?: Record<string, unknown>;
}): void {
  const now = new Date();
  const event: AuditEvent = {
    entityId: `MEDIA#${params.mediaId}`,
    eventAt: `${now.toISOString()}#${shortId()}`,
    action: params.action,
    actor: params.actor,
    ...(params.sourceIp ? { sourceIp: params.sourceIp } : {}),
    ...(params.detail ? { detail: params.detail } : {}),
    ttl: Math.floor(now.getTime() / 1000) + config.auditTtlSeconds,
  };

  void ddb
    .send(new PutCommand({ TableName: config.TABLE_AUDIT, Item: event }))
    .catch((err: unknown) => {
      logger.warn(
        { err, mediaId: params.mediaId, action: params.action },
        "failed to write audit event",
      );
    });
}
