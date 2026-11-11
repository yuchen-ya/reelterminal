import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../../i18n";
import type { HumanBoard } from "../../../services/human-board/storage";

const fixture = vi.hoisted(() => ({ hydrate: vi.fn(async () => ({})), resources: vi.fn(async () => []), save: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock("../../../services/human-board/storage", () => ({ humanBoardStorage: { resources: fixture.resources, save: fixture.save } }));
vi.mock("../../../services/human-board/media", async importOriginal => ({ ...await importOriginal<object>(), hydrateBoardFiles: fixture.hydrate, cancelBoardHtmlPreviews: fixture.cancel }));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: ({ langCode }: { langCode: string }) => <div data-testid="excalidraw-locale" data-locale={langCode} />,
  MainMenu: Object.assign(() => null, { Item: () => null, DefaultItems: { Help: () => null } }),
  CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
}));
import HumanBoardCanvas from "./HumanBoardCanvas";

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await changeAppLanguage(SYSTEM_LANGUAGE); });
it("passes current locale to Excalidraw without rehydrating or renaming an existing board", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
  await changeAppLanguage("en");
  const board: HumanBoard = { id: "existing", name: "Keep", revision: 3, updatedAt: 1, elements: [], appState: {}, imageFiles: {}, resourceIds: [] };
  render(<HumanBoardCanvas initialBoard={board} incoming={null} onIncomingConsumed={vi.fn()} onImport={vi.fn()} onSaved={vi.fn()} onFlush={vi.fn()} onLayoutLockChange={vi.fn()} />);
  const canvas = await screen.findByTestId("excalidraw-locale");
  expect(canvas).toHaveAttribute("data-locale", "en");
  const name = screen.getByRole("textbox", { name: "Board name" });
  expect(name).toHaveValue("Keep");
  await act(() => changeAppLanguage(SYSTEM_LANGUAGE));
  expect(screen.getByTestId("excalidraw-locale")).toBe(canvas);
  expect(canvas).toHaveAttribute("data-locale", "zh-CN");
  expect(screen.getByTestId("human-board-name")).toBe(name);
  expect(name).toHaveValue("Keep");
  await act(() => changeAppLanguage("en"));
  expect(canvas).toHaveAttribute("data-locale", "en");
  expect(fixture.hydrate).toHaveBeenCalledTimes(1);
  expect(fixture.save).not.toHaveBeenCalled();
  expect(board.name).toBe("Keep");
});
