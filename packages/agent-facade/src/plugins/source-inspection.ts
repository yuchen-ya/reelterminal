import { definePlugin, defineTool } from "../plugin-api";
import type { ArtifactRef } from "../providers";

export interface SourceInspectInput {
  readonly mediaId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly sampleCount?: number;
  readonly width?: number;
  readonly expectedRevision?: number;
}

export interface SourceInspectResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly mediaId: string;
  readonly mediaName: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly width: number;
  readonly height: number;
  readonly frames: readonly { timeSec: number; label: string; artifact: ArtifactRef }[];
  readonly contactSheet: ArtifactRef | null;
  readonly limitations: readonly string[];
}

const nonnegative = {
  check: (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  describe: "a non-negative finite source time in seconds",
  emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
} as const;
const artifact = { type: "object", additionalProperties: true, properties: {} } as const;

export const sourceInspectionPlugin = definePlugin({
  id: "source-inspection",
  tools: [defineTool({
    name: "media.inspect",
    description: "Sample an imported source video between startSec and endSec in ORIGINAL MEDIA seconds. Returns timestamped PNG frames and an optional contact sheet, without changing the timeline. Sparse visual samples do not review motion or audio.",
    schemaCases: [
      { name: "source range", params: { mediaId: "source", startSec: 0, endSec: 1 }, expectValid: true },
      { name: "missing source", params: { startSec: 0, endSec: 1 }, expectValid: false },
      { name: "negative start", params: { mediaId: "source", startSec: -1, endSec: 1 }, expectValid: false },
      { name: "too many frames", params: { mediaId: "source", startSec: 0, endSec: 1, sampleCount: 13 }, expectValid: false },
      { name: "unknown field", params: { mediaId: "source", startSec: 0, endSec: 1, path: "/tmp/source" }, expectValid: false },
    ],
    effect: "read",
    requires: ["render", "artifactRoot", "mediaRoots"],
    presentation: "image-collection",
    input: {
      mediaId: { required: true, check: (v) => typeof v === "string" && v.length > 0, describe: "an imported media id", emits: { kind: "leaf", schema: { type: "string", minLength: 1 } } },
      startSec: { ...nonnegative, required: true },
      endSec: { ...nonnegative, required: true },
      sampleCount: { check: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12, describe: "an integer from 1 to 12", emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 12 } } },
      width: { check: (v) => Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 1024 && (v as number) % 2 === 0, describe: "an even integer from 2 to 1024", emits: { kind: "leaf", schema: { type: "integer", minimum: 2, maximum: 1024 } } },
      expectedRevision: { check: (v) => Number.isInteger(v) && (v as number) >= 0, describe: "a non-negative integer", emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
    },
    output: {
      type: "object", additionalProperties: false,
      properties: {
        revision: { type: "integer", minimum: 0 }, sourceRevision: { type: "integer", minimum: 0 },
        mediaId: { type: "string" }, mediaName: { type: "string" },
        startSec: { type: "number", minimum: 0 }, endSec: { type: "number", minimum: 0 },
        width: { type: "integer", minimum: 2 }, height: { type: "integer", minimum: 2 },
        frames: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, properties: { timeSec: { type: "number", minimum: 0 }, label: { type: "string" }, artifact }, required: ["timeSec", "label", "artifact"] } },
        contactSheet: { anyOf: [artifact, { const: null }] },
        limitations: { type: "array", items: { type: "string" } },
      },
      required: ["revision", "sourceRevision", "mediaId", "mediaName", "startSec", "endSec", "width", "height", "frames", "contactSheet", "limitations"],
    },
    async execute(input: SourceInspectInput, context): Promise<SourceInspectResult> {
      const { inspectSource } = await import("../source-inspection");
      return inspectSource(input, context);
    },
  })],
});
