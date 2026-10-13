import { describe, expect, it } from "vitest";
import {
  INVALID_PHASE_LABEL,
  anonymizeId,
  createRunSalt,
  defaultPrivacyLimits,
  sanitizeDims,
  sanitizeEvent,
  sanitizeLabel,
} from "./privacy";
import type { PerfEvent } from "@reelterminal/core";

const limits = defaultPrivacyLimits();

function event(overrides: Partial<PerfEvent>): PerfEvent {
  return {
    schemaVersion: 1,
    runId: "run",
    processRole: "renderer",
    processEpoch: "e",
    clockId: "c",
    seq: 1,
    kind: "mark",
    phase: "ok.phase",
    tsUs: 10,
    ...overrides,
  } as PerfEvent;
}

describe("sanitizeLabel", () => {
  it("keeps enum-like labels", () => {
    expect(sanitizeLabel("workspace.hydrate", limits)).toEqual({
      label: "workspace.hydrate",
      rejected: false,
      truncated: false,
    });
    expect(sanitizeLabel("span:with-colon", limits).rejected).toBe(true);
  });

  it("replaces paths, URLs and query strings wholesale", () => {
    expect(sanitizeLabel("C:\\Users\\me\\secret.prj", limits)).toEqual({
      label: INVALID_PHASE_LABEL,
      rejected: true,
      truncated: false,
    });
    expect(sanitizeLabel("https://x.test/a?token=abc", limits).rejected).toBe(true);
    expect(sanitizeLabel("", limits).rejected).toBe(true);
    expect(sanitizeLabel("with space", limits).rejected).toBe(true);
  });

  it("truncates valid-but-overlong labels", () => {
    const long = `a${"b".repeat(200)}`;
    const result = sanitizeLabel(long, limits);
    expect(result.rejected).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.label.length).toBe(limits.maxLabelLength);
  });
});

describe("sanitizeDims", () => {
  it("keeps finite numbers and booleans", () => {
    const result = sanitizeDims({ clipCount: 35, cacheHit: true, ratio: -1.5 }, limits);
    expect(result.dims).toEqual({ clipCount: 35, cacheHit: true, ratio: -1.5 });
    expect(result.dropped).toBe(0);
  });

  it("drops strings, objects and non-finite numbers without stringifying them", () => {
    const secrets = {
      mediaPath: "file:///C:/Users/u/private-video.mp4",
      subtitle: "机密字幕内容",
      token: "sk-live-abc123def456",
      fontDataUrl: `data:font/woff2;base64,${"A".repeat(1024)}`,
      nested: { path: "C:/secret" },
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
    } as unknown as Record<string, number | boolean>;
    const result = sanitizeDims(secrets, limits);
    expect(result.dims).toEqual({});
    expect(result.dropped).toBe(7);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "private-video",
      "机密字幕",
      "sk-live-abc123",
      "base64",
      "C:/secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("caps the number of surviving dims and drops invalid keys", () => {
    const many: Record<string, number | boolean> = {};
    for (let i = 0; i < 20; i += 1) many[`dim${i}`] = i;
    many["bad key"] = 1;
    const result = sanitizeDims(many, limits);
    expect(Object.keys(result.dims).length).toBe(limits.maxDimsPerEvent);
    expect(result.dims["bad key"]).toBeUndefined();
    expect(result.dropped).toBeGreaterThanOrEqual(5);
  });
});

describe("sanitizeEvent positive controls", () => {
  it("removes every secret from a hostile event", () => {
    const hostile = event({
      phase: "user-project/C:\\Users\\me\\untitled.prj?token=xyz",
      dims: {
        mediaPath: "file:///C:/Users/u/secret.mp4",
        errorMessage: "save failed for sk-abc123",
        clipCount: 7,
      } as unknown as Record<string, number | boolean>,
    });
    const { event: clean, labelsDropped, truncatedFields } = sanitizeEvent(hostile);
    expect(clean.phase).toBe(INVALID_PHASE_LABEL);
    expect(labelsDropped).toBe(1);
    expect(truncatedFields).toBe(0);
    const serialized = JSON.stringify(clean);
    for (const secret of [
      "untitled.prj",
      "token=xyz",
      "secret.mp4",
      "sk-abc123",
      "save failed",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect((clean as { dims?: Record<string, number | boolean> }).dims).toEqual({ clipCount: 7 });
  });
});

describe("anonymous ids", () => {
  it("is deterministic within a run and unlinkable across runs", () => {
    const saltA = createRunSalt();
    const saltB = createRunSalt();
    expect(saltA).not.toBe(saltB);
    expect(saltA).toMatch(/^[0-9a-f]{16}$/);
    const id1 = anonymizeId("my-private-project", saltA);
    const id2 = anonymizeId("my-private-project", saltA);
    const id3 = anonymizeId("my-private-project", saltB);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
    expect(id1).not.toContain("my-private-project");
  });

  it("distinguishes different names under the same salt", () => {
    const salt = createRunSalt();
    expect(anonymizeId("node-a", salt)).not.toBe(anonymizeId("node-b", salt));
  });
});
