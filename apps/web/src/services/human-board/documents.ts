import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardImport } from "./media";

export interface BoardDocumentAsset { path: string; resourceId?: string; mime?: string; missing?: string }
export interface BoardDocumentBinding {
  kind: "markdown" | "html" | "webpage";
  name: string;
  source?: string;
  documentPath?: string;
  url?: string;
  assets?: readonly BoardDocumentAsset[];
  snapshotResourceId?: string;
}
export interface BoardTransferInput { files?: readonly File[]; text?: string; imageUrl?: string; entries?: BoardImport[] }

export function boardDocumentBinding(element: ExcalidrawElement): BoardDocumentBinding | undefined {
  return ["markdown", "html", "webpage"].includes(String(element.customData?.kind)) ? element.customData as unknown as BoardDocumentBinding : undefined;
}

export function singleBoardUrl(text: string): string | undefined {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return undefined;
  try { return new URL(value).href; }
  catch (error) { if (!(error instanceof TypeError)) throw error; return undefined; }
}

/** Plain copying from a browser stays text; HTML is accepted only as an explicit file. */
export function boardTransferInput(data: Pick<DataTransfer, "files" | "getData">, drop = false): BoardTransferInput | undefined {
  const files = Array.from(data.files);
  if (files.length) return { files };
  const text = data.getData("text/plain");
  if (text.trimStart().startsWith("{") && text.includes("/clipboard")) {
    let parsed: { type?: unknown };
    try { parsed = JSON.parse(text); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; parsed = {}; }
    if (parsed.type === "excalidraw/clipboard" || parsed.type === "excalidraw-api/clipboard") return undefined;
  }
  if (drop) {
    const html = data.getData("text/html");
    const image = html ? new DOMParser().parseFromString(html, "text/html").querySelector("img") : null;
    const source = image?.getAttribute("src");
    if (source && /^(https?:\/\/|data:image\/)/i.test(source)) return { imageUrl: source };
  }
  // URI-list is the native link-drag format. Do not reinterpret a text paragraph.
  const uri = data.getData("text/uri-list").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  const url = singleBoardUrl(text || (uri.length === 1 ? uri[0] : ""));
  if (url) return { entries: [{ name: new URL(url).hostname, document: { kind: "webpage", name: new URL(url).hostname, url } }] };
  return text ? { text } : undefined;
}

export function resolveDocumentAsset(binding: BoardDocumentBinding, href: string): BoardDocumentAsset | undefined {
  const path = new URL(href, `https://board-document.invalid/${binding.documentPath ?? "document.md"}`).pathname.slice(1);
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(path); }
  catch (error) { if (!(error instanceof URIError)) throw error; return undefined; }
  // A malformed reference can share its recorded path with a valid encoded one.
  return binding.assets?.find(asset => asset.path === decodedPath && asset.resourceId)
    ?? binding.assets?.find(asset => asset.path === decodedPath);
}

export function documentPreviewSource(binding: BoardDocumentBinding): string {
  // Relative URLs keep their original identity in the saved source; only this
  // rendered projection maps them to the immutable resources.
  const resolve = (href: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;
    const asset = resolveDocumentAsset(binding, href);
    return asset?.resourceId ? `app://reelterminal/review-media/${asset.resourceId}` : href;
  };
  return (binding.source ?? "")
    .replace(/(!\[[^\]]*\]\(\s*<?)([^\s)>]+)(>?)/g, (_all, before, href, after) => `${before}${resolve(href)}${after}`)
    .replace(/(\b(?:src|poster)\s*=\s*["'])([^"']+)(["'])/gi, (_all, before, href, after) => `${before}${resolve(href)}${after}`)
    .replace(/(^\s*\[[^\]]+\]:\s*<?)([^\s>]+)/gm, (_all, before, href) => `${before}${resolve(href)}`);
}

let documentCaptureQueue: Promise<void> = Promise.resolve();

/** Concurrent region captures share one editor surface, so paint them in order. */
export function captureBoardDocument(element: HTMLElement, width: number, height: number): Promise<Blob> {
  const captured = documentCaptureQueue.then(() => captureDocumentViewport(element, width, height));
  // Each caller receives its own failure; a failed viewport does not cancel a
  // later independent capture already waiting for this shared surface.
  documentCaptureQueue = captured.then(() => undefined, () => undefined);
  return captured;
}

/** Capture the existing Markdown preview in an untransformed, white DOM viewport. */
async function captureDocumentViewport(element: HTMLElement, width: number, height: number): Promise<Blob> {
  const bridge = window.reelterminal?.humanBoardDocuments;
  if (!bridge) throw new Error("文档截图需要桌面版");
  const viewport = document.createElement("div");
  viewport.className = "human-board-document-capture";
  Object.assign(viewport.style, { position: "fixed", left: "0", top: "0", width: `${Math.min(width, window.innerWidth)}px`, height: `${Math.min(height, window.innerHeight)}px`, zIndex: "2147483647", background: "#fff", color: "#17202a", overflow: "hidden", pointerEvents: "none" });
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.transform = "none";
  clone.style.width = "100%";
  clone.style.height = "100%";
  clone.style.overflow = "hidden";
  viewport.append(clone);
  document.body.append(viewport);
  try {
    const originalScroll = element.matches("[data-document-scroll]") ? element : element.querySelector<HTMLElement>("[data-document-scroll]");
    const clonedScroll = clone.matches("[data-document-scroll]") ? clone : clone.querySelector<HTMLElement>("[data-document-scroll]");
    if (originalScroll && clonedScroll) { clonedScroll.scrollTop = originalScroll.scrollTop; clonedScroll.scrollLeft = originalScroll.scrollLeft; }
    await document.fonts.ready;
    await Promise.all([...clone.querySelectorAll("img")].map(image => image.decode().catch(error => {
      if (!(error instanceof DOMException)) throw error;
      // Missing referenced assets remain visibly missing, like the live preview.
    })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const png = await bridge.captureEditor({ x: 0, y: 0, width: viewport.offsetWidth, height: viewport.offsetHeight });
    return new Blob([new Uint8Array(png)], { type: "image/png" });
  } finally { viewport.remove(); }
}
