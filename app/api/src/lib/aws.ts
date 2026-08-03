import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * ---------------------------------------------------------------------------
 * Credentials
 * ---------------------------------------------------------------------------
 *
 * There is no access key anywhere in this service, and there is no database
 * password either. Two mechanisms replace them:
 *
 * HOP 1 — the workload's own identity, resolved from the DEFAULT credential
 *   chain. On ECS that is the Task Role, delivered over the container
 *   credential endpoint (169.254.170.2). On EKS it is IRSA, delivered by
 *   exchanging a projected ServiceAccount token. Locally it is your profile.
 *   The SDK handles all three identically, which is why this file contains no
 *   platform-specific code.
 *
 * HOP 2 — sts:AssumeRole into the account that owns the DynamoDB tables.
 *
 * fromTemporaryCredentials() uses the default chain as its source credential,
 * so hop 1 feeds hop 2 automatically. Critically it also CACHES the assumed
 * credentials and refreshes them shortly before expiry. Calling AssumeRole per
 * request would add ~100ms to every call and will eventually hit an STS rate
 * limit — a genuinely common mistake worth avoiding by construction.
 *
 * If DDB_ROLE_ARN is unset we skip hop 2 entirely, which is what you want for
 * local development or a single-account deployment.
 */
function buildDynamoCredentials(): AwsCredentialIdentityProvider | undefined {
  if (!config.DDB_ROLE_ARN) {
    logger.info("DDB_ROLE_ARN unset - using the default credential chain for DynamoDB");
    return undefined;
  }

  logger.info(
    { roleArn: config.DDB_ROLE_ARN, hasExternalId: Boolean(config.DDB_EXTERNAL_ID) },
    "DynamoDB access via cross-account AssumeRole",
  );

  return fromTemporaryCredentials({
    params: {
      RoleArn: config.DDB_ROLE_ARN,
      RoleSessionName: config.DDB_ROLE_SESSION_NAME,
      ...(config.DDB_EXTERNAL_ID ? { ExternalId: config.DDB_EXTERNAL_ID } : {}),
      DurationSeconds: 3600,
    },
    clientConfig: { region: config.AWS_REGION },
  });
}

const dynamoCredentials = buildDynamoCredentials();

const rawDynamo = new DynamoDBClient({
  region: config.AWS_REGION,
  ...(dynamoCredentials ? { credentials: dynamoCredentials } : {}),
  ...(config.DDB_ENDPOINT ? { endpoint: config.DDB_ENDPOINT } : {}),
  maxAttempts: 3,
});

/**
 * The Document client marshals plain JS values to/from DynamoDB's typed
 * attribute format. removeUndefinedValues matters: DynamoDB rejects an
 * explicit `undefined`, and optional fields (description, durationSec) are
 * undefined all the time.
 */
export const ddb = DynamoDBDocumentClient.from(rawDynamo, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: { wrapNumbers: false },
});

/**
 * S3 lives in the SAME account as this service, so it uses hop 1 only — the
 * default chain, no AssumeRole.
 *
 * Traffic reaches S3 through the VPC Gateway Endpoint. Nothing needs to be
 * configured here for that to happen: the endpoint is a route table entry, so
 * it is transparent to the SDK. That transparency is the reason the endpoint
 * is easy to misconfigure and never notice — verify it at the network layer,
 * not from application code.
 */
export const s3 = new S3Client({
  region: config.AWS_REGION,
  maxAttempts: 3,
  // Newer SDK versions default this to WHEN_SUPPORTED, which computes a
  // checksum over the (at signing time, empty/unknown) body and embeds it in
  // presigned URLs. The browser then uploads real bytes that don't match, and
  // S3 rejects the PUT. WHEN_REQUIRED restores the old behaviour: no checksum
  // unless a command explicitly asks for one. This affects real AWS too, not
  // just local testing.
  requestChecksumCalculation: "WHEN_REQUIRED",
  // S3_ENDPOINT is set only for local testing against LocalStack. Unset, this
  // is a no-op and the SDK talks to real AWS as normal.
  ...(config.S3_ENDPOINT
    ? { endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE }
    : {}),
});

/** Release SDK sockets so the process can exit promptly on SIGTERM. */
export function destroyAwsClients(): void {
  rawDynamo.destroy();
  s3.destroy();
}
