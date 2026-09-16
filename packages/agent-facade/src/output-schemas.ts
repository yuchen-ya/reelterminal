import { PLUGIN_TOOLS } from "./plugins";
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
      textOverlay: objectSchema({ modelState: constSchema(true), pixelRendering: booleanSchema() }, ["modelState", "pixelRendering"]),
      preview: capabilityStatus(),
      visualInspection: capabilityStatus(),
      editorControl: capabilityStatus(),
      export: capabilityStatus(),
      verify: capabilityStatus(),
    },
    ["runtime", "stateModel", "mediaImport", "projectChanges", "history", "mediaAnalysis", "professionalEditing", "editOps", "textOverlay", "preview", "visualInspection", "editorControl", "export", "verify"],
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
      kind: enumSchema(["export", "analysis"]),
      state: enumSchema(["queued", "running", "done", "error", "cancelled"]),
      progress: nullable(jobProgress()),
      artifact: nullable(artifactRef()),
      result: nullable(openObject()),
      error: nullable(objectSchema({ code: stringSchema(), message: stringSchema() }, ["code", "message"])),
      deliveredTo: nullable(stringSchema()),
      deliveryError: nullable(stringSchema()),
      sourceRevision: integerSchema(0),
      route: nullable(stringSchema()),
      cancelRequested: booleanSchema(),
      createdAt: stringSchema(),
      updatedAt: stringSchema(),
    },
    ["jobId", "kind", "state", "progress", "artifact", "result", "error", "deliveredTo", "deliveryError", "sourceRevision", "route", "cancelRequested", "createdAt", "updatedAt"],
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
            entityType: enumSchema(["track", "clip", "text", "media", "transition", "marker", "subtitle"]),
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
  "project.create": objectSchema({ ...projectState()["properties"], replayed: booleanSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.open": objectSchema({ ...projectState()["properties"], replayed: booleanSchema() }, ["revision", "project", "counts", "replayed"]),
  "project.save": projectSaveResult(),
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
  "project.changes": projectChangesResult(),
  "media.import": mediaImportResult(),
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
  "editor.get_context": editorContext(),
  "editor.control": editorControlResult(),
  "edit.validate": editValidateResult(),
  "edit.apply": editApplyResult(),
  "history.get": historyGetResult(),
  "history.control": historyControlResult(),
  "preview.render_frame": objectSchema({ revision: integerSchema(0), timeSec: numberSchema(0), width: integerSchema(0), height: integerSchema(0), artifact: artifactRef(), replayed: booleanSchema() }, ["revision", "timeSec", "width", "height", "artifact", "replayed"]),
  "visual.inspect": objectSchema({ revision: integerSchema(0), sourceRevision: integerSchema(0), selection: openObject(), sampleCount: integerSchema(1, 12), width: integerSchema(2), height: integerSchema(2), frameBudgetBytes: integerSchema(1), frames: arraySchema(openObject(), { minItems: 1, maxItems: 12 }), contactSheet: nullable(artifactRef()), limitations: arraySchema(stringSchema()), replayed: booleanSchema() }, ["revision", "sourceRevision", "selection", "sampleCount", "width", "height", "frameBudgetBytes", "frames", "contactSheet", "limitations", "replayed"]),
  "preview.render_comparison": objectSchema({ revision: integerSchema(0), sourceRevision: integerSchema(0), timeSec: numberSchema(0), referenceSec: numberSchema(0), clamped: stringSchema(), layout: stringSchema(), width: integerSchema(2), height: integerSchema(2), frameBudgetBytes: integerSchema(1), artifact: artifactRef(), limitations: arraySchema(stringSchema()), replayed: booleanSchema() }, ["revision", "sourceRevision", "timeSec", "referenceSec", "clamped", "layout", "width", "height", "frameBudgetBytes", "artifact", "limitations", "replayed"]),
  "analysis.list": arraySchema(
    objectSchema({ id: stringSchema(), finishedAt: stringSchema(), subject: openObject(), analysisTypes: arraySchema(stringSchema()), stale: openObject(), recheckOf: nullable(stringSchema()) }, ["id", "finishedAt", "subject", "analysisTypes", "stale", "recheckOf"]),
    { maxItems: 200 },
  ),
  "analysis.get": openObject(),
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
};

/** Successful `{ok:true,value}` output schema for every MCP facade verb. */
export const EMITTED_VERB_OUTPUT_JSON_SCHEMAS: Readonly<Record<FacadeVerb, OutputSchemaObject>> = Object.fromEntries(
  Object.entries({ ...valueSchemas, ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.output])) }).map(([verb, value]) => [verb, successEnvelope(value)]),
) as Readonly<Record<FacadeVerb, OutputSchemaObject>>;
