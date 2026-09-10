/**
 * End-to-end color policy + container color-metadata probing (P0 color work).
 *
 * The product composites in the browser's sRGB canvas space and encodes SDR
 * 8-bit yuv420p. Two facts drive everything in this module (both verified
 * empirically against the shipping Chromium, see docs/COLOR.md):
 *
 *  - Decode honors container color tags. When a file carries complete
 *    matrix/primaries/transfer/range tags, decode and re-encode are correct
 *    regardless of which standard the file uses (BT.601, BT.709, full or
 *    limited range). When tags are MISSING, mediabunny's Chromium workaround
 *    fills BT.709/limited into the decoder config — an untagged file that was
 *    actually encoded as BT.601 (the ffmpeg/swscale default for untagged
 *    output) will shift on import. That case is detected and REPORTED here,
 *    never silently accepted.
 *  - The WebCodecs H.264 encoder in Chromium IGNORES
 *    VideoEncoderConfig.colorSpace: RGBA canvas frames are always converted
 *    with the BT.601 matrix and honestly tagged `smpte170m` + limited range.
 *    Re-tagging those bytes as BT.709 would be a lie about the pixels, so the
 *    WebCodecs route keeps its honest smpte170m tag. Routes where we control
 *    the RGB→YUV matrix (system-ffmpeg frame encoding) convert explicitly
 *    with BT.709 limited and tag completely — both routes round-trip
 *    correctly when tags are honored.
 *
 * Nothing here "fixes" a pixel problem by editing metadata labels: pixel
 * conversion and tagging always move together.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Normalized container-level color facts for one video stream. */
export interface ColorMetadataFacts {
  /** YUV↔RGB matrix coefficients, e.g. bt601/bt709; null when the container doesn't say. */
  readonly matrix: string | null;
  readonly primaries: string | null;
  readonly transfer: string | null;
  /** "tv" (limited) / "pc" (full); null when unspecified. */
  readonly range: "tv" | "pc" | null;
  readonly pixFmt: string | null;
  /** 8 for yuv420p-family 8-bit formats, 10/12 for p10/p12…, null when unknown. */
  readonly bitDepth: number | null;
  /**
   * Where the facts came from: "container" = ffprobe read real tags;
   * "unavailable" = ffprobe missing/failed — the color facts are unknown and
   * no support claim may be made.
   */
  readonly source: "container" | "unavailable";
}

/** Support verdict for one file against the documented SDR pipeline. */
export type ColorSupport =
  | "supported-sdr"
  /** Metadata absent: decode will ASSUME BT.709 limited; a BT.601-encoded file shifts. */
  | "unknown-metadata"
  | "unsupported-hdr"
  | "unsupported-bit-depth"
  | "unsupported-matrix"
  | "unverifiable";

export interface ColorSupportReport {
  readonly facts: ColorMetadataFacts;
  readonly support: ColorSupport;
  /**
   * Plain-language statements an agent or user can act on. Empty only for the
   * fully-tagged supported SDR case; never used to overclaim.
   */
  readonly notes: readonly string[];
}

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67", "smpte428"]);
const SDR_SUPPORTED_MATRICES = new Set(["bt709", "bt601", "smpte170m", "bt470bg", "smpte240m"]);
const SDR_SUPPORTED_PRIMARIES = new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m"]);
const SDR_SUPPORTED_TRANSFERS = new Set([
  "bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "gamma22", "gamma28",
]);

function normalizeToken(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return token.length === 0 || token === "unknown" || token === "unspecified" ? null : token;
}

function bitDepthOf(pixFmt: string | null): number | null {
  if (pixFmt === null) return null;
  if (/(10le|10be|p10)$/.test(pixFmt)) return 10;
  if (/(12le|12be|p12)$/.test(pixFmt)) return 12;
  if (/^(yuv|gray|nv|rgb|gbr)[a-z0-9]*$/.test(pixFmt) && !/(10|12|16)/.test(pixFmt)) return 8;
  return null;
}

/**
 * Assess normalized container facts against the documented policy. Pure: no
 * I/O, unit-testable. The untagged case is the important one — it is exactly
 * the "externally pre-composited file from a tool that wrote untagged
 * BT.601" scenario that shifted colors in the field.
 */
export function assessColorSupport(facts: ColorMetadataFacts): ColorSupportReport {
  if (facts.source === "unavailable") {
    return {
      facts,
      support: "unverifiable",
      notes: [
        "Color metadata could not be probed (ffprobe unavailable or failed); no color-correctness claim is made for this file.",
      ],
    };
  }
  const notes: string[] = [];
  const bitDepth = facts.bitDepth;
  // HDR first: HDR content is typically 10-bit too, and "HDR" is the
  // decisive exclusion an agent needs to see.
  if (facts.transfer !== null && HDR_TRANSFERS.has(facts.transfer)) {
    return {
      facts,
      support: "unsupported-hdr",
      notes: [
        `Transfer characteristics "${facts.transfer}" indicate HDR; only SDR (BT.601/BT.709, gamma 2.2/2.4-class transfers) is supported. HDR files are NOT tone-mapped — importing one does not preserve its intended look.`,
      ],
    };
  }
  if (bitDepth !== null && bitDepth > 8) {
    return {
      facts,
      support: "unsupported-bit-depth",
      notes: [
        `Pixel format ${facts.pixFmt} is ${bitDepth}-bit; the SDR pipeline composites and exports 8-bit — expect precision loss, and do not treat preview/export colors as bit-exact.`,
      ],
    };
  }
  if (facts.matrix !== null && !SDR_SUPPORTED_MATRICES.has(facts.matrix)) {
    return {
      facts,
      support: "unsupported-matrix",
      notes: [
        `Matrix coefficients "${facts.matrix}" are outside the supported SDR set (bt709/bt601/smpte170m/bt470bg/smpte240m); color conversion for this file is not verified.`,
      ],
    };
  }
  if (
    facts.matrix === null && facts.transfer === null && facts.primaries === null
    && facts.range === null
  ) {
    return {
      facts,
      support: "unknown-metadata",
      notes: [
        "No color metadata in the container. ReelTerminal decodes this file ASSUMING BT.709 limited range.",
        "If the file was actually encoded with BT.601 (a common default for untagged SD video and for ffmpeg-encoded intermediates), saturated reds/blues will visibly shift after import. Re-tag the source with its real matrix before relying on preview/export colors.",
      ],
    };
  }
  const missingTags = [
    facts.matrix === null ? "matrix" : null,
    facts.primaries === null ? "primaries" : null,
    facts.transfer === null ? "transfer" : null,
    facts.range === null ? "range" : null,
  ].filter((field): field is string => field !== null);
  if (
    facts.matrix === null || facts.primaries === null
    || facts.transfer === null || facts.range === null
  ) {
    return {
      facts,
      support: "unknown-metadata",
      notes: [
        `Container color tags are incomplete (missing ${missingTags.join(", ")}; matrix=${facts.matrix ?? "?"}, primaries=${facts.primaries ?? "?"}, transfer=${facts.transfer ?? "?"}, range=${facts.range ?? "?"}). Decode fills missing pieces from BT.709/limited defaults; no color-correctness claim is made without complete tags.`,
      ],
    };
  }
  if (facts.bitDepth === null) {
    return {
      facts,
      support: "unknown-metadata",
      notes: [
        `Pixel format ${facts.pixFmt ?? "?"} does not reveal a supported 8-bit precision; no color-correctness claim is made.`,
      ],
    };
  }
  if (!SDR_SUPPORTED_PRIMARIES.has(facts.primaries)) {
    return {
      facts,
      support: "unknown-metadata",
      notes: [
        `Color primaries "${facts.primaries}" are outside the verified SDR set (bt709/bt470m/bt470bg/smpte170m/smpte240m); no color-correctness claim is made.`,
      ],
    };
  }
  if (!SDR_SUPPORTED_TRANSFERS.has(facts.transfer)) {
    return {
      facts,
      support: "unknown-metadata",
      notes: [
        `Transfer characteristics "${facts.transfer}" are outside the verified SDR gamma set; no color-correctness claim is made.`,
      ],
    };
  }
  if (facts.range === "pc") {
    notes.push(
      "Full-range (pc) video: supported, but many downstream tools mishandle full-range YUV — expect small brightness differences when such tools re-decode the export.",
    );
  }
  return {
    facts,
    support: "supported-sdr",
    notes,
  };
}

interface FfprobeStreamShape {
  readonly codec_type?: string;
  readonly color_space?: string;
  readonly color_primaries?: string;
  readonly color_transfer?: string;
  readonly color_range?: string;
  readonly pix_fmt?: string;
}

/**
 * Probe container color metadata with the system ffprobe (same PATH-resolution
 * discipline as video-review/audio-analysis). Best-effort by design: a
 * missing ffprobe yields `source: "unavailable"` — the caller reports it,
 * never guessing.
 */
export async function probeColorMetadata(
  absPath: string,
  timeoutMs = 15_000,
): Promise<ColorMetadataFacts> {
  try {
    const { stdout } = await execute(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=color_space,color_primaries,color_transfer,color_range,pix_fmt",
        "-of", "json",
        absPath,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { streams?: FfprobeStreamShape[] };
    const stream = parsed.streams?.[0];
    if (!stream) {
      return emptyFacts("container");
    }
    const range = normalizeToken(stream.color_range);
    return {
      matrix: normalizeToken(stream.color_space),
      primaries: normalizeToken(stream.color_primaries),
      transfer: normalizeToken(stream.color_transfer),
      range: range === "tv" || range === "pc" ? range : null,
      pixFmt: normalizeToken(stream.pix_fmt),
      bitDepth: bitDepthOf(normalizeToken(stream.pix_fmt)),
      source: "container",
    };
  } catch {
    return emptyFacts("unavailable");
  }
}

function emptyFacts(source: "container" | "unavailable"): ColorMetadataFacts {
  return {
    matrix: null,
    primaries: null,
    transfer: null,
    range: null,
    pixFmt: null,
    bitDepth: null,
    source,
  };
}

/**
 * The working/export color policy as machine-readable disclosure. Exposed via
 * capabilities_get so external agents never have to guess how to decode
 * ReelTerminal outputs (see docs/COLOR.md for the full statement).
 */
export const COLOR_POLICY = {
  workingSpace: "sRGB (browser canvas compositing)",
  decode: {
    taggedContainers: "honored as-is (matrix/primaries/transfer/range from the container)",
    untaggedContainers: "assumed BT.709 limited — reported as unknown-metadata, not silently trusted",
  },
  export: {
    webcodecsRoute: {
      matrix: "bt601 (smpte170m)",
      range: "limited",
      tagging: "explicit VUI + colr written by the encoder; verified by regression tests",
      note: "Chromium's WebCodecs H.264 encoder ignores VideoEncoderConfig.colorSpace and always converts RGBA frames with the BT.601 matrix; the tag honestly describes the pixels.",
    },
    ffmpegFrameRoutes: {
      matrix: "bt709",
      range: "limited",
      tagging: "explicit scale=out_color_matrix=bt709:out_range=tv + x264 VUI colorprim/transfer/colormatrix=bt709",
    },
    unsupported: ["HDR transfers (PQ/HLG)", "10-bit+ precision", "non-SDR matrices"],
  },
  verification: "verify_artifact comparisons decode matrix-aware; never compare YUV through an assumed matrix",
} as const;
