/**
 * Shared verb-parameter rule tests (verb-param-rules.ts): the cross-field
 * rules that were duplicated between session.ts, live-session.ts and
 * request-validation.ts must behave IDENTICALLY at every entry real traffic
 * can take:
 *
 *  - the headless facade factory (createAgentFacade) and its direct session;
 *  - the live facade factory (createLiveFacade) and its direct session.
 *
 * Corpus conventions follow verb-schema-corpus.ts: named, dependency-free
 * cases with a stable expectation, evaluated against all four entries. A case
 * whose outcome legitimately differs between headless and live (a documented
 * product difference — editor attachment, mediaRoots fallback, live store
 * ownership) pins BOTH sides' exact code+message instead of an equality
 * assertion, so any accidental divergence still fails the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";

import { createAgentFacade, createLiveFacade, LiveWriterLease } from "./index";
import { AgentFacadeSession } from "./session";
import { LiveFacadeSession } from "./live-session";
import { FacadeError, type FacadeResult } from "./errors";
import { validateFontUploadSource } from "./verb-param-rules";
import {
  collectEntityIds,
  diffCreatedIdsByCategory,
} from "./ops";
import { createEmptyProject } from "./project-factory";
import type {
  LiveApplyActionsOptions,
  LiveEditorContext,
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveMediaImportRequest,
  LiveMediaImportResult,
  LiveProjectIdentity,
  LiveProjectStore,
} from "./live-store";
import type {
  RequirementsListParams,
  RequirementsListResult,
  RequirementsGetParams,
  RequirementsGetResult,
} from "./requirements";
import type {
  ArtifactVerifier,
  ProviderPreflight,
  RenderProvider,
} from "./providers";
import type {
  ProjectChangesParams,
  ProjectChangesResult,
  HistoryGetParams,
  HistoryGetResult,
  HistoryControlResult,
} from "./types";

/* ------------------------------ fixtures ------------------------------ */

const VALID_SRT =
  "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n\n";

const TEXT_BATCH = [
  { op: "track.add", trackType: "text", trackId: "t1" },
  { op: "text.create", text: "Hello corpus", startTime: 0, duration: 2 },
];

function availablePreflight(details?: Record<string, unknown>): ProviderPreflight {
  return { available: true, ...(details ? { details } : {}) };
}

function stubRenderProvider(): RenderProvider {
  return {
    id: "stub-render",
    preflight: async () => availablePreflight(),
    renderFramePng: async (request) => {
      await mkdir(path.dirname(request.destPath), { recursive: true });
      const bytes = Buffer.from(
        `fake-png:${request.timeSec}:${request.width}x${request.height}`,
      );
      await writeFile(request.destPath, bytes);
      return { bytesWritten: bytes.length };
    },
  };
}

function stubArtifactVerifier(seenPaths: string[]): ArtifactVerifier {
  return {
    id: "stub-verifier",
    preflight: async () => availablePreflight(),
    verify: async (request) => {
      seenPaths.push(request.path);
      return {
        pass: true,
        probe: {
          container: "png",
          videoCodec: null,
          audioCodec: null,
          width: 8,
          height: 8,
          durationSec: 0,
          frameCount: null,
          frameRate: null,
          sizeBytes: 64,
          sha256: "stub-sha256",
        },
        checks: [{ name: "probe", pass: true, details: "stub probe" }],
      };
    },
  };
}

/* ---------------------------- FakeLiveStore --------------------------- */

class FakeLiveStore implements LiveProjectStore {
  project: Project;
  revision = 0;
  contextRevision = 1;
  context: LiveEditorContext = {
    contextRevision: 1,
    playheadSeconds: null,
    selectedClipIds: [],
    selectedTextIds: [],
    selectedMediaIds: [],
    timeRange: null,
    canvasPoint: null,
    references: {},
  };
  readonly batches: Array<{ readonly actions: readonly Action[] }> = [];
  editorControlCalls = 0;

  constructor(project?: Project) {
    this.project = project ?? createEmptyProject("Corpus Live");
  }

  async getIdentity(): Promise<LiveProjectIdentity> {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      workspaceId: "workspace-corpus",
      workspaceInstanceId: "runtime-corpus",
      windowId: "win-corpus",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }

  async listRequirements(params: RequirementsListParams): Promise<RequirementsListResult> {
    const { requirementsListView } = await import("./requirements");
    return requirementsListView(this.project.requirements?.items ?? [], this.revision, params);
  }

  async getRequirement(params: RequirementsGetParams): Promise<RequirementsGetResult> {
    const { requirementsGetView } = await import("./requirements");
    return requirementsGetView(this.project.requirements?.items ?? [], this.revision, params);
  }

  async getContext(): Promise<LiveEditorContext> {
    return {
      ...this.context,
      contextRevision: this.contextRevision,
      selectedClipIds: [...this.context.selectedClipIds],
      selectedTextIds: [...this.context.selectedTextIds],
      selectedMediaIds: [...this.context.selectedMediaIds],
      timeRange: this.context.timeRange ? { ...this.context.timeRange } : null,
      canvasPoint: this.context.canvasPoint ? { ...this.context.canvasPoint } : null,
      references: { ...this.context.references },
    };
  }

  async getProjectChanges(params: ProjectChangesParams): Promise<ProjectChangesResult> {
    return {
      fromRevision: params.sinceRevision,
      toRevision: this.revision,
      changes: [],
      nextCursor: null,
      requiresFullRefresh: params.sinceRevision < this.revision,
    };
  }

  async getHistory(params: HistoryGetParams): Promise<HistoryGetResult> {
    void params;
    return {
      revision: this.revision,
      available: true,
      canUndo: false,
      canRedo: false,
      undoCount: 0,
      redoCount: 0,
      entries: [],
    };
  }

  async historyControl(
    action: "undo" | "redo",
    opts: { readonly expectedRevision: number; readonly idempotencyKey?: string },
  ): Promise<Omit<HistoryControlResult, "action">> {
    void action;
    void opts.idempotencyKey;
    if (opts.expectedRevision !== this.revision) {
      throw new (await import("./live-store")).LiveStoreConflictError(
        "history revision conflict",
        { currentRevision: this.revision },
      );
    }
    this.revision += 1;
    return { revision: this.revision, canUndo: false, canRedo: true, replayed: false };
  }

  async editorControl(
    params: LiveEditorControlParams,
  ): Promise<LiveEditorControlResult> {
    this.editorControlCalls += 1;
    const context = this.context;
    if (params.action === "seek") {
      this.context = { ...context, playheadSeconds: params.timeSeconds ?? 0 };
    }
    if (params.action === "select") {
      this.context = {
        ...context,
        selectedClipIds: (params.targets ?? []).filter((t) => t.kind === "clip").map((t) => t.id),
        selectedTextIds: (params.targets ?? []).filter((t) => t.kind === "text").map((t) => t.id),
        selectedMediaIds: (params.targets ?? []).filter((t) => t.kind === "media").map((t) => t.id),
      };
    }
    this.contextRevision += 1;
    return {
      action: params.action,
      playbackState: params.action === "play" ? "playing" : "paused",
      playheadSeconds: this.context.playheadSeconds ?? 0,
      selectedClipIds: this.context.selectedClipIds,
      selectedTextIds: this.context.selectedTextIds,
      selectedMediaIds: this.context.selectedMediaIds,
      revealedTargets: params.targets ?? [],
      contextRevision: this.contextRevision,
    };
  }

  async applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ) {
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new (await import("./live-store")).LiveStoreConflictError(
        `store revision conflict: expected ${opts.expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    const draft = structuredClone(this.project);
    const createdIds = {
      tracks: [] as string[],
      clips: [] as string[],
      textClips: [] as string[],
      transitions: [] as string[],
      subtitles: [] as string[],
    };
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const before = collectEntityIds(draft);
      const result = await executor.execute(action, draft);
      if (!result.success) {
        throw new Error(`store apply failed: ${result.error?.message ?? "unknown core error"}`);
      }
      const created = diffCreatedIdsByCategory(before, collectEntityIds(draft));
      createdIds.tracks.push(...created.tracks);
      createdIds.clips.push(...created.clips);
      createdIds.textClips.push(...created.textClips);
      createdIds.transitions.push(...created.transitions);
      createdIds.subtitles.push(...created.subtitles);
    }
    this.project = draft;
    this.revision += 1;
    this.batches.push({ actions });
    return { revision: this.revision, createdIds };
  }

  async importMedia(
    request: LiveMediaImportRequest,
    _opts: LiveApplyActionsOptions,
  ): Promise<LiveMediaImportResult> {
    void request;
    throw new Error("media.import is not exercised by this corpus");
  }

  async requestSave() {
    return { revision: this.revision };
  }
}

/* ----------------------------- harness -------------------------------- */

interface Outcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
}

function outcome<T>(result: FacadeResult<T>): Outcome {
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        code: result.error.code,
        message: result.error.message,
        details: result.error.details,
      };
}

interface Entries {
  readonly store: FakeLiveStore;
  readonly headlessFactory: Record<
    string,
    (params?: unknown) => Promise<FacadeResult<unknown>>
  >;
  readonly liveFactory: Record<
    string,
    (params?: unknown) => Promise<FacadeResult<unknown>>
  >;
  readonly headlessDirect: Record<
    string,
    (params?: unknown) => Promise<FacadeResult<unknown>>
  >;
  readonly liveDirect: Record<
    string,
    (params?: unknown) => Promise<FacadeResult<unknown>>
  >;
}

async function callEntry(
  entry: Record<string, (params?: unknown) => Promise<FacadeResult<unknown>>>,
  verb: string,
  params: unknown,
): Promise<Outcome> {
  return outcome(await entry[verb](params));
}

let artifactRoot: string;
let outsideDir: string;

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "facade-rules-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "facade-rules-outside-"));
  await writeFile(path.join(artifactRoot, "frame.png"), Buffer.from("png-bytes-frame"));
  await writeFile(path.join(artifactRoot, "ref.png"), Buffer.from("png-bytes-ref"));
  // An EXISTING file outside artifactRoot: containment results require a
  // resolvable path (nonexistent paths fail closed as "unresolvable").
  await writeFile(path.join(outsideDir, "elsewhere.mp4"), Buffer.from("mp4-outside"));
  await writeFile(path.join(outsideDir, "ref-escape.png"), Buffer.from("png-outside"));
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

/**
 * Direct session methods are camelCase; expose them under their facade verb
 * names so the corpus runner drives all four entries uniformly.
 */
function asFacadeRecord(
  session: object,
): Record<string, (params?: unknown) => Promise<FacadeResult<unknown>>> {
  const s = session as unknown as Record<
    string,
    (p?: unknown) => Promise<FacadeResult<unknown>>
  >;
  return {
    "editor.control": (p) => s.editorControl(p),
    "timeline.query": (p) => s.timelineQuery(p),
    "edit.apply": (p) => s.editApply(p),
    "edit.validate": (p) => s.editValidate(p),
    "visual.inspect": (p) => s.visualInspect(p),
    "verify.artifact": (p) => s.verifyArtifact(p),
    "project.get_state": () => s.projectGetState(),
  };
}

/** Fresh headless entry pair (factory + direct session), project open on both. */
async function makeHeadlessEntries() {
  const config = {
    artifactRoot,
    mediaRoots: [] as readonly string[],
    deliveryRoots: [] as readonly string[],
    renderProvider: stubRenderProvider(),
    artifactVerifier: stubArtifactVerifier([]),
  };
  const facade = createAgentFacade({ ...config });
  await facade["project.create"]({ name: "Corpus Headless" });
  const direct = new AgentFacadeSession({ ...config });
  await direct.projectCreate({ name: "Corpus Headless Direct" });
  return { facade, direct: asFacadeRecord(direct) };
}

/** Fresh live entry pair (factory + direct session) over one shared store. */
async function makeLiveEntries() {
  const store = new FakeLiveStore();
  const config = {
    store: store as LiveProjectStore,
    lease: new LiveWriterLease(),
    sessionId: "agent-corpus",
    access: "write" as const,
    artifactRoot,
    renderProvider: stubRenderProvider(),
    artifactVerifier: stubArtifactVerifier([]),
  };
  const facade = createLiveFacade({ ...config });
  // The direct session must hold its OWN writer lease: two sessions cannot
  // share one lease (the second would be demoted to read-only and its write
  // verbs would fail CONFLICT before validation even runs).
  const direct = new LiveFacadeSession({
    ...config,
    lease: new LiveWriterLease(),
    sessionId: "agent-corpus-direct",
  });
  return { facade, direct: asFacadeRecord(direct), store };
}

async function makeEntries(): Promise<Entries> {
  const headless = await makeHeadlessEntries();
  const live = await makeLiveEntries();
  const asRecord = (facade: object) =>
    facade as unknown as Record<
      string,
      (params?: unknown) => Promise<FacadeResult<unknown>>
    >;
  return {
    store: live.store,
    headlessFactory: asRecord(headless.facade),
    liveFactory: asRecord(live.facade),
    headlessDirect: headless.direct,
    liveDirect: live.direct,
  };
}

const ALL_ENTRY_KEYS = ["headlessFactory", "liveFactory", "headlessDirect", "liveDirect"] as const;

/**
 * Assert that EVERY entry produces the exact same error code and message for
 * these params — the convergence contract of the shared rules. Pass
 * `messageContains` instead of `message` when the underlying schema message
 * embeds an unstable allowed-fields list.
 */
async function expectSameInvalidEverywhere(
  entries: Entries,
  verb: string,
  params: unknown,
  expected: { code: string; message?: string; messageContains?: string },
): Promise<void> {
  for (const key of ALL_ENTRY_KEYS) {
    const got = await callEntry(entries[key], verb, params);
    expect(got.ok, `${key}: expected rejection`).toBe(false);
    expect(got.code, `${key}: code`).toBe(expected.code);
    if (expected.message !== undefined) {
      expect(got.message, `${key}: message`).toBe(expected.message);
    }
    if (expected.messageContains !== undefined) {
      expect(got.message ?? "", `${key}: message fragment`).toContain(expected.messageContains);
    }
  }
}

/* ------------------------- editor.control corpus ----------------------- */

describe("editor.control cross-field rules (shared)", () => {
  it("identical INVALID_PARAMS for every illegal action/target combination at all four entries", async () => {
    const entries = await makeEntries();
    const cases: Array<{ name: string; params: Record<string, unknown>; message: string }> = [
      {
        name: "seek without timeSeconds",
        params: { action: "seek" },
        message: "editor.control: seek requires timeSeconds",
      },
      {
        name: "timeSeconds outside seek",
        params: { action: "play", timeSeconds: 1.5 },
        message: "editor.control: timeSeconds is only valid for seek, not play",
      },
      {
        name: "select without targets",
        params: { action: "select" },
        message: "editor.control: select requires at least one target",
      },
      {
        name: "targets outside select",
        params: { action: "pause", targets: [{ kind: "clip", id: "clip-1" }] },
        message: "editor.control: targets and selectionMode are only valid for select, not pause",
      },
      {
        name: "selectionMode outside select",
        params: { action: "play", selectionMode: "replace" },
        message: "editor.control: targets and selectionMode are only valid for select, not play",
      },
      {
        name: "malformed target shape",
        params: { action: "select", targets: [{ kind: "bogus", id: "x" }] },
        // Schema-level message from the shared EDITOR_CONTROL_TARGET_SCHEMA.
        message: 'editor.control params.targets[0]: field "kind" must be "clip", "text" or "media"',
      },
    ];
    for (const testCase of cases) {
      await expectSameInvalidEverywhere(entries, "editor.control", testCase.params, {
        code: "INVALID_PARAMS",
        message: testCase.message,
      });
    }
    // No illegal case ever reached the live renderer bridge.
    expect(entries.store.editorControlCalls).toBe(0);
  });

  it("legal combinations validate everywhere; headless then honestly reports UNSUPPORTED, live applies", async () => {
    const entries = await makeEntries();
    for (const params of [
      { action: "seek", timeSeconds: 1.25 },
      { action: "select", targets: [{ kind: "clip", id: "clip-1" }] },
      { action: "play" },
    ]) {
      const headlessFactory = await callEntry(entries.headlessFactory, "editor.control", params);
      const headlessDirect = await callEntry(entries.headlessDirect, "editor.control", params);
      expect(headlessFactory).toEqual({ ok: false, code: "UNSUPPORTED", message: "editor.control: no live editor is attached to this headless session" });
      expect(headlessDirect).toEqual(headlessFactory);
      const liveFactory = await callEntry(entries.liveFactory, "editor.control", params);
      const liveDirect = await callEntry(entries.liveDirect, "editor.control", params);
      expect(liveFactory.ok, "live editor.control succeeds for a legal request").toBe(true);
      expect(liveDirect.ok, "live direct editor.control succeeds for a legal request").toBe(true);
    }
    expect(entries.store.editorControlCalls).toBe(6);
  });
});

/* ------------------------- timeline.query corpus ----------------------- */

describe("timeline.query timeRange rule (shared)", () => {
  it("endSec must be strictly greater than startSec — identical everywhere", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "timeline.query",
      { timeRange: { startSec: 5, endSec: 5 } },
      { code: "INVALID_PARAMS", message: "timeline.query: timeRange.endSec must be greater than startSec" },
    );
    await expectSameInvalidEverywhere(
      entries,
      "timeline.query",
      { timeRange: { startSec: 6, endSec: 5 } },
      { code: "INVALID_PARAMS", message: "timeline.query: timeRange.endSec must be greater than startSec" },
    );
  });

  it("nested range schema violations are identical everywhere", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "timeline.query",
      { timeRange: { startSec: -1, endSec: 5 } },
      {
        code: "INVALID_PARAMS",
        message: 'timeline.query params.timeRange: field "startSec" must be a non-negative finite number',
      },
    );
  });

  it("legal ranges query fine on both live entries (documented: headless direct has a project too)", async () => {
    const entries = await makeEntries();
    for (const key of ["headlessFactory", "liveFactory", "headlessDirect", "liveDirect"] as const) {
      const got = await callEntry(entries[key], "timeline.query", {
        timeRange: { startSec: 0, endSec: 10 },
      });
      expect(got.ok, `${key}: empty-project query succeeds`).toBe(true);
    }
  });
});

/* ------------------------- edit batch corpus --------------------------- */

describe("edit.apply / edit.validate batch rules (shared)", () => {
  it("empty ops and malformed ops fail identically everywhere, before any state access", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "edit.apply",
      { ops: [] },
      { code: "INVALID_PARAMS", message: "edit.apply: ops must contain at least one op" },
    );
    await expectSameInvalidEverywhere(
      entries,
      "edit.validate",
      { ops: [] },
      { code: "INVALID_PARAMS", message: "edit.validate: ops must contain at least one op" },
    );
    await expectSameInvalidEverywhere(
      entries,
      "edit.apply",
      { ops: [{ op: "track.add", trackType: "video", unknownField: true }] },
      { code: "INVALID_PARAMS", messageContains: 'unknown field "unknownField"' },
    );
  });

  it("cross-op constraint (at most one subtitle.importSrt) is identical everywhere", async () => {
    const entries = await makeEntries();
    const ops = [
      { op: "subtitle.importSrt", srtContent: VALID_SRT },
      { op: "subtitle.importSrt", srtContent: VALID_SRT },
    ];
    await expectSameInvalidEverywhere(entries, "edit.apply", { ops }, {
      code: "INVALID_PARAMS",
      message:
        "edit batch may contain at most one subtitle.importSrt op; combine the SRT cues into one document",
    });
    await expectSameInvalidEverywhere(entries, "edit.validate", { ops }, {
      code: "INVALID_PARAMS",
      message:
        "edit batch may contain at most one subtitle.importSrt op; combine the SRT cues into one document",
    });
  });

  it("an invalid batch applies NOTHING and does not touch the ledger (headless)", async () => {
    const entries = await makeEntries();
    const verb = "edit.apply";
    // A legal batch first so the project gains a text track for the next step.
    const warmup = await callEntry(entries.headlessFactory, verb, { ops: TEXT_BATCH });
    expect(warmup.ok).toBe(true);

    const before = await callEntry(entries.headlessFactory, "project.get_state", {});
    expect(before.ok).toBe(true);

    // Half-valid batch: valid first op, invalid second op.
    const bad = await callEntry(entries.headlessFactory, verb, {
      idempotencyKey: "retry-key",
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }, { op: "nonsense" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("INVALID_PARAMS");

    const after = await callEntry(entries.headlessFactory, "project.get_state", {});
    expect(after).toEqual(before);

    // The ledger never saw the failed request: the same idempotency key with
    // a DIFFERENT valid payload must NOT be answered as a replay.
    const retry = await callEntry(entries.headlessFactory, verb, {
      idempotencyKey: "retry-key",
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    expect(retry.ok).toBe(true);
    const replayedFlag = await entries.headlessFactory[verb]({
      idempotencyKey: "retry-key",
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    expect(replayedFlag.ok).toBe(true);
    if (replayedFlag.ok) {
      expect((replayedFlag.value as { replayed?: boolean }).replayed).toBe(true);
    }
  });

  it("an invalid batch applies NOTHING on live (no store batch, no revision bump, no ledger scope)", async () => {
    const entries = await makeEntries();
    const batchesBefore = entries.store.batches.length;
    const revisionBefore = entries.store.revision;

    const bad = await callEntry(entries.liveFactory, "edit.apply", {
      idempotencyKey: "live-retry-key",
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }, { op: 42 }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("INVALID_PARAMS");

    expect(entries.store.batches.length).toBe(batchesBefore);
    expect(entries.store.revision).toBe(revisionBefore);

    // The failed request left no receipt behind: the same key commits fresh.
    const retry = await callEntry(entries.liveFactory, "edit.apply", {
      idempotencyKey: "live-retry-key",
      ops: TEXT_BATCH,
    });
    expect(retry.ok).toBe(true);
    expect(entries.store.batches.length).toBe(batchesBefore + 1);
  });
});

/* ------------------------ visual.inspect corpus ------------------------ */

describe("visual.inspect cross-field rules (shared)", () => {
  it("nested timeRange schema violations are identical everywhere", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "visual.inspect",
      { clipId: "c1", timeRange: { startSec: 0, endSec: -1 } },
      {
        code: "INVALID_PARAMS",
        message: 'visual.inspect params.timeRange: field "endSec" must be a non-negative finite number',
      },
    );
  });

  it("exactly-one-selector rule fails identically at the session level", async () => {
    const entries = await makeEntries();
    for (const params of [
      { clipId: "c1", timeRange: { startSec: 0, endSec: 1 } },
      {},
    ]) {
      const headlessDirect = await callEntry(entries.headlessDirect, "visual.inspect", params);
      const liveDirect = await callEntry(entries.liveDirect, "visual.inspect", params);
      for (const [key, got] of [["headlessDirect", headlessDirect], ["liveDirect", liveDirect]] as const) {
        expect(got.ok, `${key}`).toBe(false);
        expect(got.code, `${key}: code`).toBe("INVALID_PARAMS");
        expect(got.message, `${key}: message`).toBe(
          'visual.inspect: pass exactly one selector — clipId (a timeline clip id) or timeRange ({"startSec": <number ≥ 0>, "endSec": <number > startSec>})',
        );
      }
    }
  });

  it("timeRange beyond the timeline duration fails identically everywhere (inside the shared plan+raster chunk)", async () => {
    const entries = await makeEntries();
    // Give each distinct project real timeline duration. liveFactory and
    // liveDirect share ONE canonical store, so one live apply covers both.
    for (const key of ["headlessFactory", "headlessDirect", "liveFactory"] as const) {
      const applied = await callEntry(entries[key], "edit.apply", { ops: [...TEXT_BATCH] });
      expect(applied.ok, `${key}: text batch applied`).toBe(true);
    }
    await expectSameInvalidEverywhere(
      entries,
      "visual.inspect",
      { timeRange: { startSec: 0, endSec: 5 } },
      {
        code: "INVALID_PARAMS",
        message: "visual.inspect: timeRange.endSec 5 is beyond the timeline duration 2",
      },
    );
  });
});

/* ------------------------ verify.artifact corpus ----------------------- */

describe("verify.artifact path/compare rules (shared)", () => {
  it("URL targets, escaping paths, unreadable paths and non-files fail identically everywhere", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "verify.artifact",
      { path: "https://example.com/video.mp4" },
      {
        code: "INVALID_PARAMS",
        message: "verify.artifact: URLs are not accepted — pass a local artifact path inside artifactRoot",
      },
    );
    await expectSameInvalidEverywhere(
      entries,
      "verify.artifact",
      { path: path.join(outsideDir, "elsewhere.mp4") },
      {
        code: "INVALID_PARAMS",
        message:
          "verify.artifact: path escapes the configured artifactRoot and every delivery root's job deliverables directory (<deliveryRoot>/jobs/<slug>/output/)",
      },
    );
    await expectSameInvalidEverywhere(
      entries,
      "verify.artifact",
      { path: path.join(artifactRoot, "missing.mp4") },
      {
        code: "INVALID_PARAMS",
        message: "verify.artifact: path cannot be read (not found or unreadable)",
      },
    );
    await expectSameInvalidEverywhere(
      entries,
      "verify.artifact",
      { path: artifactRoot },
      {
        code: "INVALID_PARAMS",
        message: "verify.artifact: path is not a regular file",
      },
    );
  });

  it("compare.region unit-square rule is identical everywhere", async () => {
    const entries = await makeEntries();
    await expectSameInvalidEverywhere(
      entries,
      "verify.artifact",
      {
        path: path.join(artifactRoot, "frame.png"),
        compare: {
          referencePath: path.join(artifactRoot, "ref.png"),
          timeSec: 0,
          mode: "similar",
          region: { x: 0.8, y: 0, width: 0.5, height: 0.5 },
        },
      },
      {
        code: "INVALID_PARAMS",
        message: "verify.artifact: compare.region must satisfy x+width ≤ 1 and y+height ≤ 1",
      },
    );
  });

  it("referencePath containment is a DOCUMENTED product difference: headless falls back to mediaRoots, live does not", async () => {
    const entries = await makeEntries();
    const params = {
      path: path.join(artifactRoot, "frame.png"),
      compare: {
        referencePath: "https://example.com/ref.png",
        timeSec: 0,
        mode: "similar",
      },
    };
    const headless = await callEntry(entries.headlessFactory, "verify.artifact", params);
    expect(headless.ok).toBe(false);
    expect(headless.code).toBe("INVALID_PARAMS");
    expect(headless.message).toBe(
      "verify.artifact: reference URLs are not accepted — pass a local path inside mediaRoots or artifactRoot",
    );
    const live = await callEntry(entries.liveFactory, "verify.artifact", params);
    expect(live.ok).toBe(false);
    expect(live.code).toBe("INVALID_PARAMS");
    expect(live.message).toBe(
      "verify.artifact: reference URLs are not accepted — pass a local path inside artifactRoot",
    );

    // Escaped (non-URL) reference pointing at an EXISTING file outside
    // artifactRoot: distinct messages, pinned per side.
    const escaped = {
      path: path.join(artifactRoot, "frame.png"),
      compare: {
        referencePath: path.join(outsideDir, "ref-escape.png"),
        timeSec: 0,
        mode: "similar",
      },
    };
    const headlessEscaped = await callEntry(entries.headlessFactory, "verify.artifact", escaped);
    expect(headlessEscaped.message).toBe(
      "verify.artifact: referencePath escapes both artifactRoot and mediaRoots",
    );
    const liveEscaped = await callEntry(entries.liveFactory, "verify.artifact", escaped);
    expect(liveEscaped.message).toBe(
      "verify.artifact: referencePath escapes the configured artifactRoot (a live session has no mediaRoots to fall back to)",
    );
  });

  it("a fully legal verify.artifact request reaches the verifier at every entry", async () => {
    const entries = await makeEntries();
    for (const key of ALL_ENTRY_KEYS) {
      const got = await callEntry(entries[key], "verify.artifact", {
        path: path.join(artifactRoot, "frame.png"),
        expect: { container: "mp4" },
        compare: {
          referencePath: path.join(artifactRoot, "ref.png"),
          timeSec: 0,
          mode: "similar",
          region: { x: 0, y: 0, width: 0.5, height: 0.5 },
        },
      });
      expect(got.ok, `${key}: legal verify succeeds`).toBe(true);
    }
  });
});

/* ------------------------ font.upload source rule ----------------------- */

describe("font.upload exactly-one-source rule (shared validateFontUploadSource)", () => {
  const EXPECTED_MESSAGE =
    "font.upload: exactly one of filePath or dataBase64 is required";

  function catchFacadeError(run: () => void): FacadeError {
    try {
      run();
    } catch (error) {
      expect(error, "the rule must throw FacadeError").toBeInstanceOf(FacadeError);
      return error as FacadeError;
    }
    throw new Error("expected validateFontUploadSource to throw, but it returned");
  }

  it("throws the exact shared INVALID_PARAMS message when both sources are missing", () => {
    const error = catchFacadeError(() => validateFontUploadSource({}));
    expect(error.code).toBe("INVALID_PARAMS");
    expect(error.message).toBe(EXPECTED_MESSAGE);
  });

  it("throws the exact shared INVALID_PARAMS message when both sources are given", () => {
    const error = catchFacadeError(() =>
      validateFontUploadSource({ filePath: "/media/fonts/a.ttf", dataBase64: "AAAA" }),
    );
    expect(error.code).toBe("INVALID_PARAMS");
    expect(error.message).toBe(EXPECTED_MESSAGE);
  });

  it("returns without throwing when exactly one source is given (each side)", () => {
    expect(() => validateFontUploadSource({ filePath: "/media/fonts/a.ttf" })).not.toThrow();
    expect(() => validateFontUploadSource({ dataBase64: "AAAA" })).not.toThrow();
  });
});
