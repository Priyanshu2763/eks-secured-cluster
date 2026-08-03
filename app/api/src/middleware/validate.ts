import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodError, ZodTypeAny } from "zod";
import { badRequest } from "../lib/errors.js";

/**
 * Parse-and-stash middleware. The parsed value lands on `req.valid` and
 * handlers read it from there.
 *
 * Why not overwrite req.query in place? In Express 5 `req.query` is a
 * getter-only property, so assigning to it throws. Stashing the parsed result
 * separately works on both Express 4 and 5 and has the nicer property that the
 * raw and validated values never get confused for one another.
 */

declare global {
  namespace Express {
    interface Request {
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

/**
 * Field-level messages are safe and genuinely useful to a client: they carry
 * the path and the rule that failed, never the offending value. Echoing back
 * attacker-supplied input is how a validation error becomes a reflection bug.
 */
const toApiError = (err: ZodError) =>
  badRequest(
    "Request validation failed",
    err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );

type Target = "body" | "query" | "params";

const validate =
  (target: Target) =>
  (schema: ZodTypeAny): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(toApiError(result.error));
      return;
    }
    req.valid = { ...req.valid, [target]: result.data };
    next();
  };

export const validateBody = validate("body");
export const validateQuery = validate("query");
export const validateParams = validate("params");

/** Typed accessors so handlers avoid casting at every call site. */
export const body = <T>(req: Request): T => req.valid?.body as T;
export const query = <T>(req: Request): T => req.valid?.query as T;
export const params = <T>(req: Request): T => req.valid?.params as T;
