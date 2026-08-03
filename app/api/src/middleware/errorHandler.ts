import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

/** 404 for anything no route matched. Mounted last, before the error handler. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * The single place an error becomes an HTTP response.
 *
 * The rule that matters: an ApiError carries a message we wrote and is safe to
 * return. Anything else is unknown in origin — an SDK exception, a TypeError,
 * a driver failure — and its message may contain table names, ARNs, internal
 * hostnames or fragments of a query. Those all become a flat 500 with a
 * generic message, and the real detail goes to the logs where it belongs.
 *
 * Stack traces are never sent to a client in any environment. In development
 * you have the terminal; in production it is an information leak.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    // The response is already streaming; the only correct move is to destroy
    // the socket rather than append garbage to a partial body.
    req.socket.destroy();
    return;
  }

  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path }, err.message);
    } else {
      logger.info(
        { code: err.code, status: err.status, path: req.path },
        "request rejected",
      );
    }

    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Body-parser throws this for malformed JSON before any of our code runs.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "unhandled error");

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: config.isProd
        ? "An internal error occurred"
        : String((err as Error)?.message ?? err),
    },
  });
}
