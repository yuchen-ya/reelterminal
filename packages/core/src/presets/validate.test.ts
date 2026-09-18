import { describe, it, expect } from "vitest";
import {
  ASSERT_TEXT_STYLE_WHITELIST_COMPLETE,
  MAX_EFFECTS_PER_PRESET,
  MAX_GRAPHICS_SVG_BYTES,
  MAX_SAMPLE_TEXT_LENGTH,
  MAX_THUMBNAIL_BYTES,
  getTransitionDefaultParams,
  validatePresetName,
  validatePresetPayload,
  validatePresetRecord,
  validatePresetThumbnail,
  validateTextPresetStyle,
} from "./validate";
import {
  PRESET_PAYLOAD_SCHEMA_VERSION,
  PRESET_RECORD_VERSION,
  type CustomPresetRecord,
} from "./types";
import { AUDIO_EFFECT_TYPES, TRANSITION_TYPES } from "../types/effects";

const SCHEMA = PRESET_PAYLOAD_SCHEMA_VERSION;

describe("text payload validation", () => {
  const base = { schemaVersion: SCHEMA, kind: "text" as const };

  it("normalizes a whitelisted style", () => {
    const result = validatePresetPayload({
      ...base,
      style: {
        fontFamily: "Inter",
        fontSize: 48,
        fontWeight: 700,
        fontStyle: "italic",
        color: "#ffffff",
        textAlign: "center",
        verticalAlign: "middle",
        lineHeight: 1.2,
        letterSpacing: 0,
        textDecoration: "underline",
      },
      sampleText: "Hello",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text") {
      expect(result.value.style.fontSize).toBe(48);
    }
  });

  it("rejects unknown style fields", () => {
    const result = validatePresetPayload({ ...base, style: { fontKerning: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(result.details?.field).toBe("style.fontKerning");
    }
  });

  it("rejects the shader field explicitly", () => {
    const result = validatePresetPayload({
      ...base,
      style: { shader: { shaderId: "x", params: {} } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNSUPPORTED_PAYLOAD_FIELD");
      expect(result.message).toContain("parameter-only");
    }
  });

  it("rejects out-of-domain enum and non-finite numeric values", () => {
    const weight = validatePresetPayload({ ...base, style: { fontWeight: 650 } });
    expect(weight.ok).toBe(false);
    if (!weight.ok) expect(weight.code).toBe("INVALID_PARAM_VALUE");

    const align = validateTextPresetStyle({ textAlign: "diagonal" });
    expect(align.ok).toBe(false);

    const infinite = validateTextPresetStyle({ fontSize: Number.POSITIVE_INFINITY });
    expect(infinite.ok).toBe(false);
    if (!infinite.ok) expect(infinite.code).toBe("INVALID_PARAM_VALUE");

    const negative = validateTextPresetStyle({ fontSize: -12 });
    expect(negative.ok).toBe(false);

    const color = validateTextPresetStyle({ color: 42 });
    expect(color.ok).toBe(false);
  });

  it("rejects overlong sampleText and non-object style", () => {
    const sample = validatePresetPayload({
      ...base,
      style: {},
      sampleText: "a".repeat(MAX_SAMPLE_TEXT_LENGTH + 1),
    });
    expect(sample.ok).toBe(false);
    if (!sample.ok) expect(sample.code).toBe("INVALID_PARAM_VALUE");

    const style = validatePresetPayload({ ...base, style: "bold" });
    expect(style.ok).toBe(false);
    if (!style.ok) expect(style.code).toBe("INVALID_PAYLOAD");
  });

  it("locks the whitelist to the TextStyle shape at compile time", () => {
    expect(ASSERT_TEXT_STYLE_WHITELIST_COMPLETE).toBe(true);
  });
});

describe("effect payload validation", () => {
  const base = { schemaVersion: SCHEMA, kind: "effect" as const };

  it("accepts a video effect stack with in-range params", () => {
    const result = validatePresetPayload({
      ...base,
      effects: [
        { type: "blur", params: { radius: 12 } },
        { type: "vignette", params: { amount: 30, size: 50, roundness: 0, feather: 50 } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects engine-unknown effect types", () => {
    const result = validatePresetPayload({
      ...base,
      effects: [{ type: "dream-glow", params: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_EFFECT_TYPE");
      expect(result.message).toContain("engine does not provide");
    }
  });

  it("explicitly rejects audio effect types", () => {
    for (const audioType of AUDIO_EFFECT_TYPES) {
      const result = validatePresetPayload({
        ...base,
        effects: [{ type: audioType, params: {} }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("UNSUPPORTED_EFFECT_TYPE");
        expect(result.message).toContain("audio effect");
      }
    }
  });

  it("rejects unknown parameter keys and out-of-range values without clamping", () => {
    const unknownKey = validatePresetPayload({
      ...base,
      effects: [{ type: "blur", params: { radiusness: 5 } }],
    });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) {
      expect(unknownKey.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(unknownKey.details?.field).toBe("effects[0].params.radiusness");
    }

    const outOfRange = validatePresetPayload({
      ...base,
      effects: [{ type: "blur", params: { radius: 500 } }],
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.code).toBe("INVALID_PARAM_VALUE");
      expect(outOfRange.details?.expected).toBe("[0, 100]");
      expect(outOfRange.details?.actual).toBe("500");
    }

    const nonFinite = validatePresetPayload({
      ...base,
      effects: [{ type: "blur", params: { radius: Number.NaN } }],
    });
    expect(nonFinite.ok).toBe(false);
  });

  it("rejects stacks outside the 1..8 range and malformed items", () => {
    const empty = validatePresetPayload({ ...base, effects: [] });
    expect(empty.ok).toBe(false);

    const tooMany = validatePresetPayload({
      ...base,
      effects: Array.from({ length: MAX_EFFECTS_PER_PRESET + 1 }, () => ({
        type: "blur",
        params: {},
      })),
    });
    expect(tooMany.ok).toBe(false);

    const extraKey = validatePresetPayload({
      ...base,
      effects: [{ type: "blur", params: {}, enabled: true }],
    });
    expect(extraKey.ok).toBe(false);
    if (!extraKey.ok) expect(extraKey.code).toBe("UNKNOWN_PAYLOAD_FIELD");
  });

  it("accepts the eight GUI-stack effect types the engines render", () => {
    // Keys and ranges mirror what the GUI writes (effects-bridge
    // getDefaultParams) and what the engines read (video-effects-engine +
    // canvas2d fallback): grayscale/sepia/invert=amount 0..1,
    // sharpen=amount, grain=amount+size, temperature/tint=value -100..100,
    // tonal=shadows/midtones/highlights.
    const result = validatePresetPayload({
      ...base,
      effects: [
        { type: "grayscale", params: { amount: 0.8 } },
        { type: "sepia", params: { amount: 1 } },
        { type: "invert", params: { amount: 0.5 } },
        { type: "sharpen", params: { amount: 120 } },
        { type: "grain", params: { amount: 25, size: 1.5 } },
        { type: "temperature", params: { value: -40 } },
        { type: "tint", params: { value: 30 } },
        { type: "tonal", params: { shadows: -20, midtones: 0, highlights: 15 } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects out-of-range parameters for the added GUI-stack types", () => {
    const cases: Array<{ type: string; params: Record<string, unknown> }> = [
      { type: "grayscale", params: { amount: 1.5 } },
      { type: "sepia", params: { amount: -0.1 } },
      { type: "invert", params: { amount: 2 } },
      { type: "sharpen", params: { amount: 500 } },
      { type: "grain", params: { amount: 200 } },
      { type: "grain", params: { size: 0.1 } },
      { type: "temperature", params: { value: 101 } },
      { type: "tint", params: { value: -101 } },
      { type: "tonal", params: { shadows: 0, midtones: 999, highlights: 0 } },
    ];
    for (const effect of cases) {
      const result = validatePresetPayload({ ...base, effects: [effect] });
      expect(result.ok, `${effect.type} ${JSON.stringify(effect.params)}`).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_PARAM_VALUE");
    }
  });

  it("rejects engine params the preset contract does not define for the added types", () => {
    // sharpen's radius slider and grain's roughness/colored extras are not
    // engine-consumed parameters, so they stay out of the whitelist.
    const result = validatePresetPayload({
      ...base,
      effects: [{ type: "sharpen", params: { amount: 50, radius: 2 } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(result.details?.field).toBe("effects[0].params.radius");
    }
  });

  it("still rejects the engine-only stack features with no safe preset contract", () => {
    // hue: two render paths disagree on the parameter key (GPU reads
    // rotation, the canvas filter chain reads value) — contract TBD.
    // chromaKey: clip-level keying field, not a stack effect.
    // shader: per-shaderId dynamic params; presets are parameter-only.
    for (const type of ["hue", "chromaKey", "shader"]) {
      const result = validatePresetPayload({ ...base, effects: [{ type, params: {} }] });
      expect(result.ok, type).toBe(false);
      if (!result.ok) expect(result.code).toBe("UNKNOWN_EFFECT_TYPE");
    }
  });
});

describe("transition payload validation", () => {
  const base = { schemaVersion: SCHEMA, kind: "transition" as const };

  it("accepts every engine transition type with defaults-derive params", () => {
    for (const type of TRANSITION_TYPES) {
      const defaults = getTransitionDefaultParams(type);
      const result = validatePresetPayload({ ...base, type, params: defaults });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects unknown transition types", () => {
    const result = validatePresetPayload({ ...base, type: "starWipe", params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_TRANSITION_TYPE");
      expect(result.message).toContain("engine does not provide");
    }
  });

  it("rejects parameter keys that are not in the live engine defaults table", () => {
    const result = validatePresetPayload({
      ...base,
      type: "crossfade",
      params: { curve: "linear", speed: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(result.details?.field).toBe("params.speed");
    }
  });

  it("rejects wrong-typed parameter values and out-of-range duration", () => {
    const wrongType = validatePresetPayload({
      ...base,
      type: "crossfade",
      params: { curve: 3 },
    });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.code).toBe("INVALID_PARAM_VALUE");

    const nested = validatePresetPayload({
      ...base,
      type: "zoom",
      params: { center: { x: 0.5, y: "top" } },
    });
    expect(nested.ok).toBe(false);

    const duration = validatePresetPayload({
      ...base,
      type: "crossfade",
      params: {},
      durationSec: 99,
    });
    expect(duration.ok).toBe(false);
    if (!duration.ok) expect(duration.code).toBe("INVALID_PARAM_VALUE");
  });

  it("rejects extra unknown keys inside nested object parameters (F1)", () => {
    const extraNested = validatePresetPayload({
      ...base,
      type: "zoom",
      params: { center: { x: 0.5, y: 0.5, overshoot: 1 } },
    });
    expect(extraNested.ok).toBe(false);
    if (!extraNested.ok) {
      expect(extraNested.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(extraNested.details?.field).toBe("params.center.overshoot");
    }

    // Same rule one level deeper and for inherited names on the nested record.
    const inheritedNested = validatePresetPayload({
      ...base,
      type: "circleReveal",
      params: { center: { x: 0.5, y: 0.5, toString: 1 } },
    });
    expect(inheritedNested.ok).toBe(false);
    if (!inheritedNested.ok) {
      expect(inheritedNested.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(inheritedNested.details?.field).toBe("params.center.toString");
    }
  });

  it("normalizes nested object parameters to the whitelisted default keys", () => {
    const center = { x: 0.25, y: 0.75 };
    const result = validatePresetPayload({
      ...base,
      type: "zoom",
      params: { scale: 3, center },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "transition") return;
    const params = result.value.params as {
      scale: number;
      center: Record<string, unknown>;
    };
    expect(params.scale).toBe(3);
    expect(params.center).toEqual({ x: 0.25, y: 0.75 });
    // The returned nested object is a cleaned copy, not the caller's object:
    // a different reference holding only the whitelisted default keys.
    expect(params.center).not.toBe(center);
    expect(Object.keys(params.center).sort()).toEqual(["x", "y"]);
  });

  it("rejects prototype-inherited names as top-level parameter keys (F2)", () => {
    for (const smuggled of ["toString", "constructor", "valueOf"]) {
      const result = validatePresetPayload({
        ...base,
        type: "circleReveal",
        params: { [smuggled]: {} },
      });
      expect(result.ok, smuggled).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("UNKNOWN_PAYLOAD_FIELD");
        expect(result.details?.field).toBe(`params.${smuggled}`);
      }
    }
  });
});

describe("graphics payload validation", () => {
  const base = { schemaVersion: SCHEMA, kind: "graphics" as const };

  it("accepts safe inline SVG", () => {
    const result = validatePresetPayload({
      ...base,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>`,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects scripts, unsafe protocols, and external references", () => {
    const script = validatePresetPayload({
      ...base,
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    });
    expect(script.ok).toBe(false);
    if (!script.ok) expect(script.code).toBe("INVALID_SVG");

    const external = validatePresetPayload({
      ...base,
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/i.png"/></svg>`,
    });
    expect(external.ok).toBe(false);
    if (!external.ok) expect(external.code).toBe("INVALID_SVG");
  });

  it("rejects oversized sources", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${"x".repeat(
      MAX_GRAPHICS_SVG_BYTES,
    )} --></svg>`;
    const result = validatePresetPayload({ ...base, svg });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("payload envelope", () => {
  it("rejects unsupported schema versions", () => {
    const result = validatePresetPayload({
      schemaVersion: SCHEMA + 1,
      kind: "text",
      style: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PAYLOAD_VERSION_UNSUPPORTED");
  });

  it("rejects unknown kinds and unknown envelope fields", () => {
    const badKind = validatePresetPayload({ schemaVersion: SCHEMA, kind: "audio", x: 1 });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.code).toBe("INVALID_PAYLOAD");

    const badField = validatePresetPayload({
      schemaVersion: SCHEMA,
      kind: "text",
      style: {},
      mediaId: "m1",
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) {
      expect(badField.code).toBe("UNKNOWN_PAYLOAD_FIELD");
      expect(badField.details?.field).toBe("mediaId");
    }
  });

  it("rejects non-object payloads", () => {
    expect(validatePresetPayload(null).ok).toBe(false);
    expect(validatePresetPayload("text").ok).toBe(false);
    expect(validatePresetPayload([1]).ok).toBe(false);
  });
});

describe("name validation", () => {
  it("trims and accepts valid names", () => {
    const result = validatePresetName("  My Preset  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("My Preset");
  });

  it("rejects empty and overlong names", () => {
    expect(validatePresetName("   ").ok).toBe(false);
    expect(validatePresetName("").ok).toBe(false);
    expect(validatePresetName("x".repeat(81)).ok).toBe(false);
    expect(validatePresetName(42).ok).toBe(false);
  });
});

/* ------------------------------ thumbnails ------------------------------ */

function pngDataUrl(width: number, height: number, extraBytes = 0): string {
  const bytes: number[] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ];
  for (let index = 0; index < extraBytes; index += 1) bytes.push(0x00);
  const binary = bytes.map((byte) => String.fromCharCode(byte)).join("");
  const encoded = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return `data:image/png;base64,${encoded}`;
}

describe("thumbnail validation", () => {
  it("accepts a small PNG data URL", () => {
    const result = validatePresetThumbnail(pngDataUrl(64, 64));
    expect(result.ok).toBe(true);
  });

  it("rejects non-PNG prefixes and malformed payloads", () => {
    expect(validatePresetThumbnail("data:image/jpeg;base64,AAAA").ok).toBe(false);
    expect(validatePresetThumbnail("not-a-url").ok).toBe(false);
    expect(validatePresetThumbnail(123).ok).toBe(false);
    expect(validatePresetThumbnail("data:image/png;base64,!!!!").ok).toBe(false);
    // A valid base64 payload whose bytes are not a PNG image.
    expect(
      validatePresetThumbnail(`data:image/png;base64,${Buffer.from("hello world").toString("base64")}`).ok,
    ).toBe(false);
  });

  it("rejects oversized and wrongly dimensioned images", () => {
    const tooBig = validatePresetThumbnail(
      pngDataUrl(16, 16, MAX_THUMBNAIL_BYTES),
    );
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.code).toBe("INVALID_THUMBNAIL");

    const tooWide = validatePresetThumbnail(pngDataUrl(257, 10));
    expect(tooWide.ok).toBe(false);

    const tooTall = validatePresetThumbnail(pngDataUrl(10, 161));
    expect(tooTall.ok).toBe(false);
  });
});

/* ------------------------------- records -------------------------------- */

function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "preset_test-1",
    kind: "effect",
    name: "Warm Stack",
    tags: ["warm"],
    payload: {
      schemaVersion: SCHEMA,
      kind: "effect",
      effects: [{ type: "brightness", params: { value: 10 } }],
    },
    createdAt: 1_000,
    updatedAt: 2_000,
    revision: 3,
    recordVersion: PRESET_RECORD_VERSION,
    ...overrides,
  };
}

describe("record validation", () => {
  it("accepts a complete record and normalizes optional fields", () => {
    const result = validatePresetRecord(baseRecord());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("effect");
      expect(result.value.tags).toEqual(["warm"]);
      expect(result.value.thumbnailDataUrl).toBeUndefined();
    }
  });

  it("rejects bad kinds, ids, revisions, and timestamps", () => {
    expect(validatePresetRecord(baseRecord({ kind: "audio" })).ok).toBe(false);
    expect(validatePresetRecord(baseRecord({ id: "" })).ok).toBe(false);
    expect(validatePresetRecord(baseRecord({ revision: -1 })).ok).toBe(false);
    expect(validatePresetRecord(baseRecord({ createdAt: Number.NaN })).ok).toBe(false);
    expect(validatePresetRecord(baseRecord({ tags: [1] })).ok).toBe(false);
  });

  it("rejects records written by a newer record version", () => {
    const result = validatePresetRecord(
      baseRecord({ recordVersion: PRESET_RECORD_VERSION + 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PAYLOAD_VERSION_UNSUPPORTED");
  });

  it("rejects records whose payload fails validation", () => {
    const result = validatePresetRecord(
      baseRecord({
        payload: { schemaVersion: SCHEMA, kind: "transition", type: "nope", params: {} },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_TRANSITION_TYPE");
  });

  it("accepts a fully-shaped custom preset record", () => {
    const record: CustomPresetRecord = {
      id: "preset_abc",
      kind: "text",
      name: "Title",
      tags: [],
      payload: { schemaVersion: SCHEMA, kind: "text", style: { fontSize: 32 } },
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      recordVersion: PRESET_RECORD_VERSION,
    };
    expect(validatePresetRecord(record).ok).toBe(true);
  });
});
