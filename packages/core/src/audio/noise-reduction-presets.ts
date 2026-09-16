import type { AudioEffectParams } from "../types/effects";

/**
 * Shared noise-reduction preset parameters — the single source of truth for
 * the GUI noise-reduction panel and the agent facade's clip.setNoiseReduction
 * op. Both import the SAME symbols so the parameter sets cannot drift, and
 * the op lands exactly the effect the panel would produce.
 *
 * The render engine consumes these as effect params of type
 * AudioEffectParams["noiseReduction"] (see audio-effects-engine.ts, which
 * derives its focus profiles from the same union), so this module only
 * re-states the contract it depends on.
 */

export const NOISE_REDUCTION_FOCUS_OPTIONS = [
  "balanced",
  "speech",
  "whiteNoise",
  "music",
  "heavy",
  "wind",
  "hum",
] as const;

export type NoiseReductionFocus = (typeof NOISE_REDUCTION_FOCUS_OPTIONS)[number];

/** Effect params shape consumed by the audio effects render chain. */
export type NoiseReductionEffectParams = AudioEffectParams["noiseReduction"];

/** Defaults used when a clip has no prior noiseReduction effect params. */
export const DEFAULT_NOISE_REDUCTION_SETTINGS: NoiseReductionEffectParams = {
  threshold: -40,
  reduction: 0.5,
  attack: 10,
  release: 100,
  focus: "balanced",
};

export interface NoiseReductionPreset {
  readonly id: NoiseReductionFocus;
  readonly label: string;
  readonly description: string;
  readonly config: NoiseReductionEffectParams;
}

export const NOISE_REDUCTION_PRESETS: readonly NoiseReductionPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description:
      "General cleanup for moderate room noise without pushing too hard.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -34,
      reduction: 0.56,
      attack: 10,
      release: 120,
      focus: "balanced",
    },
  },
  {
    id: "speech",
    label: "Speech Focus",
    description: "Preserve dialog presence while reducing hiss and ambient bed.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -36,
      reduction: 0.64,
      attack: 9,
      release: 130,
      focus: "speech",
    },
  },
  {
    id: "whiteNoise",
    label: "White Noise",
    description:
      "Aggressive broadband hiss removal for fans, air, camera preamp noise, and room tone.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -56,
      reduction: 0.92,
      attack: 6,
      release: 240,
      focus: "whiteNoise",
    },
  },
  {
    id: "music",
    label: "Music Bed",
    description:
      "Pushes background music down while keeping speech presence forward.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -48,
      reduction: 0.82,
      attack: 8,
      release: 220,
      focus: "music",
    },
  },
  {
    id: "heavy",
    label: "Heavy Noise",
    description:
      "More aggressive broadband cleanup for loud air, fan, and street wash.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -42,
      reduction: 0.8,
      attack: 14,
      release: 190,
      focus: "heavy",
    },
  },
  {
    id: "wind",
    label: "Wind & Rumble",
    description:
      "Targets low-end rumble, handling noise, and outdoor wind pressure.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -40,
      reduction: 0.74,
      attack: 8,
      release: 210,
      focus: "wind",
    },
  },
  {
    id: "hum",
    label: "Hum & HVAC",
    description:
      "Focused cleanup for tonal hum, AC drone, and power-line style noise.",
    config: {
      ...DEFAULT_NOISE_REDUCTION_SETTINGS,
      threshold: -38,
      reduction: 0.7,
      attack: 12,
      release: 170,
      focus: "hum",
    },
  },
];

export const getNoiseReductionPreset = (
  presetId: NoiseReductionFocus,
): NoiseReductionPreset =>
  NOISE_REDUCTION_PRESETS.find((preset) => preset.id === presetId) ??
  NOISE_REDUCTION_PRESETS[0]!;
