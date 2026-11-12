import type {
  TaskReviewSnapshot,
  TaskTextFormat,
} from "../../../../../desktop/src/shared/task-review";
import { isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type { TaskContextHistory, TaskCriteriaVersion } from "../../../../../desktop/src/shared/task-review-context";
import type { TaskReviewBridge, TaskReviewContextBridge } from "../../../../../desktop/src/shared/task-review-bridge";
import { selectTaskDecisionHistory } from "../../../../../desktop/src/shared/task-review-selectors";
import type {
  TaskAgentBridge,
  TaskAgentGrant,
  TaskAgentJob,
  TaskAgentState,
  TaskCompletionEvent,
  TaskSemanticSearchResult,
} from "../../../../../desktop/src/shared/task-review-runtime-types";

/**
 * In-memory fakes mirroring the desktop-main store semantics that the UI
 * depends on: revision-checked commits, the applied decision stack with
 * undo/redo, drafts, and export artifacts. For component tests only; no
 * model is called.
 */

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function emptySnapshot(root = "task-root"): TaskReviewSnapshot {
  return {
    root,
    taskId: "task-1",
    revision: 0,
    policyRevision: 0,
    goal: "",
    sources: [],
    sourceFiles: [],
    units: [],
    decisions: [],
    decisionActions: [],
    drafts: [],
    issues: [],
    planRevisions: [],
    history: [],
    artifacts: [],
  };
}

let unitCounter = 0;

function parseText(text: string): { text: string; ordinal: number }[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .flatMap((line, index) => (line.trim() ? [{ text: line, ordinal: index + 1 }] : []));
}

export interface FakeTaskReviewBridge extends TaskReviewBridge {
  calls: { method: string; input: unknown }[];
  /** Test-side mutation of the persisted state (simulates AI publication). */
  mutateState(update: (state: TaskReviewSnapshot) => void): void;
  snapshotState(): TaskReviewSnapshot;
  failNext(method: string, message: string): void;
}

export function createFakeTaskReviewBridge(
  initial?: Partial<TaskReviewSnapshot>,
): FakeTaskReviewBridge {
  let state = { ...emptySnapshot(), ...initial };
  const calls: { method: string; input: unknown }[] = [];
  const failures = new Map<string, string>();
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const commit = (
    input: { expectedRevision: number },
    method: string,
    mutate: (state: TaskReviewSnapshot) => void,
    skipUnchanged = false,
  ): TaskReviewSnapshot => {
    record(method, input);
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw new Error(failure);
    }
    if (state.revision !== input.expectedRevision)
      throw new Error(
        `Revision conflict: expected ${input.expectedRevision}, current ${state.revision}`,
      );
    const before = skipUnchanged ? clone(state) : undefined;
    mutate(state);
    if (skipUnchanged && JSON.stringify(before) === JSON.stringify(state)) return clone(state);
    state.revision++;
    return clone(state);
  };
  const addSource = (
    draft: TaskReviewSnapshot,
    entryId: string,
    relativePath: string,
    text: string,
    format: TaskTextFormat,
  ) => {
    const source = {
      id: `source-${draft.sources.length + 1}`,
      entryId,
      relativePath,
      hash: `hash-${draft.sources.length + 1}`,
      format,
      text,
      createdAt: Date.now(),
    };
    draft.sources.push(source);
    draft.units.push(
      ...parseText(text).map((parsed) => ({
        id: `unit-${++unitCounter}`,
        sourceVersionId: source.id,
        ordinal: parsed.ordinal,
        text: parsed.text,
        startLine: parsed.ordinal,
        endLine: parsed.ordinal,
      })),
    );
    draft.sourceFiles = draft.sourceFiles.filter((file) => file.entryId !== entryId);
    draft.sourceFiles.push({
      entryId,
      relativePath,
      size: text.length,
      mtimeMs: 1,
      currentVersionId: source.id,
      status: "available",
    });
    draft.sourceFiles.sort((a, b) => a.entryId.localeCompare(b.entryId));
    draft.policyRevision++;
  };
  const changeDecisionHistory = (
    kind: "undo" | "redo",
    input: Parameters<TaskReviewBridge["undoDecision"]>[0],
  ): TaskReviewSnapshot =>
    commit(input, kind === "undo" ? "undoDecision" : "redoDecision", (draft) => {
      if (input.policyRevision !== draft.policyRevision)
        throw new Error("Decision policy is no longer current");
      const history = selectTaskDecisionHistory(draft, {
        unitId: input.unitId,
        sourceVersionId: input.sourceVersionId,
        purpose: input.purpose,
      });
      const eligible = kind === "undo" ? history.undo : history.redo;
      if (eligible?.id !== input.decisionId)
        throw new Error(`Decision is not available for ${kind}`);
      draft.decisionActions.push({
        id: `action-${draft.decisionActions.length + 1}`,
        kind,
        decisionId: input.decisionId,
        createdAt: Date.now(),
      });
    });
  const bridge: FakeTaskReviewBridge = {
    calls,
    mutateState: (update) => {
      update(state);
      state = clone(state);
    },
    snapshotState: () => clone(state),
    failNext: (method, message) => failures.set(method, message),
    open: async (root) => {
      record("open", { root });
      return clone({ ...state, root });
    },
    refreshSources: async (input) =>
      commit(
        input,
        "refreshSources",
        (draft) => {
          // Minimal reconciliation: files stay as imported; tests inject
          // missing/invalid states through mutateState.
          void draft;
        },
        true,
      ),
    setGoal: async (input) =>
      commit(
        input,
        "setGoal",
        (draft) => {
          if (draft.goal === input.goal) return;
          draft.goal = input.goal;
          draft.policyRevision++;
        },
        true,
      ),
    importText: async (input) =>
      commit(input, "importText", (draft) => {
        addSource(
          draft,
          `entry-${draft.sources.length + 1}`,
          `${input.name}.${input.format}`,
          input.text,
          input.format,
        );
      }),
    importFile: async (input) =>
      commit(input, "importFile", (draft) => {
        if (!draft.sources.some((source) => source.entryId === input.entryId))
          addSource(
            draft,
            input.entryId,
            `folder-${input.entryId}.txt`,
            "Imported file content\nSecond line",
            "txt",
          );
      }),
    decide: async (input) =>
      commit(input, "decide", (draft) => {
        if (input.replacementText !== undefined && !input.replacementText.trim())
          throw new Error("Replacement text must not be empty");
        const id = `decision-${draft.decisions.length + 1}`;
        draft.decisions.push({
          id,
          unitId: input.unitId,
          sourceVersionId: input.sourceVersionId,
          policyRevision: draft.policyRevision,
          purpose: input.purpose,
          status: input.status,
          note: input.note,
          ...(input.replacementText !== undefined
            ? { replacementText: input.replacementText }
            : {}),
          createdAt: Date.now(),
        });
        draft.decisionActions.push({
          id: `action-${draft.decisionActions.length + 1}`,
          kind: "decide",
          decisionId: id,
          createdAt: Date.now(),
        });
      }),
    decideBatch: async (input) => ({
      ...commit(input, "decideBatch", (draft) => {
        const decisionIds: string[] = [];
        const targets = input.pendingOnly ? input.targets.filter((target) => !selectTaskDecisionHistory(draft, { ...target, purpose: input.purpose }).current) : input.targets;
        for (const target of targets) {
          draft.decisions.push({
            id: target.decisionId,
            unitId: target.unitId,
            sourceVersionId: target.sourceVersionId,
            policyRevision: draft.policyRevision,
            purpose: input.purpose,
            status: input.status,
            note: input.note,
            createdAt: Date.now(),
          });
          draft.decisionActions.push({ id: `action-${draft.decisionActions.length + 1}`, kind: "decide", decisionId: target.decisionId, createdAt: Date.now() });
          decisionIds.push(target.decisionId);
        }
        draft.decisionBatches ??= [];
        draft.decisionBatches.push({ id: input.batchId, decisionIds });
      }),
      decisionReceipt: { decisionId: input.batchId, outcome: "committed" as const },
    }),
    undoDecisionBatch: async (input) => commit(input, "undoDecisionBatch", (draft) => {
      const batch = draft.decisionBatches?.find((item) => item.id === input.batchId);
      if (!batch) throw new Error("Decision batch not found");
      for (const decisionId of batch.decisionIds) {
        const decision = draft.decisions.find((item) => item.id === decisionId);
        if (!decision) throw new Error("Decision batch member not found");
        const history = selectTaskDecisionHistory(draft, { unitId: decision.unitId, sourceVersionId: decision.sourceVersionId, purpose: decision.purpose });
        if (history.undo?.id !== decisionId) throw new Error("Decision batch is not eligible for undo");
        draft.decisionActions.push({ id: `action-${draft.decisionActions.length + 1}`, kind: "undo", decisionId, createdAt: Date.now() });
      }
    }),
    redoDecisionBatch: async (input) => commit(input, "redoDecisionBatch", (draft) => {
      const batch = draft.decisionBatches?.find((item) => item.id === input.batchId);
      if (!batch) throw new Error("Decision batch not found");
      for (const decisionId of batch.decisionIds) {
        const decision = draft.decisions.find((item) => item.id === decisionId);
        if (!decision) throw new Error("Decision batch member not found");
        const history = selectTaskDecisionHistory(draft, { unitId: decision.unitId, sourceVersionId: decision.sourceVersionId, purpose: decision.purpose });
        if (history.redo?.id !== decisionId) throw new Error("Decision batch is not eligible for redo");
        draft.decisionActions.push({ id: `action-${draft.decisionActions.length + 1}`, kind: "redo", decisionId, createdAt: Date.now() });
      }
    }),
    undoDecision: async (input) => changeDecisionHistory("undo", input),
    redoDecision: async (input) => changeDecisionHistory("redo", input),
    saveDraft: async (input) =>
      commit(input, "saveDraft", (draft) => {
        draft.drafts = draft.drafts.filter((item) => item.unitId !== input.draft.unitId);
        draft.drafts.push({ ...input.draft, updatedAt: Date.now() });
      }),
    visit: async (input) =>
      commit(input, "visit", (draft) => {
        draft.history.push({
          id: `visit-${draft.history.length + 1}`,
          unitId: input.unitId,
          sourceVersionId: input.sourceVersionId,
          purpose: input.purpose,
          createdAt: Date.now(),
        });
      }),
    publishAnalysis: async (input) =>
      commit(input, "publishAnalysis", (draft) => {
        if (draft.policyRevision !== input.expectedPolicyRevision)
          throw new Error("Task policy changed during analysis");
        draft.issues = [
          ...draft.issues.filter(
            (issue) => !input.sourceVersionIds.includes(issue.sourceVersionId),
          ),
          ...input.issues,
        ];
        draft.planRevisions.push({
          id: `plan-${draft.planRevisions.length + 1}`,
          policyRevision: draft.policyRevision,
          createdAt: Date.now(),
          steps: input.steps,
          reason: input.reason,
        });
      }),
    exportSource: async (input) =>
      commit(input, "exportSource", (draft) => {
        const units = draft.units
          .filter(isTextTaskUnit)
          .filter((unit) => unit.sourceVersionId === input.sourceVersionId)
          .flatMap((unit) => {
            const decision = selectTaskDecisionHistory(draft, {
              unitId: unit.id,
              sourceVersionId: unit.sourceVersionId,
              purpose: input.purpose,
            }).current;
            return decision?.status === "kept"
              ? [{ ...unit, text: decision.replacementText ?? unit.text }]
              : [];
          });
        if (!units.length) throw new Error("No approved review units for this purpose");
        const relativePath = `result-${draft.artifacts.length + 1}.txt`;
        draft.artifacts.push({
          id: `artifact-${draft.artifacts.length + 1}`,
          relativePath,
          manifestRelativePath: `${relativePath}.review.json`,
          sourceVersionId: input.sourceVersionId,
          unitIds: units.map((unit) => unit.id),
          purpose: input.purpose,
          status: "complete",
          createdAt: Date.now(),
        });
      }),
  };
  return bridge;
}

export interface FakeTaskContextBridge extends TaskReviewContextBridge {
  calls: { method: string; input: unknown }[];
}

/**
 * In-memory fake of the task-context channel over the fake task store: the
 * same revision guard, feedback provenance, append-only adoption log and the
 * policy bump that real main applies for task-scoped criteria.
 */
export function createFakeTaskContextBridge(host: FakeTaskReviewBridge): FakeTaskContextBridge {
  const calls: { method: string; input: unknown }[] = [];
  const commit = async <T extends { expectedRevision: number }>(
    method: string,
    input: T,
    mutate: (state: TaskReviewSnapshot, history: TaskContextHistory, input: T) => void,
  ): Promise<TaskReviewSnapshot> => {
    calls.push({ method, input });
    host.mutateState((state) => {
      if (state.revision !== input.expectedRevision)
        throw new Error(`Revision conflict: expected ${input.expectedRevision}, current ${state.revision}`);
      state.contextHistory ??= {
        taskId: state.taskId,
        proposals: [],
        adoptions: [],
        criteriaVersions: [],
        criteriaActions: [],
      };
      mutate(state, state.contextHistory, input);
      state.revision++;
    });
    return host.snapshotState();
  };
  const replay = (history: TaskContextHistory): Map<string, { versionId: string; active: boolean }> => {
    const versions = new Map(history.criteriaVersions.map((version) => [version.id, version]));
    const states = new Map<string, { versionId: string; active: boolean }>();
    for (const action of history.criteriaActions) {
      const version = versions.get(action.versionId);
      if (!version) continue;
      if (action.kind === "adopt") states.set(version.criterionId, { versionId: version.id, active: true });
      else if (states.get(version.criterionId)?.versionId === action.versionId)
        states.set(version.criterionId, { versionId: version.id, active: action.kind === "reactivate" });
    }
    return states;
  };
  return {
    calls,
    proposeContext: async (input) =>
      commit("proposeContext", input, (state, history) => {
        history.proposals.push({
          ...input.proposal,
          id: crypto.randomUUID(),
          taskId: state.taskId,
          createdAt: Date.now(),
          basedOnPolicyRevision: state.policyRevision,
        });
      }),
    adoptContext: async (input) =>
      commit("adoptContext", input, (_state, history) => {
        if (!history.proposals.some((proposal) => proposal.id === input.proposalId))
          throw new Error("Context proposal does not exist");
        history.adoptions.push({
          id: crypto.randomUUID(),
          proposalId: input.proposalId,
          acceptedBy: "human",
          createdAt: Date.now(),
        });
      }),
    adoptCriteria: async (input) =>
      commit("adoptCriteria", input, (state, history, args) => {
        const requestedOrigin: Parameters<TaskReviewContextBridge["adoptCriteria"]>[0]["origin"] = args.origin;
        const requestedScope: Parameters<TaskReviewContextBridge["adoptCriteria"]>[0]["scope"] = args.scope;
        let origin: TaskCriteriaVersion["origin"];
        if (requestedOrigin.kind === "feedback") {
          const decision = state.decisions.find((item) => item.id === requestedOrigin.decisionId);
          if (!decision || !decision.note.trim())
            throw new Error("Feedback must be a current human decision with a nonempty note");
          if (requestedScope.kind === "units" &&
            !requestedScope.targets.some((target) => target.unitId === decision.unitId && target.sourceVersionId === decision.sourceVersionId))
            throw new Error("Feedback origin must be within the adopted scope");
          origin = {
            kind: "feedback",
            decisionId: decision.id,
            noteSnapshot: decision.note,
            unitId: decision.unitId,
            sourceVersionId: decision.sourceVersionId,
            policyRevision: decision.policyRevision,
          };
        } else origin = requestedOrigin;
        const version: TaskCriteriaVersion = {
          id: crypto.randomUUID(),
          criterionId: args.criterionId ?? crypto.randomUUID(),
          taskId: state.taskId,
          ...(args.supersedesId ? { supersedesId: args.supersedesId } : {}),
          content: args.content,
          scope: requestedScope,
          purpose: args.purpose,
          origin,
          acceptedBy: "human",
          acceptedSourceVersionIds: [],
          createdAt: Date.now(),
        };
        history.criteriaVersions.push(version);
        history.criteriaActions.push({
          id: crypto.randomUUID(),
          versionId: version.id,
          kind: "adopt",
          acceptedBy: "human",
          createdAt: Date.now(),
        });
        if (requestedScope.kind === "task") state.policyRevision++;
      }),
    setCriterionActive: async (input) =>
      commit("setCriterionActive", input, (_state, history) => {
        const current = [...replay(history).values()].find((state) => state.versionId === input.versionId);
        if (!current || current.active === input.active)
          throw new Error("Criteria version is not eligible for activation change");
        history.criteriaActions.push({
          id: crypto.randomUUID(),
          versionId: input.versionId,
          kind: input.active ? "reactivate" : "deactivate",
          acceptedBy: "human",
          createdAt: Date.now(),
        });
      }),
  };
}

export interface FakeTaskAgentBridge extends TaskAgentBridge {
  emit(event: TaskCompletionEvent): void;
  setJobs(jobs: TaskAgentJob[]): void;
  setGrant(grant: TaskAgentGrant | undefined): void;
  /** Canned semantic-search result returned by search(). */
  searchResult: TaskSemanticSearchResult;
  /** Recorded complete() requests, newest last. */
  completeRequests: { generationId: string; text: string }[];
}

/** Builds a job row for coverage/job-list assertions. */
export const fakeJob = (
  id: string,
  status: TaskAgentJob["status"],
  unitIds: string[],
  extra: Partial<TaskAgentJob> = {},
): TaskAgentJob => ({
  id,
  taskId: "task-1",
  key: id,
  sourceVersionIds: ["source-1"],
  unitIds,
  policyRevision: 1,
  status,
  attempts: 1,
  completedUnitIds: status === "completed" ? unitIds : [],
  maxOutputTokens: 20000,
  reservedOutputTokens: 0,
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

export function createFakeTaskAgentBridge(): FakeTaskAgentBridge {
  let grant: TaskAgentGrant | undefined;
  let jobs: TaskAgentJob[] = [];
  const listeners = new Set<(event: TaskCompletionEvent) => void>();
  const completeRequests: { generationId: string; text: string }[] = [];
  let searchResult: TaskSemanticSearchResult = { matches: [], searchedUnitCount: 0 };
  const state = (): TaskAgentState => clone({ grant, jobs });
  const bridge: FakeTaskAgentBridge = {
    emit: (event) => {
      for (const listener of listeners) listener(clone(event));
    },
    setJobs: (next) => {
      jobs = clone(next);
    },
    setGrant: (next) => {
      grant = clone(next);
    },
    completeRequests,
    get searchResult() {
      return searchResult;
    },
    set searchResult(value) {
      searchResult = clone(value);
    },
    getModelConfig: async () => ({
      endpoint: "https://model.example.com/v1",
      backgroundModel: "review-model",
      completionModel: "writer-model",
      hasApiKey: true,
    }),
    configureModel: async (input) => ({
      endpoint: input.endpoint,
      backgroundModel: input.backgroundModel,
      completionModel: input.completionModel,
      hasApiKey: true,
    }),
    authorize: async (input) => {
      void input;
      grant = {
        taskId: "task-1",
        scope: "task",
        sourceEntryIds: [],
        endpoint: "https://model.example.com/v1",
        createdAt: Date.now(),
      };
      return state();
    },
    revoke: async () => {
      grant = undefined;
      jobs = jobs.map((item) =>
        ["queued", "running", "interrupted"].includes(item.status)
          ? { ...item, status: "cancelled" as const }
          : item,
      );
      return state();
    },
    getState: async () => state(),
    startPreflight: async () => state(),
    continueAnalysis: async () => state(),
    cancelSearch: async () => undefined,
    cancelJob: async (input) => {
      void input;
      return state();
    },
    retryJob: async (input) => {
      void input;
      return state();
    },
    search: async (input) => {
      void input;
      return clone(searchResult);
    },
    complete: async (input) => {
      completeRequests.push({ generationId: input.generationId, text: input.text });
    },
    cancelCompletion: async () => undefined,
    onCompletion: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return bridge;
}

export const grantFor = (endpoint = "https://model.example.com/v1"): TaskAgentGrant => ({
  taskId: "task-1",
  scope: "task",
  sourceEntryIds: [],
  endpoint,
  createdAt: 1,
});
