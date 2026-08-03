import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { mediaRouter } from "./routes/media.js";
import { uploadsRouter } from "./routes/uploads.js";

export function createApp(): Express {
  const app = express();

  /**
   * Behind a load balancer and API Gateway, the socket's peer address is the
   * proxy, not the client. Trusting X-Forwarded-For makes req.ip meaningful
   * again, which the audit trail and the rate limiter both depend on.
   *
   * `1` rather than `true`: trust exactly one proxy hop. Blanket-trusting the
   * whole chain lets a client prepend a forged X-Forwarded-For and choose its
   * own apparent IP, defeating per-IP limiting and poisoning the audit log.
   * Increase this only if you genuinely add another trusted hop.
   */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // This service returns JSON only; a CSP here governs nothing. The web
      // container sets its own CSP for the pages it serves.
      contentSecurityPolicy: false,
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      // Health checks are the majority of traffic and none of the signal.
      autoLogging: {
        ignore: (req) => req.url === "/healthz" || req.url === "/readyz",
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  /**
   * A tight body limit. Nothing this API accepts is large - the biggest body
   * is a create-media call with a title and description - and an unbounded
   * JSON parser on a public endpoint is a cheap denial-of-service.
   */
  app.use(express.json({ limit: "64kb" }));

  /**
   * CORS is OFF by default and that is intentional.
   *
   * In the deployed architecture API Gateway emits the CORS headers. If this
   * service emitted them too the browser would see duplicate
   * Access-Control-Allow-Origin values and reject the response - a failure
   * that is hard to spot because each header looks correct on its own.
   *
   * Enable it only for local development against the Vite dev server.
   */
  if (config.CORS_ENABLED && config.CORS_ORIGIN) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin === config.CORS_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        res.setHeader("Access-Control-Max-Age", "300");
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  app.use(healthRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/media", mediaRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
