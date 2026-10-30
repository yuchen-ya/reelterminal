import { expect, it, vi } from "vitest";
import { renderBoardRegion } from "./render";

// Geometry and SVG painting are exercised by the real pixel E2E. Isolate this
// allocation guard from the browser-only Excalidraw package in Node.
vi.mock("@excalidraw/excalidraw", () => ({
  getCommonBounds: vi.fn(() => [0, 0, 128, 128]),
  convertToExcalidrawElements: vi.fn(), exportToSvg: vi.fn(),
}));
vi.mock("./media", () => ({ imageSize: vi.fn(async () => ({ width: 1024, height: 1024 })) }));

it.each([
  { width: 16385, height: 1 },
  { width: 8193, height: 8193 },
])("rejects an oversized region before allocating its canvas: %j", async region => {
  const elements = [{ type: "rectangle" }] as unknown as Parameters<typeof renderBoardRegion>[0]["elements"];
  await expect(renderBoardRegion({ elements, files: {}, appState: {} }, { x: 0, y: 0, ...region })).rejects.toThrow(/64MP.*16384/);
});

it("applies the limit at source image density rather than the small scene rectangle", async () => {
  const elements = [{ type: "image", fileId: "source", width: 128, height: 128 }] as unknown as Parameters<typeof renderBoardRegion>[0]["elements"];
  const files = { source: { id: "source", dataURL: "data:image/png;base64,AA==", mimeType: "image/png", created: 0 } } as unknown as Parameters<typeof renderBoardRegion>[0]["files"];
  await expect(renderBoardRegion({ elements, files, appState: {} }, { x: 0, y: 0, width: 3000, height: 3000 })).rejects.toThrow(/64MP.*16384/);
});
