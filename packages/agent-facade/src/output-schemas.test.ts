import { describe, expect, it } from "vitest";
import { EMITTED_VERB_OUTPUT_JSON_SCHEMAS } from "./output-schemas";
import { FACADE_VERBS } from "./types";

type Schema = Record<string, unknown>;

describe("emitted MCP output schemas", () => {
  it("covers every facade verb with a closed successful envelope", () => {
    expect(Object.keys(EMITTED_VERB_OUTPUT_JSON_SCHEMAS).sort()).toEqual(
      [...FACADE_VERBS].sort(),
    );
    for (const verb of FACADE_VERBS) {
      const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as unknown as Schema;
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["ok", "value"],
      });
      expect((schema.properties as Schema).ok).toEqual({ const: true });
    }
  });

  it("makes edit.apply creating-op results explicit per applied op", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["edit.apply"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    const applied = (value.properties as Schema).applied as Schema;
    const item = applied.items as Schema;
    expect(item.required).toEqual(["op", "createdIds"]);
    expect(item.additionalProperties).toBe(false);
    expect((item.properties as Schema).createdIds).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("timeline.get reports the sorted project-marker array with the closed target union", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["timeline.get"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    expect(value.required).toEqual(["revision", "duration", "tracks", "textOverlays", "subtitles", "markers"]);
    const markers = (value.properties as Schema).markers as Schema;
    const item = markers.items as Schema;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["ref", "number", "id", "target", "createdAt"]);
    const target = (item.properties as Schema).target as Schema;
    const variants = target.anyOf as Schema[];
    expect(variants).toHaveLength(4);
    expect(variants.map((v) => ((v.properties as Schema).kind as Schema).const))
      .toEqual(["asset", "clip", "text", "timeRange"]);
  });

  it("media.import describes every supported media result kind", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["media.import"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    expect((value.properties as Schema).type).toEqual({ enum: ["video", "audio", "image"] });
  });

  it("describes audio-process start, artifact status, registration, and capability results", () => {
    const start = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["audio.process.normalize"] as unknown as Schema;
    const startValue = (start.properties as Schema).value as Schema;
    expect(startValue.required).toEqual(["jobId", "kind", "state", "sourceRevision", "replayed"]);
    expect((startValue.properties as Schema).kind).toEqual({ const: "audio-process" });

    const register = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["audio.process.register"] as unknown as Schema;
    expect((register.properties as Schema).value).toEqual(
      ((EMITTED_VERB_OUTPUT_JSON_SCHEMAS["media.import"] as unknown as Schema).properties as Schema).value,
    );

    const status = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["job.status"] as unknown as Schema;
    const statusValue = (status.properties as Schema).value as Schema;
    expect((statusValue.properties as Schema).kind).toEqual({ enum: ["export", "analysis", "audio-process"] });
    const result = (statusValue.properties as Schema).result as Schema;
    const variants = ((result.anyOf as Schema[])[0].anyOf as Schema[]);
    expect(variants).toHaveLength(2);
    const normalized = variants[1];
    expect(normalized.required).toEqual([
      "path", "provenancePath", "source", "parameters", "before", "after", "timing", "bytes", "sha256",
    ]);
    expect(((normalized.properties as Schema).timing as Schema).properties).toMatchObject({
      sampleRate: { enum: [48000] },
      outputStartSec: { type: "number", minimum: 0, maximum: 0 },
      processingDelaySamples: { type: "integer", minimum: 0, maximum: 0 },
    });

    const capabilities = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["capabilities.get"] as unknown as Schema;
    expect(((capabilities.properties as Schema).value as Schema).properties).toHaveProperty("audioNormalize");
  });

  it("makes evidence coordinates and identity explicit in visual and analysis results", () => {
    const visual = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["visual.inspect"] as unknown as Schema;
    const visualValue = (visual.properties as Schema).value as Schema;
    expect(visualValue.required).toContain("mediaSources");
    const mediaSources = (visualValue.properties as Schema).mediaSources as Schema;
    expect(((mediaSources.items as Schema).required as string[])).toEqual([
      "mediaId", "sizeBytes", "mtimeMs", "sha256",
    ]);
    const frames = (visualValue.properties as Schema).frames as Schema;
    const frame = frames.items as Schema;
    expect(frame.required).toContain("requestedTimelineTimeSec");
    expect(frame.required).toContain("renderedTimelineTimeSec");
    expect((frame.properties as Schema).coordinateSpace).toEqual({ const: "timeline" });
    expect((frame.properties as Schema).renderedTimelineTimeSec).toEqual({ const: null });
    expect((frame.properties as Schema).sourceFrameNumber).toEqual({ const: null });
    expect((frame.properties as Schema).sourcePtsSec).toEqual({ const: null });

    const analysis = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["analysis.get"] as unknown as Schema;
    const analysisValue = (analysis.properties as Schema).value as Schema;
    expect(analysisValue.required).toContain("sourceRevision");
    expect((analysisValue.properties as Schema).coordinateSpace).toEqual({ const: "source" });
  });

  it("bounds analysis event pages and waveform output while exposing historical completeness", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["analysis.get"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    const properties = value.properties as Schema;
    expect((properties.schemaVersion as Schema).enum).toEqual([3]);
    expect(properties.view).toEqual({ enum: ["summary", "events", "waveform"] });

    const details = properties.details as Schema;
    expect(details.maxItems).toBe(4);
    const detail = details.items as Schema;
    expect(detail.required).toEqual(["series", "totalCount", "storedCount", "complete"]);
    expect((detail.properties as Schema).totalCount).toMatchObject({ anyOf: [{ type: "integer", minimum: 0 }, { const: null }] });

    const events = properties.events as Schema;
    expect(((events.properties as Schema).items as Schema).maxItems).toBe(256);
    expect(((events.properties as Schema).limit as Schema)).toMatchObject({ type: "integer", minimum: 1, maximum: 256 });
    expect(events.required).toContain("storedMatched");
    expect((events.properties as Schema).storedMatched).toEqual({ type: "integer", minimum: 0 });
    expect((events.properties as Schema).totalMatched).toMatchObject({ anyOf: [{ type: "integer", minimum: 0 }, { const: null }] });
    const waveform = properties.waveform as Schema;
    expect(((waveform.properties as Schema).points as Schema).maxItems).toBe(600);
    expect((waveform.properties as Schema).maxPoints).toMatchObject({ type: "integer", minimum: 1, maximum: 600 });
  });

  it("exposes workspace routing identity from editor.get_context without requiring it headlessly", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["editor.get_context"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    const identity = ((value.properties as Schema).identity as Schema);
    expect(identity.properties).toHaveProperty("workspaceId", { type: "string" });
    expect(identity.properties).toHaveProperty("workspaceInstanceId", { type: "string" });
    expect(identity.required).not.toContain("workspaceId");
    expect(identity.required).not.toContain("workspaceInstanceId");
  });

  it("does not prescribe agent collaboration behavior", () => {
    for (const verb of ["session.describe", "editor.get_context"] as const) {
      const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as unknown as Schema;
      const value = (schema.properties as Schema).value as Schema;
      expect(value.properties).not.toHaveProperty("workMode");
      expect(value.properties).not.toHaveProperty("workModeSemantics");
    }
  });
});
