import { useChineseReviewLocale } from "../../../test/review-locale";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderReviewBridge } from "../../../../../desktop/src/shared/folder-review-bridge";
import { isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type { TaskContextHistory } from "../../../../../desktop/src/shared/task-review-context";
import { TaskReviewWorkspace } from "./TaskReviewWorkspace";
import {
  createFakeTaskAgentBridge,
  createFakeTaskContextBridge,
  createFakeTaskReviewBridge,
  type FakeTaskContextBridge,
  type FakeTaskReviewBridge,
} from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  delete (window as { reelterminal?: unknown }).reelterminal;
});

function installBridges(withContext = true): {
  taskReview: FakeTaskReviewBridge;
  taskContext: FakeTaskContextBridge | null;
} {
  const taskReview = createFakeTaskReviewBridge();
  const taskAgent = createFakeTaskAgentBridge();
  const taskContext = withContext ? createFakeTaskContextBridge(taskReview) : null;
  const folderSnapshot = {
    root: "task-root",
    taskId: "task-1",
    name: "任务A",
    revision: 1,
    entries: [],
  };
  const folderReview = {
    open: vi.fn().mockResolvedValue(folderSnapshot),
    refresh: vi.fn().mockResolvedValue(folderSnapshot),
    preview: vi.fn().mockResolvedValue({ kind: "text", text: "" }),
    defaults: vi.fn().mockResolvedValue({ tasksRoot: "X" }),
  } as unknown as FolderReviewBridge;
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      taskReview,
      taskAgent,
      folderReview,
      ...(taskContext ? { taskReviewContext: taskContext } : {}),
    },
  });
  return { taskReview, taskContext };
}

const importUnits = async (taskReview: FakeTaskReviewBridge) => {
  await screen.findByTestId("task-review-progress");
  fireEvent.click(screen.getByTestId("spotlight-flip-btn"));
  fireEvent.click(screen.getByTestId("task-review-launcher-overview"));
  fireEvent.click(screen.getByTestId("task-review-show-import"));
  fireEvent.change(await screen.findByLabelText("原文名称"), {
    target: { value: "第一集台词" },
  });
  fireEvent.change(screen.getByLabelText("粘贴文本内容"), {
    target: { value: "第一句台词\n第二句台词\n第三句台词" },
  });
  fireEvent.click(screen.getByTestId("task-review-import-text"));
  await waitFor(() => expect(taskReview.snapshotState().units).toHaveLength(3));
  await screen.findAllByTestId("task-review-unit-row");
};

const openUnit = async (ordinal: number) => {
  fireEvent.click(screen.getAllByTestId("task-review-unit-row")[ordinal - 1]);
  await screen.findByTestId("task-review-unit-scene");
};

/** 单元批注在工具卡的「批注」短标签后面。 */
const openNoteTab = () => {
  fireEvent.click(screen.getByRole("button", { name: "批注" }));
  return screen.findByTestId("task-review-unit-note") as Promise<HTMLTextAreaElement>;
};

const openGlobal = () => {
  fireEvent.click(screen.getByTestId("spotlight-flip-btn"));
  fireEvent.click(screen.getByTestId("task-review-launcher-overview"));
  expect(screen.getByTestId("task-review-global-scene")).toBeTruthy();
};

/** Seeds one agent understanding proposal with an exact quote of unit `index`. */
function seedProposal(
  taskReview: FakeTaskReviewBridge,
  options: { stalePolicy?: boolean } = {},
): void {
  taskReview.mutateState((state) => {
    const unit = state.units.filter(isTextTaskUnit)[0]!;
    const history: TaskContextHistory = state.contextHistory ?? {
      taskId: state.taskId,
      proposals: [],
      adoptions: [],
      criteriaVersions: [],
      criteriaActions: [],
    };
    history.proposals.push({
      id: "proposal-1",
      taskId: state.taskId,
      content: {
        groundedClaims: ["台词年份与固定设定年份矛盾", "第二条有据观察"],
        hypotheses: ["正片设定以固定口径为准"],
      },
      sourceRefs: [
        {
          unitId: unit.id,
          sourceVersionId: unit.sourceVersionId,
          start: 0,
          end: 4,
          text: unit.text.slice(0, 4),
        },
      ],
      openQuestions: ["该年份口径是否适用于后续集数？"],
      proposedBy: "agent",
      createdAt: 1,
      basedOnPolicyRevision: options.stalePolicy
        ? state.policyRevision - 1
        : state.policyRevision,
    });
    state.contextHistory = history;
    // Seeding simulates an out-of-band writer: bump the revision so the
    // workspace's next refreshSources picks the new state up.
    state.revision++;
  });
}

describe("task context and criteria adoption", () => {
  it("adopts committed feedback as a unit-scoped criterion through an explicit action only", async () => {
    const { taskReview, taskContext } = installBridges();
    render(<TaskReviewWorkspace root="task-root" />);
    await importUnits(taskReview);
    const units = taskReview.snapshotState().units.filter(isTextTaskUnit);

    await openUnit(1);
    fireEvent.change(await openNoteTab(), {
      target: { value: "儿童受众，避免专业术语" },
    });
    fireEvent.click(screen.getByTestId("task-review-decide-kept"));
    await waitFor(() => expect(screen.getByTestId("task-review-decide-kept")).toHaveAttribute("aria-pressed", "true"));

    // Typing and deciding adopted nothing: no implicit criteria.
    expect(taskContext!.calls).toHaveLength(0);

    const toggle = screen.getByTestId("task-review-adopt-criteria-toggle");
    expect(screen.queryByTestId("task-review-adopt-criteria-form")).toBeNull();
    fireEvent.click(toggle);
    const form = screen.getByTestId("task-review-adopt-criteria-form");
    expect((within(form).getByLabelText("口径内容") as HTMLTextAreaElement).value).toBe("儿童受众，避免专业术语");
    // The default scope is the current entry, never the whole task.
    expect((within(form).getByDisplayValue("unit") as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByTestId("task-review-adopt-criteria-content"), {
      target: { value: "儿童受众：避免专业术语与惊吓画面" },
    });
    fireEvent.click(screen.getByTestId("task-review-adopt-criteria-submit"));

    const decision = taskReview.snapshotState().decisions[0]!;
    await waitFor(() => expect(taskContext!.calls).toHaveLength(1));
    expect(taskContext!.calls[0]).toMatchObject({
      method: "adoptCriteria",
      input: {
        root: "task-root",
        taskId: "task-1",
        purpose: "review",
        content: "儿童受众：避免专业术语与惊吓画面",
        scope: {
          kind: "units",
          targets: [{ unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId }],
        },
        origin: { kind: "feedback", decisionId: decision.id },
      },
    });
    const history = taskReview.snapshotState().contextHistory!;
    expect(history.criteriaVersions).toHaveLength(1);
    expect(history.criteriaActions.map((action) => action.kind)).toEqual(["adopt"]);
    // The snapshot updated through the same revision-guarded chain.
    expect(history.criteriaVersions[0]!.origin).toMatchObject({
      kind: "feedback",
      decisionId: decision.id,
      noteSnapshot: "儿童受众，避免专业术语",
    });
    // A units-scoped criterion does not bump the global policy, but the prior
    // decision on the adopted unit no longer matches its basis: needs recheck.
    expect(taskReview.snapshotState().policyRevision).toBe(1);
    await waitFor(() => expect(screen.getByTestId("task-review-needs-recheck").textContent).toContain("需重新确认"));
    expect(screen.queryByTestId("task-review-adopt-criteria-toggle")).toBeNull();
  });

  it("shows the AI understanding with expandable evidence and adopts it only on explicit click", async () => {
    const { taskReview, taskContext } = installBridges();
    render(<TaskReviewWorkspace root="task-root" />);
    await importUnits(taskReview);
    const units = taskReview.snapshotState().units.filter(isTextTaskUnit);
    seedProposal(taskReview);

    await openGlobal();
    // The seeded proposal arrives the way an external writer would: through a
    // source refresh, without resetting the open scene.
    fireEvent.click(screen.getByTestId("task-review-refresh-sources"));
    await waitFor(() =>
      expect(screen.getByTestId("task-review-context-summary").textContent).toContain("AI 提案"),
    );
    const summary = screen.getByTestId("task-review-context-summary");
    expect(summary.textContent).toContain("台词年份与固定设定年份矛盾");
    // Collapsed detail keeps the default review space; expanding is optional.
    expect(screen.getByTestId("task-review-context-detail").textContent).toContain("台词年份与固定设定年份矛盾");
    expect(screen.getByTestId("task-review-context-hypotheses").textContent).toContain("正片设定以固定口径为准");
    expect(screen.getByTestId("task-review-context-questions").textContent).toContain("该年份口径是否适用于后续集数？");
    const evidence = screen.getByTestId("task-review-context-evidence");
    expect(evidence.textContent).toContain(units[0]!.text.slice(0, 4));

    // Browsing the evidence jumps to the unit without adopting anything.
    fireEvent.click(within(evidence).getByRole("button"));
    await screen.findByTestId("task-review-unit-scene");
    expect(taskContext!.calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("task-review-back"));
    await screen.findByTestId("task-review-global-scene");
    fireEvent.click(screen.getByTestId("task-review-adopt-context"));
    await waitFor(() => expect(taskContext!.calls).toHaveLength(1));
    const source = taskReview.snapshotState().sources[0]!;
    expect(taskContext!.calls[0]).toMatchObject({
      method: "adoptContext",
      input: {
        proposalId: "proposal-1",
        authorizedSourceVersionIds: [source.id],
      },
    });
    expect(taskReview.snapshotState().contextHistory!.adoptions).toHaveLength(1);
    await screen.findByTestId("task-review-context-adopted");
    expect(screen.queryByTestId("task-review-adopt-context")).toBeNull();
  });

  it("displays adopted criteria and toggles them through the append-only log", async () => {
    const { taskReview, taskContext } = installBridges();
    render(<TaskReviewWorkspace root="task-root" />);
    await importUnits(taskReview);
    const units = taskReview.snapshotState().units.filter(isTextTaskUnit);
    taskReview.mutateState((state) => {
      const history: TaskContextHistory = {
        taskId: state.taskId,
        proposals: [],
        adoptions: [],
        criteriaVersions: [
          {
            id: "version-1",
            criterionId: "criterion-1",
            taskId: state.taskId,
            content: "儿童受众：避免专业术语",
            scope: {
              kind: "units",
              targets: [{ unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId }],
            },
            purpose: "review",
            origin: { kind: "explicit", text: "明确输入的口径" },
            acceptedBy: "human",
            acceptedSourceVersionIds: [],
            createdAt: 1,
          },
        ],
        criteriaActions: [
          { id: "action-1", versionId: "version-1", kind: "adopt", acceptedBy: "human", createdAt: 2 },
        ],
      };
      state.contextHistory = history;
      state.revision++;
    });

    await openGlobal();
    fireEvent.click(screen.getByTestId("task-review-refresh-sources"));
    const criterion = await waitFor(() => {
      const element = screen.getByTestId("task-review-criterion");
      expect(element).toBeTruthy();
      return element;
    });
    expect(criterion.getAttribute("data-active")).toBe("true");
    expect(criterion.textContent).toContain("儿童受众：避免专业术语");
    expect(criterion.textContent).toContain("指定条目：#1");
    expect(criterion.textContent).toContain("明确输入的口径");

    fireEvent.click(screen.getByTestId("task-review-criterion-toggle"));
    await waitFor(() =>
      expect(taskContext!.calls.at(-1)).toMatchObject({
        method: "setCriterionActive",
        input: { versionId: "version-1", active: false },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("task-review-criterion").getAttribute("data-active")).toBe("false"));
    expect(taskReview.snapshotState().contextHistory!.criteriaActions).toHaveLength(2);

    fireEvent.click(screen.getByTestId("task-review-criterion-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("task-review-criterion").getAttribute("data-active")).toBe("true"),
    );
    expect(taskReview.snapshotState().contextHistory!.criteriaActions.map((action) => action.kind)).toEqual([
      "adopt",
      "deactivate",
      "reactivate",
    ]);
  });

  it("disables context adoption when the proposal is based on an older policy", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" />);
    await importUnits(taskReview);
    seedProposal(taskReview, { stalePolicy: true });
    await openGlobal();
    fireEvent.click(screen.getByTestId("task-review-refresh-sources"));
    const button = (await screen.findByTestId("task-review-adopt-context")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("较早的任务口径");
  });

  it("reports a missing context channel instead of faking adoption", async () => {
    const { taskReview, taskContext } = installBridges(false);
    expect(taskContext).toBeNull();
    render(<TaskReviewWorkspace root="task-root" />);
    await importUnits(taskReview);
    seedProposal(taskReview);

    await openGlobal();
    expect(screen.getByTestId("task-review-context-unavailable").textContent).toContain("只读");
    expect(screen.queryByTestId("task-review-adopt-context")).toBeNull();

    // The unit scene hides the feedback-adoption entry on the same shells.
    await openUnit(1);
    fireEvent.change(await openNoteTab(), {
      target: { value: "有备注的决定" },
    });
    fireEvent.click(screen.getByTestId("task-review-decide-kept"));
    await waitFor(() => expect(screen.getByTestId("task-review-decide-kept")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByTestId("task-review-adopt-criteria-toggle")).toBeNull();
  });
});

useChineseReviewLocale();
