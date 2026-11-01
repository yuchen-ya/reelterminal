import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../../i18n";
import { BoardDocument } from "./BoardDocument";

afterEach(async () => { cleanup(); await changeAppLanguage(SYSTEM_LANGUAGE); });
it("updates native missing-reference errors and editor labels without changing paths or unsaved source", async () => {
  await changeAppLanguage("en");
  const element = { id: "document", width: 640, height: 420, customData: { kind: "html", name: "Keep", source: "<h1>用户原文</h1>",
    assets: [{ path: "用户路径/Keep.png", missing: "Referenced file is missing" }] } } as unknown as ExcalidrawElement;
  const before = structuredClone(element), update = vi.fn(async () => {});
  const { container } = render(<BoardDocument element={element} register={vi.fn()} onUpdate={update} onBrowse={vi.fn()} onLink={vi.fn()} onError={vi.fn()} />);
  expect(container.querySelector("details")).toHaveTextContent("用户路径/Keep.png：Referenced file is missing");
  fireEvent.click(screen.getByTestId("human-board-document-edit"));
  const editor = screen.getByRole("textbox", { name: "HTML source" });
  fireEvent.change(editor, { target: { value: "<h1>未保存的内容 Keep</h1>" } });
  await act(() => changeAppLanguage("zh-CN"));
  expect(screen.getByRole("textbox", { name: "HTML 原文" })).toBe(editor);
  expect(editor).toHaveValue("<h1>未保存的内容 Keep</h1>");
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("human-board-document-cancel"));
  expect(container.querySelector("details")).toHaveTextContent("用户路径/Keep.png：引用文件缺失");
  expect(element).toEqual(before);
});
