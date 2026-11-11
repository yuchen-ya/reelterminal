import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import type { FileResource } from "@reelterminal/core/review/types";
import type { HumanBoard } from "../../../services/human-board/storage";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../../i18n";

const fixture = vi.hoisted(() => ({ resources: vi.fn() }));
vi.mock("../../../services/human-board/storage", () => ({ humanBoardStorage: { resources: fixture.resources } }));
import { BoardFileOutput } from "./BoardFileOutput";

const board: HumanBoard = { id: "board", name: "Board", revision: 7, updatedAt: 1, elements: [], appState: {}, imageFiles: {}, resourceIds: ["model"] };
const resource = { id: "model", storage: { kind: "managed" } } as FileResource;
const prepare = vi.fn(), status = vi.fn(), copy = vi.fn(), showOpenDialog = vi.fn();
const state = (exportId: string, phase: ReviewExportStatus["state"]): ReviewExportStatus => ({
  exportId, nodeId: board.id, nodeRevision: board.revision, state: phase,
  completedFiles: phase === "ready" ? 1 : 0, totalFiles: 1,
  ...(phase === "failed" ? { error: { reason: "missing-source", message: "Export source is missing" } } : {}),
});
function Output() {
  const [error, setError] = useState("");
  return <><BoardFileOutput board={board} output={{ name: "model.glb", resource, image: false }}
    onClose={vi.fn()} onAddImage={vi.fn()} onError={error => setError((error as Error).message)} />
    {error && <div role="alert">{error}</div>}</>;
}

beforeEach(async () => {
  await changeAppLanguage("en");
  vi.useFakeTimers();
  fixture.resources.mockResolvedValue([resource]);
  prepare.mockImplementation(async ({ exportId }) => ({ ok: true, value: state(exportId, "preparing") }));
  copy.mockResolvedValue({ ok: true, value: {} });
  showOpenDialog.mockResolvedValue("/fixture/saved");
  Object.defineProperty(window, "reelterminal", { configurable: true, value: {
    fs: { showOpenDialog }, reviewExport: { prepare, status, copy },
  } });
});
afterEach(async () => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); await changeAppLanguage(SYSTEM_LANGUAGE); });

it("waits for native preparation beyond one second and saves only the ready immutable export", async () => {
  const started = Date.now();
  status.mockImplementation(async ({ exportId }) => ({ ok: true, value: state(exportId, Date.now() - started >= 2000 ? "ready" : "preparing") }));
  render(<Output />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  const save = screen.getByTestId("human-board-output-save");
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(showOpenDialog).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  expect(screen.getByTestId("human-board-output-drag")).toHaveAttribute("draggable", "false");
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(save).toBeEnabled();
  const request = prepare.mock.calls[0][0];
  expect(fixture.resources).toHaveBeenCalledWith(board.id);
  expect(request).toEqual({ exportId: expect.any(String), nodeId: board.id, nodeRevision: 7, name: "Board",
    mode: "version", scope: "selected", entries: [{ fileName: "model.glb", resourceId: "model" }] });
  expect(status).toHaveBeenCalledWith({ exportId: request.exportId, nodeId: board.id });
  await act(async () => { fireEvent.click(save); });
  expect(showOpenDialog).toHaveBeenCalledWith({ directory: true, filters: [] });
  expect(copy).toHaveBeenCalledExactlyOnceWith({ exportId: request.exportId, nodeId: board.id, directory: "/fixture/saved", source: "user" });
  expect(screen.getByRole("status")).toHaveTextContent("Saved to /fixture/saved");
});

it("reports failed native preparation and never offers a save or claims success", async () => {
  status.mockImplementation(async ({ exportId }) => ({ ok: true, value: state(exportId, "failed") }));
  render(<Output />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByRole("alert")).toHaveTextContent("Export source is missing");
  expect(screen.getByTestId("human-board-output-save")).toBeDisabled();
  fireEvent.click(screen.getByTestId("human-board-output-save"));
  expect(showOpenDialog).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).not.toHaveTextContent("Saved to");
});
