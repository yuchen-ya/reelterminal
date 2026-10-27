import { PLUGIN_TOOLS } from "./plugins";
import { MAX_TIMELINE_SOURCE_MAP_POINTS } from "./timeline-source-map";
/**
 * Machine-readable successful-result schemas for the facade tools.
 *
 * These schemas describe the complete `{ok:true,value}` command envelope.
 * Error envelopes use `ok:false` and remain outside successful-output
 * validation. Keep this declaration
 * small and JSON-only: it is shared by headless and live command discovery.
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
const reviewNode = (): OutputSchemaNode => objectSchema({
  id: stringSchema(), workspaceId: stringSchema(), name: stringSchema(), groupId: stringSchema(), pinned: booleanSchema(),
  archivedAt: numberSchema(0), trashedAt: numberSchema(0), revision: integerSchema(0), createdAt: numberSchema(0), updatedAt: numberSchema(0),
  history: objectSchema({ undoActor: enumSchema(["human", "agent"]), redoActor: enumSchema(["human", "agent"]) }),
  branch: objectSchema({ taskId: stringSchema(), sourceNodeId: stringSchema(), sourceNodeRevision: integerSchema(0) }, ["taskId", "sourceNodeId", "sourceNodeRevision"]),
}, ["id", "workspaceId", "name", "pinned", "revision", "createdAt", "updatedAt"]);
const reviewCommit = (): OutputSchemaNode => objectSchema({ nodeId: stringSchema(), revision: integerSchema(0), sequence: integerSchema(0), replayed: booleanSchema() }, ["nodeId", "revision", "sequence", "replayed"]);
const reviewExportStatus = (): OutputSchemaNode => objectSchema({ exportId: stringSchema(), nodeId: stringSchema(), nodeRevision: integerSchema(0),
  state: enumSchema(["queued", "preparing", "ready", "failed", "cancelled"]), completedFiles: integerSchema(0), totalFiles: integerSchema(1),
  manifest: objectSchema({ schemaVersion: enumSchema([1]), exportId: stringSchema(), nodeId: stringSchema(), nodeRevision: integerSchema(0), mode: enumSchema(["original", "current", "adopted", "node-package", "version"]), scope: enumSchema(["node", "filtered", "selected"]), createdAt: numberSchema(0),
    entries: arraySchema(objectSchema({ itemId: stringSchema(), itemVersion: integerSchema(1), resourceId: stringSchema(), relativePath: stringSchema(), size: integerSchema(0), sha256: stringSchema(), serialization: enumSchema(["utf8-text", "lossless-json"]) }, ["relativePath", "size", "sha256"])),
    archive: objectSchema({ relativePath: stringSchema(), size: integerSchema(0), sha256: stringSchema() }, ["relativePath", "size", "sha256"]),
  }, ["schemaVersion", "exportId", "nodeId", "nodeRevision", "mode", "scope", "createdAt", "entries"]),
  error: objectSchema({ reason: stringSchema(), message: stringSchema() }, ["reason", "message"]),
}, ["exportId", "nodeId", "nodeRevision", "state", "completedFiles", "totalFiles"]);
const reviewGroup = (): OutputSchemaNode => objectSchema({ id: stringSchema(), workspaceId: stringSchema(), name: stringSchema(), order: integerSchema(0) }, ["id", "workspaceId", "name", "order"]);
const reviewDirectoryCommit = (): OutputSchemaNode => objectSchema({ revision: integerSchema(0), sequence: integerSchema(0), replayed: booleanSchema(), nodes: arraySchema(reviewNode()), groups: arraySchema(reviewGroup()) }, ["revision", "sequence", "replayed", "nodes", "groups"]);

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
      kind: enumSchema(["video", "review"]),
      facadeVersion: stringSchema(),
      contractVersion: stringSchema(),
      runtime: enumSchema(["node-headless", "live"]),
      verbs: arraySchema(stringSchema(), { minItems: 1 }),
      editOps: arraySchema(stringSchema()),
      errorCodes: arraySchema(stringSchema(), { minItems: 1 }),
      stepLetters: objectSchema(
        {
          facadeToRuntime: constSchema("P"),
          createProject: enumSchema(["P", "D", "X"]),
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
      kind: enumSchema(["video", "review"]), verbs: arraySchema(stringSchema()), access: enumSchema(["read-only", "write"]),
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
      collaborationInstructions: objectSchema({
        enabledCount: integerSchema(0),
        items: arraySchema(objectSchema({ id: stringSchema(), title: stringSchema(), updatedAt: numberSchema() }, ["id", "title", "updatedAt"]), { maxItems: 20 }),
      }, ["enabledCount", "items"]),
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
      "collaborationInstructions",
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
      projectId: stringSchema(),
      workspaceId: stringSchema(),
      cleanupReview: objectSchema({
        command: enumSchema(["media.cleanup.review"]),
        arguments: objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), exportId: stringSchema() }, ["projectId", "workspaceId", "exportId"]),
      }, ["command", "arguments"]),
      ownership: objectSchema({
        kind: enumSchema(["source", "work", "project", "output"]),
        purpose: stringSchema(),
        origin: enumSchema(["user", "product", "agent"]),
        projectId: stringSchema(),
        workspaceId: stringSchema(),
        nodeId: stringSchema(),
        deliveryStatus: enumSchema(["pending", "delivered"]),
      }, ["kind", "purpose", "origin", "projectId", "workspaceId", "deliveryStatus"]),
      artifactFiles: arraySchema(objectSchema({
        fileId: stringSchema(),
        path: stringSchema(),
        kind: enumSchema(["source", "work", "project", "output"]),
        purpose: stringSchema(),
        origin: enumSchema(["agent", "product"]),
        nodeId: stringSchema(),
        rebuildable: booleanSchema(),
        deliveryStatus: enumSchema(["pending", "delivered"]),
      }, ["fileId", "path", "kind", "purpose", "origin", "rebuildable", "deliveryStatus"])),
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
      // checkpoint fields below. Keeping these optional makes one command
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

/** Bounded workbench item projection (workbench.get); text keeps only the CURRENT text + version count. */
const workbenchItemView = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      batchId: stringSchema(),
      title: stringSchema(),
      subtitle: stringSchema(),
      type: enumSchema(["image", "text", "data", "video", "model3d"]),
      version: integerSchema(0),
      status: enumSchema(["pending", "kept", "discarded", "modified", "rework"]),
      orderIndex: integerSchema(0),
      createdAt: numberSchema(0),
      decisionCount: integerSchema(0),
      lastDecision: nullable(
        objectSchema(
          {
            decision: enumSchema(["kept", "discarded", "modified", "rework"]),
            decisionRevision: integerSchema(0),
            baseVersion: integerSchema(0),
            decidedAt: numberSchema(0),
            operator: enumSchema(["human", "agent"]),
            contentRevisionId: stringSchema(),
          },
          ["decision", "decisionRevision", "baseVersion", "decidedAt", "operator"],
        ),
      ),
      feedbackCount: integerSchema(0),
      confirmedFeedbackCount: integerSchema(0),
      reworkOrigin: objectSchema(
        {
          fromHandoffId: stringSchema(),
          previousVersion: integerSchema(0),
          summary: stringSchema(),
        },
        ["fromHandoffId", "previousVersion"],
      ),
      feedback: arraySchema(openObject()),
      revisions: arraySchema(openObject()),
      content: {
        anyOf: [
          objectSchema({ type: constSchema("model3d"), resourceId: stringSchema() }, ["type", "resourceId"]),
          objectSchema(
            {
              type: constSchema("text"),
              entryId: stringSchema(),
              title: stringSchema(),
              speakerOrContext: stringSchema(),
              currentText: stringSchema(),
              versionCount: integerSchema(0),
              duplicateProposal: openObject(),
            },
            ["type", "entryId", "title", "speakerOrContext", "currentText", "versionCount"],
          ),
          objectSchema(
            {
              type: constSchema("data"),
              datasetId: stringSchema(),
              columns: arraySchema(objectSchema({ columnId: stringSchema(), title: stringSchema() }, ["columnId", "title"])),
              rowCount: integerSchema(0),
              proposalCount: integerSchema(0),
              rows: arraySchema(openObject()),
            },
            ["type", "datasetId", "columns", "rowCount", "proposalCount"],
          ),
          objectSchema(
            {
              type: constSchema("image"),
              mediaId: stringSchema(),
              naturalWidth: integerSchema(0),
              naturalHeight: integerSchema(0),
              annotationCount: integerSchema(0),
              strokeCount: integerSchema(0),
            },
            ["type", "mediaId", "annotationCount", "strokeCount"],
          ),
          objectSchema(
            {
              type: constSchema("video"),
              mediaId: stringSchema(),
              durationSec: numberSchema(0),
              resolution: stringSchema(),
              markerCount: integerSchema(0),
              markers: arraySchema(openObject()),
            },
            ["type", "mediaId", "markerCount"],
          ),
        ],
      },
    },
    [
      "id",
      "batchId",
      "title",
      "type",
      "version",
      "status",
      "orderIndex",
      "createdAt",
      "decisionCount",
      "lastDecision",
      "feedbackCount",
      "confirmedFeedbackCount",
      "content",
    ],
  );

const workbenchBatchSummary = (): OutputSchemaNode =>
  objectSchema(
    {
      id: stringSchema(),
      name: stringSchema(),
      description: stringSchema(),
      createdAt: numberSchema(0),
      revision: integerSchema(0),
      itemCount: integerSchema(0),
      statusCounts: objectSchema(
        {
          pending: integerSchema(0),
          kept: integerSchema(0),
          discarded: integerSchema(0),
          modified: integerSchema(0),
          rework: integerSchema(0),
        },
        ["pending", "kept", "discarded", "modified", "rework"],
      ),
      handoffState: enumSchema(["none", "published_waiting", "agent_acked", "rework_returned"]),
    },
    ["id", "name", "createdAt", "revision", "itemCount", "statusCounts", "handoffState"],
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
  "media.cleanup.review": openObject(),
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
  "collaboration.instructions.get": objectSchema({
    revision: integerSchema(0), projectId: stringSchema(), workspaceId: stringSchema(),
    instructions: arraySchema(openObject(), { maxItems: 20 }),
  }, ["revision", "projectId", "instructions"]),
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
  "review.context": objectSchema({
    target: objectSchema({ kind: constSchema("review"), reviewWorkspaceId: stringSchema(), instanceId: stringSchema() }, ["kind", "reviewWorkspaceId", "instanceId"]),
    revision: integerSchema(0), access: enumSchema(["read-only", "write"]), ready: constSchema(true),
  }, ["target", "revision", "access", "ready"]),
  "review.nodes.list": objectSchema({ nodes: arraySchema(reviewNode(), { maxItems: 500 }), cursor: stringSchema() }, ["nodes"]),
  "review.nodes.create": reviewNode(),
  "review.branches.create": objectSchema({ node: reviewNode(), target: openObject(), workspaceRevision: integerSchema(0), replayed: booleanSchema() }, ["node", "target", "workspaceRevision", "replayed"]),
  "review.branches.compare": objectSchema({ branch: reviewNode(), source: reviewNode(), items: arraySchema(openObject()), idMap: arraySchema(openObject()) }, ["branch", "source", "items", "idMap"]),
  "review.items.submit": reviewCommit(),
  "review.branches.submit": reviewCommit(),
  "review.directory.get": objectSchema({ revision: integerSchema(0), groups: arraySchema(reviewGroup()), canUndo: booleanSchema(), canRedo: booleanSchema() }, ["revision", "groups", "canUndo", "canRedo"]),
  "review.directory.apply": reviewDirectoryCommit(),
  "review.directory.history.control": reviewDirectoryCommit(),
  "review.get": objectSchema({ node: reviewNode(), item: openObject(), feedback: arraySchema(openObject()), items: arraySchema(objectSchema({
    id: stringSchema(), batchId: stringSchema(), title: stringSchema(), subtitle: stringSchema(), type: enumSchema(["image", "text", "data", "video", "model3d"]),
    version: integerSchema(1), status: enumSchema(["pending", "kept", "discarded", "modified", "rework"]), orderIndex: integerSchema(0),
    provenanceTags: arraySchema(openObject()), userTags: arraySchema(stringSchema()), agentGuidance: openObject(), lineage: openObject(), reworkOrigin: openObject(), updatedAt: numberSchema(0), hasManualRevision: booleanSchema(),
  }, ["id", "batchId", "title", "type", "version", "status", "orderIndex"]), { maxItems: 500 }), cursor: stringSchema() }, ["node"]),
  "review.ingest": reviewCommit(),
  "review.export.prepare": reviewExportStatus(),
  "review.media.inspect": objectSchema({ target: objectSchema({ kind: constSchema("review"), reviewWorkspaceId: stringSchema(), nodeId: stringSchema(), instanceId: stringSchema() }, ["kind", "reviewWorkspaceId", "nodeId", "instanceId"]),
    nodeRevision: integerSchema(0), resource: objectSchema({ id: stringSchema(), originalFileName: stringSchema(), mime: stringSchema(), size: integerSchema(0), sha256: stringSchema(), createdAt: numberSchema(0), source: enumSchema(["user", "agent", "migration"]),
      metadata: objectSchema({ type: enumSchema(["image", "video", "audio"]), width: numberSchema(0), height: numberSchema(0), durationSec: numberSchema(0), frameRate: numberSchema(0), codec: stringSchema() }, ["type", "width", "height", "durationSec", "frameRate", "codec"]),
    }, ["id", "originalFileName", "mime", "size", "createdAt", "source"]),
  }, ["target", "nodeRevision", "resource"]),
  "review.frames.extract": objectSchema({ target: objectSchema({ kind: constSchema("review"), reviewWorkspaceId: stringSchema(), nodeId: stringSchema(), instanceId: stringSchema() }, ["kind", "reviewWorkspaceId", "nodeId", "instanceId"]),
    nodeRevision: integerSchema(0), resourceId: stringSchema(), facts: objectSchema({ width: integerSchema(1), height: integerSchema(1), durationSec: numberSchema(0), timing: enumSchema(["cfr", "vfr", "unknown"]) }, ["width", "height", "durationSec", "timing"]),
    frames: arraySchema(objectSchema({ frame: integerSchema(0), ptsTimeSec: numberSchema(0), artifact: artifactRef() }, ["frame", "ptsTimeSec", "artifact"]), { minItems: 1, maxItems: 600 }), limitations: arraySchema(stringSchema()),
  }, ["target", "nodeRevision", "resourceId", "facts", "frames", "limitations"]),
  "review.attach": objectSchema({ projectId: stringSchema(), workspaceId: stringSchema(), mediaId: stringSchema(), itemId: stringSchema(),
    version: integerSchema(1), resourceId: stringSchema(), revision: integerSchema(0), replayed: booleanSchema(), present: booleanSchema() },
    ["projectId", "workspaceId", "mediaId", "itemId", "version", "resourceId", "revision", "replayed", "present"]),
  "review.package.inspect": objectSchema({ packageId: stringSchema(), digest: stringSchema(), name: stringSchema(), sourceNodeId: stringSchema(),
    itemCount: integerSchema(0), versionCount: integerSchema(0), stepCount: integerSchema(0), resourceCount: integerSchema(0), bytes: integerSchema(0), handoffCount: integerSchema(0), missingResourceCount: integerSchema(0), missingVersionCount: integerSchema(0),
  }, ["packageId", "digest", "name", "sourceNodeId", "itemCount", "versionCount", "stepCount", "resourceCount", "bytes", "handoffCount", "missingResourceCount", "missingVersionCount"]),
  "review.package.restore": objectSchema({ node: reviewNode(), workspaceRevision: integerSchema(0), replayed: booleanSchema() }, ["node", "workspaceRevision", "replayed"]),
  "review.steps.start": reviewCommit(),
  "review.steps.complete": reviewCommit(),
  "review.steps.fail": reviewCommit(),
  "review.steps.list": objectSchema({ node: reviewNode(), steps: arraySchema(openObject(), { maxItems: 500 }), cursor: stringSchema() }, ["node", "steps"]),
  "review.export.status": reviewExportStatus(),
  "review.export.cancel": reviewExportStatus(),
  "review.export.copy": objectSchema({ directory: stringSchema(), files: arraySchema(objectSchema({ relativePath: stringSchema(), size: integerSchema(0), sha256: stringSchema() }, ["relativePath", "size", "sha256"])) }, ["directory", "files"]),
  "review.apply": reviewCommit(),
  "review.handoff.get": objectSchema({ node: reviewNode(), handoff: openObject() }, ["node", "handoff"]),
  "review.versions.get": objectSchema({ node: reviewNode(), itemId: stringSchema(), version: integerSchema(1), content: openObject(), revision: openObject() }, ["node", "itemId", "version", "content"]),
  "review.changes": objectSchema({ node: reviewNode(), entries: arraySchema(objectSchema({ sequence: integerSchema(1), actor: enumSchema(["human", "agent"]), label: stringSchema(), kind: enumSchema(["commit", "undo", "redo", "event"]), relatedSequence: integerSchema(1), handoffIds: arraySchema(stringSchema()) }, ["sequence", "actor", "label", "kind"]), { maxItems: 500 }), nextSequence: integerSchema(0), hasMore: booleanSchema() }, ["node", "entries", "nextSequence", "hasMore"]),
  "review.history.control": reviewCommit(),
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
  "workbench.ingest": objectSchema(
    {
      revision: integerSchema(0),
      batchId: stringSchema(),
      batchRevision: integerSchema(0),
      acceptedItemIds: arraySchema(stringSchema()),
      skippedItemIds: arraySchema(stringSchema()),
      received: constSchema(true),
      replayed: booleanSchema(),
    },
    ["revision", "batchId", "batchRevision", "acceptedItemIds", "skippedItemIds", "received", "replayed"],
  ),
  "workbench.get": objectSchema(
    {
      revision: integerSchema(0),
      read: objectSchema(
        { capturedAt: numberSchema(0), stateRevision: integerSchema(0) },
        ["capturedAt", "stateRevision"],
      ),
      // Single-item lookup form (absent on listing reads).
      item: nullable(workbenchItemView()),
      // Listing form (absent on single-item reads).
      batches: arraySchema(workbenchBatchSummary()),
      items: arraySchema(workbenchItemView(), { maxItems: 200 }),
      total: integerSchema(0),
    },
    ["revision"],
  ),
  "workbench.changes": objectSchema(
    {
      projectRevision: integerSchema(0),
      cursor: nullable(integerSchema(0)),
      stale: booleanSchema(),
      decided: arraySchema(
        objectSchema(
          {
            itemId: stringSchema(),
            batchId: stringSchema(),
            decision: enumSchema(["kept", "discarded", "modified", "rework"]),
            decisionRevision: integerSchema(0),
            baseVersion: integerSchema(0),
            decidedAt: numberSchema(0),
            operator: enumSchema(["human", "agent"]),
            contentRevisionId: stringSchema(),
          },
          ["itemId", "batchId", "decision", "decisionRevision", "baseVersion", "decidedAt", "operator"],
        ),
      ),
      handoffEvents: arraySchema(
        objectSchema(
          {
            handoffId: stringSchema(),
            batchId: stringSchema(),
            deliveryState: enumSchema(["published_waiting", "agent_acked", "rework_returned"]),
            publishedAt: numberSchema(0),
            supersedesHandoffId: stringSchema(),
            itemCount: integerSchema(0),
          },
          ["handoffId", "batchId", "deliveryState", "publishedAt", "itemCount"],
        ),
      ),
      note: stringSchema(),
    },
    ["projectRevision", "cursor", "stale", "decided", "handoffEvents", "note"],
  ),
  "workbench.handoff.get": objectSchema(
    {
      revision: integerSchema(0),
      // The complete immutable handoff snapshot; absent on a header-only read.
      handoff: openObject(),
      // Header-only read when no snapshot id was supplied (null when none).
      latest: nullable(openObject()),
    },
    ["revision"],
  ),
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

/** Successful `{ok:true,value}` output schema for every facade command. */
export const EMITTED_VERB_OUTPUT_JSON_SCHEMAS: Readonly<Record<FacadeVerb, OutputSchemaObject>> = Object.fromEntries(
  Object.entries({ ...valueSchemas, ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.output])) }).map(([verb, value]) => [verb, successEnvelope(value)]),
) as Readonly<Record<FacadeVerb, OutputSchemaObject>>;
