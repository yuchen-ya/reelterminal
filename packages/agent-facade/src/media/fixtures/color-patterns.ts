/**
 * Deterministic color test patterns for the end-to-end color pipeline
 * regression (docs/COLOR.md acceptance):
 *
 *  - `writeColorPatternPng`: a 320×180 PNG with seven full-height bars —
 *    saturated red/green/blue, white, black, mid gray and a skin tone. PNG is
 *    RGB: the reference colors are exact and matrix-independent.
 *  - `writeColorPatternVideo`: the same bars as an H.264/yuv420p MP4 with a
 *    selectable color-tag variant ("untagged" | "bt601" | "bt709" | "hdr"),
 *    encoding through the same explicit-matrix ffmpeg discipline the product
 *    routes use.
 *
 * Everything is generated with the system ffmpeg from `-f lavfi` sources —
 * no binary fixtures live in the repository, and every byte is reproducible.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const COLOR_PATTERN_WIDTH = 320;
export const COLOR_PATTERN_HEIGHT = 180;
export const COLOR_PATTERN_DURATION_SEC = 2;
export const COLOR_PATTERN_FRAME_RATE = 10;

/**
 * Bar colors (RGB): saturated red/green/blue are the colors the BT.601↔BT.709
 * matrix mixup shifts hardest; white/black/gray catch range errors; the skin
 * tone catches the subtle hue rotation real footage shows.
 */
export const COLOR_PATTERN_PALETTE: readonly (readonly [number, number, number])[] = [
  [192, 0, 0],
  [0, 192, 0],
  [0, 0, 192],
  [255, 255, 255],
  [0, 0, 0],
  [128, 128, 128],
  [200, 150, 125],
];

export type ColorPatternVariant = "untagged" | "bt601" | "bt709" | "hdr";

/** Per-bar lavfi color sources + an hstack filter_complex — identical pixels in every variant. */
function barGraph(): {
  readonly inputs: readonly string[];
  readonly filterComplex: string;
} {
  const barWidth = Math.ceil(COLOR_PATTERN_WIDTH / COLOR_PATTERN_PALETTE.length);
  const inputs: string[] = [];
  COLOR_PATTERN_PALETTE.forEach(([r, g, b], index) => {
    const width = index === COLOR_PATTERN_PALETTE.length - 1
      ? COLOR_PATTERN_WIDTH - barWidth * (COLOR_PATTERN_PALETTE.length - 1)
      : barWidth;
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    inputs.push(
      "-f", "lavfi", "-i",
      `color=c=0x${hex}:s=${width}x${COLOR_PATTERN_HEIGHT}:r=${COLOR_PATTERN_FRAME_RATE}:d=${COLOR_PATTERN_DURATION_SEC}`,
    );
  });
  const pads = COLOR_PATTERN_PALETTE.map((_, index) => `[${index}:v]`);
  return {
    inputs,
    filterComplex: `${pads.join("")}hstack=inputs=${COLOR_PATTERN_PALETTE.length}[v]`,
  };
}

function encodeArgs(variant: ColorPatternVariant): string[] {
  const { filterComplex } = barGraph();
  const shared = [
    "-t", String(COLOR_PATTERN_DURATION_SEC),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  const chain = filterComplex.replace(/\[v\]$/, "");
  const withScale = (matrix: string): string[] => [
    "-filter_complex", `${chain},scale=out_color_matrix=${matrix}:out_range=tv[v]`,
    "-map", "[v]",
  ];
  const noScale = (): string[] => [
    "-filter_complex", filterComplex,
    "-map", "[v]",
  ];
  switch (variant) {
    case "untagged":
      // swscale default matrix (bt601), no VUI — the classic
      // externally-precomposed-intermediate shape.
      return [...noScale(), ...shared];
    case "bt601":
      return [
        ...withScale("bt601"),
        ...shared,
        "-x264-params", "colorprim=smpte170m:transfer=smpte170m:colormatrix=smpte170m",
        "-color_range", "tv",
      ];
    case "bt709":
      return [
        ...withScale("bt709"),
        ...shared,
        "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
        "-color_range", "tv",
      ];
    case "hdr":
      // PQ transfer in an 8-bit yuv420p stream: intentionally outside the
      // supported SDR pipeline — the probe must say so, not the pixels.
      return [
        ...noScale(),
        ...shared,
        "-x264-params", "transfer=smpte2084:colormatrix=bt709:colorprim=bt709",
        "-color_range", "tv",
      ];
  }
}

export async function writeColorPatternPng(dir: string): Promise<string> {
  const outPath = path.join(dir, "color-pattern.png");
  const chain = barGraph().filterComplex.replace(/\[v\]$/, "");
  await execute(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-v", "error",
      ...barGraph().inputs,
      "-filter_complex", `${chain},trim=end_frame=1[v]`,
      "-map", "[v]",
      "-frames:v", "1",
      "-y", outPath,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return outPath;
}

export async function writeColorPatternVideo(
  dir: string,
  variant: ColorPatternVariant,
): Promise<string> {
  const outPath = path.join(dir, `color-pattern-${variant}.mp4`);
  await execute(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-v", "error",
      ...barGraph().inputs,
      ...encodeArgs(variant),
      "-y", outPath,
    ],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return outPath;
}
