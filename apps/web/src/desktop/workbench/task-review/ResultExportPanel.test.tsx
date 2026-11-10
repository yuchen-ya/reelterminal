import { useChineseReviewLocale } from "../../../test/review-locale";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskDecision,
  TaskReviewSnapshot,
} from "../../../../../desktop/src/shared/task-review";
import type {
  TaskExportUnit,
  TaskOriginalExportItem,
  TaskOriginalExportRecord,
} from "../../../../../desktop/src/shared/task-review-export";
import { ResultExportPanel } from "./ResultExportPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { reelterminal?: unknown }).reelterminal;
});

const uuid = (tail: string) =>
  `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

const taskId = uuid("t1");
const entryA = uuid("e1");
const entryB = uuid("e2");
const entryC = uuid("e3");
const sourceA = uuid("sa");
const sourceB = uuid("sb");
const sourceC = uuid("sc");
const unitA1 = uuid("ua");
const unitA2 = uuid("ub");
const unitB1 = uuid("uc");
const unitB2 = uuid("ud");
const unitC1 = uuid("ue");

/**
 * Three originals: episode01 has a kept and a pending unit (mixed),
 * episode02 is fully kept, notes.txt is a missing file whose only unit
 * therefore derives to recheck (its decision can no longer apply).
 */
function buildSnapshot(): TaskReviewSnapshot {
  const decision = (
    id: string,
    unitId: string,
    sourceVersionId: string,
  ): TaskDecision => ({
    id,
    unitId,
    sourceVersionId,
    policyRevision: 0,
    purpose: "review",
    status: "kept",
    note: "ok",
    createdAt: 1,
  });
  const decisions = [
    decision(uuid("d1"), unitA1, sourceA),
    decision(uuid("d2"), unitB1, sourceB),
    decision(uuid("d3"), unitB2, sourceB),
    decision(uuid("d4"), unitC1, sourceC),
  ];
  return {
    root: "task-root",
    taskId,
    revision: 7,
    policyRevision: 0,
    goal: "",
    sources: [
      {
        id: sourceA,
        entryId: entryA,
        relativePath: "第一集/episode01.srt",
        hash: "a".repeat(64),
        format: "srt",
        text: "保留句\n待审句",
        createdAt: 1,
      },
      {
        id: sourceB,
        entryId: entryB,
        relativePath: "第二集/episode02.srt",
        hash: "b".repeat(64),
        format: "srt",
        text: "好句\n也好",
        createdAt: 1,
      },
      {
        id: sourceC,
        entryId: entryC,
        relativePath: "备注/notes.txt",
        hash: "c".repeat(64),
        format: "txt",
        text: "备注",
        createdAt: 1,
      },
    ],
    sourceFiles: [
      {
        entryId: entryA,
        relativePath: "第一集/episode01.srt",
        size: 8,
        mtimeMs: 1,
        currentVersionId: sourceA,
        status: "available",
      },
      {
        entryId: entryB,
        relativePath: "第二集/episode02.srt",
        size: 6,
        mtimeMs: 1,
        currentVersionId: sourceB,
        status: "available",
      },
      {
        entryId: entryC,
        relativePath: "备注/notes.txt",
        size: 4,
        mtimeMs: 1,
        currentVersionId: sourceC,
        status: "missing",
        error: "ENOENT",
      },
    ],
    units: [
      {
        id: unitA1,
        sourceVersionId: sourceA,
        ordinal: 1,
        text: "保留句",
        startLine: 1,
        endLine: 1,
      },
      {
        id: unitA2,
        sourceVersionId: sourceA,
        ordinal: 2,
        text: "待审句",
        startLine: 2,
        endLine: 2,
      },
      {
        id: unitB1,
        sourceVersionId: sourceB,
        ordinal: 1,
        text: "好句",
        startLine: 1,
        endLine: 1,
      },
      {
        id: unitB2,
        sourceVersionId: sourceB,
        ordinal: 2,
        text: "也好",
        startLine: 2,
        endLine: 2,
      },
      {
        id: unitC1,
        sourceVersionId: sourceC,
        ordinal: 1,
        text: "备注",
        startLine: 1,
        endLine: 1,
      },
    ],
    decisions,
    decisionActions: decisions.map((item, index) => ({
      id: `action-${index}`,
      kind: "decide",
      decisionId: item.id,
      createdAt: 1,
    })),
    drafts: [],
    issues: [],
    planRevisions: [],
    history: [],
    artifacts: [],
  };
}

const exportUnit = (
  unitId: string,
  sourceVersionId: string,
  matched = true,
): TaskExportUnit => ({
  unitId,
  sourceVersionId,
  ordinal: 1,
  status: "kept",
  matched,
  historicalDecisionIds: [],
});

const exportItem = (
  input: {
    entryId: string;
    sourceVersionId: string;
    relativePath: string;
    matchedUnitIds: string[];
  },
  extra: Partial<TaskOriginalExportItem> = {},
): TaskOriginalExportItem => ({
  entryId: input.entryId,
  sourceVersionId: input.sourceVersionId,
  sourceHash: "a".repeat(64),
  relativePath: input.relativePath,
  relativeOutputPath: input.relativePath,
  units: input.matchedUnitIds.map((id) => exportUnit(id, input.sourceVersionId)),
  matchedUnitIds: input.matchedUnitIds,
  distribution: {
    kept: input.matchedUnitIds.length,
    rework: 0,
    discarded: 0,
    pending: 0,
    recheck: 0,
  },
  mixed: false,
  allKept: input.matchedUnitIds.length > 0,
  selectable: true,
  status: "ready",
  ...extra,
});

const exportRecord = (
  items: TaskOriginalExportItem[],
  extra: Partial<TaskOriginalExportRecord> = {},
): TaskOriginalExportRecord => ({
  id: uuid("x1"),
  taskId,
  createdAt: 1,
  previewRevision: 8,
  purpose: "review",
  goal: "",
  policyRevision: 0,
  statuses: ["kept"],
  destination: "D:/exports",
  outputDirectory: "D:/exports/review-export-x",
  manifestPath: "D:/exports/review-export-x/review-manifest.json",
  manifestStatus: "not-created",
  items,
  status: "planned",
  ...extra,
});

const itemA = exportItem({
  entryId: entryA,
  sourceVersionId: sourceA,
  relativePath: "第一集/episode01.srt",
  matchedUnitIds: [unitA1],
});

const itemB = exportItem({
  entryId: entryB,
  sourceVersionId: sourceB,
  relativePath: "第二集/episode02.srt",
  matchedUnitIds: [unitB1, unitB2],
});

function mountPanel(snapshot = buildSnapshot()) {
  const onPreview = vi.fn();
  const onExecute = vi.fn();
  const onChooseDestination = vi.fn();
  const view = render(
    <ResultExportPanel
      snapshot={snapshot}
      onPreview={onPreview}
      onExecute={onExecute}
      onChooseDestination={onChooseDestination}
      defaultOpen
    />,
  );
  return { view, onPreview, onExecute, onChooseDestination };
}

const fileCheckbox = (path: string) =>
  screen.getByLabelText(`选择原文件 ${path}`);
const chooseDestination = async (
  onChooseDestination: ReturnType<typeof vi.fn>,
  path: string | null,
) => {
  onChooseDestination.mockResolvedValueOnce(path);
  fireEvent.click(
    screen.getByTestId("task-result-export-choose-destination"),
  );
  await waitFor(() =>
    expect(onChooseDestination).toHaveBeenCalledTimes(1),
  );
};
const runPreview = async () => {
  fireEvent.click(screen.getByTestId("task-result-export-preview-button"));
  return screen.findByTestId("task-result-export-preview");
};

describe("ResultExportPanel", () => {
  it("exports an explicitly selected transparent cutout without selecting its original, and can separately add its mask", async () => {
    const snapshot = buildSnapshot();
    const mediaSourceId = uuid("media-source");
    const mediaEntryId = uuid("media-entry");
    const regionId = uuid("region");
    snapshot.sources.push({ id: mediaSourceId, entryId: mediaEntryId, relativePath: "fish.png", hash: "a".repeat(64), createdAt: 1, kind: "image", mime: "image/png", width: 400, height: 200, durationSec: 0 });
    snapshot.sourceFiles.push({ entryId: mediaEntryId, currentVersionId: mediaSourceId, relativePath: "fish.png", size: 100, mtimeMs: 1, status: "available" });
    snapshot.units.push({ id: uuid("image-base"), sourceVersionId: mediaSourceId, ordinal: 1, kind: "image" }, {
      id: regionId, sourceVersionId: mediaSourceId, ordinal: 2, kind: "region", parentUnitId: uuid("image-base"), maskAssetId: uuid("mask"), cutoutAssetId: uuid("cutout"), pixelRevision: "pixels", width: 400, height: 200, label: "蓝色的鱼", modelVersion: "fixture-model", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] },
    });
    snapshot.decisions.push({ id: uuid("media-decision"), unitId: regionId, sourceVersionId: mediaSourceId, policyRevision: 0, purpose: "review", status: "kept", note: "人工确认", createdAt: 2 });
    snapshot.decisionActions.push({ id: "media-action", kind: "decide", decisionId: uuid("media-decision"), createdAt: 2 });
    const { onPreview, onChooseDestination } = mountPanel(snapshot);
    const item = exportItem({ entryId: mediaEntryId, sourceVersionId: mediaSourceId, relativePath: "fish.png", matchedUnitIds: [regionId] }, { outputKind: "cutout", artifactUnitId: regionId, label: "蓝色的鱼", relativeOutputPath: "derived/fish.png/蓝色的鱼.png" });
    onPreview.mockResolvedValue({ snapshot, preview: exportRecord([item]) });
    const cutout = screen.getByLabelText("导出透明抠图 蓝色的鱼");
    const mask = screen.getByLabelText("导出蒙版 蓝色的鱼");
    expect(cutout).not.toBeChecked();
    expect(mask).not.toBeChecked();
    fireEvent.click(cutout);
    await chooseDestination(onChooseDestination, "D:/media-result");
    await runPreview();
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ sourceEntryIds: [], derivedOutputs: [{ unitId: regionId, kind: "cutout" }] }));
    expect(screen.getByTestId("task-result-export-preview-item").dataset.outputKind).toBe("cutout");
    fireEvent.click(mask);
    expect(screen.getByTestId("task-result-export-preview-stale")).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-result-export-preview-button"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ sourceEntryIds: [], derivedOutputs: [{ unitId: regionId, kind: "cutout" }, { unitId: regionId, kind: "mask" }] })));
  });

  it("uses the native reveal operation for the actual completed manifest", () => {
    const revealInFolder = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "reelterminal", { configurable: true, value: { fs: { revealInFolder } } });
    const snapshot = buildSnapshot();
    const receipt = exportRecord([itemA], { status: "complete", completedAt: 2, manifestStatus: "written" });
    snapshot.originalExports = [receipt];
    mountPanel(snapshot);
    fireEvent.click(screen.getByTestId("task-result-export-reveal"));
    expect(revealInFolder).toHaveBeenCalledWith(receipt.manifestPath);
  });
  it("sends the explicit statuses, selected files and destination to preview", async () => {
    const { onPreview, onChooseDestination } = mountPanel();
    onPreview.mockResolvedValue({
      snapshot: buildSnapshot(),
      preview: exportRecord([itemB]),
    });

    fireEvent.click(fileCheckbox("第二集/episode02.srt"));
    await chooseDestination(onChooseDestination, "D:/exports-final");
    await runPreview();

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith({
      root: "task-root",
      taskId,
      expectedRevision: 7,
      purpose: "review",
      statuses: ["kept"],
      sourceEntryIds: [entryB],
      destination: "D:/exports-final",
    });

    // The statuses actually sent follow the visible filter, never a default.
    fireEvent.click(screen.getByTestId("task-result-export-status-kept"));
    fireEvent.click(screen.getByTestId("task-result-export-status-pending"));
    fireEvent.click(screen.getByTestId("task-result-export-preview-button"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
    expect(onPreview).toHaveBeenLastCalledWith({
      root: "task-root",
      taskId,
      expectedRevision: 7,
      purpose: "review",
      statuses: ["pending"],
      sourceEntryIds: [entryB],
      destination: "D:/exports-final",
    });
  });

  it("keeps preview disabled without a status, selection or destination", async () => {
    const { onPreview, onChooseDestination } = mountPanel();
    const button = screen.getByTestId("task-result-export-preview-button");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("task-result-export-status-kept"));
    fireEvent.click(fileCheckbox("第二集/episode02.srt"));
    // Still no destination.
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onPreview).not.toHaveBeenCalled();

    await chooseDestination(onChooseDestination, "D:/ok");
    // With a status back in the filter, every condition is met.
    fireEvent.click(screen.getByTestId("task-result-export-status-kept"));
    expect(button).toBeEnabled();

    // Clearing every status blocks the request again.
    fireEvent.click(screen.getByTestId("task-result-export-status-kept"));
    expect(button).toBeDisabled();
  });

  it("keeps the destination and selection when the directory dialog is cancelled", async () => {
    const { onChooseDestination } = mountPanel();
    await chooseDestination(onChooseDestination, "D:/first");
    expect(
      screen.getByTestId("task-result-export-destination-path").textContent,
    ).toBe("D:/first");

    const checkbox = fileCheckbox("第一集/episode01.srt");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    onChooseDestination.mockResolvedValueOnce(null);
    fireEvent.click(
      screen.getByTestId("task-result-export-choose-destination"),
    );
    await waitFor(() =>
      expect(onChooseDestination).toHaveBeenCalledTimes(2),
    );
    expect(
      screen.getByTestId("task-result-export-destination-path").textContent,
    ).toBe("D:/first");
    expect(checkbox).toBeChecked();
  });

  it("shows mixed originals as mixed and never as fully kept", () => {
    mountPanel();
    const rows = screen.getAllByTestId("task-result-export-file");
    const rowA = rows.find((row) => row.dataset.entryId === entryA)!;
    const rowB = rows.find((row) => row.dataset.entryId === entryB)!;
    const rowC = rows.find((row) => row.dataset.entryId === entryC)!;

    expect(rowA.dataset.mixed).toBe("true");
    expect(
      within(rowA).getByTestId("task-result-export-mixed").textContent,
    ).toContain("混合");
    expect(within(rowA).getByText("保留 1 · 待审 1")).toBeTruthy();

    expect(rowB.dataset.mixed).toBe("false");
    expect(within(rowB).getByText("全保留")).toBeTruthy();

    expect(within(rowC).getByText("文件缺失")).toBeTruthy();
    expect(within(rowC).getByText("命中 0")).toBeTruthy();
  });

  it("invalidates the previous preview when the export conditions change", async () => {
    const { onPreview, onChooseDestination } = mountPanel();
    onChooseDestination.mockResolvedValue("D:/exports");
    onPreview.mockResolvedValue({
      snapshot: buildSnapshot(),
      preview: exportRecord([itemB]),
    });

    fireEvent.click(fileCheckbox("第二集/episode02.srt"));
    await chooseDestination(onChooseDestination, "D:/exports");
    const preview = await runPreview();

    expect(preview.dataset.stale).toBe("false");
    expect(screen.getByTestId("task-result-export-execute-button")).toBeEnabled();

    // Widening the selection must make the old preview non-executable.
    fireEvent.click(fileCheckbox("第一集/episode01.srt"));
    expect(
      screen.getByTestId("task-result-export-preview").dataset.stale,
    ).toBe("true");
    expect(
      screen.queryByTestId("task-result-export-execute-button"),
    ).toBeNull();
    expect(
      screen.getByTestId("task-result-export-preview-stale").textContent,
    ).toContain("不再可执行");
  });

  it("shows a partial receipt without claiming full success", async () => {
    const { onPreview, onExecute, onChooseDestination } = mountPanel();
    onChooseDestination.mockResolvedValue("D:/exports");
    onPreview.mockResolvedValue({
      snapshot: buildSnapshot(),
      preview: exportRecord([itemA, itemB]),
    });
    onExecute.mockResolvedValue({
      snapshot: buildSnapshot(),
      receipt: exportRecord(
        [
          exportItem(
            {
              entryId: entryA,
              sourceVersionId: sourceA,
              relativePath: "第一集/episode01.srt",
              matchedUnitIds: [unitA1],
            },
            { status: "copied" },
          ),
          exportItem(
            {
              entryId: entryB,
              sourceVersionId: sourceB,
              relativePath: "第二集/episode02.srt",
              matchedUnitIds: [unitB1, unitB2],
            },
            {
              status: "failed",
              error: "Source version or path changed; update the export preview",
            },
          ),
        ],
        { status: "partial", completedAt: 9, manifestStatus: "written" },
      ),
    });

    fireEvent.click(fileCheckbox("第一集/episode01.srt"));
    fireEvent.click(fileCheckbox("第二集/episode02.srt"));
    await chooseDestination(onChooseDestination, "D:/exports");
    await runPreview();
    fireEvent.click(screen.getByTestId("task-result-export-execute-button"));

    const receipt = await screen.findByTestId("task-result-export-receipt");
    expect(receipt.dataset.status).toBe("partial");
    expect(
      screen.getByTestId("task-result-export-receipt-status").textContent,
    ).toContain("部分成功");
    expect(
      screen.getByTestId("task-result-export-receipt-status").textContent,
    ).toContain("复制 1/2");
    expect(screen.queryByText(/全部成功/)).toBeNull();

    const failed = screen
      .getAllByTestId("task-result-export-receipt-item")
      .find((item) => item.dataset.itemStatus === "failed")!;
    expect(failed.textContent).toContain(
      "Source version or path changed; update the export preview",
    );
    expect(receipt.textContent).toContain("review-manifest.json");
  });

  it("restores the latest completed receipt from the snapshot without driving selection", () => {
    const snapshot = buildSnapshot();
    snapshot.originalExports = [
      exportRecord(
        [
          exportItem(
            {
              entryId: entryB,
              sourceVersionId: sourceB,
              relativePath: "第二集/episode02.srt",
              matchedUnitIds: [unitB1],
            },
            { status: "copied" },
          ),
        ],
        { id: uuid("r9"), status: "complete", completedAt: 5, manifestStatus: "written" },
      ),
    ];
    mountPanel(snapshot);

    const receipt = screen.getByTestId("task-result-export-receipt");
    expect(receipt.dataset.status).toBe("complete");
    expect(
      screen.getByTestId("task-result-export-receipt-status").textContent,
    ).toContain("全部成功");
    // Restored history is display-only: it never pre-selects files.
    expect(fileCheckbox("第二集/episode02.srt")).not.toBeChecked();
    expect(screen.getByTestId("task-result-export-preview-button")).toBeDisabled();
  });

  it("keeps the user selection across unrelated snapshot updates", async () => {
    const base = buildSnapshot();
    const { view, onChooseDestination } = mountPanel(base);
    fireEvent.click(fileCheckbox("第一集/episode01.srt"));
    await chooseDestination(onChooseDestination, "D:/keep");

    view.rerender(
      <ResultExportPanel
        snapshot={{ ...base, revision: 8 }}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onChooseDestination={onChooseDestination}
        defaultOpen
      />,
    );

    expect(fileCheckbox("第一集/episode01.srt")).toBeChecked();
    expect(
      screen.getByTestId("task-result-export-destination-path").textContent,
    ).toBe("D:/keep");
    expect(screen.getByText("已选 1 个文件")).toBeTruthy();
  });

  it("surfaces unavailable originals and their reasons in the preview", async () => {
    const { onPreview, onChooseDestination } = mountPanel();
    onChooseDestination.mockResolvedValue("D:/exports");
    const missingItem = exportItem(
      {
        entryId: entryC,
        sourceVersionId: sourceC,
        relativePath: "备注/notes.txt",
        matchedUnitIds: [unitC1],
      },
      {
        status: "unavailable",
        selectable: false,
        error: "Original source is missing and cannot be copied",
      },
    );
    onPreview.mockResolvedValue({
      snapshot: buildSnapshot(),
      preview: exportRecord([itemA, missingItem]),
    });

    fireEvent.click(fileCheckbox("第一集/episode01.srt"));
    fireEvent.click(fileCheckbox("备注/notes.txt"));
    await chooseDestination(onChooseDestination, "D:/exports");
    const preview = await runPreview();

    expect(preview.textContent).toContain("不可复制 1 个");
    const unavailable = screen
      .getAllByTestId("task-result-export-preview-item")
      .find((item) => item.dataset.itemStatus === "unavailable")!;
    expect(unavailable.textContent).toContain(
      "Original source is missing and cannot be copied",
    );
  });

  it("applies one category across the selection with inline overrides per entry", async () => {
    const { onPreview, onChooseDestination } = mountPanel();
    onChooseDestination.mockResolvedValue("D:/exports");
    onPreview.mockResolvedValue({
      snapshot: buildSnapshot(),
      preview: exportRecord([itemA, itemB]),
    });

    fireEvent.click(fileCheckbox("第一集/episode01.srt"));
    fireEvent.click(fileCheckbox("第二集/episode02.srt"));
    fireEvent.change(screen.getByLabelText("统一分类名"), {
      target: { value: "已通过" },
    });
    fireEvent.click(screen.getByTestId("task-result-export-apply-category"));
    fireEvent.change(screen.getByLabelText("分类 第二集/episode02.srt"), {
      target: { value: "返修" },
    });

    await chooseDestination(onChooseDestination, "D:/exports");
    await runPreview();

    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        classifications: [
          { entryId: entryA, category: "已通过" },
          { entryId: entryB, category: "返修" },
        ],
      }),
    );
  });
});

useChineseReviewLocale();
