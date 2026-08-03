import { Router } from "express";
import { probe } from "../repo/mediaRepo.js";
import { logger } from "../logger.js";

export const healthRouter: Router = Router();

/**
 * LIVENESS — "is this process wedged?"
 *
 * Checks nothing external, on purpose. If this endpoint tested DynamoDB and
 * the database had a 30-second blip, the orchestrator would conclude every
 * replica was broken and restart ALL of them at once, converting a brief
 * dependency hiccup into a full outage plus a thundering-herd reconnect on
 * recovery. Restarting a process cannot fix someone else's outage, so a
 * dependency has no business in a liveness check.
 */
healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeSec: Math.floor(process.uptime()) });
});

/**
 * READINESS — "should I receive traffic right now?"
 *
 * Here dependency checks ARE correct: failing readiness removes this replica
 * from the load balancer without restarting it, so it can rejoin the moment
 * the dependency recovers.
 *
 * The result is cached briefly so that a load balancer polling every few
 * seconds across N replicas does not turn health checking into a meaningful
 * share of your DynamoDB bill.
 */
const CACHE_MS = 5_000;
let cached: { at: number; ok: boolean; error?: string } | null = null;

healthRouter.get("/readyz", async (_req, res) => {
  const now = Date.now();

  if (cached && now - cached.at < CACHE_MS) {
    sendReadiness(res, cached.ok, cached.error);
    return;
  }

  try {
    await probe();
    cached = { at: now, ok: true };
    sendReadiness(res, true);
  } catch (err) {
    const message = (err as Error)?.name ?? "unknown";
    cached = { at: now, ok: false, error: message };
    logger.warn({ err }, "readiness probe failed");
    sendReadiness(res, false, message);
  }
});

function sendReadiness(
  res: import("express").Response,
  ok: boolean,
  error?: string,
): void {
  if (ok) {
    res.status(200).json({ status: "ready", checks: { dynamodb: "ok" } });
    return;
  }
  // Never leak the raw SDK message; the error NAME is enough to distinguish
  // AccessDenied from a timeout while debugging.
  res.status(503).json({
    status: "not_ready",
    checks: { dynamodb: error ?? "failed" },
  });
}
