import { convertToExcalidrawElements, exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { blobDataUrl, imageSize } from "./media";

export interface BoardPoint { x: number; y: number }
export interface BoardRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  points?: readonly BoardPoint[];
  transparentBackground?: boolean;
}
export interface FrozenBoardScene { elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles }
export type MediaCapture = () => Promise<Blob>;

/** Freeze playback and render media from source pixels/3D scene, never screen pixels. */
export async function freezeBoardScene(elements: readonly ExcalidrawElement[], files: BinaryFiles, captures: ReadonlyMap<string, MediaCapture>): Promise<FrozenBoardScene> {
  const snapshot = structuredClone(elements.filter(element => !element.isDeleted));
  const binaryFiles = { ...files };
  const frozen = await Promise.all(snapshot.map(async element => {
    if (element.type !== "embeddable") return element;
    const capture = captures.get(element.id);
    if (!capture) throw new Error(`媒体尚未就绪：${String(element.customData?.name ?? element.id)}`);
    const blob = await capture();
    const id = crypto.randomUUID() as FileId;
    binaryFiles[id] = { id, dataURL: await blobDataUrl(blob), mimeType: "image/png", created: Date.now() };
    const image = convertToExcalidrawElements([{ type: "image", fileId: id, x: element.x, y: element.y, width: element.width, height: element.height }])[0];
    return { ...image, id: element.id, angle: element.angle, opacity: element.opacity, groupIds: element.groupIds, frameId: element.frameId };
  }));
  return { elements: frozen, files: binaryFiles, appState: { viewBackgroundColor: "#ffffff", theme: "light", exportBackground: true, exportWithDarkMode: false } };
}

/** SVG keeps source images/text/marks and clips at scene coordinates before rasterizing. */
export async function renderBoardRegion(scene: FrozenBoardScene, region?: BoardRegion): Promise<Blob> {
  const visible = scene.elements.filter(element => !element.isDeleted);
  if (!visible.length) throw new Error("画板没有可截图的内容");
  const [left, top, right, bottom] = getCommonBounds(visible);
  const area = region ?? { x: left, y: top, width: right - left, height: bottom - top };
  if (!(area.width > 0 && area.height > 0)) throw new Error("请框选一个有效区域");
  let scale = 1;
  for (const element of visible) if (element.type === "image" && element.fileId && scene.files[element.fileId]) {
    const [x1, y1, x2, y2] = getCommonBounds([element]);
    if (x2 < area.x || y2 < area.y || x1 > area.x + area.width || y1 > area.y + area.height) continue;
    const size = await imageSize(scene.files[element.fileId].dataURL);
    scale = Math.max(scale, (element.crop?.width ?? size.width) / element.width, (element.crop?.height ?? size.height) / element.height);
  }
  const width = Math.ceil(area.width * scale), height = Math.ceil(area.height * scale);
  if (width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error("该区域在源分辨率下超过 64MP 或 16384 像素，请缩小截图区域");
  const exportBackground = region?.transparentBackground ? false : scene.appState.exportBackground !== false;
  const svg = await exportToSvg({
    elements: visible,
    appState: { ...scene.appState, exportBackground },
    files: scene.files,
    exportPadding: 0,
  });
  svg.setAttribute("viewBox", `${area.x - left} ${area.y - top} ${area.width} ${area.height}`);
  svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    if (area.points && area.points.length >= 3) {
      context.save();
      context.beginPath();
      area.points.forEach((pt, idx) => {
        const px = (pt.x - area.x) * scale;
        const py = (pt.y - area.y) * scale;
        if (idx === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      });
      context.closePath();
      context.clip();
    }
    if (exportBackground) {
      context.fillStyle = scene.appState.viewBackgroundColor ?? "#ffffff"; context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0);
    if (area.points && area.points.length >= 3) {
      context.restore();
    }
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成 PNG")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
