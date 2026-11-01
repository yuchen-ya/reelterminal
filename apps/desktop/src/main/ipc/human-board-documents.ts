import { uiMessageKey } from "@reelterminal/core/ui-message";
import { app, session, WebContentsView, type NativeImage, type WebContents } from "electron";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { getEditorWindow } from "../editor-window";
import { importBoardDocument, isDocumentPathWithin } from "../human-board-documents";
import { getReviewFileStore } from "./review-files";
import { handle } from "./index";

const rectangle = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).strict();
const asset = z.object({ path: z.string().min(1).max(2048), resourceId: z.string().uuid().optional(), mime: z.string().optional(), missing: z.string().optional() }).strict();
interface Guest { id: string; view: WebContentsView; directory?: string; attached: boolean; disposed: boolean }
let guest: Guest | undefined;
const previews = new Map<string, Guest>();
const observedWindows = new WeakSet<Electron.BrowserWindow>();

async function disposeGuest(current: Guest): Promise<void> {
  current.disposed = true;
  previews.delete(current.id);
  if (current.attached) { getEditorWindow()?.contentView.removeChildView(current.view); current.attached = false; }
  if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  const editor = getEditorWindow();
  if (editor?.isFocused()) editor.webContents.focus();
  if (current.directory) {
    const root = path.resolve(app.getPath("temp"));
    if (!isDocumentPathWithin(root, current.directory) || !path.basename(current.directory).startsWith("reelterminal-board-")) throw new Error("Invalid document temporary directory");
    await rm(current.directory, { recursive: true, force: true });
  }
}

async function closeGuest(id?: string): Promise<void> {
  if (id && previews.has(id)) { await disposeGuest(previews.get(id)!); return; }
  if (!guest || (id && guest.id !== id)) return;
  const previous = guest;
  guest = undefined;
  await disposeGuest(previous);
}

function waitForPreviewPaint(current: Guest): Promise<void> {
  const contents = current.view.webContents;
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      contents.removeListener("destroyed", cancelled);
      if (!contents.isDestroyed()) contents.endFrameSubscription();
      if (error) reject(error); else resolve();
    };
    const cancelled = () => finish(new Error(uiMessageKey("HTML preview cancelled")));
    const timeout = setTimeout(() => finish(new Error(uiMessageKey("The HTML preview has not completed its first paint"))), 10000);
    contents.once("destroyed", cancelled);
    contents.beginFrameSubscription(false, image => { if (!image.isEmpty()) finish(); });
    current.view.setVisible(true);
  });
}

function requireGuest(id: string): Guest {
  if (!guest || guest.id !== id) throw new Error(uiMessageKey("The webpage view was closed or switched"));
  return guest;
}

function frameHasDocumentToken(frame: NativeImage, frameToken: number, scale: number): boolean {
  const size = frame.getSize();
  for (let bit = 0; bit < 32; bit++) {
    const x = Math.floor((bit * 8 + 4) * scale), y = Math.floor(4 * scale);
    if (x >= size.width || y >= size.height) return false;
    const pixel = frame.crop({ x, y, width: 1, height: 1 }).toBitmap({ scaleFactor: 1 });
    // Native bitmap channel order is platform dependent. Black/white has the
    // same three color bytes in every order; the fourth byte is opaque alpha.
    const matches = [...pixel.subarray(0, 4)].filter(value => (frameToken >>> bit) & 1 ? value > 223 : value < 32).length;
    if (matches < 3) return false;
  }
  return true;
}

function capturePresentedFrame(contents: WebContents, accepts: (frame: NativeImage) => boolean): Promise<NativeImage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let copying = false;
    const cleanup = () => {
      clearTimeout(timeout);
      contents.removeListener("destroyed", cancelled);
      if (!contents.isDestroyed()) contents.endFrameSubscription();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      setImmediate(() => { cleanup(); reject(error); });
    };
    const cancelled = () => fail(new Error(uiMessageKey("Document capture cancelled")));
    const timeout = setTimeout(() => fail(new Error(uiMessageKey("The document preview has not finished painting"))), 10000);
    contents.once("destroyed", cancelled);
    contents.beginFrameSubscription(false, frame => {
      if (settled || copying || frame.isEmpty()) return;
      try {
        if (!accepts(frame)) {
          setImmediate(() => { if (!settled && !contents.isDestroyed()) contents.invalidate(); });
          return;
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
      copying = true;
      // Subscription frames identify presentation, but Electron discards their
      // colour profile. capturePage retains it for colour-correct PNG encoding.
      // Check its receipt too: the copy can race a document/surface change.
      setImmediate(async () => {
        if (settled) return;
        try {
          const image = await contents.capturePage();
          if (settled) return;
          if (!image.isEmpty() && accepts(image)) {
            settled = true;
            cleanup();
            resolve(image);
          } else {
            copying = false;
            contents.invalidate();
          }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    contents.invalidate();
  });
}

export function registerHumanBoardDocumentsIpc(): void {
  handle(CHANNELS.boardDocumentImport, z.object({ sourcePath: z.string().min(1) }).strict(), args => importBoardDocument(args.sourcePath));
  handle(CHANNELS.boardDocumentClose, z.object({ id: z.string().uuid() }).strict(), args => closeGuest(args.id));
  handle(CHANNELS.boardDocumentResize, z.object({ id: z.string().uuid(), bounds: rectangle }).strict(), args => {
    requireGuest(args.id).view.setBounds(args.bounds);
  });
  handle(CHANNELS.boardDocumentCapture, z.object({ id: z.string().uuid() }).strict(), async args => {
    const current = requireGuest(args.id);
    if (current.view.webContents.isLoadingMainFrame()) throw new Error(uiMessageKey("The page is still loading; capture it shortly"));
    const image = await current.view.webContents.capturePage();
    if (image.isEmpty()) throw new Error(uiMessageKey("The page has no viewport to capture yet"));
    return { png: image.toPNG(), url: current.view.webContents.getURL() };
  });
  handle(CHANNELS.boardDocumentCaptureEditor, rectangle.extend({ frameToken: z.number().int().min(0).max(0xffffffff) }), async bounds => {
    const editor = getEditorWindow()!;
    const contents = editor.webContents;
    // Presentation alone does not identify the renderer's current document.
    // Accept only its paint receipt, then crop the receipt out of the result.
    const frame = await capturePresentedFrame(contents, candidate => frameHasDocumentToken(candidate, bounds.frameToken,
      candidate.getSize().width / editor.getContentSize()[0] * contents.getZoomFactor()));
    const size = frame.getSize();
    const scale = size.width / editor.getContentSize()[0] * contents.getZoomFactor();
    const x = Math.ceil(bounds.x * scale), y = Math.ceil(bounds.y * scale);
    const width = Math.min(size.width, Math.floor((bounds.x + bounds.width) * scale)) - x;
    const height = Math.min(size.height, Math.floor((bounds.y + bounds.height) * scale)) - y;
    if (width <= 0 || height <= 0) throw new Error(uiMessageKey("The document capture region moved outside the window; try again"));
    const image = frame.crop({ x, y, width, height });
    if (image.isEmpty()) throw new Error(uiMessageKey("The document preview is not ready"));
    return image.toPNG();
  });
  handle(CHANNELS.boardDocumentOpen, z.object({ id: z.string().uuid(), bounds: rectangle, url: z.url().optional(), source: z.string().max(200000).optional(), documentPath: z.string().max(2048).optional(), assets: z.array(asset).max(256).optional(), preview: z.boolean().optional() }).strict(), async args => {
    const win = getEditorWindow()!;
    if (!observedWindows.has(win)) {
      observedWindows.add(win);
      const closeAll = () => { void closeGuest(); for (const preview of previews.values()) void disposeGuest(preview); };
      win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) closeAll(); });
      win.once("closed", closeAll);
    }
    if (!args.preview) await closeGuest();
    if ((args.url === undefined) === (args.source === undefined)) throw new Error(uiMessageKey("Select an HTML document or HTTP/S webpage"));
    if (args.preview && args.source === undefined) throw new Error(uiMessageKey("Automatic preview supports local HTML source only"));
    if (args.url && !/^https?:\/\//i.test(args.url)) throw new Error(uiMessageKey("Webpages support HTTP/S only"));
    const isolated = session.fromPartition(`human-board-${args.id}`);
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.on("will-download", event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false, backgroundThrottling: false } });
    const current: Guest = { id: args.id, view, attached: true, disposed: false };
    if (!args.preview) guest = current; else previews.set(current.id, current);
    win.contentView.addChildView(view);
    const [width, height] = win.getContentSize();
    view.setBounds(args.preview ? { x: Math.max(0, Math.floor((width - args.bounds.width) / 2)), y: Math.max(0, Math.floor((height - args.bounds.height) / 2)), width: Math.min(width, args.bounds.width), height: Math.min(height, args.bounds.height) } : args.bounds);
    view.setVisible(!args.preview);
    view.setBackgroundColor("#ffffff");
    const allowed = (target: string) => {
      try {
        const url = new URL(target);
        if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
        if (["http:", "https:"].includes(url.protocol)) return !args.preview;
        return url.protocol === "file:" && !!current.directory && isDocumentPathWithin(current.directory, fileURLToPath(url));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return false;
      }
    };
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }));
    view.webContents.on("will-frame-navigate", event => { if (!allowed(event.url)) event.preventDefault(); });
    // target=_blank remains in this same Chromium content view.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!args.preview && allowed(url)) void view.webContents.loadURL(url).catch(error => { win.webContents.send(CHANNELS.boardDocumentLoadError, { id: args.id, message: String(error) }); });
      return { action: "deny" };
    });
    view.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (!args.preview && mainFrame && code !== -3) win.webContents.send(CHANNELS.boardDocumentLoadError, { id: args.id, message: uiMessageKey(`Page loading failed: ${description} (${code})`) });
    });
    try {
      if (args.source !== undefined) {
        current.directory = await mkdtemp(path.join(app.getPath("temp"), "reelterminal-board-"));
        if (current.disposed) throw new Error(uiMessageKey("HTML preview cancelled"));
        for (const asset of args.assets ?? []) {
          if (!asset.resourceId) continue;
          const destination = path.resolve(current.directory, asset.path);
          if (!isDocumentPathWithin(current.directory, destination)) throw new Error(uiMessageKey("Document asset path is outside the directory"));
          const resolved = await getReviewFileStore().resolve(asset.resourceId, true);
          if (resolved.resource.storage.kind !== "managed") throw new Error(uiMessageKey("HTML assets must be managed copies"));
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(resolved.path, destination);
          if (current.disposed) throw new Error(uiMessageKey("HTML preview cancelled"));
        }
        const entry = path.resolve(current.directory, args.documentPath ?? "__board_document__.html");
        if (!isDocumentPathWithin(current.directory, entry)) throw new Error(uiMessageKey("Document path is outside the directory"));
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, args.source, "utf8");
        await view.webContents.loadFile(entry);
      } else await view.webContents.loadURL(args.url!);
      if (args.preview) {
        // A never-visible WebContentsView has no Viz surface in Electron 44.
        // Use the same native view's first real paint before capturing it.
        await waitForPreviewPaint(current);
        const image = await view.webContents.capturePage();
        if (image.isEmpty()) throw new Error(uiMessageKey("The initial HTML viewport is not ready"));
        return image.toPNG();
      }
      if (guest !== current) throw new Error(uiMessageKey("The webpage view was closed or switched"));
      view.webContents.focus();
    } catch (error) {
      if (guest === current) guest = undefined;
      if (!args.preview) await disposeGuest(current);
      throw error;
    } finally {
      if (args.preview) await disposeGuest(current);
    }
  });
}
