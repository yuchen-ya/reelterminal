/**
 * Pure unit tests for the ffmpeg helper predicates in ffmpeg.ts — no ffmpeg
 * binary and no process spawning involved.
 */
import { describe, expect, it } from "vitest";

import { looksLikeMp4 } from "./ffmpeg";

describe("looksLikeMp4", () => {
  it("accepts a plain mp4 format name", () => {
    expect(looksLikeMp4("mp4")).toBe(true);
  });

  it("accepts mp4 among ffprobe's comma-separated tokens", () => {
    expect(looksLikeMp4("mov,mp4,m4a,3gp,3g2,mj2")).toBe(true);
    expect(looksLikeMp4(" mp4 ")).toBe(true);
  });

  it("rejects a pure QuickTime MOV", () => {
    expect(looksLikeMp4("mov")).toBe(false);
    expect(looksLikeMp4("mov,text")).toBe(false);
  });

  it("rejects undefined, empty, and unrelated formats", () => {
    expect(looksLikeMp4(undefined)).toBe(false);
    expect(looksLikeMp4("")).toBe(false);
    expect(looksLikeMp4("matroska,webm")).toBe(false);
  });
});
