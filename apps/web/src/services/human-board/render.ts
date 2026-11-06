import { uiMessage as canonicalMessage } from "../../i18n/messages";
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

// Chromium does not load SVG @font-face resources when the SVG is decoded as
// an image, including data URLs. Paint text with the board's loaded fonts before
// decoding the rest of the SVG, retaining each text node's parent transform,
// clipping, opacity and position in the drawing order.
async function rasterizeSvgText(svg: SVGSVGElement, scale: number): Promise<void> {
  await document.fonts.ready;
  for (const text of svg.querySelectorAll("text")) {
    if (!text.textContent) continue;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const font = `${text.getAttribute("font-size")} ${text.getAttribute("font-family")}`;
    context.font = font;
    context.direction = text.getAttribute("direction") === "rtl" ? "rtl" : "ltr";
    const anchor = text.getAttribute("text-anchor");
    context.textAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
    const metrics = context.measureText(text.textContent);
    const padding = 2;
    const left = -metrics.actualBoundingBoxLeft - padding;
    const top = -metrics.actualBoundingBoxAscent - padding;
    const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + padding * 2;
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + padding * 2;
    canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
    context.scale(scale, scale);
    context.font = font;
    context.direction = text.getAttribute("direction") === "rtl" ? "rtl" : "ltr";
    context.textAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
    context.fillStyle = text.getAttribute("fill")!;
    context.fillText(text.textContent, -left, -top);
    const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
    image.setAttribute("x", String(Number(text.getAttribute("x")) + left));
    image.setAttribute("y", String(Number(text.getAttribute("y")) + top));
    image.setAttribute("width", String(canvas.width / scale));
    image.setAttribute("height", String(canvas.height / scale));
    image.setAttribute("href", canvas.toDataURL("image/png"));
    text.replaceWith(image);
  }
}

/** Freeze playback and render media from source pixels/3D scene, never screen pixels. */
export async function freezeBoardScene(elements: readonly ExcalidrawElement[], files: BinaryFiles, captures: ReadonlyMap<string, MediaCapture>): Promise<FrozenBoardScene> {
  const snapshot = structuredClone(elements.filter(element => !element.isDeleted));
  const binaryFiles = { ...files };
  const frozen = await Promise.all(snapshot.map(async element => {
    if (element.type !== "embeddable") return element;
    const capture = captures.get(element.id);
    if (!capture) throw new Error(canonicalMessage("Media is not ready: {{v0}}", { v0: String(element.customData?.name ?? element.id) }));
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
  if (!visible.length) throw new Error(canonicalMessage("The board has no content to capture"));
  const [left, top, right, bottom] = getCommonBounds(visible);
  const area = region ?? { x: left, y: top, width: right - left, height: bottom - top };
  if (!(area.width > 0 && area.height > 0)) throw new Error(canonicalMessage("Select a valid region"));
  let scale = 1;
  for (const element of visible) if (element.type === "image" && element.fileId && scene.files[element.fileId]) {
    const [x1, y1, x2, y2] = getCommonBounds([element]);
    if (x2 < area.x || y2 < area.y || x1 > area.x + area.width || y1 > area.y + area.height) continue;
    const size = await imageSize(scene.files[element.fileId].dataURL);
    scale = Math.max(scale, (element.crop?.width ?? size.width) / element.width, (element.crop?.height ?? size.height) / element.height);
  }
  const width = Math.ceil(area.width * scale), height = Math.ceil(area.height * scale);
  if (width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error(canonicalMessage("This region exceeds 64MP or 16384 pixels at source resolution; select a smaller region"));
  const exportBackground = region?.transparentBackground ? false : scene.appState.exportBackground !== false;
  const svg = await exportToSvg({
    elements: visible,
    appState: { ...scene.appState, exportBackground },
    files: scene.files,
    exportPadding: 0,
    skipInliningFonts: true,
  });
  await rasterizeSvgText(svg, scale);
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
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(canonicalMessage("Unable to generate PNG"))), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
