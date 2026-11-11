import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { t as translate } from "../../../i18n";
import { useTranslation } from "react-i18next";
import "./assets";
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { Crop, Redo2, Undo2 } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements, getCommonBounds, newElementWith, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, ExcalidrawImageElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileResource } from "@reelterminal/core/review/types";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import { humanBoardStorage, type HumanBoard } from "../../../services/human-board/storage";
import { hydrateBoardFiles, imageSize, importBoardFiles, importBoardImageUrl, prepareBoardHtmlPreview, cancelBoardHtmlPreviews, resourceImage, retainBoardBlob, type BoardImport } from "../../../services/human-board/media";
import { boardBinding } from "../../../services/human-board/export";
import { dispatchBoardHistory } from "../../../services/human-board/history";
import { freezeBoardScene, renderBoardRegion, type BoardRegion, type FrozenBoardScene, type MediaCapture } from "../../../services/human-board/render";
import { boardDocumentBinding, boardTransferInput, resolveDocumentAsset, singleBoardUrl, type BoardDocumentBinding } from "../../../services/human-board/documents";
import { decodeReviewText } from "../../../services/review-workspace/table-import";
import { BoardDocument, BoardBrowser } from "./BoardDocument";
import { BoardMedia } from "./BoardMedia";
import { BoardFileOutput, type BoardOutput } from "./BoardFileOutput";
import type { BoardIncoming } from "./HumanBoardView";
import { BoardImageRepair } from "./BoardImageRepair";
import { HumanBoardCaptureOverlay } from "./HumanBoardCaptureOverlay";
import { wbButton } from "../wb-button";
import "@excalidraw/excalidraw/index.css";
import "./human-board.css";

const BOARD_MEDIA_LINK_PREFIX = "https://human-board.invalid/";

interface CaptureSession { scene: FrozenBoardScene; state: AppState }

export default function HumanBoardCanvas({ initialBoard, incoming, onIncomingConsumed, onImport, onSaved, onFlush, onLayoutLockChange, toolbarRight }: {
  initialBoard: HumanBoard; incoming: BoardIncoming | null; onIncomingConsumed: () => void;
  onImport: () => void; onSaved: () => void;
  onFlush: (callback: () => Promise<void>) => void;
  onLayoutLockChange: (locked: boolean) => void;
  toolbarRight?: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const apiRef = useRef(api); apiRef.current = api;
  const [initialFiles, setInitialFiles] = useState<BinaryFiles>();
  const [resources, setResources] = useState<Map<string, FileResource>>(new Map());
  const [selected, setSelected] = useState<readonly ExcalidrawElement[]>([]);
  const [name, setName] = useState(initialBoard.name);
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState(translate("Processing…"));
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const [output, setOutput] = useState<BoardOutput | null>(null);
  const [repair, setRepair] = useState<ExcalidrawElement | null>(null);
  const [browser, setBrowser] = useState<ExcalidrawElement | null>(null);
  const [documentExport, setDocumentExport] = useState("source");
  useEffect(() => { onLayoutLockChange(busy || !!capture || !!browser); return () => onLayoutLockChange(false); }, [busy, capture, browser, onLayoutLockChange]);
  const board = useRef(initialBoard);
  const host = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const saveQueue = useRef(Promise.resolve());
  const captures = useRef(new Map<string, MediaCapture>());
  const repairHistory = useRef<((direction: "undo" | "redo") => void) | null>(null);
  const repairOpen = useRef(false); repairOpen.current = !!repair;
  const captureOpen = useRef(false); captureOpen.current = !!capture;
  const importing = useRef(false);
  const sceneFingerprint = useRef("");
  const selectionFingerprint = useRef("");
  const report = useCallback((problem: unknown) => { setError(problem instanceof Error ? problem.message : String(problem)); }, []);
  const refreshResources = useCallback(async () => {
    const rows = await humanBoardStorage.resources(initialBoard.id);
    setResources(previous => new Map(rows.map(resource => [resource.id, previous.get(resource.id) ?? resource])));
    board.current = { ...board.current, resourceIds: [...new Set([...board.current.resourceIds, ...rows.map(resource => resource.id)])] };
  }, [initialBoard.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([hydrateBoardFiles(initialBoard), humanBoardStorage.resources(initialBoard.id)]).then(([files, rows]) => {
      if (cancelled) return;
      setInitialFiles(files); setResources(new Map(rows.map(resource => [resource.id, resource])));
    }).catch(report);
    return () => { cancelled = true; };
  }, [initialBoard, report]);

  useEffect(() => () => { void cancelBoardHtmlPreviews(initialBoard.id).catch(report); }, [initialBoard.id, report]);

  const persist = useCallback(async () => {
    if (!api || !dirty.current) return;
    window.clearTimeout(timer.current);
    const task = async () => {
      if (!dirty.current) return;
      setSaveState("saving"); dirty.current = false;
      const files = api.getFiles();
      const mapping = { ...board.current.imageFiles };
      // Native image-tool insertion also enters the same managed resource store.
      for (const element of api.getSceneElementsIncludingDeleted()) if (element.type === "image" && element.fileId && !mapping[element.fileId]) {
        const file = files[element.fileId];
        if (!file) throw new Error(translate("Image pixels have not loaded; the board cannot be saved"));
        const response = await fetch(file.dataURL);
        const resource = await retainBoardBlob(board.current.id, await response.blob(), translate("Board image.png"));
        mapping[element.fileId] = resource.id;
      }
      const elements = api.getSceneElementsIncludingDeleted().map(element => {
        if (element.type !== "image" || !element.fileId || boardBinding(element)) return element;
        return newElementWith(element, { customData: { ...element.customData, resourceId: mapping[element.fileId], kind: "image", name: translate("Board image") } });
      });
      if (elements.some((element, index) => element !== api.getSceneElementsIncludingDeleted()[index])) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      const state = api.getAppState();
      const saved = await humanBoardStorage.save({ ...board.current, elements, imageFiles: mapping,
        appState: { viewBackgroundColor: state.viewBackgroundColor, scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom, gridSize: state.gridSize, gridStep: state.gridStep } });
      board.current = { ...board.current, revision: saved.revision, imageFiles: { ...mapping, ...board.current.imageFiles }, resourceIds: saved.resourceIds };
      setSaveState(dirty.current ? "pending" : "saved"); onSaved();
    };
    const pending = saveQueue.current.then(task);
    // Keep failures visible and let the caller decide whether to switch away.
    saveQueue.current = pending.then(() => {}, () => { dirty.current = true; setSaveState("error"); });
    await pending;
  }, [api, onSaved]);
  const persistRef = useRef(persist); persistRef.current = persist;
  useEffect(() => { onFlush(async () => { await persistRef.current(); await saveQueue.current; }); }, [onFlush]);
  useEffect(() => () => { window.clearTimeout(timer.current); void persistRef.current().catch(report); }, [report]);
  const scheduleSave = () => {
    dirty.current = true; setSaveState("pending"); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void persistRef.current().catch(report); }, 500);
  };
  const scheduleSaveRef = useRef(scheduleSave); scheduleSaveRef.current = scheduleSave;
  const onSceneChange = useCallback((elements: readonly ExcalidrawElement[], state: AppState) => {
    if (state.viewBackgroundColor !== "#ffffff" || state.theme !== "light") {
      apiRef.current?.updateScene({ appState: { viewBackgroundColor: "#ffffff", theme: "light" }, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const selection = elements.filter(element => !element.isDeleted && state.selectedElementIds[element.id]);
    const selectedKey = selection.map(element => `${element.id}:${element.version}:${element.versionNonce}`).join("|");
    if (selectedKey !== selectionFingerprint.current) { selectionFingerprint.current = selectedKey; setSelected(selection); }
    const key = `${elements.map(element => `${element.id}:${element.version}:${element.versionNonce}`).join("|")}:${state.scrollX}:${state.scrollY}:${state.zoom.value}:${state.viewBackgroundColor}:${state.gridSize}`;
    if (key !== sceneFingerprint.current) {
      const previous = sceneFingerprint.current; sceneFingerprint.current = key;
      if (previous && apiRef.current) scheduleSaveRef.current();
    }
  }, []);

  const append = async (entries: readonly BoardImport[], point?: { x: number; y: number }) => {
    if (!api) return;
    const state = api.getAppState();
    const center = viewportCoordsToSceneCoords({ clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 }, state);
    const existing = api.getSceneElements();
    // Explicit drops keep their landing point. File-picker/paste batches get one
    // deterministic offset below existing content instead of hiding old objects.
    const bounds = existing.length ? getCommonBounds(existing) : null;
    const start = point ?? { x: center.x - 200, y: bounds ? Math.max(center.y - 150, bounds[3] + 80) : center.y - 150 };
    const added: ExcalidrawElement[] = [];
    const imageFiles = { ...board.current.imageFiles };
    await humanBoardStorage.retain(board.current.id, entries.flatMap(entry => entry.resource ? [entry.resource] : []));
    for (const [index, entry] of entries.entries()) {
      const x = start.x + (index % 3) * 720, y = start.y + Math.floor(index / 3) * 620;
      if (entry.document) {
        let document = entry.document;
        if (document.kind === "html" && !document.snapshotResourceId) {
          const preview = await prepareBoardHtmlPreview(document, board.current.id);
          await humanBoardStorage.retain(board.current.id, [preview]);
          document = { ...document, snapshotResourceId: preview.id };
        }
        const frame = convertToExcalidrawElements([{ type: "rectangle", x, y, width: 640, height: 480 }])[0];
        added.push({ ...frame, type: "embeddable", link: `${BOARD_MEDIA_LINK_PREFIX}${frame.id}`, customData: { ...document } });
      } else if (entry.text !== undefined) {
        if (!entry.text || entry.text.length > 200000) throw new Error(translate("Enter text containing 1–200000 characters"));
        added.push(...convertToExcalidrawElements([{ type: "text", text: entry.text, x, y, fontSize: 20, fontFamily: 2, width: 380, autoResize: false, customData: { name: entry.name } }]));
      } else if (entry.kind === "image") {
        const file = entry.image ?? await resourceImage(entry.resource!);
        const size = await imageSize(file.dataURL);
        const scale = Math.min(1, 400 / size.width, 340 / size.height);
        api.addFiles([file]); imageFiles[file.id] = entry.resource!.id;
        added.push(...convertToExcalidrawElements([{ type: "image", fileId: file.id, status: "saved", x, y, width: size.width * scale, height: size.height * scale,
          customData: { resourceId: entry.resource!.id, kind: "image", name: entry.name } }]));
      } else {
        const frame = convertToExcalidrawElements([{ type: "rectangle", x, y, width: 640, height: entry.kind === "model3d" ? 540 : 420 }])[0];
        added.push({ ...frame, type: "embeddable", link: `${BOARD_MEDIA_LINK_PREFIX}${entry.resource!.id}`, customData: { resourceId: entry.resource!.id, kind: entry.kind, name: entry.name } });
      }
    }
    board.current = { ...board.current, imageFiles };
    await refreshResources();
    const firstContent = api.getSceneElements().length === 0;
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...added], appState: { selectedElementIds: Object.fromEntries(added.map(element => [element.id, true])) }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (firstContent || !point) api.scrollToContent(added, { fitToContent: true, animate: false });
    scheduleSave();
  };
  const receive = async (content: BoardIncoming, point?: { x: number; y: number }) => {
    if (!api || importing.current) return;
    setBusyLabel(content.files?.some(file => /\.html?$/i.test(file.name)) ? translate("Generating HTML preview…") : translate("Processing…"));
    importing.current = true; setBusy(true);
    try {
      const entries = content.entries ?? (content.files ? await importBoardFiles(board.current.id, content.files) : content.imageUrl ? await importBoardImageUrl(board.current.id, content.imageUrl) : [{ name: translate("review.pasteText"), text: content.text! }]);
      await append(entries, point);
    } finally { importing.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!api || !incoming) return;
    void receive(incoming).then(onIncomingConsumed).catch(report);
  }, [api, incoming]);

  const addBlob = async (blob: Blob, title: string) => {
    const resource = await retainBoardBlob(board.current.id, blob, title);
    await append([{ name: title, kind: "image", resource, image: await resourceImage(resource) }]);
  };
  const register = useCallback((id: string, callback: MediaCapture | null) => {
    if (callback) captures.current.set(id, callback); else captures.current.delete(id);
  }, []);
  const observe = useCallback((id: string, observation: ModelObservation) => {
    if (!api) return;
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(element => element.id === id ? newElementWith(element, { customData: { ...element.customData, observation } }) : element), captureUpdate: CaptureUpdateAction.NEVER });
  }, [api]);
  const history = useCallback((direction: "undo" | "redo") => {
    if (repairOpen.current) { repairHistory.current?.(direction); return; }
    if (captureOpen.current) return;
    const target = host.current?.querySelector<HTMLElement>(".excalidraw");
    dispatchBoardHistory(target, direction);
  }, []);
  const setRepairHistory = useCallback((callback: ((direction: "undo" | "redo") => void) | null) => { repairHistory.current = callback; }, []);
  useEffect(() => {
    const listener = (event: Event) => { const direction = (event as CustomEvent).detail; if (direction === "undo" || direction === "redo") history(direction); };
    window.addEventListener("reelterminal:human-board-history", listener);
    return () => window.removeEventListener("reelterminal:human-board-history", listener);
  }, [history]);
  const one = selected.length === 1 ? selected[0] : undefined;
  const selectedDocument = one && boardDocumentBinding(one);
  useEffect(() => { setDocumentExport(selectedDocument?.kind === "markdown" ? "source" : "preview"); }, [one?.id]);
  const updateDocument = useCallback(async (id: string, patch: Partial<BoardDocumentBinding>) => {
    const current = api!.getSceneElements().find(element => element.id === id)!;
    const binding = boardDocumentBinding(current)!;
    if (binding.kind === "html" && patch.source !== undefined) {
      const preview = await prepareBoardHtmlPreview({ ...binding, ...patch }, board.current.id);
      await humanBoardStorage.retain(board.current.id, [preview]);
      await refreshResources();
      patch = { ...patch, snapshotResourceId: preview.id };
    }
    api!.updateScene({ elements: api!.getSceneElementsIncludingDeleted().map(element => element.id === id ? newElementWith(element, { customData: { ...element.customData, ...patch } }) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, [api, refreshResources]);
  const openDocumentLink = async (binding: BoardDocumentBinding, href: string) => {
    const url = singleBoardUrl(href);
    if (url) { await append([{ name: new URL(url).hostname, document: { kind: "webpage", name: new URL(url).hostname, url } }]); return; }
    const asset = resolveDocumentAsset(binding, href);
    if (!asset?.resourceId) throw new Error(translate(asset?.missing ? "Reference unavailable: {{reference}} ({{reason}})" : "Reference unavailable: {{reference}}", { reference: href, reason: asset?.missing }));
    const resource = resources.get(asset.resourceId)!;
    if (asset.mime?.startsWith("image/")) { await append([{ name: asset.path, kind: "image", resource }]); return; }
    const kind = asset.mime === "text/markdown" ? "markdown" : asset.mime === "text/html" ? "html" : undefined;
    if (!kind) throw new Error(translate("This reference cannot be opened as a document: {{v0}}", { v0: href }));
    const response = await fetch(`app://reelterminal/review-media/${asset.resourceId}`);
    if (!response.ok) throw new Error(translate("Unable to read the document reference: {{v0}}", { v0: href }));
    await append([{ name: asset.path, document: { kind, name: asset.path, source: decodeReviewText(await response.arrayBuffer()), documentPath: asset.path, assets: binding.assets } }]);
  };
  const contentSelected = one && ["text", "image", "embeddable"].includes(one.type);
  const patchSelected = (patch: Partial<Pick<ExcalidrawImageElement, "angle" | "scale">>) => {
    api!.updateScene({ elements: api!.getSceneElementsIncludingDeleted().map(element => element.id === one!.id ? newElementWith(element, patch) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };
  const freeze = (elements?: readonly ExcalidrawElement[]) => {
    const state = api!.getAppState();
    const topLeft = viewportCoordsToSceneCoords({ clientX: state.offsetLeft, clientY: state.offsetTop }, state);
    const bottomRight = viewportCoordsToSceneCoords({ clientX: state.offsetLeft + state.width, clientY: state.offsetTop + state.height }, state);
    // The region overlay is constrained to this viewport. Excalidraw does not
    // mount never-visible embeds, so unrelated offscreen media is not captured.
    const visible = elements ?? api!.getSceneElements().filter(element => {
      const [left, top, right, bottom] = getCommonBounds([element]);
      return right >= topLeft.x && bottom >= topLeft.y && left <= bottomRight.x && top <= bottomRight.y;
    });
    return freezeBoardScene(visible, api!.getFiles(), captures.current);
  };
  const produceImage = async (blob: Blob, title: string) => {
    const resource = await retainBoardBlob(board.current.id, blob, title);
    await refreshResources(); setOutput({ name: title, resource, blob, image: true });
    return resource;
  };
  const selectedResource = async () => {
    if (!one) throw new Error(translate("Select a content container"));
    if (boardDocumentBinding(one)) {
      if (documentExport === "source") return undefined;
      return produceImage(await renderBoardRegion(await freeze([one])), translate("{{v0}}-viewport.png", { v0: String(one.customData?.name ?? translate("Document")) }));
    }
    if (one.type === "image") {
      const scene = await freeze([one]);
      scene.appState = { ...scene.appState, exportBackground: false };
      return produceImage(await renderBoardRegion(scene), `${String(one.customData?.name ?? translate("Board image")).replace(/\.[^.]+$/, "")}.png`);
    }
    const binding = boardBinding(one);
    if (binding) return resources.get(binding.resourceId)!;
    return undefined;
  };

  return <div ref={host} className="flex h-full min-h-0 flex-col" data-testid="human-board-canvas" data-board-id={initialBoard.id} data-selected-element-id={selected.length === 1 ? selected[0].id : undefined} data-save-state={saveState}
    onKeyDown={event => event.stopPropagation()}>
    {/* Single fixed-height (h-10) unified board toolbar keeps scene origin 100% stable across selection changes. */}
    <div data-testid="human-board-toolbar" className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto scrollbar-none border-b border-border bg-bg-1 px-3 text-xs">
      <input aria-label={t("Board name")} data-testid="human-board-name" className="h-6 w-36 shrink-0 rounded-[5px] border border-border bg-bg-2 px-2 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent" value={name} maxLength={200} onChange={event => { setName(event.target.value); board.current = { ...board.current, name: event.target.value.trim() || translate("Untitled board") }; scheduleSave(); }} />
      {saveState !== "saved" && (
        <span role="status" className="shrink-0 text-[11px] text-fg-3">
          {saveState === "error" ? t("material.saveFailed") : t("settings.autoSaveSaving")}
        </span>
      )}
      <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg"
          data-testid="human-board-undo"
          title={t("Undo (Ctrl+Z)")}
          aria-label={t("editorRail.undo")}
          onClick={() => history("undo")}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg"
          data-testid="human-board-redo"
          title={t("Redo (Ctrl+Y)")}
          aria-label={t("review.redo")}
          onClick={() => history("redo")}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
      <button className={wbButton.primary} disabled={!api || busy} data-testid="human-board-capture-region" onClick={() => {
        setBusy(true); setOutput(null);
        const state = api!.getAppState();
        void freeze().then(scene => setCapture({ scene, state })).catch(report).finally(() => setBusy(false));
      }}>
        <Crop className="h-3.5 w-3.5" />
        <span>{t("Region capture")}</span>
      </button>
      {/* Keep the full action width in the scroll area so trailing controls cannot cover image actions. */}
      <div className="flex min-w-max flex-1 items-center gap-1.5 pl-1" data-testid="human-board-selection-tools">
        {selected.length > 0 && <>
          <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
          <span className="shrink-0 font-medium text-accent">{t("Selected: {{v0}}", { v0: selected.length })}</span>
          <button className={wbButton.secondary} data-testid="human-board-delete-selection" onClick={() => api!.updateScene({ elements: api!.getSceneElementsIncludingDeleted().map(element => selected.some(item => item.id === element.id) ? newElementWith(element, { isDeleted: true }) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY })}>{t("Delete object")}</button>
          {one?.type === "image" && <>
            <button className={wbButton.secondary} onClick={() => patchSelected({ angle: one.angle + Math.PI / 2 })}>{t("Rotate 90°")}</button>
            <button className={wbButton.secondary} onClick={() => patchSelected({ scale: [-one.scale[0], one.scale[1]] })}>{t("Flip Horizontal")}</button>
            <button className={wbButton.secondary} onClick={() => patchSelected({ scale: [one.scale[0], -one.scale[1]] })}>{t("Flip Vertical")}</button>
            <button className={wbButton.secondary} onClick={() => api!.updateScene({ appState: { croppingElementId: one.id }, captureUpdate: CaptureUpdateAction.NEVER })}>{t("Crop image")}</button>
            <button className={wbButton.secondary} data-testid="human-board-image-repair" onClick={() => setRepair(one)}>{t("Pixel repair")}</button>
          </>}
          {selectedDocument && <select className="h-6 rounded-[5px] border border-border bg-bg-2 px-1.5 text-xs text-fg" data-testid="human-board-document-export-mode" aria-label={t("Document export content")} value={documentExport} onChange={event => setDocumentExport(event.target.value)}><option value="source">{selectedDocument.kind === "webpage" ? t("URL text → text") : selectedDocument.kind === "markdown" ? t("Markdown content → text") : t("HTML source → text")}</option><option value="preview">{selectedDocument.kind === "markdown" ? t("Visible preview PNG → image") : t("Current viewport PNG → image")}</option></select>}
          <button className={wbButton.secondary} disabled={!contentSelected || busy} data-testid="human-board-single-file" onClick={() => {
            setBusy(true);
            void selectedResource().then(resource => {
              if (selectedDocument && documentExport === "source") setOutput({ name: `${selectedDocument.name}.${selectedDocument.kind === "markdown" ? "md" : selectedDocument.kind === "html" ? "html" : "txt"}`, text: selectedDocument.source ?? selectedDocument.url ?? "", image: false });
              else if (one?.type === "text") setOutput({ name: `${String(one.customData?.name ?? translate("Board text"))}.txt`, text: one.text, image: false });
              else if (resource && one?.type !== "image" && !selectedDocument) setOutput({ name: resource.originalFileName, resource, image: false });
            }).catch(report).finally(() => setBusy(false));
          }}>{t("Single file: drag out / save")}</button>
        </>}
      </div>
      {toolbarRight}
    </div>
    {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border p-2 text-xs text-status-error"><LocalizedMessage>{error}</LocalizedMessage><button onClick={() => setError("")}>{t("common.close")}</button><button onClick={() => void persist().catch(report)}>{t("Retry saving")}</button></div>}
    <div className="relative min-h-0 flex-1" data-testid="human-board-scene"
      onDragOverCapture={event => {
        if ((event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
        if (event.dataTransfer.types.some(type => ["Files", "text/plain", "text/uri-list", "text/html"].includes(type))) { event.preventDefault(); event.stopPropagation(); }
      }}
      onDropCapture={event => {
        if (!api || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
        const content = boardTransferInput(event.dataTransfer, true);
        if (!content) return;
        event.preventDefault(); event.stopPropagation();
        void receive(content, viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState())).catch(report);
      }}
      onPasteCapture={event => {
        if (!api || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
        const content = boardTransferInput(event.clipboardData);
        if (!content) return;
        event.preventDefault(); event.stopPropagation(); void receive(content).catch(report);
      }}>
      {initialFiles && <Excalidraw excalidrawAPI={setApi} initialData={{ elements: initialBoard.elements, appState: { ...initialBoard.appState, viewBackgroundColor: "#ffffff", theme: "light" }, files: initialFiles }}
        langCode={i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en"} theme="light" aiEnabled={false} autoFocus handleKeyboardGlobally={false}
        onChange={onSceneChange}
        onPaste={data => {
          if (data.elements?.length || !data.text) return true;
          void receive({ text: data.text }).catch(report);
          return false;
        }}
        validateEmbeddable={link => link.startsWith(BOARD_MEDIA_LINK_PREFIX)}
        onLinkOpen={(element, event) => {
          if ((boardBinding(element) || boardDocumentBinding(element)) && element.link?.startsWith(BOARD_MEDIA_LINK_PREFIX)) event.preventDefault();
        }}
        renderEmbeddable={element => {
          if (boardDocumentBinding(element)) return <BoardDocument element={element} register={register} onUpdate={updateDocument} onBrowse={setBrowser} onLink={(binding, href) => { void openDocumentLink(binding, href).catch(report); }} onError={report} />;
          const binding = boardBinding(element);
          const resource = binding && resources.get(binding.resourceId);
          return resource ? <BoardMedia element={element} resource={resource} register={register} onObservation={observe} onCapture={(blob, title) => { void addBlob(blob, title).catch(report); }} onError={report} /> : null;
        }}>
        <MainMenu>
          <MainMenu.Item onSelect={onImport}>{t("Import files…")}</MainMenu.Item>
          <MainMenu.DefaultItems.Help />
          <MainMenu.Item onSelect={() => window.open("https://github.com/excalidraw/excalidraw", "_blank", "noopener,noreferrer")}>Excalidraw · MIT</MainMenu.Item>
        </MainMenu>
      </Excalidraw>}
      {capture && (
        <HumanBoardCaptureOverlay
          state={capture.state}
          busy={busy}
          onConfirm={(region: BoardRegion) => {
            const session = capture;
            setBusy(true);
            void renderBoardRegion(session.scene, region)
              .then((blob) => produceImage(blob, translate("Board region.png")))
              .then(() => setCapture(null))
              .catch(report)
              .finally(() => setBusy(false));
          }}
          onCancel={() => setCapture(null)}
        />
      )}
      {browser && <BoardBrowser element={browser} onClose={() => { setBrowser(null); requestAnimationFrame(() => host.current?.querySelector<HTMLElement>(".excalidraw")?.focus()); }} onError={report} onSnapshot={async (blob, url) => {
        const resource = await retainBoardBlob(board.current.id, blob, translate("{{v0}}-viewport.png", { v0: String(browser.customData?.name ?? translate("Webpage")) }));
        await refreshResources();
        await updateDocument(browser.id, { snapshotResourceId: resource.id, ...(boardDocumentBinding(browser)?.kind === "webpage" && /^https?:\/\//i.test(url) ? { url } : {}) });
      }} />}
      {output && <BoardFileOutput key={output.resource?.id ?? output.text} board={board.current} output={output} onClose={() => setOutput(null)} onError={report}
        onAddImage={() => { void append([{ name: output.name, kind: "image", resource: output.resource! }]).then(() => setOutput(null)).catch(report); }} />}
      {busy && !capture && <div className="pointer-events-none absolute left-1/2 top-20 z-40 -translate-x-1/2 rounded bg-bg-1 px-4 py-2 text-xs shadow" role="status"><LocalizedMessage>{busyLabel}</LocalizedMessage></div>}
      {repair?.type === "image" && <BoardImageRepair element={repair} files={api!.getFiles()} onHistoryReady={setRepairHistory} onClose={() => setRepair(null)} onSave={async blob => {
        const resource = await retainBoardBlob(board.current.id, blob, translate("Repaired image.png"));
        const image = await resourceImage(resource);
        api!.addFiles([image]);
        board.current = { ...board.current, imageFiles: { ...board.current.imageFiles, [image.id]: resource.id } };
        await refreshResources();
        api!.updateScene({ elements: api!.getSceneElementsIncludingDeleted().map(element => element.id === repair.id && element.type === "image" ? newElementWith(element, { fileId: image.id as FileId, customData: { ...element.customData, resourceId: resource.id } }) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        setRepair(null);
      }} />}
    </div>
  </div>;
}
