import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../../i18n";
import { useWorkbenchTabsStore } from "../../../stores/workbench-tabs-store";
import { WorkbenchTabs } from "./WorkbenchTabs";
import { WorkbenchQueueState } from "./WorkbenchQueueState";
import { SimpleBottomDetailsTimeline } from "./SimpleBottomDetailsTimeline";

beforeEach(async () => {
  useWorkbenchTabsStore.setState({ tabs: [{ kind: "board", id: "existing", name: "Keep" }], activeKey: "board:existing" });
  await changeAppLanguage("en");
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await changeAppLanguage(SYSTEM_LANGUAGE); });

describe("workbench language switching without remounting", () => {
  it("updates tab controls in both directions and retains persisted names and selection", async () => {
    const props = { locked: false, managerOpen: true, onActivate: vi.fn(), onClose: vi.fn(), onOpen: vi.fn(), onCloseManager: vi.fn() };
    render(<WorkbenchTabs {...props} />);
    expect(screen.getByRole("tablist", { name: "Review Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Keep" })).toBeInTheDocument();
    await act(() => changeAppLanguage("zh-CN"));
    expect(screen.getByRole("tablist", { name: "审阅工作台" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 Keep" })).toBeInTheDocument();
    expect(screen.getByTestId("review-workspace-open")).toHaveAttribute("title", "打开或管理审阅任务与自由画板");
    await act(() => changeAppLanguage("en"));
    expect(screen.getByTestId("review-workspace-open")).toHaveAttribute("title", "Open or manage review tasks and free boards");
    expect(useWorkbenchTabsStore.getState().tabs).toEqual([{ kind: "board", id: "existing", name: "Keep" }]);
    expect(useWorkbenchTabsStore.getState().activeKey).toBe("board:existing");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("follows System while explicit choices override an opposite system locale", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    render(<WorkbenchQueueState kind="queue-done" processedCount={3} onResetFilters={vi.fn()} onOpenHandoff={vi.fn()} onSwitchToAll={vi.fn()} />);
    expect(screen.getByTestId("workbench-queue-done")).toHaveTextContent("The current queue is complete");
    await act(() => changeAppLanguage(SYSTEM_LANGUAGE));
    expect(screen.getByTestId("workbench-queue-done")).toHaveTextContent("当前队列已全部处理");
    expect(screen.getByRole("button", { name: "查看并发布审阅结果 (3)" })).toBeInTheDocument();
    await act(() => changeAppLanguage("en"));
    expect(screen.getByRole("button", { name: "Review and publish results (3)" })).toBeInTheDocument();
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    await act(() => changeAppLanguage("zh-CN"));
    expect(screen.getByTestId("workbench-queue-done")).toHaveTextContent("当前队列已全部处理");
  });
});

it("retranslates retained history-blocking reasons without enabling the blocked action", async () => {
  const reason = "The next history entry is a video template. Undo it in the video editor.";
  const onUndo = vi.fn(async () => ({ ok: true as const }));
  render(<SimpleBottomDetailsTimeline currentItem={null} canUndo={false} canRedo={false} undoDisabledReason={reason}
    onSelectItemById={vi.fn()} onCommitDecision={vi.fn(async () => ({ ok: true as const }))} onSkipNext={vi.fn()}
    onUndoLast={onUndo} onRedoLast={vi.fn(async () => ({ ok: true as const }))} onAddUserTag={vi.fn(async () => ({ ok: true as const }))} />);
  const undo = screen.getByRole("button", { name: "Undo the last review action" });
  expect(undo).toHaveAttribute("title", reason);
  await act(() => changeAppLanguage("zh-CN"));
  expect(screen.getByRole("button", { name: "撤销上一次审阅操作" })).toBe(undo);
  expect(undo).toHaveAttribute("title", "下一步是视频模板历史，请在视频编辑器中撤销");
  expect(undo).toBeDisabled();
  expect(onUndo).not.toHaveBeenCalled();
});
