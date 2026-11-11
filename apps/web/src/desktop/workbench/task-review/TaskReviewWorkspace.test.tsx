import { useChineseReviewLocale } from "../../../test/review-locale";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderReviewBridge } from "../../../../../desktop/src/shared/folder-review-bridge";
import type { TaskSceneSuggestion } from "../../../../../desktop/src/shared/task-review";
import type { TaskOriginalExportRecord, TaskReviewExportBridge } from "../../../../../desktop/src/shared/task-review-export";
import { TaskReviewWorkspace } from "./TaskReviewWorkspace";
import {
  createFakeTaskAgentBridge,
  createFakeTaskContextBridge,
  createFakeTaskReviewBridge,
  fakeJob,
  grantFor,
} from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  delete (window as { reelterminal?: unknown }).reelterminal;
});

function installBridges() {
  const taskReview = createFakeTaskReviewBridge();
  const taskAgent = createFakeTaskAgentBridge();
  const folderSnapshot = {
    root: "task-root",
    taskId: "task-1",
    name: "任务A",
    revision: 1,
    entries: [
      {
        id: "folder-entry-1",
        relativePath: "素材01.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
    ],
  };
  const folderReviewMocks = {
    open: vi.fn().mockResolvedValue(folderSnapshot),
    refresh: vi.fn().mockResolvedValue(folderSnapshot),
    preview: vi.fn().mockResolvedValue({ kind: "text", text: "" }),
    defaults: vi.fn().mockResolvedValue({ tasksRoot: "X" }),
  };
  const folderReview =
    folderReviewMocks as unknown as FolderReviewBridge;
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: { taskReview, taskAgent, folderReview },
  });
  return { taskReview, taskAgent, folderReview: folderReviewMocks };
}

/** 打开聚光灯卡的九宫格面，再点某个启动盘入口。 */
const openLauncher = () => {
  fireEvent.click(screen.getByTestId("spotlight-flip-btn"));
};
const launchOverview = async () => {
  openLauncher();
  fireEvent.click(screen.getByTestId("task-review-launcher-overview"));
  await screen.findByTestId("task-review-global-scene");
};

const importThreeUnits = async (
  taskReview: ReturnType<typeof createFakeTaskReviewBridge>,
) => {
  // Wait until the task snapshot has loaded before navigating scenes.
  await screen.findByTestId("task-review-revision");
  await launchOverview();
  fireEvent.click(screen.getByTestId("task-review-show-import"));
  fireEvent.change(await screen.findByLabelText("原文名称"), {
    target: { value: "第一集台词" },
  });
  fireEvent.change(screen.getByLabelText("粘贴文本内容"), {
    target: { value: "第一句台词\n第二句台词\n第三句台词" },
  });
  fireEvent.click(screen.getByTestId("task-review-import-text"));
  await waitFor(() =>
    expect(taskReview.snapshotState().units).toHaveLength(3),
  );
  await screen.findAllByTestId("task-review-unit-row");
};

/** 单元批注在工具卡的「批注」短标签后面。 */
const openNoteTab = () => {
  fireEvent.click(screen.getByRole("button", { name: "批注" }));
  return screen.findByTestId("task-review-unit-note") as Promise<HTMLTextAreaElement>;
};

const openUnit = async (ordinal: number) => {
  fireEvent.click(
    screen.getAllByTestId("task-review-unit-row")[ordinal - 1],
  );
  await screen.findByTestId("task-review-unit-scene");
};

function installSceneTask(kind: "compare" | "lowRiskGroup") {
  const bridges = installBridges();
  const taskId = crypto.randomUUID();
  const sourceVersionId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const units = ["A", "B", "C", "D"].map((text, index) => ({ id: crypto.randomUUID(), sourceVersionId, ordinal: index + 1, text: `${text}的原文`, startLine: index + 1, endLine: index + 1 }));
  const scene = (id: string, members: typeof units, sceneKind: TaskSceneSuggestion["kind"]): TaskSceneSuggestion => ({
    id, kind: sceneKind, targets: members.map(({ id: unitId }) => ({ unitId, sourceVersionId })), purpose: "review", decisionMode: "per-unit",
    checkIntent: sceneKind === "compare" ? "检查关联事实" : "完整扫阅", reason: "按目标编排", issueIds: [], criteriaRefs: [],
    sourceRefs: members.map((unit) => ({ unitId: unit.id, sourceVersionId, start: 0, end: 1, text: unit.text[0]! })),
    criteriaBasis: members.map((unit) => ({ taskId, unitId: unit.id, sourceVersionId, purpose: "review", policyRevision: 0, criteriaVersionIds: [] })),
  });
  const scenes = [scene("working-scene", units.slice(0, 2), kind), scene("future-c", [units[2]!], "single"), scene("future-d", [units[3]!], "single")];
  bridges.taskReview.mutateState((state) => {
    state.taskId = taskId;
    state.sources = [{ id: sourceVersionId, entryId, relativePath: "source.txt", hash: "h", format: "txt", text: units.map((unit) => unit.text).join("\n"), createdAt: 1 }];
    state.sourceFiles = [{ entryId, relativePath: "source.txt", size: 1, mtimeMs: 1, currentVersionId: sourceVersionId, status: "available" }];
    state.units = units;
    state.planRevisions = [{ id: "formal-plan", policyRevision: 0, createdAt: 1, reason: "正式场景", steps: [], scenes }];
  });
  bridges.taskAgent.setJobs([{ ...fakeJob("coverage", "completed", units.map((unit) => unit.id)), taskId, sourceVersionIds: [sourceVersionId], policyRevision: 0 }]);
  return { ...bridges, units, scenes, taskId, sourceVersionId };
}

describe("task review workspace", () => {
  it.each([false, true])("goal save completion preserves later navigation: %s", async (navigate) => {
    const { taskReview } = installBridges();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const original = taskReview.setGoal.bind(taskReview);
    const save = vi.spyOn(taskReview, "setGoal").mockImplementation(async (input) => {
      await pending;
      return original(input);
    });
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-show-goal"));
    fireEvent.change(screen.getByRole("textbox", { name: "任务目标口径" }), { target: { value: "Saved goal" } });
    fireEvent.click(screen.getByRole("button", { name: "保存目标口径" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    if (navigate) {
      fireEvent.click(screen.getByTestId("task-review-show-import"));
      fireEvent.change(screen.getByLabelText("原文名称"), { target: { value: "Pending source" } });
      fireEvent.change(screen.getByLabelText("粘贴文本内容"), { target: { value: "Unsaved source draft" } });
      expect(screen.getByTestId("task-review-import-editor")).toBeVisible();
    }
    await act(async () => { finish(); });
    await waitFor(() => expect(taskReview.snapshotState().goal).toBe("Saved goal"));
    expect(screen.getByTestId("task-review-goal-editor")).not.toBeVisible();
    expect(screen.getByTestId("task-review-show-goal")).toHaveAttribute("aria-expanded", "false");
    if (navigate) {
      expect(screen.getByTestId("task-review-import-editor")).toBeVisible();
      expect(screen.getByTestId("task-review-show-import")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByLabelText("原文名称")).toHaveValue("Pending source");
      expect(screen.getByLabelText("粘贴文本内容")).toHaveValue("Unsaved source draft");
    } else expect(screen.getByTestId("task-review-import-editor")).not.toBeVisible();
  });

  it.each([false, true])("text import completion preserves later navigation: %s", async (navigate) => {
    const { taskReview } = installBridges();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const original = taskReview.importText.bind(taskReview);
    const save = vi.spyOn(taskReview, "importText").mockImplementation(async (input) => {
      await pending;
      return original(input);
    });
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-show-import"));
    fireEvent.change(screen.getByLabelText("原文名称"), { target: { value: "Saved source" } });
    fireEvent.change(screen.getByLabelText("粘贴文本内容"), { target: { value: "Imported line" } });
    fireEvent.click(screen.getByTestId("task-review-import-text"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    if (navigate) {
      fireEvent.click(screen.getByTestId("task-review-show-goal"));
      fireEvent.change(screen.getByRole("textbox", { name: "任务目标口径" }), { target: { value: "Unsaved goal draft" } });
      expect(screen.getByTestId("task-review-goal-editor")).toBeVisible();
    }
    await act(async () => { finish(); });
    await waitFor(() => expect(taskReview.snapshotState().units).toHaveLength(1));
    expect(taskReview.snapshotState().units[0]).toMatchObject({ text: "Imported line" });
    expect(screen.getByTestId("task-review-import-editor")).not.toBeVisible();
    expect(screen.getByTestId("task-review-show-import")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("原文名称")).toHaveValue("");
    expect(screen.getByLabelText("粘贴文本内容")).toHaveValue("");
    if (navigate) {
      expect(screen.getByTestId("task-review-goal-editor")).toBeVisible();
      expect(screen.getByTestId("task-review-show-goal")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("textbox", { name: "任务目标口径" })).toHaveValue("Unsaved goal draft");
      expect(taskReview.snapshotState().goal).not.toBe("Unsaved goal draft");
    } else expect(screen.getByTestId("task-review-goal-editor")).not.toBeVisible();
  });

  it("waits for the task snapshot before the first browse action while the progress header is already visible", async () => {
    const { taskReview } = installSceneTask("compare");
    let finish!: (snapshot: ReturnType<typeof taskReview.snapshotState>) => void;
    const loading = new Promise<ReturnType<typeof taskReview.snapshotState>>((resolve) => { finish = resolve; });
    vi.spyOn(taskReview, "open").mockReturnValueOnce(loading);
    render(<TaskReviewWorkspace root="task-root" />);
    expect(screen.getByTestId("task-review-progress")).toBeInTheDocument();
    expect(screen.getByTestId("task-review-continue")).toBeDisabled();
    fireEvent.click(screen.getByTestId("task-review-continue"));
    expect(screen.queryByTestId("task-review-agent-scene")).toBeNull();
    await act(async () => { finish(taskReview.snapshotState()); });
    await screen.findByTestId("task-review-revision");
    expect(screen.getByTestId("task-review-continue")).toBeEnabled();
    fireEvent.click(screen.getByTestId("task-review-continue"));
    expect(await screen.findByTestId("task-review-agent-scene")).toHaveAttribute("data-scene-id", "working-scene");
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
  });

  it("starts a compare at its current highest-risk target and restores a later human focus choice on Back", async () => {
    const { taskReview, taskId, sourceVersionId, units } = installSceneTask("compare");
    taskReview.mutateState((state) => state.issues.push({ id: "risk-b", unitId: units[1]!.id, sourceVersionId, policyRevision: 0, purpose: "review", severity: "high", title: "先核对B", evidence: "B", hypothesis: "需核实", options: [], inputSourceVersionIds: [sourceVersionId], criteriaBasis: [{ taskId, unitId: units[1]!.id, sourceVersionId, purpose: "review", policyRevision: 0, criteriaVersionIds: [] }] }));
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    expect(screen.getAllByTestId("task-review-scene-focus")[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getAllByTestId("task-review-scene-focus")[0]!);
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-back"));
    expect(screen.getAllByTestId("task-review-scene-focus")[0]).toHaveAttribute("aria-pressed", "true");
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
  });
  it("does not replace the user's global scene when a previously requested media import finishes late", async () => {
    const { taskReview, folderReview } = installBridges();
    const folder = { root: "task-root", taskId: "task-1", name: "任务A", revision: 1, entries: [{ id: "picture", relativePath: "fish.png", kind: "file" as const, size: 10, mtimeMs: 1, review: { status: "pending" as const, note: "" } }] };
    folderReview.open.mockResolvedValue(folder);
    folderReview.refresh.mockResolvedValue(folder);
    let finish!: (snapshot: ReturnType<typeof taskReview.snapshotState>) => void;
    const importFile = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const open = vi.fn();
    Object.defineProperty(window, "reelterminal", { configurable: true, value: { ...window.reelterminal, taskReviewMedia: { importFile, open } } });
    render(<TaskReviewWorkspace root="task-root" />);
    fireEvent.doubleClick(await screen.findByText("fish.png"));
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1));
    await launchOverview();
    taskReview.mutateState((state) => {
      state.revision++;
      state.sources.push({ id: "image-source", entryId: "picture", relativePath: "fish.png", hash: "h", createdAt: 1, kind: "image", mime: "image/png", width: 400, height: 200, durationSec: 0 });
      state.sourceFiles.push({ entryId: "picture", relativePath: "fish.png", size: 10, mtimeMs: 1, currentVersionId: "image-source", status: "available" });
      state.units.push({ id: "image-unit", sourceVersionId: "image-source", ordinal: 1, kind: "image" });
    });
    await act(async () => { finish(taskReview.snapshotState()); });
    expect(screen.getByTestId("task-review-global-scene")).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("task-review-media-scene")).toBeNull();
  });
  it("opens on a concise overview and makes long forms and export separate explicit work areas", async () => {
    installSceneTask("compare");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    await launchOverview();
    expect(screen.getByTestId("task-review-context-brief")).toBeVisible();
    expect(screen.getByTestId("task-review-goal-editor")).not.toBeVisible();
    expect(screen.getByTestId("task-review-import-editor")).not.toBeVisible();
    expect(screen.getByTestId("task-review-model-settings")).not.toBeVisible();
    fireEvent.click(screen.getByTestId("task-review-show-import"));
    expect(screen.getByLabelText("粘贴文本内容")).toBeVisible();
    fireEvent.click(screen.getByTestId("task-review-show-model"));
    expect(screen.getByTestId("task-review-import-editor")).not.toBeVisible();
    expect(screen.getByTestId("task-review-model-settings")).toBeVisible();
  });

  it("reports the end of a round by opening the pending list without erasing items", async () => {
    const { taskReview } = installSceneTask("compare");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    // Pure browse advance: four scenes, then the end of the plan round.
    fireEvent.click(screen.getByTestId("task-review-continue"));
    fireEvent.click(screen.getByTestId("task-review-continue"));
    fireEvent.click(screen.getByTestId("task-review-continue"));
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await screen.findByTestId("task-review-global-scene");
    expect(screen.getAllByTestId("task-review-unit-row")).toHaveLength(4);
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
  });
  it("mounts original-file export from the launcher and routes destination, preview and execution through the controller", async () => {
    const { taskReview, taskId } = installSceneTask("compare");
    const choose = vi.fn().mockResolvedValue("external-destination");
    let planned!: TaskOriginalExportRecord;
    const preview = vi.fn<TaskReviewExportBridge["preview"]>(async (input) => {
      planned = { id: "original-export", taskId, createdAt: 1, previewRevision: input.expectedRevision, purpose: input.purpose,
        goal: "", policyRevision: 0, statuses: input.statuses, sourceEntryIds: input.sourceEntryIds, destination: input.destination,
        outputDirectory: "external-destination/result", manifestPath: "external-destination/result/manifest.json", manifestStatus: "not-created", items: [], status: "planned" };
      taskReview.mutateState((state) => { state.revision++; state.originalExports = [planned]; });
      return { snapshot: taskReview.snapshotState(), preview: planned };
    });
    const execute = vi.fn<TaskReviewExportBridge["execute"]>(async () => {
      const receipt = { ...planned, status: "complete" as const, completedAt: 2, manifestStatus: "written" as const };
      taskReview.mutateState((state) => { state.revision++; state.originalExports = [receipt]; });
      return { snapshot: taskReview.snapshotState(), receipt };
    });
    Object.defineProperty(window, "reelterminal", { configurable: true, value: { ...window.reelterminal, fs: { showOpenDialog: choose }, taskReviewExport: { preview, execute } } });
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    openLauncher();
    fireEvent.click(screen.getByTestId("task-review-launcher-export"));
    await screen.findByTestId("task-review-export-scene");
    fireEvent.click(screen.getByTestId("task-result-export-status-pending"));
    fireEvent.click(screen.getByLabelText("选择原文件 source.txt"));
    fireEvent.click(screen.getByTestId("task-result-export-choose-destination"));
    await waitFor(() => expect(screen.getByTestId("task-result-export-destination-path").textContent).toContain("external-destination"));
    expect(choose).toHaveBeenCalledWith({ directory: true, filters: [] });
    fireEvent.click(screen.getByTestId("task-result-export-preview-button"));
    await screen.findByTestId("task-result-export-execute-button");
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ root: "task-root", taskId, purpose: "review", statuses: ["kept", "pending"], sourceEntryIds: [taskReview.snapshotState().sources[0]!.entryId] }));
    fireEvent.click(screen.getByTestId("task-result-export-execute-button"));
    await waitFor(() => expect(screen.getByTestId("task-result-export-receipt-status").textContent).toContain("全部成功"));
    expect(screen.getByTestId("task-result-export-execute-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("task-result-export-execute-button"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ exportId: "original-export", taskId }));
    expect(taskReview.snapshotState().originalExports?.[0]?.status).toBe("complete");
  });
  it("keeps the open formal scene and focus stable when a replacement future plan arrives", async () => {
    const { taskReview, scenes } = installSceneTask("compare");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    fireEvent.click(screen.getAllByTestId("task-review-scene-focus")[1]!);
    taskReview.mutateState((state) => state.planRevisions.push({ id: "new-future", policyRevision: 0, createdAt: 2, reason: "后续调整", steps: [], scenes: [scenes[2]!] }));
    fireEvent.change(await screen.findByTestId("task-review-unit-note"), { target: { value: "当前阅读不跳" } });
    await waitFor(() => expect(taskReview.snapshotState().drafts.at(-1)?.text).toBe("当前阅读不跳"), { timeout: 2000 });
    expect(screen.getByTestId("task-review-agent-scene")).toHaveAttribute("data-scene-id", "working-scene");
    expect(screen.getAllByTestId("task-review-scene-focus")[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-unit-text").textContent).toBe("D的原文"));
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
  });

  it("sends semantic scope to the real bridge seam, reports candidate coverage, and suppresses cancelled results", async () => {
    const { taskAgent, taskId, sourceVersionId, units } = installSceneTask("compare");
    taskAgent.setGrant({ ...grantFor(), taskId });
    const result = { matches: [{ unitId: units[0]!.id, sourceVersionId, reason: "含义相近" }], searchedUnitCount: 2,
      scopeUnitCount: 4, locallyScannedUnitCount: 4, candidateUnitCount: 2, coverage: "candidates" as const, truncated: true, omittedUnitCount: 2 };
    const search = vi.spyOn(taskAgent, "search").mockResolvedValue(result);
    const cancel = vi.spyOn(taskAgent, "cancelSearch");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await launchOverview();
    fireEvent.change(screen.getByLabelText("搜索条目文本"), { target: { value: "关联说法" } });
    fireEvent.change(screen.getByLabelText("语义搜索范围"), { target: { value: "scene" } });
    fireEvent.click(screen.getByTestId("task-review-semantic-search"));
    await waitFor(() => expect(screen.getByTestId("task-review-semantic-result").textContent).toContain("仅覆盖候选内容"));
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "units", targets: units.slice(0, 2).map(({ id: unitId }) => ({ unitId, sourceVersionId })) } }));
    fireEvent.change(screen.getByLabelText("语义搜索范围"), { target: { value: "source" } });
    fireEvent.click(screen.getByTestId("task-review-semantic-search"));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "sources", sourceVersionIds: [sourceVersionId] } })));
    let resolve!: (value: typeof result) => void;
    search.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.change(screen.getByLabelText("语义搜索范围"), { target: { value: "task" } });
    fireEvent.click(screen.getByTestId("task-review-semantic-search"));
    fireEvent.click(screen.getByTestId("task-review-cancel-search"));
    expect(cancel).toHaveBeenCalledWith({ root: "task-root", taskId });
    await act(async () => { resolve(result); });
    expect(screen.queryByTestId("task-review-semantic-result")).toBeNull();
  });
  it("plays the formal compare scene and restores its focus, draft, selection and scroll through global and restart", async () => {
    const { taskReview } = installSceneTask("compare");
    const rendered = render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    const scene = await screen.findByTestId("task-review-agent-scene");
    expect(scene).toHaveAttribute("data-scene-kind", "compare");
    expect(screen.getAllByTestId("task-review-unit-text").map((node) => node.textContent)).toEqual(["A的原文", "B的原文"]);
    fireEvent.click(screen.getAllByTestId("task-review-scene-focus")[1]!);
    const note = screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "B的反馈现场", selectionStart: 1, selectionEnd: 4 } });
    scene.scrollTop = 80;
    fireEvent.scroll(scene);
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-back"));
    const restored = screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement;
    expect(restored.value).toBe("B的反馈现场");
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([1, 4]);
    expect(screen.getAllByTestId("task-review-scene-focus")[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("task-review-agent-scene").scrollTop).toBe(80);
    await waitFor(() => expect(taskReview.snapshotState().drafts.at(-1)?.text).toBe("B的反馈现场"), { timeout: 2000 });
    rendered.unmount();
    render(<TaskReviewWorkspace root="task-root" />);
    const recovered = await screen.findByTestId("task-review-unit-note") as HTMLTextAreaElement;
    await waitFor(() => expect(recovered.value).toBe("B的反馈现场"));
    expect([recovered.selectionStart, recovered.selectionEnd]).toEqual([1, 4]);
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-unit-text").textContent).toBe("C的原文"));
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
  });

  it("only confirms explicitly selected covered group members and skips an already decided future target", async () => {
    const { taskReview, units } = installSceneTask("lowRiskGroup");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    await launchOverview();
    fireEvent.click(screen.getAllByTestId("task-review-unit-row").find((node) => node.textContent?.includes("C的原文"))!);
    fireEvent.click(screen.getByTestId("task-review-decide-kept"));
    await waitFor(() => expect(taskReview.snapshotState().decisions).toHaveLength(1));
    await launchOverview();
    fireEvent.click(screen.getAllByTestId("task-review-plan-scene")[0]!);
    const confirm = screen.getByTestId("task-review-group-keep-continue");
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[0]!);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId("task-review-unit-text").textContent).toBe("D的原文"));
    expect(taskReview.snapshotState().decisions.map((decision) => decision.unitId)).toEqual([units[2]!.id, units[0]!.id]);
  });

  it("accepts a group confirmation while autosave is in flight and queues decisions after the draft", async () => {
    const { taskReview, units } = installSceneTask("lowRiskGroup");
    taskReview.mutateState((state) => {
      const [group, thirdMember] = state.planRevisions[0]!.scenes!;
      group!.targets.push(...thirdMember!.targets);
      group!.criteriaBasis.push(...thirdMember!.criteriaBasis);
      group!.sourceRefs.push(...thirdMember!.sourceRefs);
    });
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const originalSave = taskReview.saveDraft;
    const saveDraft = vi.spyOn(taskReview, "saveDraft").mockImplementation(async (input) => {
      await pendingSave;
      return originalSave(input);
    });
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getAllByTestId("task-review-group-select")[1]).not.toBeDisabled());
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[0]!);
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[1]!);
    expect(screen.getAllByTestId("task-review-group-select")[2]).not.toBeChecked();
    fireEvent.change(screen.getByTestId("task-review-unit-note"), { target: { value: "保存中的人工意见" } });
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const confirm = screen.getByTestId("task-review-group-keep-continue");
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
    await act(async () => { releaseSave(); });
    await waitFor(() => expect(taskReview.snapshotState().decisions).toHaveLength(2));
    const saved = taskReview.snapshotState();
    expect(saved.drafts[0]?.text).toBe("保存中的人工意见");
    expect(saved.decisions.map(({ unitId, status }) => ({ unitId, status }))).toEqual([
      { unitId: units[0]!.id, status: "kept" },
      { unitId: units[1]!.id, status: "kept" },
    ]);
  });

  it("keeps unknown group members unselectable and reports a partially saved group", async () => {
    const { taskReview, taskAgent, units, taskId, sourceVersionId } = installSceneTask("lowRiskGroup");
    taskAgent.setJobs([{ ...fakeJob("coverage", "completed", [units[0]!.id]), taskId, sourceVersionIds: [sourceVersionId], policyRevision: 0 }]);
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getAllByTestId("task-review-group-select")[0]).not.toBeDisabled());
    expect(screen.getAllByTestId("task-review-group-select")[1]).toBeDisabled();
    expect(screen.getByTestId("task-review-group-keep-continue")).toBeDisabled();
    taskAgent.setJobs([{ ...fakeJob("coverage", "completed", units.map((unit) => unit.id)), taskId, sourceVersionIds: [sourceVersionId], policyRevision: 0 }]);
    // A task revision refreshes the runtime coverage projection.
    fireEvent.change(screen.getByTestId("task-review-unit-note"), { target: { value: "触发保存" } });
    await waitFor(() => expect(screen.getAllByTestId("task-review-group-select")[1]).not.toBeDisabled(), { timeout: 2000 });
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[0]!);
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[1]!);
    const original = taskReview.decide;
    vi.spyOn(taskReview, "decide").mockImplementation(async (input) => {
      if (input.unitId === units[1]!.id) throw new Error("disk full");
      return original(input);
    });
    fireEvent.click(screen.getByTestId("task-review-group-keep-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-error").textContent).toContain("已保存 1/2"));
    expect(taskReview.snapshotState().decisions.map((decision) => decision.unitId)).toEqual([units[0]!.id]);
    expect(screen.getByTestId("task-review-agent-scene")).toHaveAttribute("data-scene-kind", "lowRiskGroup");
  });

  it("rechecks scene basis after a revision conflict during group confirmation", async () => {
    const { taskReview, units } = installSceneTask("lowRiskGroup");
    render(<TaskReviewWorkspace root="task-root" />);
    await screen.findByTestId("task-review-revision");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getAllByTestId("task-review-group-select")[1]).not.toBeDisabled());
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[0]!);
    fireEvent.click(screen.getAllByTestId("task-review-group-select")[1]!);
    const original = taskReview.decide;
    vi.spyOn(taskReview, "decide").mockImplementation(async (input) => {
      const result = await original(input);
      if (input.unitId === units[0]!.id) taskReview.mutateState((state) => { state.policyRevision++; state.revision++; });
      return result;
    });
    fireEvent.click(screen.getByTestId("task-review-group-keep-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-error").textContent).toContain("场景判断口径或来源已变化"));
    expect(taskReview.snapshotState().decisions.map((decision) => decision.unitId)).toEqual([units[0]!.id]);
    expect(screen.getByTestId("task-review-scene-stale")).toBeTruthy();
  });
  it("restores B editing and selection through nested temporary scenes and restart; continue goes to C", async () => {
    const { taskReview } = installBridges();
    const rendered = render(<TaskReviewWorkspace root="task-root" />);
    await importThreeUnits(taskReview);
    const units = taskReview.snapshotState().units;
    taskReview.mutateState((state) => state.planRevisions.push({ id: "abc-plan", policyRevision: state.policyRevision,
      createdAt: 1, reason: "顺序审阅", steps: units.map((unit) => ({ unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: "review", reason: "顺序审阅" })) }));
    await launchOverview();
    await openUnit(1);
    fireEvent.click(screen.getByRole("button", { name: "批注" }));
    expect(screen.getByTestId("task-review-feedback-editor")).toBeTruthy();
    expect(screen.getByTestId("task-review-complete-request")).toBeTruthy();
    expect(screen.queryByTestId("task-review-replacement-field")).toBeNull();
    fireEvent.click(screen.getByTestId("task-review-keep-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#2"));
    fireEvent.click(screen.getByTestId("task-review-open-edit"));
    const editor = screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "B仍待审的反馈", selectionStart: 1, selectionEnd: 4 } });
    openLauncher();
    fireEvent.click(screen.getByTestId("task-review-launcher-files"));
    expect(screen.getByTestId("task-review-directory-host").className).not.toContain("hidden");
    await launchOverview();
    expect(screen.getByTestId("task-review-directory-host").className).toContain("hidden");
    fireEvent.click(screen.getByTestId("task-review-back"));
    expect(screen.getByTestId("task-review-directory-host").className).not.toContain("hidden");
    fireEvent.click(screen.getByTestId("task-review-back"));
    const recovered = await screen.findByTestId("task-review-edit-input") as HTMLTextAreaElement;
    expect(recovered.value).toBe("B仍待审的反馈");
    expect([recovered.selectionStart, recovered.selectionEnd]).toEqual([1, 4]);
    await waitFor(() => expect(taskReview.snapshotState().drafts.at(-1)).toMatchObject({ selectionStart: 1, selectionEnd: 4 }), { timeout: 2000 });
    rendered.unmount();
    render(<TaskReviewWorkspace root="task-root" />);
    const restarted = await screen.findByTestId("task-review-edit-input") as HTMLTextAreaElement;
    await waitFor(() => expect(restarted.value).toBe("B仍待审的反馈"));
    expect([restarted.selectionStart, restarted.selectionEnd]).toEqual([1, 4]);
    fireEvent.click(screen.getByTestId("task-review-back"));
    expect(screen.getByTestId("task-review-card-status").textContent).toContain("待审");
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() => expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#3"));
    expect(taskReview.snapshotState().decisions.map((decision) => decision.unitId)).toEqual([units[0]!.id]);
  });

  it("reports quiet source polling failures and clears the warning after retry", async () => {
    const { taskReview } = installBridges();
    taskReview.failNext("refreshSources", "permission denied");
    render(<TaskReviewWorkspace root="task-root" />);
    const warning = await screen.findByTestId("task-review-source-refresh-error");
    expect(warning.textContent).toContain("permission denied");
    fireEvent.click(within(warning).getByRole("button", { name: "重试刷新" }));
    await waitFor(() => expect(screen.queryByTestId("task-review-source-refresh-error")).toBeNull());
    expect(screen.queryByTestId("task-review-error")).toBeNull();
  });
  it("runs the manual closed loop: paste import, per-unit decision, export", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    // A fresh folder task opens on real file management.
    await screen.findByTestId("folder-review-workspace");
    await screen.findByTestId("task-review-revision");

    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-show-import"));
    fireEvent.change(await screen.findByLabelText("原文名称"), {
      target: { value: "第一集台词" },
    });
    fireEvent.change(screen.getByLabelText("粘贴文本内容"), {
      target: { value: "第一句台词\n第二句台词" },
    });
    fireEvent.click(screen.getByTestId("task-review-import-text"));
    await waitFor(() =>
      expect(taskReview.snapshotState().sources).toHaveLength(1),
    );

    await openUnit(1);
    fireEvent.change(await openNoteTab(), {
      target: { value: "口径符合，保留" },
    });
    fireEvent.click(screen.getByTestId("task-review-decide-kept"));
    await waitFor(() =>
      expect(
        taskReview.calls.filter((call) => call.method === "decide"),
      ).toHaveLength(1),
    );
    const decide = taskReview.calls.find((call) => call.method === "decide")!
      .input as Record<string, unknown>;
    expect(decide).toMatchObject({
      root: "task-root",
      taskId: "task-1",
      purpose: "review",
      status: "kept",
    });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-decide-kept")).toHaveAttribute("aria-pressed", "true"),
    );

    await launchOverview();
    const source = await screen.findByTestId("task-review-source");
    fireEvent.click(
      within(source).getByRole("button", { name: "导出通过条目" }),
    );
    await screen.findByTestId("task-review-artifacts");
    // Filtered, not positional: the workspace's own source polling may append
    // later refreshSources calls without invalidating this assertion.
    expect(
      taskReview.calls.filter((call) => call.method === "exportSource"),
    ).toHaveLength(1);
    expect(screen.getByTestId("task-review-artifacts").textContent).toContain(
      "result-1.txt",
    );
  });

  it("back from a temporary global scene restores the B draft and keeps B pending", async () => {
    const { taskReview, taskAgent } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);

    await openUnit(1);
    fireEvent.change(await openNoteTab(), {
      target: { value: "B场景的反馈草稿" },
    });
    // A: unit 1, then insert the temporary global scene G.
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-back"));
    await screen.findByTestId("task-review-unit-scene");
    expect(
      (screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement).value,
    ).toBe("B场景的反馈草稿");
    // Navigation never records a decision.
    expect(screen.getByTestId("task-review-card-status").textContent).toContain("待审");
    expect(taskReview.snapshotState().decisions).toHaveLength(0);

    // The background analysis publishes a plan; the debounced draft save
    // bumps the task revision, which refreshes the agent state and snapshot.
    const units = taskReview.snapshotState().units;
    taskReview.mutateState((state) => {
      state.planRevisions.push({
        id: "plan-1",
        policyRevision: state.policyRevision,
        createdAt: Date.now(),
        reason: "高风险优先",
        steps: [
          { unitId: units[1]!.id, sourceVersionId: units[1]!.sourceVersionId, purpose: "review", reason: "高风险" },
          { unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId, purpose: "review", reason: "扫阅" },
        ],
      });
    });
    taskAgent.setGrant(grantFor());
    taskAgent.setJobs([
      fakeJob("job-1", "completed", units.map((unit) => unit.id)),
    ]);
    await launchOverview();
    fireEvent.click(screen.getByTestId("task-review-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#2"),
    );
    expect(taskReview.snapshotState().decisions).toHaveLength(0);
    fireEvent.click(screen.getByTestId("task-review-back"));
    await waitFor(() =>
      expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#1"),
    );
    // The unit switch reset the sub-tool; reopening 批注 shows the restored draft.
    fireEvent.click(screen.getByRole("button", { name: "批注" }));
    expect(
      (screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement).value,
    ).toBe("B场景的反馈草稿");
  });

  it("保留并继续 records the decision and follows the risk-first plan order", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    const units = taskReview.snapshotState().units;
    taskReview.mutateState((state) => {
      state.planRevisions.push({
        id: "plan-1",
        policyRevision: state.policyRevision,
        createdAt: Date.now(),
        reason: "高风险优先",
        steps: [
          { unitId: units[1]!.id, sourceVersionId: units[1]!.sourceVersionId, purpose: "review", reason: "高风险" },
          { unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId, purpose: "review", reason: "扫阅" },
        ],
      });
    });

    await launchOverview();
    await openUnit(1);
    expect(screen.getByTestId("task-review-decide-scope").textContent).toContain(
      "决定仅作用于当前条目 #1",
    );
    fireEvent.click(screen.getByTestId("task-review-keep-continue"));
    await waitFor(() =>
      expect(
        taskReview.calls.filter((call) => call.method === "decide"),
      ).toHaveLength(1),
    );
    // The next planned unit is the high-risk #2, not the ordinal #1 follower.
    await waitFor(() =>
      expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#2"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("task-review-progress").textContent).toContain("1/3"),
    );
  });

  it("keeps the typed draft and offers retry when saving fails", async () => {
    const { taskReview } = installBridges();
    taskReview.failNext("saveDraft", "disk full");
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);

    await openUnit(1);
    const note = await openNoteTab();
    fireEvent.change(note, { target: { value: "必须保留的反馈" } });
    await waitFor(
      () => expect(screen.getByTestId("task-review-draft-retry")).toBeTruthy(),
      { timeout: 4000 },
    );
    expect(note.value).toBe("必须保留的反馈");
    // The draft was not persisted, but the text and cursor survived.
    expect(taskReview.snapshotState().drafts).toHaveLength(0);

    fireEvent.click(screen.getByTestId("task-review-draft-retry"));
    await waitFor(
      () =>
        expect(screen.queryByTestId("task-review-draft-retry")).toBeNull(),
      { timeout: 4000 },
    );
    expect(taskReview.snapshotState().drafts.at(-1)?.text).toBe("必须保留的反馈");
    expect(note.value).toBe("必须保留的反馈");
  });

  it("shows the explicit batch scope before applying a batch decision", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);

    fireEvent.click(screen.getByLabelText("选择条目 #1"));
    fireEvent.click(screen.getByLabelText("选择条目 #2"));
    const bar = await screen.findByTestId("task-review-batch-bar");
    expect(bar.textContent).toContain("批量决定将作用于选中的 2 项");
    fireEvent.click(screen.getByTestId("task-review-batch-discarded"));
    await waitFor(() =>
      expect(
        taskReview.calls.filter((call) => call.method === "decide"),
      ).toHaveLength(2),
    );
    for (const call of taskReview.calls.filter((call) => call.method === "decide")) {
      expect((call.input as Record<string, unknown>).status).toBe("discarded");
    }
  });

  it("a published plan update changes the future without moving the open scene", async () => {
    const { taskReview, taskAgent } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    const units = taskReview.snapshotState().units;

    await launchOverview();
    await openUnit(1);
    // The background analysis completes and publishes a new plan revision.
    taskReview.mutateState((state) => {
      state.planRevisions.push({
        id: "plan-1",
        policyRevision: state.policyRevision,
        createdAt: Date.now(),
        reason: "根据口径先审高风险",
        steps: [
          { unitId: units[2]!.id, sourceVersionId: units[2]!.sourceVersionId, purpose: "review", reason: "高风险" },
        ],
      });
    });
    taskAgent.setGrant(grantFor());
    taskAgent.setJobs([fakeJob("job-1", "completed", [units[0]!.id, units[1]!.id, units[2]!.id])]);
    // Any task mutation refreshes the agent state, which pulls the snapshot.
    fireEvent.click(screen.getByTestId("task-review-decide-rework"));
    await waitFor(() =>
      expect(
        taskReview.calls.filter((call) => call.method === "decide"),
      ).toHaveLength(1),
    );
    // The open scene is still unit 1 even though the plan now points at #3.
    expect(screen.getByTestId("task-review-unit-scene")).toBeTruthy();
    expect(screen.getByTestId("task-review-unit-title").textContent).toContain("#1");
    await launchOverview();
    await screen.findByTestId("task-review-plan-list");
    expect(screen.getByTestId("task-review-plan-list").textContent).toContain("第三句台词");
  });

  it("exports nothing when no unit is kept for the purpose", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    const source = await screen.findByTestId("task-review-source");
    fireEvent.click(
      within(source).getByRole("button", { name: "导出通过条目" }),
    );
    await waitFor(() =>
      expect(
        taskReview.calls.filter((call) => call.method === "exportSource"),
      ).toHaveLength(1),
    );
    await screen.findByText("No approved review units for this purpose");
  });
  it("semantic search filters the unit list through the agent bridge", async () => {
    const { taskReview, taskAgent } = installBridges();
    // Grant before any task mutation so the refreshed agent state carries it.
    taskAgent.setGrant(grantFor());
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    const units = taskReview.snapshotState().units;
    taskAgent.searchResult = {
      matches: [
        { unitId: units[2]!.id, sourceVersionId: units[2]!.sourceVersionId, reason: "改写表述命中" },
      ],
      searchedUnitCount: units.length,
    };
    fireEvent.change(screen.getByLabelText("搜索条目文本"), {
      target: { value: "意思相近的说法" },
    });
    fireEvent.click(screen.getByTestId("task-review-semantic-search"));
    await waitFor(() =>
      expect(screen.getByTestId("task-review-semantic-result").textContent).toContain(
        "语义匹配 1/3 条",
      ),
    );
    // Only the matched row stays visible, and the local text filter no longer applies.
    expect(screen.getAllByTestId("task-review-unit-row")).toHaveLength(1);
    expect(screen.getByTestId("task-review-unit-row").textContent).toContain("第三句台词");
  });

  it("embeds the directory scene as pure file management with no legacy review entries", async () => {
    installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    const host = await screen.findByTestId("folder-review-workspace");
    expect(host).toHaveAttribute("data-mode", "files");
    await screen.findByText("素材01.txt");
    // One decision authority: the task domain. The legacy file-level
    // verdicts, notes and status filter never appear in this scene.
    expect(screen.queryByLabelText("审阅备注")).toBeNull();
    expect(screen.queryByLabelText("审阅结果筛选")).toBeNull();
    for (const label of ["采用", "返工", "不采用", "保存备注"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // Real file capabilities remain available in the directory scene.
    expect(screen.getByLabelText("搜索文件")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建文件夹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重命名任务" })).toBeTruthy();
  });

  it("the workspace polls task sources itself and pauses the hidden directory scene's polling", async () => {
    const { taskReview, folderReview } = installBridges();
    vi.useFakeTimers();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    screen.getByTestId("folder-review-workspace");
    // Source discovery starts with the task itself, without the directory.
    expect(
      taskReview.calls.filter((call) => call.method === "refreshSources")
        .length,
    ).toBeGreaterThanOrEqual(1);
    // Covering the directory scene hides it and stops its own polling.
    // (Fake timers: query synchronously instead of waitFor-based finders.)
    openLauncher();
    fireEvent.click(screen.getByTestId("task-review-launcher-overview"));
    expect(screen.getByTestId("task-review-global-scene")).toBeTruthy();
    expect(screen.getByTestId("task-review-directory-host").className).toContain("hidden");
    const folderRefreshBefore = folderReview.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    // The task-domain poll keeps discovering external file changes…
    expect(
      taskReview.calls.filter((call) => call.method === "refreshSources")
        .length,
    ).toBeGreaterThanOrEqual(3);
    // …while the covered legacy directory scene stays idle.
    expect(folderReview.refresh.mock.calls.length).toBe(folderRefreshBefore);
  });

  it("copy centre writes real snapshot content to the clipboard and confirms with a toast", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    await launchOverview();
    await openUnit(2);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByTestId("task-review-copy-center"));
    const modal = screen.getByTestId("copy-center-modal");
    fireEvent.click(within(modal).getByRole("button", { name: "当前条目 (#2)" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("第二句台词"));
    await screen.findByTestId("task-review-toast");
    fireEvent.click(screen.getByTestId("task-review-copy-center"));
    fireEvent.click(within(screen.getByTestId("copy-center-modal")).getByRole("button", { name: "任务路径 (task-root)" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("task-root"));
  });

  it("the tool card flips to a completion delivery hub when every unit is decided", async () => {
    const { taskReview } = installBridges();
    render(<TaskReviewWorkspace root="task-root" name="任务A" />);
    await importThreeUnits(taskReview);
    await launchOverview();
    await openUnit(1);
    expect(screen.queryByTestId("spotlight-completion-hub")).toBeNull();
    // The header shortcut previews the delivery hub while work remains.
    fireEvent.click(screen.getByTestId("spotlight-completion-toggle"));
    expect(screen.getByTestId("spotlight-completion-hub")).toBeTruthy();
    fireEvent.click(screen.getByTestId("spotlight-completion-toggle"));
    expect(screen.queryByTestId("spotlight-completion-hub")).toBeNull();
    // Decide all three units; the hub becomes permanent.
    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByTestId("task-review-keep-continue"));
      await waitFor(() =>
        expect(taskReview.calls.filter((call) => call.method === "decide")).toHaveLength(round + 1),
      );
    }
    await waitFor(() => expect(screen.getByTestId("spotlight-completion-hub")).toBeTruthy());
    expect(screen.getByTestId("task-review-progress").textContent).toContain("3/3");
    // The green CTA steps aside in the completed state.
    expect(screen.queryByTestId("task-review-keep-continue")).toBeNull();
  });

  it("embodies built-in agent standby state with startup prompt and inline import on an empty task", async () => {
    const { taskReview } = installBridges();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    // Header title embodies built-in agent standby
    expect(screen.getByText("内置 Agent · 待命")).toBeVisible();

    // Clean UI: empty left dock, bottom track and top banner are hidden
    expect(screen.queryByTestId("task-review-dock-scene")).toBeNull();
    expect(screen.queryByTestId("task-review-unit-track")).toBeNull();
    expect(screen.queryByTestId("task-review-context-brief")).toBeNull();

    // Empty agent state in card body
    expect(screen.getByTestId("task-review-empty-agent-state")).toBeVisible();
    expect(screen.getByTestId("task-review-copy-startup-prompt")).toBeVisible();
    expect(screen.getByTestId("task-review-empty-import-text")).toBeVisible();
    expect(screen.getByTestId("task-review-empty-open-files")).toBeVisible();

    // Copy startup prompt writes prompt to clipboard
    fireEvent.click(screen.getByTestId("task-review-copy-startup-prompt"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("reelctl task-review")),
    );
    await screen.findByTestId("task-review-toast");

    // Quick inline import right in the card
    fireEvent.click(screen.getByTestId("task-review-empty-import-text"));
    expect(screen.getByTestId("task-review-inline-import-form")).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("粘贴台词或字幕文本，每行一条…"), {
      target: { value: "台词一\n台词二" },
    });
    fireEvent.click(screen.getByTestId("task-review-quick-import-submit"));
    await waitFor(() => expect(taskReview.snapshotState().units).toHaveLength(2));
  });

  it("embodies built-in agent ready state with preflight CTA when units exist without grant", async () => {
    const { taskAgent, taskReview } = installBridges();
    const sourceVersionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    taskReview.mutateState((state) => {
      state.sources = [{ id: sourceVersionId, entryId, relativePath: "dialogue.txt", hash: "h", format: "txt", text: "一句\n两句", createdAt: 1 }];
      state.sourceFiles = [{ entryId, relativePath: "dialogue.txt", size: 10, mtimeMs: 1, currentVersionId: sourceVersionId, status: "available" }];
      state.units = [
        { id: "u1", sourceVersionId, ordinal: 1, text: "一句", startLine: 1, endLine: 1 },
        { id: "u2", sourceVersionId, ordinal: 2, text: "两句", startLine: 2, endLine: 2 },
      ];
    });
    const authorizeSpy = vi.spyOn(taskAgent, "authorize");
    const preflightSpy = vi.spyOn(taskAgent, "startPreflight");

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    expect(screen.getByTestId("task-review-agent-ready")).toBeVisible();
    expect(screen.getByTestId("task-review-start-preflight")).toBeVisible();

    fireEvent.click(screen.getByTestId("task-review-start-preflight"));
    await waitFor(() => expect(authorizeSpy).toHaveBeenCalled());
    expect(preflightSpy).toHaveBeenCalled();
  });

  it("shows live preflight indicator in card footer when background job is running", async () => {
    const { taskAgent, taskReview } = installBridges();
    const sourceVersionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    taskReview.mutateState((state) => {
      state.sources = [{ id: sourceVersionId, entryId, relativePath: "dialogue.txt", hash: "h", format: "txt", text: "一句", createdAt: 1 }];
      state.sourceFiles = [{ entryId, relativePath: "dialogue.txt", size: 10, mtimeMs: 1, currentVersionId: sourceVersionId, status: "available" }];
      state.units = [{ id: "u1", sourceVersionId, ordinal: 1, text: "一句", startLine: 1, endLine: 1 }];
    });
    taskAgent.setGrant(grantFor());
    taskAgent.setJobs([{ ...fakeJob("job-run", "running", ["u1"]), sourceVersionIds: [sourceVersionId], policyRevision: 0 }]);

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    await screen.findByTestId("task-review-agent-running");
    expect(screen.getAllByText("AI 正在预审编排中…")[0]).toBeVisible();
  });

  it("presents understanding proposal in SpotlightCard with adopt CTA and adopts it", async () => {
    const { taskReview } = installBridges();
    const taskReviewContext = createFakeTaskContextBridge(taskReview);
    Object.defineProperty(window, "reelterminal", {
      configurable: true,
      value: { ...window.reelterminal, taskReviewContext },
    });
    const sourceVersionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const proposalId = crypto.randomUUID();
    taskReview.mutateState((state) => {
      state.sources = [{ id: sourceVersionId, entryId, relativePath: "dialogue.txt", hash: "h", format: "txt", text: "一句\n两句", createdAt: 1 }];
      state.sourceFiles = [{ entryId, relativePath: "dialogue.txt", size: 10, mtimeMs: 1, currentVersionId: sourceVersionId, status: "available" }];
      state.units = [
        { id: "u1", sourceVersionId, ordinal: 1, text: "一句", startLine: 1, endLine: 1 },
        { id: "u2", sourceVersionId, ordinal: 2, text: "两句", startLine: 2, endLine: 2 },
      ];
      state.contextHistory = {
        taskId: state.taskId,
        proposals: [
          {
            id: proposalId,
            taskId: state.taskId,
            content: {
              groundedClaims: ["关于剧情设定的事实梳理"],
              hypotheses: ["角色口吻一致性假设"],
            },
            sourceRefs: [{ unitId: "u1", sourceVersionId, start: 0, end: 2, text: "一句" }],
            openQuestions: ["第二句的感情基调待确定"],
            proposedBy: "agent",
            createdAt: 1,
          },
        ],
        adoptions: [],
        criteriaVersions: [],
        criteriaActions: [],
      };
    });

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    expect(screen.getByText("内置 Agent · 任务理解提案")).toBeVisible();
    expect(screen.getByTestId("task-review-proposal-body")).toBeVisible();
    expect(screen.getByText("关于剧情设定的事实梳理")).toBeVisible();
    expect(screen.getByTestId("task-review-adopt-proposal-cta")).toBeVisible();

    fireEvent.click(screen.getByTestId("task-review-adopt-proposal-cta"));
    await waitFor(() =>
      expect(
        taskReviewContext.calls.filter((call) => call.method === "adoptContext"),
      ).toHaveLength(1),
    );
  });
  it("allows opening model and API key settings from gear button, changing provider and saving", async () => {
    const { taskAgent } = installBridges();
    const configureSpy = vi.spyOn(taskAgent, "configureModel");

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    const settingsBtn = screen.getByTestId("spotlight-model-settings-btn");
    expect(settingsBtn).toBeVisible();

    fireEvent.click(settingsBtn);

    const providerSelect = await screen.findByTestId("task-review-provider-select");
    expect(providerSelect).toBeVisible();

    // Select DeepSeek preset
    fireEvent.change(providerSelect, { target: { value: "deepseek" } });

    const endpointInput = screen.getByTestId("task-review-config-endpoint") as HTMLInputElement;
    expect(endpointInput.value).toBe("https://api.deepseek.com");

    const modelInput = screen.getByTestId("task-review-config-model") as HTMLInputElement;
    expect(modelInput.value).toBe("deepseek-chat");

    // Select model preset
    const modelSelect = screen.getByTestId("task-review-model-preset-select");
    fireEvent.change(modelSelect, { target: { value: "deepseek-reasoner" } });
    expect(modelInput.value).toBe("deepseek-reasoner");

    // Enter API key
    const apikeyInput = screen.getByTestId("task-review-config-apikey") as HTMLInputElement;
    fireEvent.change(apikeyInput, { target: { value: "sk-my-deepseek-key" } });

    // Click Save
    const saveBtn = screen.getByTestId("task-review-save-model-btn");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(configureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "https://api.deepseek.com",
          backgroundModel: "deepseek-reasoner",
          completionModel: "deepseek-reasoner",
          apiKey: "sk-my-deepseek-key",
        }),
      );
    });

    // Verify settings closed after save
    await waitFor(() => {
      expect(screen.queryByTestId("task-review-provider-select")).toBeNull();
    });
  });

  it("opens model settings from empty state button and from launcher items", async () => {
    installBridges();

    render(<TaskReviewWorkspace root="task-root" name="空任务" />);
    await screen.findByTestId("task-review-revision");

    // 1. Click empty state button
    const openBtn = await screen.findByTestId("task-review-open-model-settings-btn");
    expect(openBtn).toBeVisible();
    fireEvent.click(openBtn);

    expect(screen.getByTestId("task-review-provider-select")).toBeVisible();

    // Close settings via return button
    fireEvent.click(screen.getByTestId("task-review-close-model-settings-btn"));
    expect(screen.queryByTestId("task-review-provider-select")).toBeNull();

    // 2. Open launcher and click Agent launcher item
    openLauncher();
    const launcherAgent = screen.getByTestId("task-review-launcher-agent");
    expect(launcherAgent).toBeVisible();
    fireEvent.click(launcherAgent);

    expect(screen.getByTestId("task-review-provider-select")).toBeVisible();
  });

  it("detects and saves model configuration with preflight when unanalyzed units exist", async () => {
    const { taskAgent, taskReview } = installBridges();
    const sourceVersionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    taskReview.mutateState((state) => {
      state.sources = [{ id: sourceVersionId, entryId, relativePath: "dialogue.txt", hash: "h", format: "txt", text: "一句", createdAt: 1 }];
      state.sourceFiles = [{ entryId, relativePath: "dialogue.txt", size: 10, mtimeMs: 1, currentVersionId: sourceVersionId, status: "available" }];
      state.units = [{ id: "u1", sourceVersionId, ordinal: 1, text: "一句", startLine: 1, endLine: 1 }];
    });

    const configureSpy = vi.spyOn(taskAgent, "configureModel");
    const authorizeSpy = vi.spyOn(taskAgent, "authorize");
    const preflightSpy = vi.spyOn(taskAgent, "startPreflight");

    render(<TaskReviewWorkspace root="task-root" name="测试任务" />);
    await screen.findByTestId("task-review-revision");

    // Click header gear button to configure
    fireEvent.click(screen.getByTestId("spotlight-model-settings-btn"));

    const endpointInput = await screen.findByTestId("task-review-config-endpoint");
    fireEvent.change(endpointInput, { target: { value: "https://custom-ai.internal/v1" } });

    const modelInput = screen.getByTestId("task-review-config-model");
    fireEvent.change(modelInput, { target: { value: "internal-custom-model" } });

    const keyInput = screen.getByTestId("task-review-config-apikey");
    fireEvent.change(keyInput, { target: { value: "custom-secret-key" } });

    fireEvent.click(screen.getByTestId("task-review-save-model-btn"));

    await waitFor(() => {
      expect(configureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "https://custom-ai.internal/v1",
          backgroundModel: "internal-custom-model",
        }),
      );
    });

    await waitFor(() => expect(authorizeSpy).toHaveBeenCalled());
    expect(preflightSpy).toHaveBeenCalled();
  });
});

useChineseReviewLocale();
