import type { NextFunction, Request, RequestHandler, Response } from "express";
import { tooManyRequests } from "../lib/errors.js";

/**
 * A small fixed-window limiter for the presign endpoint.
 *
 * Read the limitation before relying on this: state lives in ONE process's
 * memory, so with N replicas the effective limit is N x what you configure,
 * and it resets whenever a task restarts. It is a cheap backstop, not the real
 * control.
 *
 * The real control is API Gateway's per-route throttling at the edge, which is
 * shared across every replica and rejects traffic before it reaches a
 * container at all. This exists so the service is still not trivially abusable
 * when someone runs it locally or reaches it directly during debugging —
 * defence in depth, deliberately modest.
 *
 * For a genuinely distributed limit you would keep counters in ElastiCache or
 * a DynamoDB item with a conditional increment. Both are more moving parts
 * than this app warrants.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function fixedWindowLimiter(opts: {
  limit: number;
  windowMs: number;
  keyFn?: (req: Request) => string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? "unknown");

  // Bound memory: without this, a burst of unique client IPs grows the map
  // forever, which turns a rate limiter into a slow memory leak.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, opts.windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFn(req);
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      setHeaders(res, opts.limit, opts.limit - 1, now + opts.windowMs);
      next();
      return;
    }

    existing.count += 1;

    if (existing.count > opts.limit) {
      setHeaders(res, opts.limit, 0, existing.resetAt);
      res.setHeader("Retry-After", Math.ceil((existing.resetAt - now) / 1000));
      next(tooManyRequests("Too many upload requests; slow down"));
      return;
    }

    setHeaders(res, opts.limit, opts.limit - existing.count, existing.resetAt);
    next();
  };
}

function setHeaders(res: Response, limit: number, remaining: number, resetAt: number) {
  res.setHeader("RateLimit-Limit", limit);
  res.setHeader("RateLimit-Remaining", Math.max(0, remaining));
  res.setHeader("RateLimit-Reset", Math.ceil((resetAt - Date.now()) / 1000));
}
