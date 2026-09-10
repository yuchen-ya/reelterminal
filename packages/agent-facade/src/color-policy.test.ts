/**
 * Color-policy regression (P0): the facade must KNOW and REPORT what color
 * space every file is in — tagged SDR supported, untagged flagged as an
 * assumption, HDR/10-bit rejected as unsupported — and technicalQuality must
 * carry that verdict to agents. See docs/COLOR.md for the policy statement.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade } from "./index";
import { assessColorSupport } from "./color-policy";
import {
  writeColorPatternVideo,
} from "./media/fixtures/color-patterns";

describe("assessColorSupport (pure policy)", () => {
  it("accepts fully tagged SDR BT.709 limited", () => {
    const report = assessColorSupport({
      matrix: "bt709", primaries: "bt709", transfer: "bt709", range: "tv",
      pixFmt: "yuv420p", bitDepth: 8, source: "container",
    });
    expect(report.support).toBe("supported-sdr");
    expect(report.notes).toHaveLength(0);
  });

  it("accepts tagged SDR BT.601 limited", () => {
    const report = assessColorSupport({
      matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", range: "tv",
      pixFmt: "yuv420p", bitDepth: 8, source: "container",
    });
    expect(report.support).toBe("supported-sdr");
  });

  it("flags untagged files as an assumption with actionable notes", () => {
    const report = assessColorSupport({
      matrix: null, primaries: null, transfer: null, range: null,
      pixFmt: "yuv420p", bitDepth: 8, source: "container",
    });
    expect(report.support).toBe("unknown-metadata");
    expect(report.notes.join(" ")).toContain("BT.709");
    expect(report.notes.join(" ")).toContain("BT.601");
  });

  it("does not claim support when any required container color tag is missing", () => {
    for (const missing of ["matrix", "primaries", "transfer", "range"] as const) {
      const facts = {
        matrix: "bt709" as string | null,
        primaries: "bt709" as string | null,
        transfer: "bt709" as string | null,
        range: "tv" as "tv" | null,
        pixFmt: "yuv420p",
        bitDepth: 8,
        source: "container" as const,
      };
      facts[missing] = null;
      const report = assessColorSupport(facts);
      expect(report.support, missing).toBe("unknown-metadata");
      expect(report.notes.join(" "), missing).toContain(`missing ${missing}`);
    }
  });

  it("does not claim support for unverified primaries, transfer, or pixel precision", () => {
    const base = {
      matrix: "bt709", primaries: "bt709", transfer: "bt709", range: "tv" as const,
      pixFmt: "yuv420p", bitDepth: 8, source: "container" as const,
    };
    expect(assessColorSupport({ ...base, primaries: "bt2020" }).support).toBe("unknown-metadata");
    expect(assessColorSupport({ ...base, transfer: "log100" }).support).toBe("unknown-metadata");
    expect(assessColorSupport({ ...base, pixFmt: null, bitDepth: null }).support).toBe("unknown-metadata");
  });

  it("rejects HDR transfers without pretending to support them", () => {
    const report = assessColorSupport({
      matrix: "bt709", primaries: "bt2020", transfer: "smpte2084", range: "tv",
      pixFmt: "yuv420p10le", bitDepth: 10, source: "container",
    });
    expect(report.support).not.toBe("supported-sdr");
    expect(report.notes.join(" ")).toContain("HDR");
  });

  it("flags full range as supported-with-interop-notes", () => {
    const report = assessColorSupport({
      matrix: "bt709", primaries: "bt709", transfer: "bt709", range: "pc",
      pixFmt: "yuv420p", bitDepth: 8, source: "container",
    });
    expect(report.support).toBe("supported-sdr");
    expect(report.notes.join(" ")).toContain("full-range");
  });

  it("makes no support claim when ffprobe was unavailable", () => {
    const report = assessColorSupport({
      matrix: null, primaries: null, transfer: null, range: null,
      pixFmt: null, bitDepth: null, source: "unavailable",
    });
    expect(report.support).toBe("unverifiable");
  });
});

describe("media.analyze_start technicalQuality color disclosure", () => {
  let mediaRoot: string;
  let artifactRoot: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "color-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "color-artifacts-"));
    return async () => {
      await rm(mediaRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    };
  });

  async function analyzeColor(pathToMedia: string) {
    const facade = createAgentFacade({ mediaRoots: [mediaRoot], artifactRoot });
    const created = await facade["project.create"]({ name: "Color" });
    expect(created.ok).toBe(true);
    const imported = await facade["media.import"]({ path: pathToMedia });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const started = await facade["media.analyze_start"]({
      mediaId: imported.value.mediaId,
      analysisTypes: ["technicalQuality"],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("analyze failed");
    for (;;) {
      const status = await facade["job.status"]({ jobId: started.value.jobId });
      expect(status.ok).toBe(true);
      if (!status.ok) throw new Error("status failed");
      if (status.value.state === "done") {
        return status.value.result!.summary.technicalQuality as {
          color: { support: string; facts: { matrix: string | null }; notes: readonly string[] };
        };
      }
      if (status.value.state === "error") throw new Error("analysis errored");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  it(
    "reports tagged bt601 as supported, untagged as assumption, HDR as unsupported",
    { timeout: 240_000 },
    async () => {
      const cleanup = await (async () => undefined)();
      void cleanup;
      const bt601 = await analyzeColor(await writeColorPatternVideo(mediaRoot, "bt601"));
      expect(bt601.color.facts.matrix).toMatch(/bt601|smpte170m/);
      expect(bt601.color.support).toBe("supported-sdr");

      const untagged = await analyzeColor(await writeColorPatternVideo(mediaRoot, "untagged"));
      expect(untagged.color.support).toBe("unknown-metadata");
      expect(untagged.color.notes.join(" ")).toContain("BT.709");

      const hdr = await analyzeColor(await writeColorPatternVideo(mediaRoot, "hdr"));
      expect(hdr.color.support).toBe("unsupported-hdr");
    },
  );
});
