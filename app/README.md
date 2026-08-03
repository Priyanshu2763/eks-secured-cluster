# MediaVault — application layer

The two deployable units. Everything here is **platform-agnostic**: credentials
come from the AWS SDK's default chain, which resolves an ECS Task Role, an EKS
IRSA role, or your local profile identically. Nothing in this directory knows or
cares which orchestrator it runs on.

```
app/
├── api/    Node 20+ · TypeScript · Express 5   → the CRUD + presign service
└── web/    React 18 · TypeScript · Vite        → the single-page frontend
```

## Quick start

Two terminals.

```bash
# terminal 1 — API on :8080
cd app/api
cp .env.example .env          # then edit MEDIA_BUCKET and the table names
npm install
npm run dev

# terminal 2 — web on :5173, proxying /api to :8080
cd app/web
npm install
npm run dev
```

Open <http://localhost:5173>.

You need real AWS credentials on your shell (`AWS_PROFILE`) plus an S3 bucket and
the three DynamoDB tables. Until those exist, `/healthz` returns 200 and
`/readyz` returns 503 — which is the correct behaviour, not a bug (see
*Liveness vs readiness* below).

## Commands

| | api | web |
|---|---|---|
| dev server | `npm run dev` | `npm run dev` |
| typecheck | `npm run typecheck` | `npm run typecheck` |
| build | `npm run build` | `npm run build` |
| test | `npm test` | — |
| run built output | `npm start` | `npm run preview` |

## The upload flow

The single most important thing to understand in this codebase.

```
browser                      api                    S3                DynamoDB
   │                          │                      │                    │
   │ POST /api/uploads/presign│                      │                    │
   │─────────────────────────►│ validate type+size   │                    │
   │                          │ generate the S3 key  │                    │
   │                          │ write UPLOAD TICKET ─┼───────────────────►│
   │                          │ SigV4-sign a PUT URL │                    │
   │◄─────────────────────────│ (local, no network)  │                    │
   │  {uploadId, uploadUrl}   │                      │                    │
   │                          │                      │                    │
   │ PUT bytes ───────────────┼─────────────────────►│  direct, never     │
   │◄──── 200 ────────────────┼──────────────────────│  through the API   │
   │                          │                      │                    │
   │ POST /api/media          │                      │                    │
   │  {uploadId, title}       │                      │                    │
   │─────────────────────────►│ load ticket ─────────┼───────────────────►│
   │                          │ expired? consumed?   │                    │
   │                          │ HeadObject(key) ────►│                    │
   │                          │ size/type match?     │                    │
   │                          │ consume ticket ──────┼──(conditional)────►│
   │                          │ write item ──────────┼───────────────────►│
   │◄─────── 201 ─────────────│                      │                    │
```

**Why the ticket exists.** The client never chooses an S3 key. It receives an
opaque `uploadId`; the server remembers which key it issued for that id. Without
this, `POST /api/media` would accept any key a caller named — including one
belonging to somebody else, or one that does not exist.

**Why `HeadObject` is not optional.** The ticket proves we issued a key; the head
request proves an object actually landed there and matches what was signed. Both
checks, not either.

**Why bytes bypass the API.** Partly efficiency, but mainly because they must:
API Gateway caps request payloads at **10 MB** and integrations at **30 seconds**.
A 200 MB video physically cannot be proxied. Presigned URLs are the only design
that works, which is why there is no `UPLOAD_MODE` switch.

## Design notes worth reading before changing things

**Liveness vs readiness.** `/healthz` checks nothing external, deliberately. If
it tested DynamoDB and the database blipped for 30 seconds, the orchestrator
would restart *every* replica simultaneously — turning a brief dependency hiccup
into a full outage. Restarting a process cannot fix someone else's outage.
`/readyz` does check DynamoDB, because failing readiness removes one replica from
the load balancer without restarting it. Result cached 5s so health polling
doesn't become a line item.

**Delete order is S3 first, then DynamoDB.** There is no transaction spanning the
two, so a crash between them is possible and the only question is which
inconsistent state you prefer. This order can leave a row pointing at a missing
object: visible in the UI, trivially cleaned up. The reverse leaves an orphaned
object with nothing referencing it — invisible, and billed forever. *When you
cannot be atomic, fail toward the state you can detect.*

**Cursor pagination, not page numbers.** DynamoDB has no `OFFSET`. A `Query`
returns `LastEvaluatedKey` and you hand it back. This is a feature — it is O(1)
at any depth — but it means "jump to page 7" is not answerable cheaply, hence
prev/next in the UI.

**An empty page does not mean the end.** With `?q=` set, DynamoDB filters *after*
reading, so a page can return zero items and still have a `nextCursor`. Clients
must follow the cursor until it is `null`, never stop on `items.length === 0`.

**No `Scan`, anywhere.** Enforced twice: the data-account IAM role does not grant
`dynamodb:Scan`, so a stray one fails with `AccessDenied` rather than quietly
costing money. The IAM policy and the data model agree on purpose.

**Rate limiting runs before validation.** Malformed requests consume quota too —
otherwise spamming garbage would be free. Note the limiter is per-process and
resets on restart; it is a backstop. API Gateway's per-route throttling is the
real control.

**CORS is off by default.** In deployment API Gateway emits the CORS headers. If
this service emitted them too the browser would see duplicate
`Access-Control-Allow-Origin` values and reject the response — a nasty failure
because each header looks correct alone. `CORS_ENABLED=true` is for local dev
only.

**Errors are safe-by-default.** Only an `ApiError` — one we constructed — has its
message returned. Anything else becomes a flat 500, because an SDK exception may
carry table names, ARNs or internal hostnames. Stack traces are never sent to a
client in any environment.

## Security properties, and where they live

| Control | Where |
|---|---|
| Content type allowlist | `schemas/media.ts` — server-side, client checks are UX only |
| Size ceiling bound into the signature | `lib/s3.ts` `signableHeaders` |
| S3 key never derived from the filename | `lib/ids.ts` `buildObjectKey` |
| Upload ticket is single-use | `repo/uploadRepo.ts` conditional write |
| Unknown request keys rejected | zod `.strict()` |
| No string-concatenated Dynamo expressions | `repo/mediaRepo.ts` — names/values only |
| Presigned URLs never logged | `logger.ts` redact list |
| Internal fields stripped from responses | `routes/media.ts` `toPublic` |
| XSS | React escaping; no `dangerouslySetInnerHTML` anywhere |
| Non-root, read-only rootfs, no shell | both `Dockerfile`s |

The client-side checks in `web/src/format.ts` exist so users learn about a bad
file instantly instead of after uploading 200 MB. They are **not** a security
control and are trivially bypassed; every one of them is re-checked server-side.

## Containers

```bash
docker build -t mediavault-api:dev app/api
docker build -t mediavault-web:dev app/web \
  --build-arg VITE_API_BASE_URL=https://api.example.com
```

The API image is **distroless** — no shell, no package manager. An attacker with
RCE lands somewhere with nothing to pivot with. The cost is that you cannot exec
into it; swap to a `:debug` tag temporarily if you must.

The web image is `nginx-unprivileged` listening on **8080**, because binding
below 1024 needs `CAP_NET_BIND_SERVICE` and the container drops all
capabilities.

Both need a writable `/tmp` when `readOnlyRootFilesystem` is set — mount an
`emptyDir` (Kubernetes) or a `tmpfs` volume (ECS). nginx in particular writes
several temp paths there and fails to start otherwise.

`VITE_API_BASE_URL` is baked in at **build** time: a static SPA has no server to
read env vars from. A different API endpoint means a rebuild. The CSP values
(`API_ORIGIN`, `MEDIA_SRC`) are substituted at **container start**, so those can
vary per environment without one.

## Environment

See `api/.env.example` and `web/.env.example`. In deployment the split matters:

- **non-secret config** (table names, bucket, region, role ARN) → task
  definition environment / ConfigMap
- **secrets** (`DDB_EXTERNAL_ID`) → Secrets Manager or SSM, injected at start

Mixing them means changing a table name requires touching your secret store.

Note there is **no database password** — DynamoDB access is IAM-authenticated via
the task/pod identity, so the credential simply does not exist to leak. That is
the strongest argument for AWS-native datastores.

## What is deliberately missing

- **Authentication.** Everything is attributed to `anonymous`. The seam is
  `lib/request.ts` `actorOf()`, and `ownerId` is already written to every item
  and audit event, so adding real auth is a small change rather than a migration.
- **Full-text search.** DynamoDB cannot do it efficiently. `?q=` uses a
  `FilterExpression`, which reads then filters — fine at demo scale, wrong at
  real scale. Real search means OpenSearch.
- **Multipart upload.** A single presigned `PUT` caps at 5 GB with no resume.
  Fine for a 200 MB limit; revisit if that grows.
- **Thumbnail generation / transcoding.** Would belong in an async worker
  triggered by S3 events, not in the request path.
