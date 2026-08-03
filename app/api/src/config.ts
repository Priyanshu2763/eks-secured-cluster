import { z } from "zod";

/**
 * Environment parsing. Two rules:
 *
 *  1. Parse ONCE at startup and fail loudly. A container that boots with a
 *     missing table name and only discovers it on the first request is far
 *     worse than one that refuses to start — the orchestrator can roll back a
 *     crash loop, it cannot roll back "quietly returning 500s".
 *
 *  2. Nothing in here is a secret except DDB_EXTERNAL_ID. Table names, bucket
 *     names and ARNs are configuration and belong in a ConfigMap / task
 *     definition environment block. Secrets arrive separately (Secrets Manager
 *     or SSM) so they can rotate without a config change.
 */

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  AWS_REGION: z.string().min(1),

  // ---- S3 -----------------------------------------------------------------
  MEDIA_BUCKET: z.string().min(1),
  UPLOAD_PREFIX: z.string().default("uploads/"),
  // LOCAL DEV / TESTING ONLY. Points the S3 client at LocalStack (or any
  // S3-compatible endpoint) instead of real AWS. Unset in every deployed
  // environment. forcePathStyle is required alongside it because a custom
  // endpoint can't do virtual-hosted-style bucket subdomains.
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  PRESIGN_PUT_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(209_715_200), // 200 MB
  ALLOWED_CONTENT_TYPES: z
    .string()
    .default("video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg")
    .transform(csv),

  // ---- DynamoDB (may live in a different AWS account) ----------------------
  // If DDB_ROLE_ARN is unset we fall back to the default credential chain,
  // which is what you want for local development and same-account setups.
  DDB_ROLE_ARN: z.string().optional(),
  DDB_ROLE_SESSION_NAME: z.string().default("mediavault-api"),
  DDB_EXTERNAL_ID: z.string().optional(),
  DDB_ENDPOINT: z.string().optional(), // local DynamoDB for tests

  TABLE_ITEMS: z.string().min(1),
  TABLE_UPLOADS: z.string().min(1),
  TABLE_AUDIT: z.string().min(1),
  GSI_FEED: z.string().default("gsi1-feed"),
  GSI_TYPE: z.string().default("gsi2-type"),

  // ---- HTTP ---------------------------------------------------------------
  // CORS defaults OFF. In the deployed architecture API Gateway emits the CORS
  // headers; if this service emits them too the browser sees duplicate
  // Access-Control-Allow-Origin values and rejects the response — a failure
  // that is genuinely hard to spot because each header looks correct alone.
  // Turn this on only for local development against a Vite dev server.
  CORS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CORS_ORIGIN: z.string().default(""),

  RATE_LIMIT_PRESIGN_PER_MIN: z.coerce.number().int().positive().default(10),

  UPLOAD_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  AUDIT_TTL_DAYS: z.coerce.number().int().positive().default(30),

  MAX_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(50),
  DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(20),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  // Deliberately not using the logger: it depends on config, and this must work
  // before anything else is wired up.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  auditTtlSeconds: parsed.data.AUDIT_TTL_DAYS * 24 * 60 * 60,
});

export type Config = typeof config;
