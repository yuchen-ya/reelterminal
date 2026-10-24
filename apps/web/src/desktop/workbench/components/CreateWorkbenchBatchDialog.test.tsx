import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreateWorkbenchBatchDialog } from "./CreateWorkbenchBatchDialog";
import type { WorkbenchMediaAsset } from "../types";

const ASSETS: readonly WorkbenchMediaAsset[] = [
  {
    id: "media-img",
    name: "镜头 A.png",
    type: "image",
    thumbnailUrl: null,
    width: 1024,
    height: 1024,
    usage: "pending",
  },
  {
    id: "media-vid",
    name: "镜头 B.mp4",
    type: "video",
    thumbnailUrl: null,
    width: 1920,
    height: 1080,
    durationSec: 12.5,
    usage: "processed",
  },
];

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof CreateWorkbenchBatchDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onCreate = vi.fn();
  const onOpenMediaLibrary = vi.fn();
  render(
    <CreateWorkbenchBatchDialog
      isOpen
      onOpenChange={onOpenChange}
      assets={ASSETS}
      onCreate={onCreate}
      onOpenMediaLibrary={onOpenMediaLibrary}
      {...overrides}
    />,
  );
  return { onOpenChange, onCreate, onOpenMediaLibrary };
}

afterEach(cleanup);

describe("CreateWorkbenchBatchDialog", () => {
  it("shows pending and processed usage separately", () => {
    renderDialog();
    expect(screen.getByTestId("media-usage-pending")).toHaveTextContent(
      "已在工作台 · 待处理",
    );
    expect(screen.getByTestId("media-usage-processed")).toHaveTextContent("已审阅");
    expect(screen.getAllByTestId("create-batch-media-card")).toHaveLength(2);
  });

  it("reuses the frozen batch/item ids when retrying the same selection", async () => {
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "IO", message: "模拟失败" })
      .mockResolvedValueOnce({
        ok: true,
        batchId: "frozen-batch",
        itemIds: ["frozen-item"],
      });
    renderDialog({ onCreate });

    fireEvent.click(screen.getAllByTestId("create-batch-media-card")[0]);
    fireEvent.click(screen.getByTestId("create-batch-submit"));
    expect(await screen.findByText("模拟失败")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("create-batch-submit"));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));

    const first = onCreate.mock.calls[0][0];
    const second = onCreate.mock.calls[1][0];
    expect(second.batchId).toBe(first.batchId);
    expect(second.itemIds).toEqual(first.itemIds);
    expect(second.mediaIds).toEqual(first.mediaIds);
  });

  it("mints a new submission after the media selection changes", async () => {
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "IO", message: "模拟失败" })
      .mockResolvedValueOnce({ ok: true, batchId: "b", itemIds: ["i"] });
    renderDialog({ onCreate });

    fireEvent.click(screen.getAllByTestId("create-batch-media-card")[0]);
    fireEvent.click(screen.getByTestId("create-batch-submit"));
    expect(await screen.findByText("模拟失败")).toBeInTheDocument();

    // Change the selection: the old frozen identity must not be reused.
    fireEvent.click(screen.getAllByTestId("create-batch-media-card")[1]);
    fireEvent.click(screen.getByTestId("create-batch-submit"));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));

    const first = onCreate.mock.calls[0][0];
    const second = onCreate.mock.calls[1][0];
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.itemIds).not.toEqual(first.itemIds);
    expect(second.mediaIds).toEqual(["media-img", "media-vid"]);
  });

  it("disables submit until media is selected and opens the real host media panel", () => {
    const { onOpenMediaLibrary } = renderDialog({ assets: [] });
    expect(screen.getByTestId("create-batch-submit")).toBeDisabled();
    expect(screen.getByText(/项目素材库没有图片\/视频/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("create-batch-open-media"));
    expect(onOpenMediaLibrary).toHaveBeenCalledTimes(1);
  });
});
