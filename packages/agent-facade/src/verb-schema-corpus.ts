import { PLUGIN_TOOLS } from "./plugins";
/**
 * Adversarial corpus per verb (ADR 0003 Decision 4 item 3): dependency-free
 * DATA ONLY — no imports, no logic. The transport's differential test
 * evaluates every case twice and asserts one classification:
 *
 *  - the emitted JSON Schema (EMITTED_VERB_JSON_SCHEMAS, via ajv — ajv is
 *    the transport's devDependency, never the facade's) accepts a payload
 *    exactly when `schemaValid` would be true (defaults to `expectValid`);
 *  - the facade's runtime validators reject a payload exactly when
 *    `expectValid` is false, with INVALID_PARAMS.
 *
 * The `schemaValid: true, expectValid: false` cases are the load-bearing
 * ordering pins: cross-field rules the emitted schema cannot express
 * (clip.trim's at-least-one-of, even raster dimensions, region x+width ≤ 1)
 * must pass ajv and still fail at the facade — the schema is a boundary
 * superset filter and the runtime validators remain the only authority
 * (Decision 4 item 5).
 *
 * Failure classes per verb: unknown field, missing required, wrong type,
 * enum/const violation — plus the deterministic cases above.
 */

export interface VerbSchemaCorpusCase {
  /** Failure class or purpose, stable across releases for CI diffing. */
  readonly name: string;
  /** The payload exactly as it would cross the boundary. */
  readonly params: unknown;
  /** Facade expectation: rejected (INVALID_PARAMS) when false. */
  readonly expectValid: boolean;
  /**
   * Emitted-schema expectation. Defaults to `expectValid` when omitted;
   * `true` with `expectValid: false` pins a schema-valid-but-facade-
   * rejected (validation-only predicate) case.
   */
  readonly schemaValid?: boolean;
}

export const VERB_SCHEMA_CORPUS: Readonly<
  Record<string, readonly VerbSchemaCorpusCase[]>
> = {
  ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.schemaCases])),
  "session.describe": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { verbose: true }, expectValid: false },
  ],
  "capabilities.get": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { force: true }, expectValid: false },
  ],
  "project.create": [
    { name: "valid minimal", params: { name: "Demo" }, expectValid: true },
    {
      name: "valid with partial settings",
      params: { name: "Demo", settings: { width: 1280, height: 720 }, idempotencyKey: "k1" },
      expectValid: true,
    },
    { name: "params optional entirely", params: {}, expectValid: true },
    { name: "unknown field", params: { name: "Demo", expectedRevision: 0 }, expectValid: false },
    { name: "wrong type name", params: { name: 42 }, expectValid: false },
    { name: "wrong type settings", params: { settings: "1920x1080" }, expectValid: false },
    {
      name: "settings width must be a positive integer",
      params: { name: "Demo", settings: { width: 0 } },
      expectValid: false,
    },
    {
      name: "settings width must be an integer",
      params: { name: "Demo", settings: { width: 1919.5 } },
      expectValid: false,
    },
    {
      name: "idempotencyKey must be non-empty",
      params: { name: "Demo", idempotencyKey: "" },
      expectValid: false,
    },
  ],
  "project.open": [
    { name: "valid", params: { path: "/checkpoints/promo-v1.openreel.json" }, expectValid: true },
    {
      name: "valid with idempotencyKey",
      params: { path: "/checkpoints/promo-v1.openreel.json", idempotencyKey: "open-1" },
      expectValid: true,
    },
    { name: "missing required path", params: {}, expectValid: false },
    { name: "wrong type path", params: { path: 42 }, expectValid: false },
    { name: "unknown field (expectedRevision is not an open param)", params: { path: "/c/x", expectedRevision: 0 }, expectValid: false },
    { name: "empty path", params: { path: "" }, expectValid: false },
  ],
  "project.save": [
    { name: "valid minimal", params: { path: "/checkpoints/promo-v1.openreel.json" }, expectValid: true },
    {
      name: "valid with guard and overwrite",
      params: { path: "/checkpoints/promo-v2.openreel.json", expectedRevision: 3, overwrite: true },
      expectValid: true,
    },
    { name: "missing required path", params: { expectedRevision: 1 }, expectValid: false },
    { name: "wrong type overwrite", params: { path: "/c/x", overwrite: "yes" }, expectValid: false },
    {
      name: "expectedRevision must be an integer",
      params: { path: "/c/x", expectedRevision: 1.5 },
      expectValid: false,
    },
    { name: "unknown field (idempotencyKey is not a save param)", params: { path: "/c/x", idempotencyKey: "k" }, expectValid: false },
  ],
  "project.rename": [
    { name: "valid", params: { name: "Dam Letter" }, expectValid: true },
    {
      name: "valid with concurrency and idempotency",
      params: { name: "Dam Letter", expectedRevision: 3, idempotencyKey: "rename-1" },
      expectValid: true,
    },
    { name: "missing name", params: {}, expectValid: false },
    { name: "empty name", params: { name: "   " }, schemaValid: true, expectValid: false },
    { name: "wrong type", params: { name: 7 }, expectValid: false },
    { name: "unknown field", params: { name: "Demo", path: "/tmp/demo" }, expectValid: false },
  ],
  "project.get_state": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { summary: true }, expectValid: false },
  ],
  "project.changes": [
    { name: "valid", params: { sinceRevision: 0, limit: 50 }, expectValid: true },
    { name: "missing sinceRevision", params: {}, expectValid: false },
    { name: "negative revision", params: { sinceRevision: -1 }, expectValid: false },
    { name: "limit above ceiling", params: { sinceRevision: 0, limit: 201 }, expectValid: false },
    { name: "unknown field", params: { sinceRevision: 0, verbose: true }, expectValid: false },
  ],
  "media.import": [
    { name: "valid", params: { path: "/media/input.mp4" }, expectValid: true },
    {
      name: "valid with name and guard",
      params: { path: "/media/input.mp4", name: "Intro", expectedRevision: 0, idempotencyKey: "i1" },
      expectValid: true,
    },
    { name: "missing required path", params: { name: "Intro" }, expectValid: false },
    { name: "wrong type path", params: { path: null }, expectValid: false },
    {
      name: "expectedRevision must be a non-negative integer",
      params: { path: "/media/input.mp4", expectedRevision: -1 },
      expectValid: false,
    },
    { name: "unknown field", params: { path: "/media/input.mp4", url: "https://x" }, expectValid: false },
  ],
  "media.render_html": [
    {
      name: "valid inline source",
      params: { source: { kind: "inline", html: "<p>hi</p>" }, width: 64, height: 64 },
      expectValid: true,
    },
    {
      name: "valid path source with tuning",
      params: {
        source: { kind: "path", path: "/media/card.html" },
        assetsRoot: "/media",
        width: 1920,
        height: 1080,
        transparent: false,
        timeoutMs: 60000,
        outputDir: "/media/jobs/html-render/out",
        expectedRevision: 0,
        idempotencyKey: "html-1",
      },
      expectValid: true,
    },
    { name: "missing source", params: { width: 64, height: 64 }, expectValid: false },
    { name: "missing width", params: { source: { kind: "inline", html: "<p>x</p>" }, height: 64 }, expectValid: false },
    { name: "source kind unknown", params: { source: { kind: "url", url: "https://x" }, width: 64, height: 64 }, expectValid: false },
    { name: "path kind without path", params: { source: { kind: "path" }, width: 64, height: 64 }, expectValid: false },
    { name: "inline html must be non-empty", params: { source: { kind: "inline", html: "" }, width: 64, height: 64 }, expectValid: false },
    { name: "odd width is schema-valid but facade-rejected", params: { source: { kind: "inline", html: "<p>x</p>" }, width: 101, height: 64 }, schemaValid: true, expectValid: false },
    { name: "width above ceiling", params: { source: { kind: "inline", html: "<p>x</p>" }, width: 4098, height: 64 }, expectValid: false },
    { name: "timeoutMs above ceiling", params: { source: { kind: "inline", html: "<p>x</p>" }, width: 64, height: 64, timeoutMs: 121000 }, expectValid: false },
    { name: "unknown field", params: { source: { kind: "inline", html: "<p>x</p>" }, width: 64, height: 64, url: "https://x" }, expectValid: false },
  ],
  "media.analyze_start": [
    { name: "cloud review", params: { mediaId: "m1", analysisTypes: ["videoReview"], startSec: 0, endSec: 6, cloudUpload: true, reviewQuestion: "Check transitions" }, expectValid: true },
    { name: "review question bounded", params: { mediaId: "m1", analysisTypes: ["videoReview"], reviewQuestion: "x".repeat(1001) }, expectValid: false },
    { name: "no credential tool argument", params: { mediaId: "m1", analysisTypes: ["videoReview"], apiKey: "not-allowed" }, expectValid: false },
    { name: "valid technical analysis", params: { mediaId: "m1", analysisTypes: ["technicalQuality"] }, expectValid: true },
    { name: "valid multiple declared types", params: { mediaId: "m1", analysisTypes: ["sceneCuts", "silence"] }, expectValid: true },
    { name: "valid beat grid analysis", params: { mediaId: "m1", analysisTypes: ["beatGrid"], startSec: 0, endSec: 30 }, expectValid: true },
    { name: "valid silence tuning", params: { mediaId: "m1", analysisTypes: ["silence"], silenceParams: { thresholdDb: -35, minDurationSec: 0.4, paddingSec: 0.2 } }, expectValid: true },
    { name: "silence tuning below range", params: { mediaId: "m1", analysisTypes: ["silence"], silenceParams: { thresholdDb: -200 } }, expectValid: false },
    { name: "silence tuning unknown field", params: { mediaId: "m1", analysisTypes: ["silence"], silenceParams: { gate: 1 } }, expectValid: false },
    { name: "missing mediaId", params: { analysisTypes: ["technicalQuality"] }, expectValid: false },
    { name: "empty analysisTypes", params: { mediaId: "m1", analysisTypes: [] }, expectValid: false },
    { name: "unknown analysis type", params: { mediaId: "m1", analysisTypes: ["sentiment"] }, expectValid: false },
    { name: "unknown field", params: { mediaId: "m1", analysisTypes: ["technicalQuality"], path: "/tmp/x" }, expectValid: false },
  ],
  "timeline.get": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { trackId: "v1" }, expectValid: false },
  ],
  "timeline.query": [
    { name: "empty bounded query is valid", params: {}, expectValid: true },
    { name: "valid namespaced refs", params: { refs: ["@A1", "R2"], limit: 20 }, expectValid: true },
    { name: "bare hash ref forbidden", params: { refs: ["#1"] }, schemaValid: true, expectValid: false },
    { name: "unknown field projection", params: { fields: ["rawProject"] }, expectValid: false },
    { name: "unknown envelope field", params: { query: "clip" }, expectValid: false },
  ],
  "editor.get_context": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { verbose: true }, expectValid: false },
  ],
  "editor.control": [
    { name: "play is valid", params: { action: "play" }, expectValid: true },
    {
      name: "select accepts multiple target kinds",
      params: {
        action: "select",
        targets: [
          { kind: "clip", id: "clip-1" },
          { kind: "text", id: "text-1" },
          { kind: "media", id: "media-1" },
        ],
        selectionMode: "add",
      },
      expectValid: true,
    },
    { name: "seek requires timeSeconds (runtime cross-field rule)", params: { action: "seek" }, schemaValid: true, expectValid: false },
    { name: "unknown field", params: { action: "pause", speed: 2 }, expectValid: false },
  ],
  "edit.validate": [
    {
      name: "valid dry-run",
      params: { ops: [{ op: "track.add", trackType: "video" }], expectedRevision: 0 },
      expectValid: true,
    },
    { name: "missing ops", params: {}, expectValid: false },
    { name: "empty ops", params: { ops: [] }, expectValid: false },
    {
      name: "idempotency is mutation-only",
      params: { ops: [{ op: "track.add", trackType: "video" }], idempotencyKey: "x" },
      expectValid: false,
    },
  ],
  "edit.apply": [
    {
      name: "valid track.add without optional id",
      params: { ops: [{ op: "track.add", trackType: "video" }] },
      expectValid: true,
    },
    {
      name: "valid track.update",
      params: { ops: [{ op: "track.update", trackId: "v1", name: "Picture", locked: true, muted: false }] },
      expectValid: true,
    },
    {
      name: "schema-valid but facade-rejected: track.update needs a change",
      params: { ops: [{ op: "track.update", trackId: "v1" }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid media.rename",
      params: { ops: [{ op: "media.rename", mediaId: "m1", displayName: "片头配音 v3" }] },
      expectValid: true,
    },
    {
      name: "media.rename rejects a blank displayName",
      params: { ops: [{ op: "media.rename", mediaId: "m1", displayName: "   " }] },
      // Trim-then-check cannot be expressed as minLength: the emitted schema
      // accepts "   " (length 3) and the facade rejects it — a pin, not a
      // schema bug (same class as track.update's at-least-one-field).
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid subtitle.importSrt",
      params: { ops: [{ op: "subtitle.importSrt", srtContent: "1\n00:00:00,000 --> 00:00:01,000\nHello" }] },
      expectValid: true,
    },
    {
      name: "schema-valid but facade-rejected: malformed SRT",
      params: { ops: [{ op: "subtitle.importSrt", srtContent: "not srt" }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid clip.setColorGrade",
      params: { ops: [{ op: "clip.setColorGrade", clipId: "c1", temperature: 25, tint: -10 }] },
      expectValid: true,
    },
    {
      name: "schema-valid but facade-rejected: empty color grade",
      params: { ops: [{ op: "clip.setColorGrade", clipId: "c1" }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid clip.setKeyframes",
      params: { ops: [{ op: "clip.setKeyframes", clipId: "c1", keyframes: [{ property: "opacity", time: 0, value: 0 }, { property: "opacity", time: 1, value: 1, easing: "ease-out" }] }] },
      expectValid: true,
    },
    {
      name: "keyframe property is allowlisted",
      params: { ops: [{ op: "clip.setKeyframes", clipId: "c1", keyframes: [{ property: "audio.volume", time: 0, value: 1 }] }] },
      expectValid: false,
    },
    {
      name: "valid clip.setChromaKey enable with defaults",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true }] },
      expectValid: true,
    },
    {
      name: "valid clip.setChromaKey full settings",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true, keyColor: { r: 0, g: 0, b: 1 }, tolerance: 0.35, edgeSoftness: 0.05, spillSuppression: 0.6 }] },
      expectValid: true,
    },
    {
      name: "clip.setChromaKey requires enabled",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1" }] },
      expectValid: false,
    },
    {
      name: "clip.setChromaKey tolerance must be in [0, 1]",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true, tolerance: 1.5 }] },
      expectValid: false,
    },
    {
      name: "clip.setChromaKey keyColor channels must be in [0, 1]",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true, keyColor: { r: 2, g: 0, b: 0 } }] },
      expectValid: false,
    },
    {
      name: "clip.setChromaKey unknown field",
      params: { ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true, preset: "green" }] },
      expectValid: false,
    },
    {
      name: "valid clip.setNoiseReduction preset",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "speech" }] },
      expectValid: true,
    },
    {
      name: "valid clip.setNoiseReduction explicit params",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, threshold: -50, reduction: 0.75, attack: 8, release: 180 }] },
      expectValid: true,
    },
    {
      name: "clip.setNoiseReduction requires enabled",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", preset: "balanced" }] },
      expectValid: false,
    },
    {
      name: "clip.setNoiseReduction threshold must be in [-80, 0]",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, threshold: -90 }] },
      expectValid: false,
    },
    {
      name: "clip.setNoiseReduction reduction must be in [0, 1]",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, reduction: 1.5 }] },
      expectValid: false,
    },
    {
      name: "clip.setNoiseReduction preset id is allowlisted",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "vocal" }] },
      expectValid: false,
    },
    {
      name: "clip.setNoiseReduction unknown field",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, effectId: "n1" }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: profile array lengths must match",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, profile: { frequencyBins: [100, 200], magnitudes: [0.5], sampleRate: 48000 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: profile fftSize must be twice magnitudes length",
      params: { ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: true, profile: { frequencyBins: [100], magnitudes: [0.5], sampleRate: 48000, fftSize: 1024 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid clip.addVideoEffect auto-color saturation leg",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "saturation", params: { value: 1.15 } }] },
      expectValid: true,
    },
    {
      name: "valid clip.addVideoEffect with deterministic effectId and no params",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "brightness", effectId: "fx-1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.addVideoEffect blur radius",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "blur", params: { radius: 12 } }] },
      expectValid: true,
    },
    {
      name: "clip.addVideoEffect effectType is closed to the GUI effect stack",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "denoise" }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: saturation value must be in [0, 2] (the emitted union carries brightness's wider range)",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "saturation", params: { value: 5 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: params keys are per-effectType (value 5 is brightness-legal, saturation-illegal)",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "brightness", params: { value: 5 } }, { op: "clip.addVideoEffect", clipId: "c1", effectType: "saturation", params: { value: 5 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: unknown param key for the addressed effect",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "grayscale", params: { radius: 3 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: shader params must match the addressed shader definition",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "shader", params: { shaderId: "vhs", levels: 5 } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "clip.addVideoEffect shader params reject unknown keys outright",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "shader", params: { shaderId: "vhs", bogusParam: 1 } }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: hex color params must be hex",
      params: { ops: [{ op: "clip.addVideoEffect", clipId: "c1", effectType: "glow", params: { radius: 20, color: "lavender" } }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid clip.setDucking with pre-computed points",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 1 }, { time: 1, value: 0.4 }] }] },
      expectValid: true,
    },
    {
      name: "valid clip.setDucking with presenceRanges",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -25, reduction: 0.8, attack: 0.05, release: 0.2, holdTime: 0.1, presenceRanges: [{ start: 0.5, end: 2 }] }] },
      expectValid: true,
    },
    {
      name: "clip.setDucking threshold must be in [-60, 0]",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -61, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 1 }] }] },
      expectValid: false,
    },
    {
      name: "clip.setDucking reduction must be in [0, 1]",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 1.5, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 1 }] }] },
      expectValid: false,
    },
    {
      name: "clip.setDucking point value must be in [0, 4]",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 5 }] }] },
      expectValid: false,
    },
    {
      name: "clip.setDucking point time must be >= 0",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: -1, value: 1 }] }] },
      expectValid: false,
    },
    {
      name: "clip.setDucking presenceRanges start must be >= 0",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, presenceRanges: [{ start: -0.5, end: 2 }] }] },
      expectValid: false,
    },
    {
      name: "clip.setDucking unknown field",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 1 }], sourceTrackId: "t2" }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: ducking needs points or presenceRanges",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: points and presenceRanges are mutually exclusive",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, points: [{ time: 0, value: 1 }], presenceRanges: [{ start: 0, end: 1 }] }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: presenceRange end must exceed start",
      params: { ops: [{ op: "clip.setDucking", clipId: "c1", threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, presenceRanges: [{ start: 2, end: 2 }] }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid clip.setBackgroundRemoval enable with defaults",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true }] },
      expectValid: true,
    },
    {
      name: "valid clip.setBackgroundRemoval full settings",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, mode: "color", backgroundColor: "#0000ff80", blurAmount: 20, edgeBlur: 4, threshold: 0.6 }] },
      expectValid: true,
    },
    {
      name: "clip.setBackgroundRemoval requires enabled",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", mode: "blur" }] },
      expectValid: false,
    },
    {
      name: "clip.setBackgroundRemoval mode is allowlisted",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, mode: "neon" }] },
      expectValid: false,
    },
    {
      name: "clip.setBackgroundRemoval blurAmount must be in [0, 50]",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, blurAmount: 51 }] },
      expectValid: false,
    },
    {
      name: "clip.setBackgroundRemoval threshold must be in [0, 1]",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, threshold: 1.5 }] },
      expectValid: false,
    },
    {
      name: "clip.setBackgroundRemoval backgroundColor must be hex",
      // The runtime validator is the only hex authority (the emitted string
      // leaf has no pattern), so this is an ordering pin: ajv accepts, the
      // facade rejects.
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, backgroundColor: "blue" }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "clip.setBackgroundRemoval unknown field",
      params: { ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, preset: "portrait" }] },
      expectValid: false,
    },
    {
      name: "valid clip.applyReframe crop plan",
      params: {
        ops: [{
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [
            { time: 0, cropX: 106.25, cropY: 0, cropWidth: 107.5, cropHeight: 180 },
            { time: 4, cropX: 212.5, cropY: 0, cropWidth: 107.5, cropHeight: 180 },
          ],
          outputWidth: 1080,
          outputHeight: 1920,
        }],
      },
      expectValid: true,
    },
    {
      name: "clip.applyReframe requires at least one crop keyframe",
      params: { ops: [{ op: "clip.applyReframe", clipId: "c1", keyframes: [], outputWidth: 1080, outputHeight: 1920 }] },
      expectValid: false,
    },
    {
      name: "clip.applyReframe crop width must be positive",
      params: { ops: [{ op: "clip.applyReframe", clipId: "c1", keyframes: [{ time: 0, cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 180 }], outputWidth: 1080, outputHeight: 1920 }] },
      expectValid: false,
    },
    {
      name: "clip.applyReframe output size must be a positive integer",
      params: { ops: [{ op: "clip.applyReframe", clipId: "c1", keyframes: [{ time: 0, cropX: 0, cropY: 0, cropWidth: 107.5, cropHeight: 180 }], outputWidth: 1080.5, outputHeight: 1920 }] },
      expectValid: false,
    },
    {
      name: "clip.applyReframe unknown field",
      params: { ops: [{ op: "clip.applyReframe", clipId: "c1", detectSubjects: true, keyframes: [{ time: 0, cropX: 0, cropY: 0, cropWidth: 107.5, cropHeight: 180 }], outputWidth: 1080, outputHeight: 1920 }] },
      expectValid: false,
    },
    {
      name: "valid track.remove",
      params: { ops: [{ op: "track.remove", trackId: "v1" }] },
      expectValid: true,
    },
    {
      name: "valid media.remove",
      params: { ops: [{ op: "media.remove", mediaId: "m1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.add fully specified",
      params: {
        ops: [
          { op: "clip.add", trackId: "v1", mediaId: "m1", startTime: 0, duration: 5, inPoint: 0, outPoint: 5, clipId: "c1" },
        ],
        expectedRevision: 1,
        idempotencyKey: "e1",
      },
      expectValid: true,
    },
    {
      name: "valid clip.trim with both points",
      params: { ops: [{ op: "clip.trim", clipId: "c1", inPoint: 1, outPoint: 4 }] },
      expectValid: true,
    },
    {
      name: "valid with expectedContextRevision (live CAS guard, ADR 0004 Decision 4)",
      params: {
        ops: [{ op: "track.add", trackType: "video" }],
        expectedRevision: 3,
        expectedContextRevision: 7,
      },
      expectValid: true,
    },
    {
      name: "expectedContextRevision must be a non-negative integer",
      params: { ops: [{ op: "track.add", trackType: "video" }], expectedContextRevision: -1 },
      expectValid: false,
    },
    {
      name: "expectedContextRevision must be an integer",
      params: { ops: [{ op: "track.add", trackType: "video" }], expectedContextRevision: 1.5 },
      expectValid: false,
    },
    {
      name: "valid text.create with style",
      params: {
        ops: [
          { op: "text.create", text: "Hello", startTime: 0, duration: 5, trackId: "t1", style: { fontSize: 48, fontWeight: "bold", textAlign: "center" } },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid numeric fontWeight",
      params: {
        ops: [{ op: "text.create", text: "x", startTime: 0, duration: 2, style: { fontWeight: 700 } }],
      },
      expectValid: true,
    },
    {
      name: "valid text.create with position and anchor",
      params: {
        ops: [
          { op: "text.create", text: "Lower third", startTime: 0, duration: 4, position: { x: 0.5, y: 0.85 }, anchor: { x: 0.5, y: 0.5 } },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid text.update with text only",
      params: {
        ops: [{ op: "text.update", overlayId: "text-1", text: "New copy" }],
      },
      expectValid: true,
    },
    {
      name: "valid text.update with position, style and timing",
      params: {
        ops: [
          { op: "text.update", overlayId: "text-1", startTime: 1, duration: 3, style: { color: "#ff0000" }, position: { x: 0.5, y: 0.15 } },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid text.delete",
      params: { ops: [{ op: "text.delete", overlayId: "text-1" }] },
      expectValid: true,
    },
    {
      name: "valid svg.create without a track (auto graphics lane)",
      params: {
        ops: [
          { op: "svg.create", svgContent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>', startTime: 0, duration: 4 },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid svg.create with track, position and anchor",
      params: {
        ops: [
          { op: "svg.create", svgContent: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>', startTime: 1, duration: 3, trackId: "g1", position: { x: 0.5, y: 0.5 }, anchor: { x: 0.5, y: 0.5 } },
        ],
      },
      expectValid: true,
    },
    {
      name: "svg.create requires svgContent",
      params: { ops: [{ op: "svg.create", startTime: 0, duration: 4 }] },
      expectValid: false,
    },
    {
      name: "svg.create svgContent must be a non-empty string",
      params: { ops: [{ op: "svg.create", svgContent: "", startTime: 0, duration: 4 }] },
      expectValid: false,
    },
    {
      name: "svg.create unknown field",
      params: { ops: [{ op: "svg.create", svgContent: "<svg/>", startTime: 0, duration: 4, viewBox: "0 0 10 10" }] },
      expectValid: false,
    },
    {
      name: "valid svg.update with timing only",
      params: { ops: [{ op: "svg.update", overlayId: "svg-1", startTime: 2, duration: 5 }] },
      expectValid: true,
    },
    {
      name: "schema-valid but facade-rejected: svg.update needs a change",
      params: { ops: [{ op: "svg.update", overlayId: "svg-1" }] },
      schemaValid: true,
      expectValid: false,
    },
    {
      name: "valid svg.remove",
      params: { ops: [{ op: "svg.remove", overlayId: "svg-1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.setVolume at the ceiling",
      params: { ops: [{ op: "clip.setVolume", clipId: "c1", volume: 4 }] },
      expectValid: true,
    },
    {
      name: "valid clip.setVolume mute",
      params: { ops: [{ op: "clip.setVolume", clipId: "c1", volume: 0 }] },
      expectValid: true,
    },
    {
      name: "valid clip.remove",
      params: { ops: [{ op: "clip.remove", clipId: "c1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.move across tracks",
      params: { ops: [{ op: "clip.move", clipId: "c1", startTime: 3.5, trackId: "v2" }] },
      expectValid: true,
    },
    {
      name: "valid clip.split at an absolute timeline time",
      params: { ops: [{ op: "clip.split", clipId: "c1", time: 2.5 }] },
      expectValid: true,
    },
    {
      name: "valid clip.duplicate with automatic placement",
      params: { ops: [{ op: "clip.duplicate", clipId: "c1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.rippleDelete",
      params: { ops: [{ op: "clip.rippleDelete", clipId: "c1" }] },
      expectValid: true,
    },
    {
      name: "valid clip.setSpeed at the ceiling",
      params: { ops: [{ op: "clip.setSpeed", clipId: "c1", speed: 20 }] },
      expectValid: true,
    },
    {
      name: "valid clip.setReverse",
      params: { ops: [{ op: "clip.setReverse", clipId: "c1", reversed: true }] },
      expectValid: true,
    },
    {
      name: "valid clip.setTransform composition patch",
      params: {
        ops: [{
          op: "clip.setTransform",
          clipId: "c1",
          transform: {
            position: { x: 120, y: -40 },
            scale: { x: 0.75, y: 0.75 },
            rotation: 12,
            opacity: 0.8,
            fitMode: "cover",
            crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          },
        }],
      },
      expectValid: true,
    },
    {
      name: "valid clip.setFade with both edges",
      params: { ops: [{ op: "clip.setFade", clipId: "c1", fadeIn: 0.25, fadeOut: 0.5 }] },
      expectValid: true,
    },
    {
      name: "valid transition.add",
      params: {
        ops: [{ op: "transition.add", clipAId: "c1", clipBId: "c2", type: "crossfade", duration: 0.5 }],
      },
      expectValid: true,
    },
    {
      name: "valid transition.update",
      params: {
        ops: [{ op: "transition.update", transitionId: "tr1", type: "dipToBlack", duration: 0.3 }],
      },
      expectValid: true,
    },
    {
      name: "valid transition.remove",
      params: { ops: [{ op: "transition.remove", transitionId: "tr1" }] },
      expectValid: true,
    },
    {
      name: "valid marker.add with an asset target",
      params: {
        ops: [{ op: "marker.add", target: { kind: "asset", mediaId: "m1" }, label: "Review shot", color: "#ff0000" }],
      },
      expectValid: true,
    },
    {
      name: "valid marker.add with a clip target",
      params: { ops: [{ op: "marker.add", target: { kind: "clip", clipId: "c1" } }] },
      expectValid: true,
    },
    {
      name: "valid marker.add with a text target",
      params: { ops: [{ op: "marker.add", target: { kind: "text", textClipId: "text-1" } }] },
      expectValid: true,
    },
    {
      name: "valid marker.add with a time range target",
      params: { ops: [{ op: "marker.add", target: { kind: "timeRange", start: 1.5, end: 4 } }] },
      expectValid: true,
    },
    {
      name: "valid marker.remove by number",
      params: { ops: [{ op: "marker.remove", number: 2 }] },
      expectValid: true,
    },
    {
      name: "marker.add requires a target",
      params: { ops: [{ op: "marker.add" }] },
      expectValid: false,
    },
    {
      name: "marker.add rejects an unknown target kind",
      params: { ops: [{ op: "marker.add", target: { kind: "region", id: "r1" } }] },
      expectValid: false,
    },
    {
      name: "marker.add rejects an unknown field inside the target",
      params: { ops: [{ op: "marker.add", target: { kind: "clip", clipId: "c1", trackId: "v1" } }] },
      expectValid: false,
    },
    {
      name: "marker.add rejects a negative time-range start",
      params: { ops: [{ op: "marker.add", target: { kind: "timeRange", start: -1, end: 2 } }] },
      expectValid: false,
    },
    {
      name: "marker.add rejects an unknown op field",
      params: { ops: [{ op: "marker.add", target: { kind: "clip", clipId: "c1" }, markerId: "m" }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: marker.add label over 200 characters",
      params: { ops: [{ op: "marker.add", target: { kind: "clip", clipId: "c1" }, label: "x".repeat(201) }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "marker.remove requires a positive integer number",
      params: { ops: [{ op: "marker.remove", number: 0 }] },
      expectValid: false,
    },
    {
      name: "marker.remove rejects a wrong-typed number",
      params: { ops: [{ op: "marker.remove", number: "2" }] },
      expectValid: false,
    },
    {
      name: "marker.remove requires number",
      params: { ops: [{ op: "marker.remove" }] },
      expectValid: false,
    },
    {
      name: "valid workAsset.capture with a name",
      params: {
        ops: [{ op: "workAsset.capture", clipId: "c1", name: "Hero trim" }],
      },
      expectValid: true,
    },
    {
      name: "valid workAsset.capture with a captureRequestId echo",
      params: {
        ops: [
          {
            op: "workAsset.capture",
            clipId: "c1",
            captureRequestId: "req-42",
          },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid workAsset.capture multi-clip form (clipIds)",
      params: {
        ops: [
          {
            op: "workAsset.capture",
            clipIds: ["c1", "c2", "c3"],
            name: "Composite",
          },
        ],
      },
      expectValid: true,
    },
    {
      name: "workAsset.capture requires clipId or clipIds",
      params: { ops: [{ op: "workAsset.capture", name: "Hero trim" }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "workAsset.capture rejects clipId together with clipIds",
      params: {
        ops: [
          {
            op: "workAsset.capture",
            clipId: "c1",
            clipIds: ["c2", "c3"],
          },
        ],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "workAsset.capture rejects a one-clip clipIds set",
      params: {
        ops: [{ op: "workAsset.capture", clipIds: ["c1"] }],
      },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: workAsset.capture duplicate ids in clipIds",
      params: {
        ops: [{ op: "workAsset.capture", clipIds: ["c1", "c1"] }],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "workAsset.capture rejects a non-string entry in clipIds",
      params: {
        ops: [{ op: "workAsset.capture", clipIds: ["c1", 2] }],
      },
      expectValid: false,
    },
    {
      name: "workAsset.capture rejects an unknown field",
      params: {
        ops: [{ op: "workAsset.capture", clipId: "c1", mediaId: "m1" }],
      },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: workAsset.capture name over 200 characters",
      params: {
        ops: [{ op: "workAsset.capture", clipId: "c1", name: "x".repeat(201) }],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "valid workAsset.rename",
      params: {
        ops: [{ op: "workAsset.rename", workAssetId: "wa-1", name: "Renamed" }],
      },
      expectValid: true,
    },
    {
      name: "workAsset.rename requires a name",
      params: { ops: [{ op: "workAsset.rename", workAssetId: "wa-1" }] },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: workAsset.rename blank name",
      params: {
        ops: [{ op: "workAsset.rename", workAssetId: "wa-1", name: "   " }],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "valid workAsset.delete",
      params: { ops: [{ op: "workAsset.delete", workAssetId: "wa-1" }] },
      expectValid: true,
    },
    {
      name: "workAsset.delete requires workAssetId",
      params: { ops: [{ op: "workAsset.delete" }] },
      expectValid: false,
    },
    {
      name: "valid workAsset.instantiate onto an explicit track",
      params: {
        ops: [
          { op: "workAsset.instantiate", workAssetId: "wa-1", trackId: "v1", startTime: 2 },
        ],
      },
      expectValid: true,
    },
    {
      name: "valid workAsset.instantiate with defaults (new lane, timeline end)",
      params: { ops: [{ op: "workAsset.instantiate", workAssetId: "wa-1" }] },
      expectValid: true,
    },
    {
      name: "workAsset.instantiate requires workAssetId",
      params: { ops: [{ op: "workAsset.instantiate", trackId: "v1" }] },
      expectValid: false,
    },
    {
      name: "workAsset.instantiate rejects a negative start time",
      params: {
        ops: [{ op: "workAsset.instantiate", workAssetId: "wa-1", startTime: -1 }],
      },
      expectValid: false,
    },
    {
      name: "workAsset.instantiate rejects an unknown field",
      params: {
        ops: [
          { op: "workAsset.instantiate", workAssetId: "wa-1", clipId: "c9" },
        ],
      },
      expectValid: false,
    },
    {
      name: "position x above 1",
      params: {
        ops: [{ op: "text.create", text: "x", startTime: 0, duration: 2, position: { x: 1.5, y: 0.5 } }],
      },
      expectValid: false,
    },
    {
      name: "anchor y below 0",
      params: {
        ops: [{ op: "text.update", overlayId: "text-1", anchor: { x: 0.5, y: -0.1 } }],
      },
      expectValid: false,
    },
    {
      name: "position missing y",
      params: {
        ops: [{ op: "text.update", overlayId: "text-1", position: { x: 0.5 } }],
      },
      expectValid: false,
    },
    {
      name: "volume above the ceiling",
      params: { ops: [{ op: "clip.setVolume", clipId: "c1", volume: 4.5 }] },
      expectValid: false,
    },
    {
      name: "volume below zero",
      params: { ops: [{ op: "clip.setVolume", clipId: "c1", volume: -0.5 }] },
      expectValid: false,
    },
    {
      name: "wrong type volume",
      params: { ops: [{ op: "clip.setVolume", clipId: "c1", volume: "1" }] },
      expectValid: false,
    },
    {
      name: "missing overlayId in text.delete",
      params: { ops: [{ op: "text.delete" }] },
      expectValid: false,
    },
    {
      name: "missing clipId in clip.remove",
      params: { ops: [{ op: "clip.remove" }] },
      expectValid: false,
    },
    {
      name: "missing trackId in track.remove",
      params: { ops: [{ op: "track.remove" }] },
      expectValid: false,
    },
    {
      name: "missing mediaId in media.remove",
      params: { ops: [{ op: "media.remove" }] },
      expectValid: false,
    },
    {
      name: "empty clipId in clip.remove",
      params: { ops: [{ op: "clip.remove", clipId: "" }] },
      expectValid: false,
    },
    {
      name: "unknown field in clip.remove",
      params: { ops: [{ op: "clip.remove", clipId: "c1", trackId: "v1" }] },
      expectValid: false,
    },
    {
      name: "unknown field in track.remove",
      params: { ops: [{ op: "track.remove", trackId: "v1", force: true }] },
      expectValid: false,
    },
    {
      name: "unknown field in media.remove",
      params: { ops: [{ op: "media.remove", mediaId: "m1", force: true }] },
      expectValid: false,
    },
    {
      name: "clip.move rejects negative start time",
      params: { ops: [{ op: "clip.move", clipId: "c1", startTime: -0.1 }] },
      expectValid: false,
    },
    {
      name: "clip.split requires time",
      params: { ops: [{ op: "clip.split", clipId: "c1" }] },
      expectValid: false,
    },
    {
      name: "clip.setSpeed rejects values the core would clamp",
      params: { ops: [{ op: "clip.setSpeed", clipId: "c1", speed: 20.1 }] },
      expectValid: false,
    },
    {
      name: "transition.add rejects an unknown type",
      params: {
        ops: [{ op: "transition.add", clipAId: "c1", clipBId: "c2", type: "magic", duration: 0.5 }],
      },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: transition.update needs a change",
      params: { ops: [{ op: "transition.update", transitionId: "tr1" }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "clip.setTransform rejects an empty patch",
      params: { ops: [{ op: "clip.setTransform", clipId: "c1", transform: {} }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "clip.setTransform rejects crop outside the source",
      params: {
        ops: [{
          op: "clip.setTransform",
          clipId: "c1",
          transform: { crop: { x: 0.5, y: 0, width: 0.75, height: 1 } },
        }],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "clip.setTransform rejects crop and clearCrop together",
      params: {
        ops: [{
          op: "clip.setTransform",
          clipId: "c1",
          transform: {
            crop: { x: 0, y: 0, width: 1, height: 1 },
            clearCrop: true,
          },
        }],
      },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "schema-valid but facade-rejected: clip.setFade needs at least one edge",
      params: { ops: [{ op: "clip.setFade", clipId: "c1" }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "unknown field in text.update",
      params: {
        ops: [{ op: "text.update", overlayId: "text-1", font_size: 48 }],
      },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: whitespace-only text.update",
      params: { ops: [{ op: "text.update", overlayId: "text-1", text: "   " }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "schema-valid but facade-rejected: text.update needs at least one updatable field",
      params: { ops: [{ op: "text.update", overlayId: "text-1" }] },
      expectValid: false,
      schemaValid: true,
    },
    {
      name: "schema-valid but facade-rejected: whitespace-only text.create",
      params: {
        ops: [
          { op: "text.create", text: "   ", startTime: 0, duration: 2 },
        ],
      },
      expectValid: false,
      schemaValid: true,
    },
    { name: "missing required ops", params: { expectedRevision: 0 }, expectValid: false },
    { name: "ops must be an array", params: { ops: "track.add" }, expectValid: false },
    { name: "ops must not be empty", params: { ops: [] }, expectValid: false },
    { name: "unknown envelope field", params: { ops: [{ op: "track.add", trackType: "video" }], track_id: "v1" }, expectValid: false },
    {
      name: "unsupported op (union violation)",
      params: { ops: [{ op: "clip.merge", clipId: "c1" }] },
      expectValid: false,
    },
    {
      name: "trackType enum violation",
      params: { ops: [{ op: "track.add", trackType: "gold" }] },
      expectValid: false,
    },
    {
      name: "unknown op field",
      params: { ops: [{ op: "track.add", trackType: "video", track_type: "v" }] },
      expectValid: false,
    },
    {
      name: "wrong type startTime",
      params: { ops: [{ op: "clip.add", trackId: "v1", mediaId: "m1", startTime: "0" }] },
      expectValid: false,
    },
    {
      name: "unknown style field",
      params: {
        ops: [{ op: "text.create", text: "x", startTime: 0, duration: 2, style: { font_size: 48 } }],
      },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: clip.trim needs at least one of in/out",
      params: { ops: [{ op: "clip.trim", clipId: "c1" }] },
      expectValid: false,
      schemaValid: true,
    },
  ],
  "history.get": [
    { name: "empty params valid", params: {}, expectValid: true },
    { name: "bounded limit valid", params: { limit: 20 }, expectValid: true },
    { name: "limit above ceiling", params: { limit: 101 }, expectValid: false },
    { name: "unknown field", params: { full: true }, expectValid: false },
  ],
  "history.control": [
    { name: "valid undo", params: { action: "undo", expectedRevision: 2, idempotencyKey: "u1" }, expectValid: true },
    { name: "valid redo", params: { action: "redo" }, expectValid: true },
    { name: "missing action", params: {}, expectValid: false },
    { name: "action enum violation", params: { action: "reset" }, expectValid: false },
    { name: "unknown field", params: { action: "undo", count: 2 }, expectValid: false },
  ],
  "preview.render_frame": [
    { name: "valid", params: { timeSec: 2.5 }, expectValid: true },
    {
      name: "valid with raster",
      params: { timeSec: 0, width: 640, height: 360, expectedRevision: 2, idempotencyKey: "p1" },
      expectValid: true,
    },
    { name: "missing required timeSec", params: { width: 640 }, expectValid: false },
    { name: "timeSec below minimum", params: { timeSec: -0.5 }, expectValid: false },
    {
      name: "width below schema minimum",
      params: { timeSec: 0, width: 0, height: 360 },
      expectValid: false,
    },
    {
      name: "schema-valid but facade-rejected: odd width (evenness is validator-only)",
      params: { timeSec: 0, width: 639, height: 360 },
      expectValid: false,
      schemaValid: true,
    },
    { name: "unknown field", params: { timeSec: 0, format: "png" }, expectValid: false },
  ],
  "preview.render_comparison": [
    { name: "valid", params: { timeSec: 2.5 }, expectValid: true },
    {
      name: "valid with layout override and raster",
      params: { timeSec: 0, width: 640, height: 360, layout: "overlay", maxFrameBytes: 262144 },
      expectValid: true,
    },
    { name: "missing required timeSec", params: { width: 640 }, expectValid: false },
    { name: "timeSec below minimum", params: { timeSec: -0.5 }, expectValid: false },
    { name: "invalid layout", params: { timeSec: 0, layout: "wipe" }, expectValid: false },
    { name: "budget under minimum", params: { timeSec: 0, maxFrameBytes: 1000 }, expectValid: false },
    { name: "unknown field", params: { timeSec: 0, roi: { x: 0 } }, expectValid: false },
  ],
  "analysis.list": [
    { name: "valid empty", params: {}, expectValid: true },
    { name: "valid with filter", params: { mediaId: "media-1", limit: 10 }, expectValid: true },
    { name: "limit zero", params: { limit: 0 }, expectValid: false },
    { name: "unknown field", params: { projectId: "p" }, expectValid: false },
  ],
  "analysis.get": [
    { name: "valid", params: { recordId: "analysis-123e4567-e89b-12d3-a456-426614174000" }, expectValid: true },
    { name: "missing recordId", params: {}, expectValid: false },
    { name: "empty recordId", params: { recordId: "" }, expectValid: false },
  ],
  "visual.inspect": [
    { name: "valid clip selection", params: { clipId: "clip-1" }, expectValid: true },
    {
      name: "valid explicit range",
      params: { timeRange: { startSec: 0, endSec: 3 }, sampleCount: 12, width: 320, height: 180 },
      expectValid: true,
    },
    { name: "schema-valid but facade-rejected: selection is required", params: { sampleCount: 3 }, expectValid: false, schemaValid: true },
    { name: "schema-valid but facade-rejected: selection is exclusive", params: { clipId: "clip-1", timeRange: { startSec: 0, endSec: 3 } }, expectValid: false, schemaValid: true },
    { name: "wrong sample count", params: { clipId: "clip-1", sampleCount: 13 }, expectValid: false },
    { name: "wrong range type", params: { timeRange: { startSec: 0 } }, expectValid: false },
    { name: "width over visual limit", params: { clipId: "clip-1", width: 2048 }, expectValid: false },
    { name: "unknown field", params: { clipId: "clip-1", format: "png" }, expectValid: false },
  ],
  "export.start": [
    { name: "valid empty", params: {}, expectValid: true },
    { name: "valid with settings", params: { settings: { format: "mp4", codec: "h264", width: 1280, height: 720 } }, expectValid: true },
    {
      name: "format const violation",
      params: { settings: { format: "mov" } },
      expectValid: false,
    },
    {
      name: "unknown settings field",
      params: { settings: { audioBitrateKbps: 128 } },
      expectValid: false,
    },
    { name: "settings wrong type", params: { settings: [1, 2] }, expectValid: false },
    {
      name: "videoBitrateKbps must be a positive integer",
      params: { settings: { videoBitrateKbps: 0 } },
      expectValid: false,
    },
    {
      name: "valid upscaling request",
      params: { settings: { upscaling: { enabled: true, quality: "quality" } } },
      expectValid: true,
    },
    {
      name: "upscaling enabled alone is valid (quality defaults)",
      params: { settings: { upscaling: { enabled: true } } },
      expectValid: true,
    },
    {
      name: "upscaling requires enabled",
      params: { settings: { upscaling: { quality: "fast" } } },
      expectValid: false,
    },
    {
      name: "upscaling quality is the GUI tier enum",
      params: { settings: { upscaling: { enabled: true, quality: "ultra" } } },
      expectValid: false,
    },
    {
      name: "upscaling rejects sharpening (GUI-only slider, not agent surface)",
      params: { settings: { upscaling: { enabled: true, sharpening: 0.5 } } },
      expectValid: false,
    },
  ],
  "job.status": [
    { name: "valid", params: { jobId: "job-abc" }, expectValid: true },
    { name: "missing required jobId", params: {}, expectValid: false },
    { name: "wrong type jobId", params: { jobId: 7 }, expectValid: false },
    { name: "unknown field", params: { jobId: "j", wait: true }, expectValid: false },
  ],
  "job.cancel": [
    { name: "valid", params: { jobId: "job-abc" }, expectValid: true },
    { name: "missing required jobId", params: {}, expectValid: false },
    { name: "unknown field", params: { jobId: "j", force: true }, expectValid: false },
  ],
  "verify.artifact": [
    { name: "valid minimal", params: { path: "/artifacts/out.mp4" }, expectValid: true },
    {
      name: "valid full",
      params: {
        path: "/artifacts/out.mp4",
        expect: { container: "mp4", videoCodec: "h264", width: 1920, height: 1080, durationSec: 5, durationToleranceSec: 0.05 },
        compare: { referencePath: "/artifacts/ref.png", timeSec: 2.5, referenceTimeSec: 2.5, region: { x: 0, y: 0.5, width: 1, height: 0.5 }, mode: "similar", maxMeanAbsDiff: 8 },
      },
      expectValid: true,
    },
    { name: "missing required path", params: { expect: { container: "mp4" } }, expectValid: false },
    { name: "expect container const violation", params: { path: "/a", expect: { container: "avi" } }, expectValid: false },
    { name: "compare mode enum violation", params: { path: "/a", compare: { referencePath: "/b", timeSec: 0, mode: "same" } }, expectValid: false },
    { name: "region below minimum", params: { path: "/a", compare: { referencePath: "/b", timeSec: 0, mode: "similar", region: { x: -0.1, y: 0, width: 0.5, height: 0.5 } } }, expectValid: false },
    { name: "unknown top-level field", params: { path: "/a", hash: "xxx" }, expectValid: false },
    { name: "wrong type compare", params: { path: "/a", compare: "pixel" }, expectValid: false },
    {
      name: "schema-valid but facade-rejected: region x+width <= 1 is validator-only",
      params: {
        path: "/a",
        compare: { referencePath: "/b", timeSec: 0, mode: "similar", region: { x: 0.6, y: 0, width: 0.6, height: 0.5 } },
      },
      expectValid: false,
      schemaValid: true,
    },
  ],
  "material.list": [
    { name: "empty params valid", params: {}, expectValid: true },
    { name: "valid full filter", params: { kind: "media", status: "inbox", tag: "intro", query: "sunset", page: 2, pageSize: 50, sort: "title" }, expectValid: true },
    { name: "bad kind enum", params: { kind: "folder" }, expectValid: false },
    { name: "pageSize above max", params: { pageSize: 500 }, expectValid: false },
    { name: "unknown field", params: { folder: "x" }, expectValid: false },
  ],
  "material.get": [
    { name: "valid", params: { id: "mat_1" }, expectValid: true },
    { name: "missing id", params: {}, expectValid: false },
    { name: "wrong type id", params: { id: 7 }, expectValid: false },
  ],
  "material.create": [
    { name: "valid link", params: { kind: "link", url: "https://example.com/guide" }, expectValid: true },
    { name: "valid method with steps", params: { kind: "method", prompt: "Cut highlights", steps: ["Inspect"], inputs: ["videos"] }, expectValid: true },
    { name: "missing kind", params: { url: "https://example.com" }, expectValid: false },
    { name: "bad kind enum", params: { kind: "folder" }, expectValid: false },
    { name: "empty steps item", params: { kind: "method", prompt: "p", steps: [""] }, expectValid: false },
    {
      name: "schema-valid but facade-rejected: media without filePath",
      params: { kind: "media", mediaType: "video" },
      expectValid: false,
      schemaValid: true,
    },
  ],
  "material.update": [
    { name: "valid tags+status", params: { id: "mat_1", tags: ["a"], organizeStatus: "organized", expectedRevision: 2 }, expectValid: true },
    { name: "missing id", params: { tags: ["a"] }, expectValid: false },
    { name: "empty title", params: { id: "mat_1", title: "" }, expectValid: false },
    { name: "userNotes is not an agent field", params: { id: "mat_1", userNotes: "x" }, expectValid: false },
    { name: "negative expectedRevision", params: { id: "mat_1", expectedRevision: -1 }, expectValid: false },
  ],
  "material.batch_update": [
    {
      name: "valid two-item batch",
      params: { updates: [{ id: "mat_1", aiSummary: "s" }, { id: "mat_2", tags: ["x"], organizeStatus: "inbox" }] },
      expectValid: true,
    },
    { name: "empty updates array", params: { updates: [] }, expectValid: false },
    { name: "item missing id", params: { updates: [{ tags: ["x"] }] }, expectValid: false },
    { name: "updates not an array", params: { updates: { id: "mat_1" } }, expectValid: false },
    { name: "unknown top field", params: { updates: [{ id: "mat_1" }], force: true }, expectValid: false },
  ],
  "material.remove": [
    { name: "valid", params: { id: "mat_1", force: true }, expectValid: true },
    { name: "missing id", params: { force: true }, expectValid: false },
    { name: "force not boolean", params: { id: "mat_1", force: "yes" }, expectValid: false },
  ],
  "material.attach": [
    { name: "valid ranged", params: { materialId: "mat_1", startSec: 1, endSec: 5, addClip: true, expectedRevision: 3, idempotencyKey: "a1" }, expectValid: true },
    { name: "missing materialId", params: { startSec: 0 }, expectValid: false },
    { name: "negative startSec", params: { materialId: "mat_1", startSec: -1 }, expectValid: false },
    { name: "zero endSec", params: { materialId: "mat_1", startSec: 0, endSec: 0 }, expectValid: false },
    { name: "unknown field", params: { materialId: "mat_1", path: "/x" }, expectValid: false },
  ],
  "material.undo": [
    { name: "empty params valid", params: {}, expectValid: true },
    { name: "valid entryId+key", params: { entryId: "mjr_1", idempotencyKey: "u1" }, expectValid: true },
    { name: "empty entryId", params: { entryId: "" }, expectValid: false },
    { name: "unknown field", params: { force: true }, expectValid: false },
  ],
  "font.upload": [
    { name: "valid filePath", params: { filePath: "/media/job/x.ttf" }, expectValid: true },
    { name: "valid name+dataBase64", params: { name: "Bar", dataBase64: "AAAA" }, expectValid: true },
    { name: "missing both inputs (facade rejects, schema is a superset)", params: { name: "Bar" }, expectValid: false, schemaValid: true },
    { name: "both inputs (facade rejects, schema is a superset)", params: { filePath: "/a.ttf", dataBase64: "AAAA" }, expectValid: false, schemaValid: true },
    { name: "empty filePath", params: { filePath: "" }, expectValid: false },
    { name: "name too long", params: { name: "x".repeat(121), dataBase64: "AAAA" }, expectValid: false },
    { name: "unknown field", params: { filePath: "/a.ttf", force: true }, expectValid: false },
  ],
  "font.list": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { filter: "x" }, expectValid: false },
  ],
  "preset.list": [
    { name: "empty params valid", params: {}, expectValid: true },
    { name: "kind filter", params: { kind: "text", includePayload: true }, expectValid: true },
    { name: "query filter", params: { query: "title" }, expectValid: true },
    { name: "bad kind enum", params: { kind: "layout" }, expectValid: false },
    { name: "includePayload not boolean", params: { includePayload: "yes" }, expectValid: false },
    { name: "unknown field", params: { page: 1 }, expectValid: false },
  ],
  "preset.get": [
    { name: "valid", params: { id: "preset_1" }, expectValid: true },
    { name: "missing id", params: {}, expectValid: false },
    { name: "empty id", params: { id: "" }, expectValid: false },
    { name: "unknown field", params: { id: "p", kind: "text" }, expectValid: false },
  ],
  "preset.create": [
    {
      name: "valid text preset",
      params: {
        kind: "text",
        name: "Agent Title",
        payload: { schemaVersion: 1, kind: "text", style: { fontSize: 72, fontWeight: 700 } },
        tags: ["agent"],
        idempotencyKey: "pc1",
      },
      expectValid: true,
    },
    {
      name: "valid effect preset without tags",
      params: {
        kind: "effect",
        name: "Warm",
        payload: { schemaVersion: 1, kind: "effect", effects: [{ type: "brightness", params: {} }] },
      },
      expectValid: true,
    },
    { name: "missing payload", params: { kind: "text", name: "x" }, expectValid: false },
    { name: "bad kind enum", params: { kind: "layout", name: "x", payload: {} }, expectValid: false },
    { name: "empty name", params: { kind: "text", name: "", payload: {} }, expectValid: false },
    { name: "payload not an object", params: { kind: "text", name: "x", payload: "y" }, expectValid: false },
    { name: "empty tag item", params: { kind: "text", name: "x", payload: {}, tags: [""] }, expectValid: false },
    {
      name: "schema-valid but facade-rejected: deep payload validation runs in the session body",
      params: {
        kind: "text",
        name: "Bad",
        payload: { schemaVersion: 1, kind: "text", style: { notAStyleField: 1 } },
      },
      expectValid: false,
      schemaValid: true,
    },
  ],
  "preset.update": [
    {
      name: "valid rename with CAS",
      params: { id: "preset_1", name: "Renamed", expectedRevision: 2, idempotencyKey: "pu1" },
      expectValid: true,
    },
    { name: "missing id", params: { name: "x" }, expectValid: false },
    { name: "negative expectedRevision", params: { id: "p", expectedRevision: -1 }, expectValid: false },
    { name: "empty name", params: { id: "p", name: "" }, expectValid: false },
    { name: "unknown field", params: { id: "p", builtinBaseId: "text:Heading" }, expectValid: false },
  ],
  "preset.remove": [
    { name: "valid", params: { id: "preset_1", idempotencyKey: "pr1" }, expectValid: true },
    { name: "missing id", params: {}, expectValid: false },
    { name: "unknown field", params: { id: "p", force: true }, expectValid: false },
  ],
  "preset.apply": [
    {
      name: "valid effect target",
      params: { presetId: "preset_1", target: { kind: "effect", clipIds: ["clip-1"] }, idempotencyKey: "pa1" },
      expectValid: true,
    },
    {
      name: "valid transition cut",
      params: {
        presetId: "preset_1",
        target: { kind: "transition", clipAId: "a", clipBId: "b" },
        expectedRevision: 4,
      },
      expectValid: true,
    },
    {
      name: "valid graphics target with explicit placement",
      params: {
        presetId: "preset_1",
        target: { kind: "graphics", trackId: "gfx-1", startTime: 2, durationSec: 4 },
      },
      expectValid: true,
    },
    {
      name: "valid graphics target with defaults (track/time/duration omitted)",
      params: {
        presetId: "preset_1",
        target: { kind: "graphics" },
        idempotencyKey: "pa2",
      },
      expectValid: true,
    },
    {
      name: "graphics startTime must be non-negative",
      params: {
        presetId: "preset_1",
        target: { kind: "graphics", startTime: -1 },
      },
      expectValid: false,
    },
    {
      name: "graphics durationSec must be positive",
      params: {
        presetId: "preset_1",
        target: { kind: "graphics", durationSec: 0 },
      },
      expectValid: false,
    },
    { name: "missing target", params: { presetId: "preset_1" }, expectValid: false },
    { name: "target not an object", params: { presetId: "preset_1", target: "clip-1" }, expectValid: false },
    {
      name: "unknown target kind",
      params: { presetId: "preset_1", target: { kind: "layout" } },
      expectValid: false,
    },
    {
      name: "text create mode is not an agent operation",
      params: { presetId: "preset_1", target: { kind: "text", mode: "create" } },
      expectValid: false,
    },
    { name: "unknown field", params: { presetId: "p", target: { kind: "effect", clipIds: ["a"] }, at: 0 }, expectValid: false },
  ],
  "help.list_screens": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { language: "zh" }, expectValid: false },
  ],
  "help.describe": [
    { name: "valid screen id", params: { screenId: "timeline" }, expectValid: true },
    { name: "missing screenId", params: {}, expectValid: false },
    { name: "empty screenId", params: { screenId: "" }, expectValid: false },
    {
      name: "whitespace screenId passes the boundary schema, fails as an unknown id",
      params: { screenId: "  " },
      schemaValid: true,
      expectValid: false,
    },
    { name: "wrong type screenId", params: { screenId: 7 }, expectValid: false },
    { name: "unknown field", params: { screenId: "timeline", language: "zh" }, expectValid: false },
  ],
  "help.search": [
    { name: "valid zh keyword", params: { query: "静音" }, expectValid: true },
    { name: "valid en keyword", params: { query: "rename" }, expectValid: true },
    { name: "missing query", params: {}, expectValid: false },
    { name: "whitespace-only query", params: { query: "   " }, schemaValid: true, expectValid: false },
    { name: "empty query", params: { query: "" }, expectValid: false },
    { name: "wrong type query", params: { query: 42 }, expectValid: false },
    { name: "unknown field", params: { query: "mute", limit: 5 }, expectValid: false },
  ],
} as const;
