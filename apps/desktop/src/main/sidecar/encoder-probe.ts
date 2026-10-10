import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "./ffmpeg-path";
import { isSoftwareEncoder } from "./encode-args";

const run = promisify(execFile);

type ProbeOptions = {
  timeout: number;
  maxBuffer?: number;
};

type ProbeRunner = (
  args: string[],
  options: ProbeOptions,
) => Promise<{ stdout: string }>;

const HARDWARE_ENCODER_SUFFIX = /_(?:nvenc|qsv|amf|vaapi|videotoolbox)$/;
const PROBE_TIMEOUT_MS = 5_000;

const probeCache = new Map<string, Promise<string[]>>();

export function parseEncoders(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    // The name field must be a real encoder identifier so the legend block
    // (" V..... = Video") cannot produce bogus entries named "=".
    .map((line) => /^[VAS][.A-Z]{5}\s+([A-Za-z0-9_-]+)/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

function isHardwareEncoder(encoder: string): boolean {
  return HARDWARE_ENCODER_SUFFIX.test(encoder);
}

function isExpectedEncoderFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return (
    typeof failure.code === "number" ||
    failure.code === "ETIMEDOUT" ||
    failure.killed === true ||
    typeof failure.signal === "string"
  );
}

/** Check that FFmpeg can open the encoder on this machine, not just list it. */
export async function canOpenHardwareEncoder(
  encoder: string,
  execute: (args: string[], options: ProbeOptions) => Promise<unknown>,
): Promise<boolean> {
  try {
    const pixelFormat = encoder.startsWith("prores_")
      ? "yuv422p10le"
      : "yuv420p";
    await execute(
      [
        "-hide_banner",
        "-v", "error",
        "-f", "lavfi",
        "-i", "color=c=black:s=128x128:r=1",
        "-frames:v", "1",
        "-an",
        "-c:v", encoder,
        "-pix_fmt", pixelFormat,
        "-f", "null",
        "-",
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    if (isExpectedEncoderFailure(error)) return false;
    throw error;
  }
}

/** Filter hardware encoders through their real one-frame initialization. */
export async function filterUsableEncoders(
  encoders: readonly string[],
  canOpen: (encoder: string) => Promise<boolean>,
): Promise<string[]> {
  const usable: string[] = [];
  for (const encoder of encoders) {
    if (!isHardwareEncoder(encoder) || await canOpen(encoder)) {
      usable.push(encoder);
    }
  }
  return usable;
}

export async function probeEncoderAvailability(
  execute: ProbeRunner,
): Promise<string[]> {
  const { stdout } = await execute(
    ["-hide_banner", "-encoders"],
    { maxBuffer: 4 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS },
  );
  const listed = parseEncoders(stdout);
  return filterUsableEncoders(listed, (encoder) =>
    canOpenHardwareEncoder(encoder, execute),
  );
}

type Codec = "h264" | "h265" | "hevc" | "av1" | "prores" | "vp9";

const PREFERENCE: Partial<Record<Codec, Partial<Record<NodeJS.Platform | "any", string[]>>>> = {
  h264: {
    darwin: ["h264_videotoolbox"],
    win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
    linux: ["h264_nvenc", "h264_vaapi"],
    any: ["libx264"],
  },
  hevc: {
    darwin: ["hevc_videotoolbox"],
    win32: ["hevc_nvenc", "hevc_qsv", "hevc_amf"],
    linux: ["hevc_nvenc", "hevc_vaapi"],
    any: ["libx265"],
  },
  av1: {
    win32: ["av1_nvenc", "av1_qsv", "av1_amf"],
    linux: ["av1_nvenc", "av1_vaapi"],
    any: ["libsvtav1"],
  },
  prores: {
    darwin: ["prores_videotoolbox", "prores_ks"],
    any: ["prores_ks"],
  },
  vp9: {
    any: ["libvpx-vp9"],
  },
};

export function selectEncoder(
  codec: string,
  platform: NodeJS.Platform,
  available: string[],
  mode: "fast" | "balanced" | "smallest" = "balanced",
): string | null {
  const key = (codec === "h265" ? "hevc" : codec) as Codec;
  const pref = PREFERENCE[key];
  if (!pref) return null;
  const hardwareFirst = [...(pref[platform] ?? []), ...(pref.any ?? [])];
  const softwareFirst = [
    ...(pref.any ?? []),
    ...(pref[platform] ?? []),
  ];
  const ordered = mode === "smallest" ? softwareFirst : hardwareFirst;
  const pick = ordered.find((c) => available.includes(c));
  if (pick) return pick;
  return (
    [...hardwareFirst, ...softwareFirst].find(
      (c) => available.includes(c) && isSoftwareEncoder(c),
    ) ??
    [...hardwareFirst].find((c) => available.includes(c)) ??
    null
  );
}

export async function probeEncoders(): Promise<string[]> {
  const ffmpegPath = resolveFfmpegPath();
  const cached = probeCache.get(ffmpegPath);
  if (cached) return cached;

  const pending = probeEncoderAvailability((args, options) =>
    run(ffmpegPath, args, { ...options, windowsHide: true }),
  ).catch((error: unknown) => {
    // A missing or broken FFmpeg binary is not an empty encoder list. Let the
    // caller report it, and allow a later call to retry after the environment
    // is repaired.
    probeCache.delete(ffmpegPath);
    throw error;
  });
  probeCache.set(ffmpegPath, pending);
  return pending;
}
