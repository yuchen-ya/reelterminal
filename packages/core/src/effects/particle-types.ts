export type ParticleEffectType =
  | "dissolve"
  | "explode"
  | "implode"
  | "confetti"
  | "dust"
  | "sparkle"
  | "disintegrate"
  | "pixelate"
  | "shatter"
  | "morph";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface ParticleConfig {
  particleCount: number;
  speed: number;
  speedVariance: number;
  gravity: number;
  wind: Vector3;
  turbulence: number;
  colors: string[];
  size: { min: number; max: number };
  opacity: { start: number; end: number };
  lifetime: { min: number; max: number };
  emissionRate: number;
  emissionShape: "point" | "line" | "circle" | "rectangle" | "sphere";
  emissionRadius: number;
  rotationSpeed: number;
  fadeIn: number;
  fadeOut: number;
  blendMode: "normal" | "add" | "multiply" | "screen";
}

export interface ParticleEffect {
  id: string;
  clipId: string;
  type: ParticleEffectType;
  startTime: number;
  duration: number;
  config: ParticleConfig;
  enabled: boolean;
}

export interface Particle {
  id: string;
  position: Vector3;
  velocity: Vector3;
  acceleration: Vector3;
  color: string;
  size: number;
  opacity: number;
  rotation: number;
  rotationSpeed: number;
  lifetime: number;
  age: number;
  active: boolean;
}

export interface EmitterState {
  effectId: string;
  particles: Particle[];
  elapsedTime: number;
  emissionAccumulator: number;
  active: boolean;
}

export const DEFAULT_PARTICLE_CONFIG: ParticleConfig = {
  particleCount: 100,
  speed: 100,
  speedVariance: 50,
  gravity: 200,
  wind: { x: 0, y: 0, z: 0 },
  turbulence: 10,
  colors: ["#ffffff"],
  size: { min: 2, max: 8 },
  opacity: { start: 1, end: 0 },
  lifetime: { min: 0.5, max: 2 },
  emissionRate: 50,
  emissionShape: "point",
  emissionRadius: 10,
  rotationSpeed: 0,
  fadeIn: 0.1,
  fadeOut: 0.3,
  blendMode: "add",
};

/** Validate persisted effect data before it reaches timeline rendering. */
export function validParticleEffects(value: unknown): value is ParticleEffect[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const finite = (item: unknown): item is number =>
    typeof item === "number" && Number.isFinite(item);
  const range = (item: unknown, min: number, max: number) =>
    finite(item) && item >= min && item <= max;
  return value.every((effect) => {
    if (!effect || typeof effect !== "object" ||
        typeof effect.id !== "string" || !effect.id ||
        typeof effect.clipId !== "string" || !effect.clipId ||
        ![
          "dissolve", "explode", "implode", "confetti", "dust", "sparkle",
          "disintegrate", "pixelate", "shatter", "morph",
        ].includes(effect.type) ||
        !finite(effect.startTime) || effect.startTime < 0 ||
        !finite(effect.duration) || effect.duration <= 0 ||
        typeof effect.enabled !== "boolean") {
      return false;
    }
    const config = effect.config;
    if (!config || typeof config !== "object") return false;
    return range(config.particleCount, 0, 10000) &&
      [config.speed, config.speedVariance, config.gravity, config.turbulence,
        config.emissionRate, config.emissionRadius, config.rotationSpeed].every(finite) &&
      // The inspector permits up to 200; the burst preset uses 500. Bound
      // imported emission work to the supported range before scheduling.
      range(config.emissionRate, 0, 500) &&
      config.wind && [config.wind.x, config.wind.y, config.wind.z].every(finite) &&
      Array.isArray(config.colors) && config.colors.length > 0 &&
      config.colors.every((color: unknown) => typeof color === "string" && color.length > 0) &&
      config.size && [config.size.min, config.size.max].every(
        (size) => finite(size) && size > 0,
      ) &&
      config.lifetime && [config.lifetime.min, config.lifetime.max].every(
        (lifetime) => finite(lifetime) && lifetime > 0,
      ) &&
      config.opacity && range(config.opacity.start, 0, 1) && range(config.opacity.end, 0, 1) &&
      range(config.fadeIn, 0, 1) && range(config.fadeOut, 0, 1) && config.fadeIn + config.fadeOut <= 1 &&
      ["point", "line", "circle", "rectangle", "sphere"].includes(config.emissionShape) &&
      ["normal", "add", "multiply", "screen"].includes(config.blendMode);
  });
}
