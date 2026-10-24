import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkbenchProvenanceTag } from "@reelterminal/core";
import type { FeedbackView } from "../types";
import {
  WorkbenchIssuePanel,
  type WorkbenchIssueEntry,
} from "./WorkbenchIssuePanel";

const TAGS: readonly WorkbenchProvenanceTag[] = [
  {
    id: "prov-master",
    category: "model",
    shortName: "母版",
    version: "v2",
    verification: "verified",
    detailSummary: "母版 v2 基线",
  },
  {
    id: "prov-edge",
    category: "algorithm",
    shortName: "边缘清理",
    verification: "declared",
    detailSummary: "边缘清理算法",
  },
];

const ISSUES: readonly WorkbenchIssueEntry[] = [
  {
    id: "ann-1",
    kind: "annotation",
    indexNumber: 1,
    coordinateLabel: "源像素 [10, 20, 30×40]",
    note: "第一条问题",
    version: 1,
    color: "#eab308",
    tool: "box",
  },
  {
    id: "ann-2",
    kind: "annotation",
    indexNumber: 2,
    coordinateLabel: "源像素 (50, 60)",
    note: "第二条问题",
    version: 1,
    color: "#ef4444",
    tool: "arrow",
  },
];

function renderPanel(overrides: Partial<Parameters<typeof WorkbenchIssuePanel>[0]> = {}) {
  const onSaveIssue = vi.fn(async () => ({ ok: true }) as const);
  const onDeleteIssue = vi.fn(async () => ({ ok: true }) as const);
  render(
    <WorkbenchIssuePanel
      itemId="item-1"
      itemVersion={1}
      issues={ISSUES}
      selectedIssueId="ann-1"
      onSelectIssue={() => undefined}
      onDeleteIssue={onDeleteIssue}
      onSaveIssue={onSaveIssue}
      provenanceTags={TAGS}
      widthPx={280}
      emptyHint="在画布上圈出问题"
      {...overrides}
    />,
  );
  return { onSaveIssue, onDeleteIssue };
}

describe("WorkbenchIssuePanel", () => {
  it("keeps drafts isolated per issue id and switches back unchanged", () => {
    const { rerender } = render(
      <WorkbenchIssuePanel
        itemId="item-1"
        itemVersion={1}
        issues={ISSUES}
        selectedIssueId="ann-1"
        onSelectIssue={() => undefined}
        onDeleteIssue={async () => ({ ok: true })}
        onSaveIssue={async () => ({ ok: true })}
        provenanceTags={TAGS}
        widthPx={280}
        emptyHint="在画布上圈出问题"
      />,
    );
    const textarea = screen.getByLabelText("问题建议");
    fireEvent.change(textarea, { target: { value: "只属于 #1 的草稿" } });

    rerender(
      <WorkbenchIssuePanel
        itemId="item-1"
        itemVersion={1}
        issues={ISSUES}
        selectedIssueId="ann-2"
        onSelectIssue={() => undefined}
        onDeleteIssue={async () => ({ ok: true })}
        onSaveIssue={async () => ({ ok: true })}
        provenanceTags={TAGS}
        widthPx={280}
        emptyHint="在画布上圈出问题"
      />,
    );
    expect(screen.getByLabelText("问题建议")).toHaveValue("第二条问题");

    rerender(
      <WorkbenchIssuePanel
        itemId="item-1"
        itemVersion={1}
        issues={ISSUES}
        selectedIssueId="ann-1"
        onSelectIssue={() => undefined}
        onDeleteIssue={async () => ({ ok: true })}
        onSaveIssue={async () => ({ ok: true })}
        provenanceTags={TAGS}
        widthPx={280}
        emptyHint="在画布上圈出问题"
      />,
    );
    expect(screen.getByLabelText("问题建议")).toHaveValue("只属于 #1 的草稿");
  });

  it("keeps the draft and surfaces the reason when saving fails", async () => {
    const onSaveIssue = vi.fn(async () => ({
      ok: false as const,
      code: "CONFLICT",
      message: "版本冲突",
    }));
    renderPanel({ onSaveIssue });

    const textarea = screen.getByLabelText("问题建议");
    fireEvent.change(textarea, { target: { value: "失败也要保留的草稿" } });
    fireEvent.click(screen.getByTestId("workbench-issue-save"));

    expect(await screen.findByText(/版本冲突（草稿已保留）/)).toBeInTheDocument();
    expect(screen.getByLabelText("问题建议")).toHaveValue("失败也要保留的草稿");
    expect(onSaveIssue).toHaveBeenCalledWith(
      "ann-1",
      expect.objectContaining({ text: "失败也要保留的草稿", markRework: false }),
    );
  });

  it("references real provenance tag ids and reports save vs rework distinctly", async () => {
    const { onSaveIssue } = renderPanel();
    fireEvent.change(screen.getByLabelText("问题建议"), {
      target: { value: "轮廓溢色" },
    });
    fireEvent.click(screen.getByRole("button", { name: /母版/ }));
    expect((screen.getByLabelText("问题建议") as HTMLTextAreaElement).value).toContain(
      "@母版",
    );

    fireEvent.click(screen.getByTestId("workbench-issue-save"));
    expect(await screen.findByText(/反馈已保存/)).toBeInTheDocument();
    expect(onSaveIssue).toHaveBeenCalledWith(
      "ann-1",
      expect.objectContaining({
        referencedTagIds: ["prov-master"],
        markRework: false,
      }),
    );

    fireEvent.change(screen.getByLabelText("问题建议"), {
      target: { value: "需要返工" },
    });
    fireEvent.click(screen.getByTestId("workbench-issue-rework"));
    expect(onSaveIssue).toHaveBeenLastCalledWith(
      "ann-1",
      expect.objectContaining({ markRework: true }),
    );
  });

  it("deletes exactly one issue and keeps the others listed", async () => {
    const { onDeleteIssue } = renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("workbench-issue-delete"));
    });
    expect(onDeleteIssue).toHaveBeenCalledWith("ann-1");
    expect(screen.getAllByTestId("workbench-issue-card")).toHaveLength(2);
  });

  it("reads saved feedback per issue and does not leak it to another issue", () => {
    const feedback: FeedbackView = {
      id: "fb-ann-1",
      text: "第一条已保存",
      referencedTagIds: ["prov-master"],
      targetSummary: "",
      target: { kind: "pixel-region", annotationId: "ann-1", x: 0.1, y: 0.2 },
      itemVersion: 1,
      wantsRework: false,
      isDraft: false,
      updatedAt: 1,
    };
    const onSelectIssue = vi.fn();
    renderPanel({ feedbacks: [feedback], onSelectIssue });
    expect(screen.getByTestId("workbench-issue-saved-state")).toHaveTextContent(
      "当前版本已保存",
    );

    fireEvent.click(screen.getAllByTestId("workbench-issue-card")[1]);
    expect(onSelectIssue).toHaveBeenCalledWith("ann-2");

    cleanup();
    renderPanel({ feedbacks: [feedback], selectedIssueId: "ann-2" });
    expect(screen.queryByTestId("workbench-issue-saved-state")).toBeNull();
    expect(screen.getByText(/当前版本尚未保存反馈/)).toBeInTheDocument();

    cleanup();
    renderPanel({ feedbacks: [feedback], selectedIssueId: "ann-1" });
    expect(screen.getByTestId("workbench-issue-saved-state")).toHaveTextContent(
      "当前版本已保存",
    );
  });

  it("preserves unresolved tag references and asks the user to re-select", async () => {
    const feedback: FeedbackView = {
      id: "fb-unresolved",
      text: "旧引用",
      referencedTagIds: ["missing-tag"],
      targetSummary: "",
      target: { kind: "pixel-region", annotationId: "ann-1", x: 0.1, y: 0.2 },
      itemVersion: 1,
      wantsRework: false,
      isDraft: false,
      updatedAt: 1,
    };
    const { onSaveIssue } = renderPanel({ feedbacks: [feedback] });
    expect(screen.getByTestId("workbench-issue-unresolved-tag")).toHaveTextContent(
      "引用失效",
    );

    fireEvent.click(screen.getByTestId("workbench-issue-save"));
    expect(await screen.findByText(/反馈已保存/)).toBeInTheDocument();
    expect(onSaveIssue).toHaveBeenCalledWith(
      "ann-1",
      expect.objectContaining({ referencedTagIds: ["missing-tag"] }),
    );
  });
});
