import pino from "pino";
import { config } from "./config.js";

/**
 * Structured JSON logs, because everything downstream (CloudWatch Logs
 * Insights, Loki, Datadog) can query fields but not prose.
 *
 * The redact list is not decoration. A presigned URL is a bearer credential:
 * anyone holding it has that exact S3 permission until it expires. Logging one
 * puts a live credential into your log aggregator, where it is retained,
 * indexed, and readable by everyone with log access. Same reasoning for
 * authorization headers and the cross-account ExternalId.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "mediavault-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "uploadUrl",
      "downloadUrl",
      "*.uploadUrl",
      "*.downloadUrl",
      "externalId",
      "DDB_EXTERNAL_ID",
    ],
    censor: "[REDACTED]",
  },
  // Pretty output locally; raw JSON in containers where a collector reads it.
  ...(config.isProd
    ? {}
    : {
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
      }),
});

export type Logger = typeof logger;
