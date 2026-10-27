import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextCorpusWorkspace } from "./TextCorpusWorkspace";
import ReviewMarkdown from "./ReviewMarkdown";
import type { WorkbenchItemView } from "../types";

afterEach(cleanup);

const markdown = "# 工作方案\n\n## 步骤\n\n- **检查**素材\n- 导出\n\n| 项目 | 状态 |\n| --- | --- |\n| A | 完成 |\n\n```json\n{\"ready\": true}\n```";
function textItem(): WorkbenchItemView {
  return { id: "text-1", batchId: "batch", orderIndex: 0, title: "说明", subtitle: "", type: "text", version: 1,
    status: "pending", hasManualRevision: false, provenanceTags: [], userCategoryTags: [], feedbacks: [],
    textPayload: { entryId: "entry", title: "说明", speakerOrContext: "", originalText: markdown, currentText: markdown,
      originalVersion: 1, currentVersion: 1, rangeComments: [] } };
}

it("uses the open-source renderer for headings, lists, tables and code without active HTML", () => {
  const { container } = render(<ReviewMarkdown source={`${markdown}\n\n[unsafe](javascript:alert(1))\n\n<iframe src="javascript:alert(1)"></iframe><img src="x" onerror="alert(1)" />`} />);
  expect(screen.getByRole("heading", { level: 1, name: "工作方案" })).toBeInTheDocument();
  expect(screen.getByRole("table")).toHaveTextContent("完成");
  expect(container.querySelector("strong")).toHaveTextContent("检查");
  expect(container.querySelector("pre code")).toHaveTextContent('"ready": true');
  expect(container.querySelector("iframe,script,[onerror],[href^='javascript:']")).toBeNull();
});

it("edits Markdown through the package editor and anchors comments only to exact source offsets", async () => {
  const item = textItem();
  const save = vi.fn(async () => ({ ok: true as const }));
  const comment = vi.fn(async () => ({ ok: true as const }));
  render(<TextCorpusWorkspace currentItem={item} batchTextItems={[item]} selectedIds={[item.id]}
    onSelectItem={vi.fn()} onSaveTextRevision={save} onAddRangeComment={comment} onConfirmDuplicate={vi.fn()} />);
  await screen.findByRole("heading", { name: "工作方案", level: 1 });
  expect(screen.getByTestId("text-body")).toHaveAttribute("data-mode", "markdown");
  fireEvent.click(screen.getByRole("button", { name: "原文与批注" }));
  const body = screen.getByTestId("text-body");
  expect(body.textContent).toBe(markdown);
  const start = markdown.indexOf("检查");
  const range = document.createRange();
  range.setStart(body.firstChild!, start);
  range.setEnd(body.firstChild!, start + 2);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(body);
  fireEvent.click(screen.getByRole("button", { name: "锚定区间批注" }));
  await waitFor(() => expect(comment).toHaveBeenCalledWith(item.id, expect.objectContaining({ startOffset: start, endOffset: start + 2, quotedText: "检查" }), 1));
  fireEvent.click(screen.getByRole("button", { name: "直接改文" }));
  const editor = await screen.findByRole("textbox", { name: "Markdown 原文" });
  expect(editor).toHaveValue(markdown);
  fireEvent.change(editor, { target: { value: `${markdown}\n\n> 新备注` } });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(item.id, `${markdown}\n\n> 新备注`));
});
