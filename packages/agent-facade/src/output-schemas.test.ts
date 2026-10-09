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
