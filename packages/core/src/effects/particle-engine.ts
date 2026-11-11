import {
  type Particle,
  type ParticleEffect,
  type ParticleConfig,
  type EmitterState,
  type Vector3,
  DEFAULT_PARTICLE_CONFIG,
} from "./particle-types";

type Random = () => number;

function seededRandom(effectId: string, index: number): Random {
  let state = 2166136261;
  for (const character of `${effectId}:${index}`) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(random: Random, min: number, max: number): number {
  return min + random() * (max - min);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

function lerpColor(color1: string, color2: string, t: number): string {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r},${g},${b})`;
}

function getEmissionPosition(config: ParticleConfig, center: Vector3, random: Random): Vector3 {
  switch (config.emissionShape) {
    case "circle": {
      const angle = random() * Math.PI * 2;
      const r = random() * config.emissionRadius;
      return {
        x: center.x + Math.cos(angle) * r,
        y: center.y + Math.sin(angle) * r,
        z: center.z,
      };
    }
    case "sphere": {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const r = random() * config.emissionRadius;
      return {
        x: center.x + r * Math.sin(phi) * Math.cos(theta),
        y: center.y + r * Math.sin(phi) * Math.sin(theta),
        z: center.z + r * Math.cos(phi),
      };
    }
    case "rectangle": {
      return {
        x: center.x + randomRange(random, -config.emissionRadius, config.emissionRadius),
        y: center.y + randomRange(random, -config.emissionRadius, config.emissionRadius),
        z: center.z,
      };
    }
    case "line": {
      return {
        x: center.x + randomRange(random, -config.emissionRadius, config.emissionRadius),
        y: center.y,
        z: center.z,
      };
    }
    case "point":
    default:
      return { ...center };
  }
}

function getInitialVelocity(
  config: ParticleConfig,
  effectType: string,
  center: Vector3,
  position: Vector3,
  random: Random,
): Vector3 {
  const speed = config.speed + randomRange(random, -config.speedVariance, config.speedVariance);

  switch (effectType) {
    case "explode": {
      const dx = position.x - center.x;
      const dy = position.y - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      return {
        x: (dx / dist) * speed + randomRange(random, -20, 20),
        y: (dy / dist) * speed + randomRange(random, -20, 20),
        z: randomRange(random, -speed * 0.5, speed * 0.5),
      };
    }
    case "implode": {
      const dx = center.x - position.x;
      const dy = center.y - position.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      return {
        x: (dx / dist) * speed,
        y: (dy / dist) * speed,
        z: 0,
      };
    }
    case "confetti": {
      return {
        x: randomRange(random, -speed, speed),
        y: -Math.abs(speed) * randomRange(random, 0.5, 1.5),
        z: randomRange(random, -speed * 0.3, speed * 0.3),
      };
    }
    case "dust":
    case "sparkle": {
      const angle = random() * Math.PI * 2;
      return {
        x: Math.cos(angle) * speed * 0.3,
        y: Math.sin(angle) * speed * 0.3 - speed * 0.2,
        z: randomRange(random, -10, 10),
      };
    }
    case "disintegrate": {
      return {
        x: randomRange(random, -speed * 0.5, speed * 0.5),
        y: -speed * randomRange(random, 0.3, 0.8),
        z: randomRange(random, -speed * 0.2, speed * 0.2),
      };
    }
    case "shatter": {
      const angle = random() * Math.PI * 2;
      return {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed - speed * 0.5,
        z: randomRange(random, -speed * 0.5, speed * 0.5),
      };
    }
    case "dissolve":
    default: {
      const angle = random() * Math.PI * 2;
      return {
        x: Math.cos(angle) * speed * 0.5,
        y: Math.sin(angle) * speed * 0.5,
        z: 0,
      };
    }
  }
}

interface ParticleBirth {
  readonly particle: Particle;
  readonly time: number;
}

interface ParticleSchedule {
  readonly config: ParticleConfig;
  readonly startTime: number;
  readonly width: number;
  readonly height: number;
  sampledTime: number;
  nextIndex: number;
  lastBirthTime: number;
  births: ParticleBirth[];
}

// Cache only live births for each effect object. Rewinding rebuilds the schedule;
// project ownership and cache lifetime follow the document's effect objects.
const particleSchedules = new WeakMap<ParticleEffect, ParticleSchedule>();

function createScheduledParticle(
  effect: ParticleEffect,
  index: number,
  width: number,
  height: number,
): Particle {
  const config = effect.config;
  const random = seededRandom(effect.id, index);
  const center = { x: width / 2, y: height / 2, z: 0 };
  const position = getEmissionPosition(config, center, random);
  const velocity = getInitialVelocity(config, effect.type, center, position, random);
  const color = config.colors[Math.floor(random() * config.colors.length)];
  const size = randomRange(random, config.size.min, config.size.max);
  const rotation = random() * Math.PI * 2;
  const rotationSpeed = randomRange(random, -config.rotationSpeed, config.rotationSpeed);
  const lifetime = randomRange(random, config.lifetime.min, config.lifetime.max);
  return {
    id: `${effect.id}:${index}`,
    position,
    velocity,
    acceleration: {
      x: config.wind.x + randomRange(random, -config.turbulence, config.turbulence),
      y: config.gravity + config.wind.y + randomRange(random, -config.turbulence, config.turbulence),
      z: config.wind.z,
    },
    color,
    size,
    opacity: config.opacity.start,
    rotation,
    rotationSpeed,
    lifetime,
    age: 0,
    active: true,
  };
}

/** Absolute timeline sampling: seeks, repeated frames and export do not advance state. */
export function getParticlesAtTime(
  effect: ParticleEffect,
  currentTime: number,
  width: number,
  height: number,
): Particle[] {
  const time = currentTime - effect.startTime;
  const config = effect.config;
  const capacity = Math.floor(config.particleCount);
  if (!effect.enabled || time < 0 || time >= effect.duration ||
      config.emissionRate <= 0 || capacity <= 0) return [];

  let schedule = particleSchedules.get(effect);
  if (!schedule || schedule.config !== config || schedule.startTime !== effect.startTime ||
      schedule.width !== width || schedule.height !== height || schedule.sampledTime > time) {
    schedule = {
      config, startTime: effect.startTime, width, height,
      sampledTime: -1, nextIndex: 0, lastBirthTime: 0, births: [],
    };
    particleSchedules.set(effect, schedule);
  }

  for (;;) {
    let birthTime = Math.max(
      (schedule.nextIndex + 1) / config.emissionRate,
      schedule.lastBirthTime,
    );
    const remainingBirths = schedule.births.filter(
      (birth) => birth.time + birth.particle.lifetime > birthTime,
    );
    if (remainingBirths.length >= capacity) {
      // A full emitter retains its particles until they die. Emission debt is
      // then used to fill the free slots, matching the existing capacity contract.
      birthTime = Math.min(...remainingBirths.map(
        (birth) => birth.time + birth.particle.lifetime,
      ));
    }
    if (birthTime > time) break;
    schedule.births = schedule.births.filter(
      (birth) => birth.time + birth.particle.lifetime > birthTime,
    );
    schedule.births.push({
      particle: createScheduledParticle(effect, schedule.nextIndex, width, height),
      time: birthTime,
    });
    schedule.nextIndex++;
    schedule.lastBirthTime = birthTime;
  }
  schedule.sampledTime = time;

  return schedule.births.filter((birth) => birth.time + birth.particle.lifetime > time)
    .map(({ particle, time: birthTime }) => {
      const age = time - birthTime;
      const position = { ...particle.position };
      const velocity = { ...particle.velocity };
      for (const axis of ["x", "y", "z"] as const) {
        position[axis] += velocity[axis] * age + particle.acceleration[axis] * age * age / 2;
        velocity[axis] += particle.acceleration[axis] * age;
      }
      const progress = age / particle.lifetime;
      let opacity: number;
      if (progress < config.fadeIn) {
        opacity = config.opacity.start * progress / config.fadeIn;
      } else if (progress > 1 - config.fadeOut) {
        opacity = config.opacity.end + (config.opacity.start - config.opacity.end) *
          (1 - progress) / config.fadeOut;
      } else {
        const middleDuration = 1 - config.fadeIn - config.fadeOut;
        const middle = middleDuration > 0 ? (progress - config.fadeIn) / middleDuration : 1;
        opacity = config.opacity.start + (config.opacity.end - config.opacity.start) * middle;
      }
      return {
        ...particle,
        position,
        velocity,
        age,
        opacity,
        rotation: particle.rotation + particle.rotationSpeed * age,
      };
    });
}

/** Shared project-pixel drawing for preview, frame capture and export. */
export function renderParticlesToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  effects: readonly ParticleEffect[],
  time: number,
  width: number,
  height: number,
  layoutSize = { width, height },
): void {
  ctx.save();
  ctx.scale(width / layoutSize.width, height / layoutSize.height);
  for (const effect of effects) {
    ctx.globalCompositeOperation = effect.config.blendMode === "add"
      ? "lighter" : effect.config.blendMode === "normal"
        ? "source-over" : effect.config.blendMode;
    for (const particle of getParticlesAtTime(effect, time, layoutSize.width, layoutSize.height)) {
      if (particle.opacity <= 0) continue;
      ctx.globalAlpha = particle.opacity;
      ctx.fillStyle = particle.color;
      ctx.save();
      ctx.translate(particle.position.x, particle.position.y);
      ctx.rotate(particle.rotation);
      if (effect.type === "confetti" || effect.type === "pixelate") {
        ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

export class ParticleEngine {
  private emitters: Map<string, EmitterState> = new Map();
  private effects: Map<string, ParticleEffect> = new Map();
  private canvasWidth: number = 1920;
  private canvasHeight: number = 1080;
  private changeListeners: Set<() => void> = new Set();
  private changeVersion: number = 0;

  onEffectsChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    this.changeVersion++;
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  getChangeVersion(): number {
    return this.changeVersion;
  }

  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  addEffect(effect: ParticleEffect): void {
    this.effects.set(effect.id, effect);
    this.emitters.set(effect.id, {
      effectId: effect.id,
      particles: [],
      elapsedTime: 0,
      emissionAccumulator: 0,
      active: false,
    });
    this.notifyChange();
  }

  removeEffect(effectId: string): void {
    this.effects.delete(effectId);
    this.emitters.delete(effectId);
    this.notifyChange();
  }

  updateEffect(effectId: string, updates: Partial<ParticleConfig>): void {
    const effect = this.effects.get(effectId);
    if (effect) {
      effect.config = { ...effect.config, ...updates };
      this.notifyChange();
    }
  }

  updateEffectTiming(effectId: string, startTime: number, duration: number): void {
    const effect = this.effects.get(effectId);
    if (effect) {
      effect.startTime = startTime;
      effect.duration = duration;
      this.notifyChange();
    }
  }

  getEffect(effectId: string): ParticleEffect | undefined {
    return this.effects.get(effectId);
  }

  getAllEffects(): ParticleEffect[] {
    return Array.from(this.effects.values());
  }

  getEffectsForClip(clipId: string): ParticleEffect[] {
    return Array.from(this.effects.values()).filter(e => e.clipId === clipId);
  }

  toggleEffect(effectId: string, enabled: boolean): void {
    const effect = this.effects.get(effectId);
    if (effect) {
      effect.enabled = enabled;
      this.notifyChange();
    }
  }

  update(currentTime: number, _deltaTime = 0): void {
    for (const [effectId, emitter] of this.emitters) {
      const effect = this.effects.get(effectId)!;
      emitter.active = effect.enabled && currentTime >= effect.startTime &&
        currentTime < effect.startTime + effect.duration;
      emitter.elapsedTime = currentTime - effect.startTime;
      emitter.particles = getParticlesAtTime(
        effect, currentTime, this.canvasWidth, this.canvasHeight,
      );
    }
  }

  getParticles(effectId?: string): Particle[] {
    if (effectId) {
      const emitter = this.emitters.get(effectId);
      return emitter ? emitter.particles : [];
    }

    const allParticles: Particle[] = [];
    for (const emitter of this.emitters.values()) {
      if (emitter.active) {
        allParticles.push(...emitter.particles);
      }
    }
    return allParticles;
  }

  getActiveEffectIds(): string[] {
    const activeIds: string[] = [];
    for (const [effectId, emitter] of this.emitters) {
      if (emitter.active) {
        activeIds.push(effectId);
      }
    }
    return activeIds;
  }

  reset(): void {
    for (const emitter of this.emitters.values()) {
      emitter.particles = [];
      emitter.elapsedTime = 0;
      emitter.emissionAccumulator = 0;
      emitter.active = false;
    }
  }

  dispose(): void {
    this.emitters.clear();
    this.effects.clear();
  }
}

let engineInstance: ParticleEngine | null = null;

export function getParticleEngine(): ParticleEngine {
  if (!engineInstance) {
    engineInstance = new ParticleEngine();
  }
  return engineInstance;
}

export function disposeParticleEngine(): void {
  if (engineInstance) {
    engineInstance.dispose();
    engineInstance = null;
  }
}

export { DEFAULT_PARTICLE_CONFIG, lerpColor };
