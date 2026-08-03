import { describe, expect, it } from "vitest";
import { buildObjectKey, mediaTypeOf, safeDisplayName } from "./ids.js";

/**
 * These tests exist because buildObjectKey is a security boundary, not a
 * formatting helper. Each case below corresponds to an attack the
 * server-generated-key design is meant to prevent.
 */
describe("buildObjectKey", () => {
  it("never incorporates a caller-supplied filename", () => {
    const key = buildObjectKey("uploads/", "video/mp4");
    expect(key).not.toContain("evil");
    expect(key).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/);
  });

  it("cannot be made to escape the prefix", () => {
    // Even a hostile prefix cannot produce traversal, because the filename
    // never reaches the key and the prefix is stripped of stray slashes.
    const key = buildObjectKey("///uploads///", "audio/mpeg");
    expect(key.startsWith("uploads/")).toBe(true);
    expect(key).not.toContain("..");
    expect(key).not.toContain("//");
  });

  it("derives the extension from the content type, not from user input", () => {
    expect(buildObjectKey("uploads/", "audio/mpeg")).toMatch(/\.mp3$/);
    expect(buildObjectKey("uploads/", "video/webm")).toMatch(/\.webm$/);
  });

  it("falls back to .bin for an unmapped type rather than guessing", () => {
    expect(buildObjectKey("uploads/", "application/x-weird")).toMatch(/\.bin$/);
  });

  it("produces a unique key on every call", () => {
    const keys = new Set(
      Array.from({ length: 500 }, () => buildObjectKey("uploads/", "video/mp4")),
    );
    expect(keys.size).toBe(500);
  });
});

describe("safeDisplayName", () => {
  it("strips directory components", () => {
    expect(safeDisplayName("../../etc/passwd")).toBe("passwd");
    expect(safeDisplayName("/tmp/clip.mp4")).toBe("clip.mp4");
  });

  it("removes control characters that would corrupt logs or headers", () => {
    expect(safeDisplayName("a\x00b\x1Fc\x7Fd.mp4")).toBe("abcd.mp4");
    expect(safeDisplayName("line\nbreak.mp4")).toBe("linebreak.mp4");
  });

  it("caps length", () => {
    expect(safeDisplayName("x".repeat(500)).length).toBe(200);
  });

  it("never returns an empty string", () => {
    expect(safeDisplayName("")).toBe("untitled");
    expect(safeDisplayName("///")).toBe("untitled");
  });
});

describe("mediaTypeOf", () => {
  it("classifies by MIME top-level type", () => {
    expect(mediaTypeOf("video/mp4")).toBe("video");
    expect(mediaTypeOf("audio/mpeg")).toBe("audio");
  });
});
