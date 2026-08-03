import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { ApiError } from "./errors.js";

describe("cursor", () => {
  it("round-trips a DynamoDB LastEvaluatedKey", () => {
    const key = { mediaId: "abc", gsi1pk: "FEED#ready", gsi1sk: "2026-01-01T00:00:00.000Z" };
    expect(decodeCursor(encodeCursor(key)!)).toEqual(key);
  });

  it("returns null for the end of the result set", () => {
    // DynamoDB omits LastEvaluatedKey on the final page; that must surface as
    // an explicit null so clients know to stop.
    expect(encodeCursor(undefined)).toBeNull();
  });

  it("treats an absent cursor as 'start from the beginning'", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("is URL-safe so it survives a query string unescaped", () => {
    const encoded = encodeCursor({ mediaId: "a+b/c=d", gsi1sk: "2026-01-01T00:00:00.000Z" })!;
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("rejects malformed input as a 400 rather than crashing", () => {
    expect(() => decodeCursor("not-base64!!!")).toThrow(ApiError);
    try {
      decodeCursor("bm90IGpzb24=");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }
  });

  it("rejects a JSON array, which would confuse ExclusiveStartKey", () => {
    const arrayCursor = Buffer.from("[1,2,3]", "utf8").toString("base64url");
    expect(() => decodeCursor(arrayCursor)).toThrow(ApiError);
  });

  it("does not echo the offending value back to the caller", () => {
    // The cursor is attacker-controlled; reflecting it is how a validation
    // message becomes a reflection bug.
    try {
      decodeCursor("<script>alert(1)</script>");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ApiError).message).toBe("Invalid cursor");
      expect((err as ApiError).message).not.toContain("script");
    }
  });
});
