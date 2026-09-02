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
  "project.get_state": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { summary: true }, expectValid: false },
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
  "timeline.get": [
    { name: "no params is valid", params: {}, expectValid: true },
    { name: "unknown field", params: { trackId: "v1" }, expectValid: false },
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
  "edit.apply": [
    {
      name: "valid track.add without optional id",
      params: { ops: [{ op: "track.add", trackType: "video" }] },
      expectValid: true,
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
} as const;
