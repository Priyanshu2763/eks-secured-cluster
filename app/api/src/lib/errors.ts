/**
 * Typed errors so routes can throw meaningfully and one handler decides the
 * HTTP shape. The important property: the message on an ApiError is safe to
 * show a client, and anything that is NOT an ApiError is assumed unsafe and
 * becomes a generic 500. That default protects you from leaking stack traces,
 * table names, ARNs and SDK internals through an unhandled edge case.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", message, details);

export const notFound = (message = "Resource not found") =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (message: string) =>
  new ApiError(409, "CONFLICT", message);

export const payloadTooLarge = (message: string) =>
  new ApiError(413, "PAYLOAD_TOO_LARGE", message);

export const unsupportedMediaType = (message: string) =>
  new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", message);

export const tooManyRequests = (message = "Too many requests") =>
  new ApiError(429, "TOO_MANY_REQUESTS", message);

export const serviceUnavailable = (message = "Service unavailable") =>
  new ApiError(503, "SERVICE_UNAVAILABLE", message);
