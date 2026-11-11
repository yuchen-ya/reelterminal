import { describe, expect, it, vi } from "vitest";
import { ParticleEngine, getParticlesAtTime, renderParticlesToCanvas } from "./particle-engine";
import { createEffectFromPreset, PARTICLE_PRESETS } from "./particle-presets";
import { validParticleEffects } from "./particle-types";

const effect = () => createEffectFromPreset("confetti-celebration", "effect-one", "clip-one", 2, 5)!;

describe("project particle sampling", () => {
  it("renders the same frame after repeated sampling, different cadence and backward seek", () => {
    const config = effect();
    const engine = new ParticleEngine();
    engine.addEffect(config);
    engine.setCanvasSize(1920, 1080);
    engine.update(3.25, 1 / 30);
    const expected = structuredClone(engine.getParticles());
    expect(expected.length).toBeGreaterThan(0);
    engine.update(6, 2.75);
    engine.update(2.3, 0);
    engine.update(3.25, 1 / 120);
    expect(engine.getParticles()).toEqual(expected);
    engine.update(3.25, 10);
    expect(engine.getParticles()).toEqual(expected);
    expect(getParticlesAtTime(structuredClone(config), 3.25, 1920, 1080)).toEqual(expected);
  });

  it("honors enabled state, half-open timing and project-owned effect lists", () => {
    const config = effect();
    expect(getParticlesAtTime(config, 1.9, 1920, 1080)).toEqual([]);
    expect(getParticlesAtTime(config, 7, 1920, 1080)).toEqual([]);
    expect(getParticlesAtTime({ ...config, enabled: false }, 3, 1920, 1080)).toEqual([]);
    const engine = new ParticleEngine();
    engine.addEffect(config);
    engine.update(3);
    engine.toggleEffect(config.id, false);
    engine.update(3);
    expect(engine.getParticles()).toEqual([]);
    expect(new ParticleEngine().getParticles()).toEqual([]);
  });

  it("draws in project pixels with the configured blend mode", () => {
    const config = effect();
    const ctx = {
      save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(),
      rotate: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "",
    };
    renderParticlesToCanvas(ctx as unknown as CanvasRenderingContext2D, [config], 3, 960, 540, { width: 1920, height: 1080 });
    expect(ctx.scale).toHaveBeenCalledWith(0.5, 0.5);
    const particles = getParticlesAtTime(config, 3, 1920, 1080).filter((particle) => particle.opacity > 0);
    expect(ctx.fillRect).toHaveBeenCalledTimes(particles.length);
    expect(ctx.translate).toHaveBeenCalledWith(particles[0].position.x, particles[0].position.y);
    expect(ctx.globalCompositeOperation).toBe(config.config.blendMode === "add" ? "lighter" : config.config.blendMode === "normal" ? "source-over" : config.config.blendMode);
  });

  it("accepts every real preset and rejects invalid imported counts and lifetimes", () => {
    for (const preset of PARTICLE_PRESETS) {
      expect(validParticleEffects([createEffectFromPreset(preset.id, preset.id, "clip", 0, 3)])).toBe(true);
    }
    const config = effect();
    expect(validParticleEffects([{ ...config, config: { ...config.config, particleCount: Infinity } }])).toBe(false);
    expect(validParticleEffects([{ ...config, config: { ...config.config, lifetime: { min: 0, max: 1 } } }])).toBe(false);
    expect(validParticleEffects([{
      ...config,
      config: {
        ...config.config, emissionRate: Number.MAX_VALUE,
        lifetime: { min: Number.MIN_VALUE, max: Number.MIN_VALUE },
      },
    }])).toBe(false);
    expect(validParticleEffects(undefined)).toBe(true);
  });
});

describe("particle emission capacity and lifetime", () => {
  it("keeps long-lived particles until death instead of replacing them at every scheduled birth", () => {
    const config = effect();
    config.startTime = 0;
    config.duration = 30;
    config.config = {
      ...config.config, emissionRate: 10, particleCount: 2,
      lifetime: { min: 10, max: 10 }, fadeIn: 0, fadeOut: 0,
      opacity: { start: 1, end: 1 }, colors: ["#123456"],
    };
    const early = getParticlesAtTime(config, 0.3, 1920, 1080);
    const late = getParticlesAtTime(config, 9, 1920, 1080);
    expect(late.map((particle) => particle.id)).toEqual(early.map((particle) => particle.id));
    expect(late).toHaveLength(2);
    expect(late[0].age).toBeCloseTo(8.9);
    expect(late.every((particle) => particle.color === "#123456")).toBe(true);
    const replaced = getParticlesAtTime(config, 10.3, 1920, 1080);
    expect(replaced).toHaveLength(2);
    expect(replaced.map((particle) => particle.id)).toEqual(["effect-one:2", "effect-one:3"]);
    expect(getParticlesAtTime(config, 9, 1920, 1080)).toEqual(late);
  });

  it("does not expire particles early while waiting for the next emission", () => {
    const config = effect();
    config.startTime = 0;
    config.config = { ...config.config, emissionRate: 1, lifetime: { min: 0.5, max: 0.5 } };
    expect(getParticlesAtTime(config, 1.2, 320, 180)).toHaveLength(1);
    expect(getParticlesAtTime(config, 1.6, 320, 180)).toHaveLength(0);
    expect(getParticlesAtTime(config, 2.2, 320, 180)).toHaveLength(1);
  });
});
