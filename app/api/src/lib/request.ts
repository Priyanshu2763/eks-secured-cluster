import type { Request } from "express";

/**
 * Who is making this request.
 *
 * There is no authentication yet, so everything is attributed to "anonymous".
 * This function exists so that adding real auth later is a one-line change
 * here rather than a hunt through every handler — the ownerId field is already
 * being written to every item and audit event, so the seam is in place.
 */
export function actorOf(_req: Request): string {
  return "anonymous";
}

/**
 * The client's IP.
 *
 * This is only trustworthy because of two upstream decisions:
 *
 *   1. `app.set("trust proxy", ...)` in app.ts, so Express parses
 *      X-Forwarded-For rather than reporting the proxy's own address.
 *   2. externalTrafficPolicy: Local / API Gateway forwarding, so the real
 *      client address survives the hop instead of being replaced by a node IP.
 *
 * Without both, this silently records load balancer addresses and the audit
 * trail becomes worthless without ever looking broken.
 */
export function sourceIpOf(req: Request): string | undefined {
  return req.ip;
}
