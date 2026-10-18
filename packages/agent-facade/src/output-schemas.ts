import { PLUGIN_TOOLS } from "./plugins";
import { MAX_TIMELINE_SOURCE_MAP_POINTS } from "./timeline-source-map";
/**
 * Machine-readable successful-result schemas for the facade tools.
 *
 * The MCP transports return the complete `{ok:true,value}` envelope in
 * structuredContent, so these schemas describe that envelope (not a guessed
 * `results[]` convenience shape). Error envelopes are `isError:true` and are
 * intentionally outside successful-output validation. Keep this declaration
 * small and JSON-only: it is shared by stdio and live MCP transports.
 */
import { EDIT_OP_TYPES, MEDIA_ANALYSIS_TYPES, type FacadeVerb } from "./types";

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

/** zh/en bilingual text pair used throughout the manual's help.* results. */
const localizedText = (): OutputSchemaNode =>
  objectSchema({ zh: stringSchema(), en: stringSchema() }, ["zh", "en"]);

const artifactRef = (): OutputSchemaNode =>
  objectSchema(
    {
      kind: enumSchema(["image", "video"]),
      format: enumSchema(["png", "jpeg", "mp4"]),
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
      nodeId: stringSchema(),
      replayed: booleanSchema(),
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
      colorGrading: nullable(openObject()),
      keyframes: arraySchema(openObject(), { maxItems: 100 }),
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
      "colorGrading",
      "keyframes",
      "transform",
    ],
  );

const timelineTrack = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      type: stringSchema(),
      name: stringSchema(),
      locked: booleanSchema(),
      hidden: booleanSchema(),
      muted: booleanSchema(),
      solo: booleanSchema(),
      clips: arraySchema(timelineClip()),
      transitions: arraySchema(openObject()),
    },
    ["id", "type", "name", "locked", "hidden", "muted", "solo", "clips", "transitions"],
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


      access: enumSchema(["read-only", "write"]),
      writer: booleanSchema(),
      leaseHolder: nullable(stringSchema()),
      sessionId: stringSchema(),
    },
    ["facadeVersion", "contractVersion", "runtime", "verbs", "editOps", "errorCodes", "stepLetters", "notes"],
  );

const capabilityStatus = (): OutputSchemaNode =>
  objectSchema(
    {
      available: booleanSchema(),
      reason: stringSchema(),
      requires: stringSchema(),
      details: openObject(),
      probed: booleanSchema(),
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
          limits: openObject(),
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
      projectChanges: capabilityStatus(),
      history: capabilityStatus(),
      audioNormalize: capabilityStatus(),
      audioDenoise: capabilityStatus(),
      audioSeparation: capabilityStatus(),
      pluginTools: openObject(),
      mediaAnalysis: objectSchema(
        {
          asynchronous: constSchema(true),
          types: objectSchema(
            Object.fromEntries(MEDIA_ANALYSIS_TYPES.map((type) => [type, capabilityStatus()])),
            MEDIA_ANALYSIS_TYPES,
          ),
          largeResultsAsArtifacts: constSchema(true),
        },
        ["asynchronous", "types", "largeResultsAsArtifacts"],
      ),
      professionalEditing: objectSchema(
        Object.fromEntries([
          "subtitles",
          "trackControls",
          "mediaRename",
          "transformKeyframes",
          "volumeKeyframes",
          "basicColorGrade",
          "lut",
          "audioNormalization",
          "audioDucking",
          "vocalIsolation",
          "stabilization",
          "smartReframe",
          "proxyMedia",
          "relink",
          "exportPresets",
          "exportPreflight",
        ].map((name) => [name, capabilityStatus()])),
        [
          "subtitles",
          "trackControls",
          "mediaRename",
          "transformKeyframes",
          "volumeKeyframes",
          "basicColorGrade",
          "lut",
          "audioNormalization",
          "audioDucking",
          "vocalIsolation",
          "stabilization",
          "smartReframe",
          "proxyMedia",
          "relink",
          "exportPresets",
          "exportPreflight",
        ],
      ),
      editOps: arraySchema(stringSchema()),
      manual: objectSchema(
        {
          available: booleanSchema(),
          contentVersion: stringSchema(),
          appVersion: stringSchema(),
          languages: arraySchema(stringSchema()),
          screenCount: integerSchema(0),
          screenshots: enumSchema(["reserved-not-delivered", "delivered"]),
        },
        ["available", "contentVersion", "appVersion", "languages", "screenCount", "screenshots"],
      ),
      textOverlay: objectSchema({ modelState: constSchema(true), pixelRendering: booleanSchema() }, ["modelState", "pixelRendering"]),
      preview: capabilityStatus(),
      visualInspection: capabilityStatus(),
      editorControl: capabilityStatus(),
      export: capabilityStatus(),
      verify: capabilityStatus(),
    },
    ["runtime", "stateModel", "mediaImport", "projectChanges", "history", "audioNormalize", "audioDenoise", "audioSeparation", "mediaAnalysis", "professionalEditing", "editOps", "manual", "textOverlay", "preview", "visualInspection", "editorControl", "export", "verify"],
  );

const mediaImportResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      mediaId: stringSchema(),
      name: stringSchema(),
      type: enumSchema(["video", "audio", "image"]),
      metadata: importedMediaMetadata(),
      replayed: booleanSchema(),
    },
    ["revision", "mediaId", "name", "type", "metadata", "replayed"],
  );

const projectMarker = (): OutputSchemaNode =>
  objectSchema(
    {
      ref: stringSchema(),
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
    ["ref", "number", "id", "target", "createdAt"],
  );

const timelineResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      duration: numberSchema(0),
      tracks: arraySchema(timelineTrack()),
      textOverlays: arraySchema(textOverlay()),
      subtitles: arraySchema(openObject()),
      markers: arraySchema(projectMarker()),
    },
    ["revision", "duration", "tracks", "textOverlays", "subtitles", "markers"],
  );

const editorContext = (): OutputSchemaNode =>
  objectSchema(
    {
      mode: enumSchema(["live", "headless"]),


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
      requirements: objectSchema(
        {
          ready: integerSchema(0),
          inProgress: integerSchema(0),
          ids: arraySchema(stringSchema()),
        },
        ["ready", "inProgress", "ids"],
      ),
      identity: objectSchema(
        {
          projectId: nullable(stringSchema()),
          projectName: nullable(stringSchema()),
          projectEpoch: stringSchema(),
          workspaceId: stringSchema(),
          workspaceInstanceId: stringSchema(),
          windowId: nullable(stringSchema()),
        },
        ["projectId", "projectName", "windowId"],
      ),
    },
    [
      "mode",
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
      "requirements",
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

const audioProcessNormalizeResult = (): OutputSchemaNode =>
  objectSchema(
    {
      jobId: stringSchema(),
      kind: constSchema("audio-process"),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      sourceRevision: integerSchema(0),
      replayed: booleanSchema(),
    },
    ["jobId", "kind", "state", "sourceRevision", "replayed"],
  );

const normalizeAudioMeasurement = (): OutputSchemaNode =>
  objectSchema(
    {
      integratedLufs: numberSchema(),
      truePeakDbtp: numberSchema(),
      loudnessRangeLu: numberSchema(),
      thresholdLufs: numberSchema(),
    },
    ["integratedLufs", "truePeakDbtp", "loudnessRangeLu", "thresholdLufs"],
  );

const normalizeAudioArtifact = (): OutputSchemaNode =>
  objectSchema(
    {
      path: stringSchema(),
      provenancePath: stringSchema(),
      source: objectSchema(
        {
          mediaId: stringSchema(),
          path: stringSchema(),
          audioStream: integerSchema(0),
          startSec: numberSchema(0),
          endSec: numberSchema(0),
          projectId: stringSchema(),
          workspaceId: stringSchema(),
          revision: integerSchema(0),
        },
        ["mediaId", "path", "audioStream", "startSec", "endSec", "projectId", "revision"],
      ),
      parameters: openObject(),
      before: normalizeAudioMeasurement(),
      after: normalizeAudioMeasurement(),
      timing: objectSchema(
        {
          sampleRate: enumSchema([48_000]),
          channels: enumSchema([1, 2]),
          sampleCount: integerSchema(0),
          durationSec: numberSchema(0),
          outputStartSec: numberSchema(0, 0),
          processingDelaySamples: integerSchema(0, 0),
        },
        ["sampleRate", "channels", "sampleCount", "durationSec", "outputStartSec", "processingDelaySamples"],
      ),
      bytes: integerSchema(1),
      sha256: stringSchema(),
    },
    ["path", "provenancePath", "source", "parameters", "before", "after", "timing", "bytes", "sha256"],
  );

const analysisJobResult = (): OutputSchemaNode =>
  objectSchema(
    {
      analysisTypes: arraySchema(enumSchema(MEDIA_ANALYSIS_TYPES), { minItems: 1, maxItems: MEDIA_ANALYSIS_TYPES.length }),
      summary: openObject(),
      artifacts: arraySchema(artifactRef()),
    },
    ["analysisTypes", "summary", "artifacts"],
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
      kind: enumSchema(["export", "analysis", "audio-process"]),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      progress: nullable(jobProgress()),
      artifact: nullable(artifactRef()),
      result: nullable({ anyOf: [analysisJobResult(), normalizeAudioArtifact()] }),
      error: nullable(objectSchema({ code: stringSchema(), message: stringSchema() }, ["code", "message"])),
      deliveredTo: nullable(stringSchema()),
      deliveryError: nullable(stringSchema()),
      sourceRevision: integerSchema(0),
      route: nullable(stringSchema()),
      upscalingRequestedButInactive: booleanSchema(),
      cancelRequested: booleanSchema(),
      createdAt: stringSchema(),
      updatedAt: stringSchema(),
    },
    ["jobId", "kind", "state", "progress", "artifact", "result", "error", "deliveredTo", "deliveryError", "sourceRevision", "route", "upscalingRequestedButInactive", "cancelRequested", "createdAt", "updatedAt"],
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

const projectChangesResult = (): OutputSchemaNode =>
  objectSchema(
    {
      fromRevision: integerSchema(0),
      toRevision: integerSchema(0),
      changes: arraySchema(
        objectSchema(
          {
            revision: integerSchema(0),
            change: enumSchema(["added", "updated", "removed"]),
            entityType: enumSchema(["project", "track", "clip", "text", "media", "transition", "marker", "subtitle"]),
            entityId: stringSchema(),
            fields: arraySchema(stringSchema()),
          },
          ["revision", "change", "entityType", "entityId", "fields"],
        ),
        { maxItems: 200 },
      ),
      nextCursor: nullable(stringSchema()),
      requiresFullRefresh: booleanSchema(),
    },
    ["fromRevision", "toRevision", "changes", "nextCursor", "requiresFullRefresh"],
  );

const timelineQueryResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      items: arraySchema(
        objectSchema(
          {
            // Mirrors TIMELINE_QUERY_ENTITY_TYPES (kept literal so this file
            // stays dependency-light): the projection also emits text-adjacent
            // "svg" overlays and project-scoped "workAsset" entries.
            entityType: enumSchema(["track", "clip", "text", "svg", "media", "transition", "marker", "subtitle", "workAsset"]),
            id: stringSchema(),
            ref: nullable(stringSchema()),
            trackId: nullable(stringSchema()),
            startTime: nullable(numberSchema(0)),
            endTime: nullable(numberSchema(0)),
            data: openObject(),
          },
          ["entityType", "id", "ref", "trackId", "startTime", "endTime", "data"],
        ),
        { maxItems: 200 },
      ),
      nextCursor: nullable(stringSchema()),
    },
    ["revision", "items", "nextCursor"],
  );

const timelineMapSourceTimesResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      mappings: arraySchema(
        objectSchema(
          {
            clipId: stringSchema(),
            mediaId: stringSchema(),
            timelineTime: numberSchema(0),
            clipLocalTime: numberSchema(0),
            sourceTime: numberSchema(0),
            sourceTimeFromInPoint: numberSchema(0),
            frozen: booleanSchema(),
            freezeFrameId: nullable(stringSchema()),
          },
          ["clipId", "mediaId", "timelineTime", "clipLocalTime", "sourceTime", "sourceTimeFromInPoint", "frozen", "freezeFrameId"],
        ),
        { minItems: 1, maxItems: MAX_TIMELINE_SOURCE_MAP_POINTS },
      ),
    },
    ["revision", "mappings"],
  );

const editValidateResult = (): OutputSchemaNode =>
  objectSchema(
    {
      valid: booleanSchema(),
      normalizedOps: arraySchema(openObject(), { minItems: 1, maxItems: 100 }),
      conflicts: arraySchema(openObject()),
      warnings: arraySchema(openObject()),
      affected: arraySchema(openObject()),
      created: arraySchema(openObject()),
      deleted: arraySchema(openObject()),
      estimatedDuration: numberSchema(0),
      estimatedRevision: integerSchema(0),
    },
    ["valid", "normalizedOps", "conflicts", "warnings", "affected", "created", "deleted", "estimatedDuration", "estimatedRevision"],
  );

const historyGetResult = (): OutputSchemaNode =>
  objectSchema(
    {
      revision: integerSchema(0),
      available: booleanSchema(),
      reason: stringSchema(),
      canUndo: booleanSchema(),
      canRedo: booleanSchema(),
      undoCount: integerSchema(0),
      redoCount: integerSchema(0),
      entries: arraySchema(openObject(), { maxItems: 100 }),
    },
    ["revision", "available", "canUndo", "canRedo", "undoCount", "redoCount", "entries"],
  );

const historyControlResult = (): OutputSchemaNode =>
  objectSchema(
    {
      action: enumSchema(["undo", "redo"]),
      revision: integerSchema(0),
      canUndo: booleanSchema(),
      canRedo: booleanSchema(),
      replayed: booleanSchema(),
    },
    ["action", "revision", "canUndo", "canRedo", "replayed"],
  );

const valueSchemas: Readonly<Record<string, OutputSchemaNode>> = {
  "session.describe": sessionDescription(),
  "capabilities.get": capabilities(),
  "project.create": objectSchema({ ...projectState()["properties"], replayed: booleanSchema(), projectId: stringSchema(), defaultWorkspaceId: stringSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.open": objectSchema({ ...projectState()["properties"], replayed: booleanSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.save": projectSaveResult(),
  "project.list": objectSchema({ projects: arraySchema(openObject()) }, ["projects"], true),
  "workspace.list": objectSchema({ projectId: stringSchema(), workspaces: arraySchema(openObject()) }, ["projectId", "workspaces"], true),
  "workspace.create": objectSchema({ workspace: openObject() }, ["workspace"], true),
  "workspace.delete": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), deleted: booleanSchema() }, ["projectId", "workspaceId", "deleted"], true),
  "workspace.close": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), closed: booleanSchema() }, ["projectId", "workspaceId", "closed"], true),
  "workspace.switch_view": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), switched: booleanSchema() }, ["projectId", "workspaceId", "switched"], true),
  "workspace.list_drafts": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), drafts: arraySchema(openObject()) }, ["projectId", "workspaceId", "drafts"], true),
  "workspace.recover_draft": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), draftId: stringSchema(), revision: integerSchema(0), replayed: booleanSchema() }, ["projectId", "workspaceId", "draftId", "revision", "replayed"], true),
  "node.list": objectSchema({ projectId: stringSchema(), nodes: arraySchema(openObject()) }, ["projectId", "nodes"], true),
  "node.get": objectSchema({ projectId: stringSchema(), node: openObject() }, ["projectId", "node"], true),
  "node.save": objectSchema({ node: openObject(), revision: integerSchema(0), replayed: booleanSchema() }, ["node", "revision", "replayed"], true),
  "node.restore": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), nodeId: stringSchema(), revision: integerSchema(0), replayed: booleanSchema(), restored: booleanSchema() }, ["projectId", "workspaceId", "nodeId", "revision", "replayed", "restored"], true),
  "node.rename": objectSchema({ projectId: stringSchema(), nodeId: stringSchema(), node: openObject() }, ["projectId", "nodeId", "node"], true),
  "node.media": objectSchema({ projectId: stringSchema(), nodeId: stringSchema(), media: arraySchema(openObject()), missingDependencyIds: arraySchema(stringSchema()) }, ["projectId", "nodeId", "media", "missingDependencyIds"], true),
  "node.compare": objectSchema({ projectId: stringSchema(), fromNodeId: stringSchema(), toNodeId: stringSchema(), added: arraySchema(stringSchema()), replaced: arraySchema(openObject()), removed: arraySchema(stringSchema()) }, ["projectId", "fromNodeId", "toNodeId", "added", "replaced", "removed"], true),
  "media.references": objectSchema({ projectId: stringSchema(), mediaId: stringSchema(), references: arraySchema(openObject()) }, ["projectId", "mediaId", "references"], true),
  "media.cleanup.plan": openObject(),
  "media.cleanup.execute": openObject(),
  "project.rename": objectSchema(
    {
      revision: integerSchema(0),
      projectId: stringSchema(),
      previousName: stringSchema(),
      name: stringSchema(),
      replayed: booleanSchema(),
    },
    ["revision", "projectId", "previousName", "name", "replayed"],
  ),
  "project.get_state": projectState(),
  "requirements.list": objectSchema({
    revision: integerSchema(0),
    requirements: arraySchema(objectSchema({
      ref: stringSchema(), title: stringSchema(), status: stringSchema(),
      priority: stringSchema(), markerIds: arraySchema(stringSchema()), updatedAt: numberSchema(),
    }, ["ref", "title", "status", "priority", "markerIds", "updatedAt"])),
  }, ["revision", "requirements"]),
  "requirements.get": objectSchema({
    revision: integerSchema(0), requirement: openObject(),
  }, ["revision", "requirement"]),
  "project.changes": projectChangesResult(),
  "media.import": mediaImportResult(),
  "audio.process.normalize": audioProcessNormalizeResult(),
  "audio.process.denoise": audioProcessNormalizeResult(),
  "audio.process.separate": audioProcessNormalizeResult(),
  "audio.process.register": mediaImportResult(),
  "media.render_html": objectSchema(
    {
      path: stringSchema(),
      width: integerSchema(2, 4096),
      height: integerSchema(2, 4096),
      sha256: stringSchema(),
      bytes: integerSchema(1),
      missingAssets: arraySchema(stringSchema()),
      replayed: booleanSchema(),
    },
    ["path", "width", "height", "sha256", "bytes", "missingAssets", "replayed"],
  ),
  "media.analyze_start": objectSchema(
    {
      jobId: stringSchema(),
      kind: constSchema("analysis"),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      sourceRevision: integerSchema(0),
      analysisTypes: arraySchema(enumSchema(MEDIA_ANALYSIS_TYPES), { minItems: 1, maxItems: MEDIA_ANALYSIS_TYPES.length }),
      replayed: booleanSchema(),
    },
    ["jobId", "kind", "state", "sourceRevision", "analysisTypes", "replayed"],
  ),
  "timeline.get": timelineResult(),
  "timeline.query": timelineQueryResult(),
  "timeline.mapSourceTimes": timelineMapSourceTimesResult(),
  "editor.get_context": editorContext(),
  "editor.control": editorControlResult(),
  "edit.validate": editValidateResult(),
  "edit.apply": editApplyResult(),
  "history.get": historyGetResult(),
  "history.control": historyControlResult(),
  "preview.render_frame": objectSchema({ revision: integerSchema(0), timeSec: numberSchema(0), width: integerSchema(0), height: integerSchema(0), artifact: artifactRef(), replayed: booleanSchema() }, ["revision", "timeSec", "width", "height", "artifact", "replayed"]),
  "visual.inspect": objectSchema({
    revision: integerSchema(0),
    sourceRevision: integerSchema(0),
    selection: openObject(),
    sampleCount: integerSchema(1, 12),
    mediaSources: arraySchema(objectSchema({
      mediaId: stringSchema(),
      sizeBytes: integerSchema(0),
      mtimeMs: numberSchema(0),
      sha256: nullable(stringSchema()),
    }, ["mediaId", "sizeBytes", "mtimeMs", "sha256"])),
    width: integerSchema(2),
    height: integerSchema(2),
    frameBudgetBytes: integerSchema(1),
    frames: arraySchema(objectSchema({
      index: integerSchema(0),
      timeSec: numberSchema(0),
      coordinateSpace: constSchema("timeline"),
      requestedTimelineTimeSec: numberSchema(0),
      renderedTimelineTimeSec: constSchema(null),
      sourceFrameNumber: constSchema(null),
      sourcePtsSec: constSchema(null),
      label: stringSchema(),
      sourceRevision: integerSchema(0),
      artifact: artifactRef(),
      fidelity: openObject(),
    }, ["index", "timeSec", "coordinateSpace", "requestedTimelineTimeSec", "renderedTimelineTimeSec", "sourceFrameNumber", "sourcePtsSec", "label", "sourceRevision", "artifact", "fidelity"]), { minItems: 1, maxItems: 12 }),
    contactSheet: nullable(artifactRef()),
    limitations: arraySchema(stringSchema()),
    replayed: booleanSchema(),
  }, ["revision", "sourceRevision", "selection", "sampleCount", "mediaSources", "width", "height", "frameBudgetBytes", "frames", "contactSheet", "limitations", "replayed"]),
  "preview.render_comparison": objectSchema({ revision: integerSchema(0), sourceRevision: integerSchema(0), timeSec: numberSchema(0), referenceSec: numberSchema(0), clamped: stringSchema(), layout: stringSchema(), width: integerSchema(2), height: integerSchema(2), frameBudgetBytes: integerSchema(1), artifact: artifactRef(), limitations: arraySchema(stringSchema()), replayed: booleanSchema() }, ["revision", "sourceRevision", "timeSec", "referenceSec", "clamped", "layout", "width", "height", "frameBudgetBytes", "artifact", "limitations", "replayed"]),
  "analysis.list": arraySchema(
    objectSchema({ id: stringSchema(), finishedAt: stringSchema(), sourceRevision: nullable(integerSchema(0)), coordinateSpace: constSchema("source"), subject: openObject(), analysisTypes: arraySchema(stringSchema()), stale: openObject(), recheckOf: nullable(stringSchema()) }, ["id", "finishedAt", "sourceRevision", "coordinateSpace", "subject", "analysisTypes", "stale", "recheckOf"]),
    { maxItems: 200 },
  ),
  "analysis.get": objectSchema({
    schemaVersion: enumSchema([3]),
    id: stringSchema(),
    projectId: stringSchema(),
    sourceRevision: nullable(integerSchema(0)),
    coordinateSpace: constSchema("source"),
    createdAt: stringSchema(),
    finishedAt: stringSchema(),
    subject: openObject(),
    analysisTypes: arraySchema(stringSchema()),
    rangeSec: openObject(),
    config: openObject(),
    provenance: arraySchema(openObject()),
    observations: arraySchema(openObject()),
    inferences: arraySchema(openObject()),
    recommendations: arraySchema(openObject()),
    unknowns: arraySchema(openObject()),
    recheckOf: nullable(stringSchema()),
    cloudOpinion: nullable(openObject()),
    stale: openObject(),
    recordPath: stringSchema(),
    audioDetailsComplete: booleanSchema(),
    view: enumSchema(["summary", "events", "waveform"]),
    details: arraySchema(objectSchema({
      series: enumSchema([
        "audioSummary.onsets",
        "audioSummary.silence",
        "silence.silentRegions",
        "beatGrid.beats",
        "speechActivity.speechRegions",
        "speechTranscript.segments",
        "speakerDiarization.segments",
      ]),
      totalCount: nullable(integerSchema(0)),
      storedCount: integerSchema(0),
      complete: booleanSchema(),
    }, ["series", "totalCount", "storedCount", "complete"]), { maxItems: 7 }),
    events: objectSchema({
      series: enumSchema([
        "audioSummary.onsets",
        "audioSummary.silence",
        "silence.silentRegions",
        "beatGrid.beats",
        "speechActivity.speechRegions",
        "speechTranscript.segments",
        "speakerDiarization.segments",
      ]),
      window: objectSchema({ startSec: numberSchema(0), endSec: numberSchema(0) }, ["startSec", "endSec"]),
      limit: integerSchema(1, 256),
      totalMatched: nullable(integerSchema(0)),
      storedMatched: integerSchema(0),
      items: arraySchema({
        anyOf: [
          objectSchema({ id: stringSchema(), timeSec: numberSchema(0) }, ["id", "timeSec"], true),
          objectSchema({ id: stringSchema(), startSec: numberSchema(0), endSec: numberSchema(0) }, ["id", "startSec", "endSec"], true),
        ],
      }, { maxItems: 256 }),
      nextCursor: nullable(stringSchema()),
      complete: booleanSchema(),
    }, ["series", "window", "limit", "totalMatched", "storedMatched", "items", "nextCursor", "complete"]),
    waveform: objectSchema({
      window: objectSchema({ startSec: numberSchema(0), endSec: numberSchema(0) }, ["startSec", "endSec"]),
      maxPoints: integerSchema(1, 600),
      points: arraySchema(objectSchema({
        startSec: numberSchema(0),
        endSec: numberSchema(0),
        rms: numberSchema(0),
        peak: numberSchema(0),
      }, ["startSec", "endSec", "rms", "peak"]), { maxItems: 600 }),
      complete: booleanSchema(),
    }, ["window", "maxPoints", "points", "complete"]),
  }, ["schemaVersion", "id", "projectId", "sourceRevision", "coordinateSpace", "createdAt", "finishedAt", "subject", "analysisTypes", "rangeSec", "config", "provenance", "observations", "inferences", "recommendations", "unknowns", "recheckOf", "cloudOpinion", "stale", "recordPath", "view", "details"]),
  "export.start": exportStartResult(),
  "job.status": jobStatus(),
  "job.cancel": jobStatus(),
  "verify.artifact": verifyResult(),
  "material.list": objectSchema(
    {
      items: arraySchema(openObject()),
      total: integerSchema(0),
      page: integerSchema(1),
      pageSize: integerSchema(1),
      totalPages: integerSchema(1),
      allTags: arraySchema(stringSchema()),
    },
    ["items", "total", "page", "pageSize", "totalPages", "allTags"],
  ),
  "material.get": objectSchema({ material: openObject() }, ["material"]),
  "material.create": objectSchema(
    {
      material: openObject(),
      journalEntryId: stringSchema(),
      replayed: booleanSchema(),
    },
    ["material", "journalEntryId"],
  ),
  "material.update": objectSchema(
    {
      material: openObject(),
      journalEntryId: stringSchema(),
      replayed: booleanSchema(),
    },
    ["material", "journalEntryId"],
  ),
  "material.batch_update": objectSchema(
    {
      materials: arraySchema(openObject(), { minItems: 1 }),
      journalEntryId: stringSchema(),
      replayed: booleanSchema(),
    },
    ["materials", "journalEntryId"],
  ),
  "material.remove": objectSchema(
    {
      id: stringSchema(),
      removedIds: arraySchema(stringSchema(), { minItems: 1 }),
      journalEntryId: stringSchema(),
      replayed: booleanSchema(),
    },
    ["id", "removedIds", "journalEntryId"],
  ),
  "material.attach": objectSchema(
    {
      materialId: stringSchema(),
      mediaIdInProject: stringSchema(),
      projectId: stringSchema(),
      projectName: stringSchema(),
      clipId: nullable(stringSchema()),
      rangeSec: nullable(
        objectSchema(
          { startSec: numberSchema(0), endSec: numberSchema(0) },
          ["startSec", "endSec"],
        ),
      ),
      revision: integerSchema(0),
      replayed: booleanSchema(),
    },
    [
      "materialId",
      "mediaIdInProject",
      "projectId",
      "projectName",
      "clipId",
      "rangeSec",
      "revision",
    ],
  ),
  "material.undo": objectSchema(
    {
      entryId: stringSchema(),
      undoneEntryId: stringSchema(),
      restored: arraySchema(stringSchema()),
      removed: arraySchema(stringSchema()),
      replayed: booleanSchema(),
    },
    ["entryId", "undoneEntryId", "restored", "removed"],
  ),
  "font.upload": objectSchema(
    {
      fontFamily: stringSchema(),
      format: stringSchema(),
      sizeBytes: integerSchema(0),
      deduped: booleanSchema(),
    },
    ["fontFamily", "format", "sizeBytes", "deduped"],
  ),
  "font.list": objectSchema(
    {
      fonts: arraySchema(
        objectSchema(
          {
            family: stringSchema(),
            format: nullable(stringSchema()),
            sizeBytes: nullable(integerSchema(0)),
            uploadedAt: nullable(integerSchema(0)),
            loadedInSession: booleanSchema(),
          },
          ["family", "format", "sizeBytes", "uploadedAt", "loadedInSession"],
        ),
      ),
    },
    ["fonts"],
  ),
  "preset.list": objectSchema(
    {
      presets: arraySchema(openObject()),
      total: integerSchema(0),
    },
    ["presets", "total"],
  ),
  "preset.get": objectSchema({ preset: openObject() }, ["preset"]),
  "preset.create": objectSchema(
    { preset: openObject(), replayed: booleanSchema() },
    ["preset"],
  ),
  "preset.update": objectSchema(
    { preset: openObject(), replayed: booleanSchema() },
    ["preset"],
  ),
  "preset.remove": objectSchema(
    { id: stringSchema(), alreadyGone: booleanSchema() },
    ["id", "alreadyGone"],
  ),
  "preset.apply": objectSchema(
    {
      presetId: stringSchema(),
      projectId: stringSchema(),
      projectName: stringSchema(),
      revision: integerSchema(0),
      applied: openObject(),
      replayed: booleanSchema(),
    },
    ["presetId", "projectId", "projectName", "revision", "applied"],
  ),
  "help.list_screens": objectSchema(
    {
      manual: objectSchema(
        {
          contentVersion: stringSchema(),
          appVersion: stringSchema(),
          languages: arraySchema(stringSchema()),
          screenshots: enumSchema(["reserved-not-delivered", "delivered"]),
        },
        ["contentVersion", "appVersion", "languages", "screenshots"],
      ),
      total: integerSchema(0),
      screens: arraySchema(
        objectSchema(
          {
            id: stringSchema(),
            title: objectSchema(
              { zh: stringSchema(), en: stringSchema() },
              ["zh", "en"],
            ),
            summary: objectSchema(
              { zh: stringSchema(), en: stringSchema() },
              ["zh", "en"],
            ),
            hasScreenshot: booleanSchema(),
          },
          ["id", "title", "summary", "hasScreenshot"],
        ),
      ),
    },
    ["manual", "total", "screens"],
  ),
  "help.describe": objectSchema(
    {
      manual: objectSchema(
        {
          contentVersion: stringSchema(),
          appVersion: stringSchema(),
          languages: arraySchema(stringSchema()),
          screenshots: enumSchema(["reserved-not-delivered", "delivered"]),
        },
        ["contentVersion", "appVersion", "languages", "screenshots"],
      ),
      screenshotStatus: enumSchema(["pending", "available"]),
      screen: objectSchema(
        {
          id: stringSchema(),
          title: objectSchema({ zh: stringSchema(), en: stringSchema() }, ["zh", "en"]),
          summary: objectSchema({ zh: stringSchema(), en: stringSchema() }, ["zh", "en"]),
          entry: arraySchema(localizedText()),
          visibility: localizedText(),
          steps: arraySchema(localizedText()),
          shortcutIds: arraySchema(stringSchema()),
          limitations: arraySchema(localizedText()),
          keywords: arraySchema(stringSchema()),
          screenshot: stringSchema(),
        },
        ["id", "title", "summary", "entry"],
      ),
    },
    ["manual", "screenshotStatus", "screen"],
  ),
  "help.search": objectSchema(
    {
      manual: objectSchema(
        {
          contentVersion: stringSchema(),
          appVersion: stringSchema(),
          languages: arraySchema(stringSchema()),
          screenshots: enumSchema(["reserved-not-delivered", "delivered"]),
        },
        ["contentVersion", "appVersion", "languages", "screenshots"],
      ),
      query: stringSchema(),
      total: integerSchema(0),
      hits: arraySchema(
        objectSchema(
          {
            id: stringSchema(),
            title: objectSchema({ zh: stringSchema(), en: stringSchema() }, ["zh", "en"]),
            summary: objectSchema({ zh: stringSchema(), en: stringSchema() }, ["zh", "en"]),
          },
          ["id", "title", "summary"],
        ),
      ),
    },
    ["manual", "query", "total", "hits"],
  ),
};

/** Successful `{ok:true,value}` output schema for every MCP facade verb. */
export const EMITTED_VERB_OUTPUT_JSON_SCHEMAS: Readonly<Record<FacadeVerb, OutputSchemaObject>> = Object.fromEntries(
  Object.entries({ ...valueSchemas, ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.output])) }).map(([verb, value]) => [verb, successEnvelope(value)]),
) as Readonly<Record<FacadeVerb, OutputSchemaObject>>;
