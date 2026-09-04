/**
 * Machine-readable successful-result schemas for the facade tools.
 *
 * The MCP transports return the complete `{ok:true,value}` envelope in
 * structuredContent, so these schemas describe that envelope (not a guessed
 * `results[]` convenience shape). Error envelopes are `isError:true` and are
 * intentionally outside successful-output validation. Keep this declaration
 * small and JSON-only: it is shared by stdio and live MCP transports.
 */
import { EDIT_OP_TYPES, type FacadeVerb } from "./types";

export type OutputSchemaNode =
  | {
      readonly type: "object";
      readonly additionalProperties: boolean;
      readonly properties: Readonly<Record<string, OutputSchemaNode>>;
      readonly required?: readonly string[];
    }
  | {
      readonly type: "array";
      readonly items: OutputSchemaNode;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | { readonly type: "string" }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean" }
  | { readonly const: string | boolean | null }
  | { readonly enum: readonly (string | number | boolean | null)[] }
  | { readonly anyOf: readonly OutputSchemaNode[] };

export type OutputSchemaObject = Extract<OutputSchemaNode, { readonly type: "object" }>;

const stringSchema = (): OutputSchemaNode => ({ type: "string" });
const numberSchema = (minimum?: number, maximum?: number): OutputSchemaNode => ({
  type: "number",
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});
const integerSchema = (minimum?: number, maximum?: number): OutputSchemaNode => ({
  type: "integer",
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});
const booleanSchema = (): OutputSchemaNode => ({ type: "boolean" });
const constSchema = (value: string | boolean | null): OutputSchemaNode => ({ const: value });
const enumSchema = (values: readonly (string | number | boolean | null)[]): OutputSchemaNode => ({
  enum: values,
});

const objectSchema = (
  properties: Readonly<Record<string, OutputSchemaNode>>,
  required?: readonly string[],
  additionalProperties = false,
): OutputSchemaObject => ({
  type: "object",
  additionalProperties,
  properties,
  ...(required !== undefined && required.length > 0 ? { required } : {}),
});

const arraySchema = (
  items: OutputSchemaNode,
  options: { readonly minItems?: number; readonly maxItems?: number } = {},
): OutputSchemaNode => ({
  type: "array",
  items,
  ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
  ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
});

const nullable = (schema: OutputSchemaNode): OutputSchemaNode => ({
  anyOf: [schema, constSchema(null)],
});

const openObject = (): OutputSchemaNode => objectSchema({}, undefined, true);

const workModeSemantics = (): OutputSchemaNode =>
  objectSchema(
    {
      id: enumSchema(["guided", "collaborative", "autonomous"]),
      label: enumSchema(["Guided", "Collaborative", "Autonomous"]),
      summary: stringSchema(),
      deliveryRequiresExplicitAuthorization: constSchema(true),
    },
    ["id", "label", "summary", "deliveryRequiresExplicitAuthorization"],
  );

const artifactRef = (): OutputSchemaNode =>
  objectSchema(
    {
      kind: enumSchema(["image", "video"]),
      format: enumSchema(["png", "mp4"]),
      path: stringSchema(),
      sizeBytes: integerSchema(0),
      sha256: stringSchema(),
      sourceRevision: integerSchema(0),
    },
    ["kind", "format", "path", "sizeBytes", "sha256", "sourceRevision"],
  );

const projectCounts = (): OutputSchemaNode =>
  objectSchema(
    {
      tracks: integerSchema(0),
      clips: integerSchema(0),
      mediaItems: integerSchema(0),
      textOverlays: integerSchema(0),
    },
    ["tracks", "clips", "mediaItems", "textOverlays"],
  );

const projectState = (): OutputSchemaObject =>
  objectSchema(
    {
      revision: integerSchema(0),
      // Project is deliberately open: the canonical core model is versioned
      // independently from this facade contract.
      project: openObject(),
      counts: projectCounts(),
    },
    ["revision", "project", "counts"],
  );

const importedMediaMetadata = (): OutputSchemaNode =>
  objectSchema(
    {
      durationSec: numberSchema(0),
      width: integerSchema(0),
      height: integerSchema(0),
      frameRate: numberSchema(0),
      codec: stringSchema(),
      fileSize: integerSchema(0),
    },
    ["durationSec", "width", "height", "frameRate", "codec", "fileSize"],
  );

const timelineClip = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      trackId: stringSchema(),
      mediaId: stringSchema(),
      startTime: numberSchema(0),
      duration: numberSchema(0),
      inPoint: numberSchema(0),
      outPoint: numberSchema(0),
      volume: numberSchema(0),
      speed: numberSchema(0),
      reversed: booleanSchema(),
      fade: objectSchema(
        { fadeIn: numberSchema(0), fadeOut: numberSchema(0) },
        ["fadeIn", "fadeOut"],
      ),
      transform: openObject(),
    },
    [
      "id",
      "trackId",
      "mediaId",
      "startTime",
      "duration",
      "inPoint",
      "outPoint",
      "volume",
      "speed",
      "reversed",
      "fade",
      "transform",
    ],
  );

const timelineTrack = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      type: stringSchema(),
      name: stringSchema(),
      clips: arraySchema(timelineClip()),
      transitions: arraySchema(openObject()),
    },
    ["id", "type", "name", "clips", "transitions"],
  );

const textOverlay = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      trackId: stringSchema(),
      text: stringSchema(),
      startTime: numberSchema(0),
      duration: numberSchema(0),
      position: objectSchema({ x: numberSchema(0, 1), y: numberSchema(0, 1) }, ["x", "y"]),
      anchor: objectSchema({ x: numberSchema(0, 1), y: numberSchema(0, 1) }, ["x", "y"]),
    },
    ["id", "trackId", "text", "startTime", "duration", "position", "anchor"],
  );

const editorReferences = (): OutputSchemaNode => openObject();

const successEnvelope = (value: OutputSchemaNode): OutputSchemaObject =>
  objectSchema(
    { ok: constSchema(true), value },
    ["ok", "value"],
  );

const sessionDescription = (): OutputSchemaNode =>
  objectSchema(
    {
      facadeVersion: stringSchema(),
      contractVersion: stringSchema(),
      runtime: enumSchema(["node-headless", "live"]),
      verbs: arraySchema(stringSchema(), { minItems: 1 }),
      editOps: arraySchema(stringSchema()),
      errorCodes: arraySchema(stringSchema(), { minItems: 1 }),
      stepLetters: objectSchema(
        {
          facadeToRuntime: constSchema("P"),
          createProject: enumSchema(["P", "X"]),
          importLocalMedia: enumSchema(["A", "X"]),
          trimClip: constSchema("P"),
          addTextOverlayModel: constSchema("P"),
          textOverlayPixels: enumSchema(["X", "C"]),
          exportVideo: enumSchema(["X", "C"]),
          verifyArtifact: enumSchema(["X", "A"]),
        },
        [
          "facadeToRuntime",
          "createProject",
          "importLocalMedia",
          "trimClip",
          "addTextOverlayModel",
          "textOverlayPixels",
          "exportVideo",
          "verifyArtifact",
        ],
      ),
      notes: arraySchema(stringSchema()),
      workMode: enumSchema(["guided", "collaborative", "autonomous"]),
      workModeSemantics: workModeSemantics(),
      access: enumSchema(["read-only", "write"]),
      writer: booleanSchema(),
      leaseHolder: nullable(stringSchema()),
      sessionId: stringSchema(),
    },
    ["facadeVersion", "contractVersion", "runtime", "verbs", "editOps", "errorCodes", "stepLetters", "notes", "workMode", "workModeSemantics"],
  );

const capabilityStatus = (): OutputSchemaNode =>
  objectSchema(
    {
      available: booleanSchema(),
      reason: stringSchema(),
      requires: stringSchema(),
      details: openObject(),
    },
    ["available"],
  );

const capabilities = (): OutputSchemaNode =>
  objectSchema(
    {
      runtime: enumSchema(["node-headless", "live"]),
      unavailableVerbs: arraySchema(stringSchema()),
      stateModel: objectSchema(
        {
          canonicalProject: constSchema(true),
          atomicBatch: constSchema(true),
          revisionPreconditions: constSchema(true),
          idempotencyKeys: constSchema(true),
          serializedExecution: constSchema(true),
        },
        ["canonicalProject", "atomicBatch", "revisionPreconditions", "idempotencyKeys", "serializedExecution"],
      ),
      mediaImport: objectSchema(
        {
          available: booleanSchema(),
          reason: stringSchema(),
          sources: arraySchema(enumSchema(["file"]), { minItems: 1, maxItems: 1 }),
          mediaRoots: arraySchema(stringSchema()),
          recommendedRoot: nullable(stringSchema()),
          workspaceLayout: objectSchema(
            {
              jobDirectoryPattern: constSchema("jobs/<YYYY-MM-DD>-<short-slug>"),
              sharedDirectory: constSchema("shared"),
              jobEntries: arraySchema(
                enumSchema(["brief.md", "source", "generated", "work", "project", "output", "evidence"]),
                { minItems: 7, maxItems: 7 },
              ),
              deliverablesDirectory: constSchema("output"),
            },
            ["jobDirectoryPattern", "sharedDirectory", "jobEntries", "deliverablesDirectory"],
          ),
          urlImport: constSchema(false),
          metadata: arraySchema(stringSchema()),
        },
        ["available", "sources", "mediaRoots", "recommendedRoot", "workspaceLayout", "urlImport", "metadata"],
      ),
      editOps: arraySchema(stringSchema()),
      textOverlay: objectSchema({ modelState: constSchema(true), pixelRendering: booleanSchema() }, ["modelState", "pixelRendering"]),
      preview: capabilityStatus(),
      visualInspection: capabilityStatus(),
      editorControl: capabilityStatus(),
      export: capabilityStatus(),
      verify: capabilityStatus(),
    },
    ["runtime", "stateModel", "mediaImport", "editOps", "textOverlay", "preview", "visualInspection", "editorControl", "export", "verify"],
  );

const mediaImportResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      mediaId: stringSchema(),
      name: stringSchema(),
      type: enumSchema(["video", "audio"]),
      metadata: importedMediaMetadata(),
      replayed: booleanSchema(),
    },
    ["revision", "mediaId", "name", "type", "metadata", "replayed"],
  );

const projectMarker = (): OutputSchemaNode =>
  objectSchema(
    {
      number: integerSchema(1),
      id: stringSchema(),
      target: {
        anyOf: [
          objectSchema({ kind: constSchema("asset"), mediaId: stringSchema() }, ["kind", "mediaId"]),
          objectSchema({ kind: constSchema("clip"), clipId: stringSchema() }, ["kind", "clipId"]),
          objectSchema({ kind: constSchema("text"), textClipId: stringSchema() }, ["kind", "textClipId"]),
          objectSchema(
            { kind: constSchema("timeRange"), start: numberSchema(0), end: numberSchema(0) },
            ["kind", "start", "end"],
          ),
        ],
      },
      label: stringSchema(),
      color: stringSchema(),
      createdAt: numberSchema(0),
    },
    ["number", "id", "target", "createdAt"],
  );

const timelineResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      duration: numberSchema(0),
      tracks: arraySchema(timelineTrack()),
      textOverlays: arraySchema(textOverlay()),
      markers: arraySchema(projectMarker()),
    },
    ["revision", "duration", "tracks", "textOverlays", "markers"],
  );

const editorContext = (): OutputSchemaNode =>
  objectSchema(
    {
      mode: enumSchema(["live", "headless"]),
      workMode: enumSchema(["guided", "collaborative", "autonomous"]),
      workModeSemantics: workModeSemantics(),
      projectRevision: integerSchema(0),
      contextAvailable: booleanSchema(),
      contextRevision: nullable(integerSchema(0)),
      playheadSeconds: nullable(numberSchema(0)),
      selectedClipIds: arraySchema(stringSchema()),
      selectedTextIds: arraySchema(stringSchema()),
      selectedMediaIds: arraySchema(stringSchema()),
      timeRange: nullable(openObject()),
      canvasPoint: nullable(objectSchema({ x: numberSchema(0, 1), y: numberSchema(0, 1) }, ["x", "y"])),
      references: editorReferences(),
      identity: objectSchema(
        { projectId: nullable(stringSchema()), projectName: nullable(stringSchema()), windowId: nullable(stringSchema()) },
        ["projectId", "projectName", "windowId"],
      ),
    },
    [
      "mode",
      "workMode",
      "workModeSemantics",
      "projectRevision",
      "contextAvailable",
      "contextRevision",
      "playheadSeconds",
      "selectedClipIds",
      "selectedTextIds",
      "selectedMediaIds",
      "timeRange",
      "canvasPoint",
      "references",
      "identity",
    ],
  );

const editorControlResult = (): OutputSchemaNode =>
  objectSchema(
    {
      action: enumSchema(["play", "pause", "seek", "select"]),
      playbackState: enumSchema(["stopped", "playing", "paused"]),
      playheadSeconds: numberSchema(0),
      selectedClipIds: arraySchema(stringSchema()),
      selectedTextIds: arraySchema(stringSchema()),
      selectedMediaIds: arraySchema(stringSchema()),
      revealedTargets: arraySchema(
        objectSchema({ kind: enumSchema(["clip", "text", "media"]), id: stringSchema() }, ["kind", "id"]),
      ),
      contextRevision: integerSchema(0),
    },
    [
      "action",
      "playbackState",
      "playheadSeconds",
      "selectedClipIds",
      "selectedTextIds",
      "selectedMediaIds",
      "revealedTargets",
      "contextRevision",
    ],
  );

const appliedOp = (): OutputSchemaNode =>
  objectSchema(
    {
      op: enumSchema(EDIT_OP_TYPES),
      createdIds: arraySchema(stringSchema()),
    },
    ["op", "createdIds"],
  );

const editApplyResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      applied: arraySchema(appliedOp(), { minItems: 1 }),
      replayed: booleanSchema(),
    },
    ["revision", "applied", "replayed"],
  );

const exportStartResult = (): OutputSchemaNode =>
  objectSchema(
    {
      jobId: stringSchema(),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      sourceRevision: integerSchema(0),
      replayed: booleanSchema(),
    },
    ["jobId", "state", "sourceRevision", "replayed"],
  );

const jobProgress = (): OutputSchemaNode =>
  objectSchema(
    {
      phase: enumSchema(["preparing", "rendering", "encoding", "muxing", "complete"]),
      percent: numberSchema(0, 1),
      currentFrame: integerSchema(0),
      totalFrames: integerSchema(0),
      bytesWritten: integerSchema(0),
    },
    ["phase", "percent"],
  );

const jobStatus = (): OutputSchemaNode =>
  objectSchema(
    {
      jobId: stringSchema(),
      kind: constSchema("export"),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      progress: nullable(jobProgress()),
      artifact: nullable(artifactRef()),
      error: nullable(objectSchema({ code: stringSchema(), message: stringSchema() }, ["code", "message"])),
      deliveredTo: nullable(stringSchema()),
      deliveryError: nullable(stringSchema()),
      sourceRevision: integerSchema(0),
      route: nullable(stringSchema()),
      cancelRequested: booleanSchema(),
      createdAt: stringSchema(),
      updatedAt: stringSchema(),
    },
    ["jobId", "kind", "state", "progress", "artifact", "error", "deliveredTo", "deliveryError", "sourceRevision", "route", "cancelRequested", "createdAt", "updatedAt"],
  );

const verifyResult = (): OutputSchemaNode =>
  objectSchema(
    {
      pass: booleanSchema(),
      probe: openObject(),
      checks: arraySchema(objectSchema({ name: stringSchema(), pass: booleanSchema(), details: stringSchema() }, ["name", "pass", "details"])),
      compare: openObject(),
    },
    ["pass", "probe", "checks"],
  );

const projectSaveResult = (): OutputSchemaNode =>
  objectSchema(
    {
      // Live project.save only returns revision; headless also fills the
      // checkpoint fields below. Keeping these optional makes one MCP tool
      // schema honest for both runtime modes.
      revision: integerSchema(0),
      path: stringSchema(),
      bytesWritten: integerSchema(0),
      stateSha256: stringSchema(),
      savedAt: integerSchema(0),
    },
    ["revision"],
  );

const valueSchemas: Readonly<Record<FacadeVerb, OutputSchemaNode>> = {
  "session.describe": sessionDescription(),
  "capabilities.get": capabilities(),
  "project.create": objectSchema({ ...projectState()["properties"], replayed: booleanSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.open": objectSchema({ ...projectState()["properties"], replayed: booleanSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.save": projectSaveResult(),
  "project.get_state": projectState(),
  "media.import": mediaImportResult(),
  "timeline.get": timelineResult(),
  "editor.get_context": editorContext(),
  "editor.control": editorControlResult(),
  "edit.apply": editApplyResult(),
  "preview.render_frame": objectSchema({ revision: integerSchema(0), timeSec: numberSchema(0), width: integerSchema(0), height: integerSchema(0), artifact: artifactRef(), replayed: booleanSchema() }, ["revision", "timeSec", "width", "height", "artifact", "replayed"]),
  "visual.inspect": objectSchema({ revision: integerSchema(0), sourceRevision: integerSchema(0), selection: openObject(), sampleCount: integerSchema(1, 12), width: integerSchema(2), height: integerSchema(2), frames: arraySchema(openObject(), { minItems: 1, maxItems: 12 }), contactSheet: nullable(artifactRef()), limitations: arraySchema(stringSchema()), replayed: booleanSchema() }, ["revision", "sourceRevision", "selection", "sampleCount", "width", "height", "frames", "contactSheet", "limitations", "replayed"]),
  "export.start": exportStartResult(),
  "job.status": jobStatus(),
  "job.cancel": jobStatus(),
  "verify.artifact": verifyResult(),
};

/** Successful `{ok:true,value}` output schema for every MCP facade verb. */
export const EMITTED_VERB_OUTPUT_JSON_SCHEMAS: Readonly<Record<FacadeVerb, OutputSchemaObject>> = Object.fromEntries(
  Object.entries(valueSchemas).map(([verb, value]) => [verb, successEnvelope(value)]),
) as Readonly<Record<FacadeVerb, OutputSchemaObject>>;
