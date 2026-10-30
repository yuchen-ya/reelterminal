import "./assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements, getCommonBounds, newElementWith, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, ExcalidrawImageElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileResource } from "@reelterminal/core/review/types";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import { humanBoardStorage, type HumanBoard } from "../../../services/human-board/storage";
import { hydrateBoardFiles, imageSize, importBoardFiles, importBoardImageUrl, prepareBoardHtmlPreview, cancelBoardHtmlPreviews, resourceImage, retainBoardBlob, type BoardImport } from "../../../services/human-board/media";
import { boardBinding, exportBoardObjectToReview } from "../../../services/human-board/export";
import { freezeBoardScene, renderBoardRegion, type BoardRegion, type FrozenBoardScene, type MediaCapture } from "../../../services/human-board/render";
import { boardDocumentBinding, boardTransferInput, resolveDocumentAsset, singleBoardUrl, type BoardDocumentBinding } from "../../../services/human-board/documents";
import { decodeReviewText } from "../../../services/review-workspace/table-import";
import { BoardDocument, BoardBrowser } from "./BoardDocument";
import { BoardMedia } from "./BoardMedia";
import { BoardFileOutput, type BoardOutput } from "./BoardFileOutput";
import type { BoardIncoming } from "./HumanBoardHome";
import { BoardImageRepair } from "./BoardImageRepair";
import { wbButton } from "../wb-button";
import "@excalidraw/excalidraw/index.css";
import "./human-board.css";

const BOARD_MEDIA_LINK_PREFIX = "https://human-board.invalid/";

interface CaptureSession { scene: FrozenBoardScene; state: AppState; region?: BoardRegion; start?: { x: number; y: number }; screen?: { x: number; y: number; width: number; height: number } }

export default function HumanBoardCanvas({ initialBoard, incoming, onIncomingConsumed, onImport, onSaved, onFlush, onOpenReview, onLayoutLockChange }: {
  initialBoard: HumanBoard; incoming: BoardIncoming | null; onIncomingConsumed: () => void;
  onImport: () => void; onSaved: () => void;
  onFlush: (callback: () => Promise<void>) => void;
  onOpenReview: (nodeId: string) => void;
  onLayoutLockChange: (locked: boolean) => void;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const apiRef = useRef(api); apiRef.current = api;
  const [initialFiles, setInitialFiles] = useState<BinaryFiles>();
  const [resources, setResources] = useState<Map<string, FileResource>>(new Map());
  const [selected, setSelected] = useState<readonly ExcalidrawElement[]>([]);
  const [name, setName] = useState(initialBoard.name);
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("正在处理…");
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const [output, setOutput] = useState<BoardOutput | null>(null);
  const [repair, setRepair] = useState<ExcalidrawElement | null>(null);
  const [exportedNodeId, setExportedNodeId] = useState("");
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
        if (!file) throw new Error("图片像素尚未载入，无法保存画板");
        const response = await fetch(file.dataURL);
        const resource = await retainBoardBlob(board.current.id, await response.blob(), "画板图片.png");
        mapping[element.fileId] = resource.id;
      }
      const elements = api.getSceneElementsIncludingDeleted().map(element => {
        if (element.type !== "image" || !element.fileId || boardBinding(element)) return element;
        return newElementWith(element, { customData: { ...element.customData, resourceId: mapping[element.fileId], kind: "image", name: "画板图片" } });
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
        if (!entry.text || entry.text.length > 200000) throw new Error("请输入 1–200000 字符的文本");
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
    setBusyLabel(content.files?.some(file => /\.html?$/i.test(file.name)) ? "正在生成 HTML 预览…" : "正在处理…");
    importing.current = true; setBusy(true);
    try {
      const entries = content.entries ?? (content.files ? await importBoardFiles(board.current.id, content.files) : content.imageUrl ? await importBoardImageUrl(board.current.id, content.imageUrl) : [{ name: "粘贴文本", text: content.text! }]);
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
    target?.focus();
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: direction === "redo", bubbles: true, cancelable: true }));
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
    if (!asset?.resourceId) throw new Error(`引用不可用：${href}${asset?.missing ? `（${asset.missing}）` : ""}`);
    const resource = resources.get(asset.resourceId)!;
    if (asset.mime?.startsWith("image/")) { await append([{ name: asset.path, kind: "image", resource }]); return; }
    const kind = asset.mime === "text/markdown" ? "markdown" : asset.mime === "text/html" ? "html" : undefined;
    if (!kind) throw new Error(`该引用不能作为文档打开：${href}`);
    const response = await fetch(`app://reelterminal/review-media/${asset.resourceId}`);
    if (!response.ok) throw new Error(`无法读取文档引用：${href}`);
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
    return freezeBoardScene(visible, state, api!.getFiles(), captures.current);
  };
  const produceImage = async (blob: Blob, title: string) => {
    const resource = await retainBoardBlob(board.current.id, blob, title);
    await refreshResources(); setOutput({ name: title, resource, blob, image: true });
    return resource;
  };
  const selectedResource = async () => {
    if (!one) throw new Error("请选择一个内容容器");
    if (boardDocumentBinding(one)) {
      if (documentExport === "source") return undefined;
      return produceImage(await renderBoardRegion(await freeze([one])), `${String(one.customData?.name ?? "文档")}-视口.png`);
    }
    if (one.type === "image") {
      const scene = await freeze([one]);
      scene.appState = { ...scene.appState, exportBackground: false };
      return produceImage(await renderBoardRegion(scene), `${String(one.customData?.name ?? "画板图片").replace(/\.[^.]+$/, "")}.png`);
    }
    const binding = boardBinding(one);
    if (binding) return resources.get(binding.resourceId)!;
    return undefined;
  };

  return <div ref={host} className="flex h-full min-h-0 flex-col" data-testid="human-board-canvas" data-board-id={initialBoard.id} data-save-state={saveState} data-exported-node-id={exportedNodeId}
    onKeyDown={event => event.stopPropagation()}>
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-1 px-3 py-1 text-xs">
      <input aria-label="画板名称" data-testid="human-board-name" className="w-40 rounded border border-border bg-bg-2 px-2 py-1" value={name} maxLength={200} onChange={event => { setName(event.target.value); board.current = { ...board.current, name: event.target.value.trim() || "未命名画板" }; scheduleSave(); }} />
      <span role="status" className="text-fg-3">{saveState === "saved" ? "已自动保存" : saveState === "error" ? "保存失败" : "正在保存…"}</span>
      <button className={wbButton.secondary} onClick={onImport}>导入文件</button>
      <button className={wbButton.secondary} data-testid="human-board-undo" onClick={() => history("undo")}>撤销</button>
      <button className={wbButton.secondary} data-testid="human-board-redo" onClick={() => history("redo")}>重做</button>
      <button className={wbButton.primary} disabled={!api || busy} data-testid="human-board-capture-region" onClick={() => {
        setBusy(true); setOutput(null);
        const state = api!.getAppState();
        void freeze().then(scene => setCapture({ scene, state })).catch(report).finally(() => setBusy(false));
      }}>区域截图</button>
      <span className="text-fg-3">拖入/粘贴追加 · 双击容器进入交互 · 对象多选与区域截图独立</span>
    </div>
    {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border p-2 text-xs text-status-error">{error}<button onClick={() => setError("")}>关闭</button><button onClick={() => void persist().catch(report)}>重试保存</button></div>}
    {selected.length > 0 && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs" data-testid="human-board-selection-tools">
      <span>已选 {selected.length} 项</span>
      <button className={wbButton.secondary} data-testid="human-board-delete-selection" onClick={() => api!.updateScene({ elements: api!.getSceneElementsIncludingDeleted().map(element => selected.some(item => item.id === element.id) ? newElementWith(element, { isDeleted: true }) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY })}>删除对象</button>
      {one?.type === "image" && <>
        <button className={wbButton.secondary} onClick={() => patchSelected({ angle: one.angle + Math.PI / 2 })}>旋转 90°</button>
        <button className={wbButton.secondary} onClick={() => patchSelected({ scale: [-one.scale[0], one.scale[1]] })}>水平翻转</button>
        <button className={wbButton.secondary} onClick={() => patchSelected({ scale: [one.scale[0], -one.scale[1]] })}>垂直翻转</button>
        <button className={wbButton.secondary} onClick={() => api!.updateScene({ appState: { croppingElementId: one.id }, captureUpdate: CaptureUpdateAction.NEVER })}>裁剪图片</button>
        <button className={wbButton.secondary} data-testid="human-board-image-repair" onClick={() => setRepair(one)}>像素修补</button>
      </>}
      {selectedDocument && <select data-testid="human-board-document-export-mode" aria-label="文档导出内容" value={documentExport} onChange={event => setDocumentExport(event.target.value)}><option value="source">{selectedDocument.kind === "webpage" ? "URL 文本 → text" : selectedDocument.kind === "markdown" ? "Markdown 正文 → text" : "HTML 源码 → text"}</option><option value="preview">{selectedDocument.kind === "markdown" ? "可见预览 PNG → image" : "当前视口 PNG → image"}</option></select>}
      <button className={`${wbButton.secondary} ml-auto`} disabled={!contentSelected || busy} data-testid="human-board-single-file" onClick={() => {
        setBusy(true);
        void selectedResource().then(resource => {
          if (selectedDocument && documentExport === "source") setOutput({ name: `${selectedDocument.name}.${selectedDocument.kind === "markdown" ? "md" : selectedDocument.kind === "html" ? "html" : "txt"}`, text: selectedDocument.source ?? selectedDocument.url ?? "", image: false });
          else if (one?.type === "text") setOutput({ name: `${String(one.customData?.name ?? "画板文本")}.txt`, text: one.text, image: false });
          else if (resource && one?.type !== "image" && !selectedDocument) setOutput({ name: resource.originalFileName, resource, image: false });
        }).catch(report).finally(() => setBusy(false));
      }}>单个文件：拖出 / 保存</button>
      <button className={wbButton.primary} disabled={!contentSelected || busy} data-testid="human-board-export-review" onClick={() => {
        const element = one!;
        setBusy(true);
        void selectedResource().then(resource => exportBoardObjectToReview(String(element.customData?.name ?? "画板内容"), element, resource, selectedDocument ? documentExport === "source" ? { text: selectedDocument.source ?? selectedDocument.url ?? "" } : { image: true } : undefined))
          .then(nodeId => { setExportedNodeId(nodeId); setOutput(null); }).catch(report).finally(() => setBusy(false));
      }}>导出此内容为审阅节点</button>
      {exportedNodeId && <button className={wbButton.secondary} onClick={() => onOpenReview(exportedNodeId)}>打开导出的审阅节点</button>}
    </div>}
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
        langCode="zh-CN" theme="light" aiEnabled={false} autoFocus handleKeyboardGlobally={false}
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
        <MainMenu><MainMenu.DefaultItems.Help /><MainMenu.Item onSelect={() => window.open("https://github.com/excalidraw/excalidraw", "_blank", "noopener,noreferrer")}>Excalidraw · MIT</MainMenu.Item></MainMenu>
      </Excalidraw>}
      {capture && <div className="absolute inset-0 z-30 cursor-crosshair bg-black/10" data-testid="human-board-capture-overlay"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest("button")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.getBoundingClientRect();
          setCapture({ ...capture, start: { x: event.clientX, y: event.clientY }, region: undefined, screen: { x: event.clientX - bounds.left, y: event.clientY - bounds.top, width: 0, height: 0 } });
        }}
        onPointerMove={event => {
          if (!capture.start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const start = viewportCoordsToSceneCoords({ clientX: capture.start.x, clientY: capture.start.y }, capture.state);
          const bounds = event.currentTarget.getBoundingClientRect();
          const clientX = Math.max(bounds.left, Math.min(bounds.right, event.clientX));
          const clientY = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
          const end = viewportCoordsToSceneCoords({ clientX, clientY }, capture.state);
          setCapture({ ...capture, region: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) },
            screen: { x: Math.min(capture.start.x, clientX) - bounds.left, y: Math.min(capture.start.y, clientY) - bounds.top, width: Math.abs(clientX - capture.start.x), height: Math.abs(clientY - capture.start.y) } });
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
        <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded border border-border bg-bg-1 p-2 text-xs shadow-xl">
          <span>场景已冻结 · 拖动框选截图区域</span>
          <button className={wbButton.primary} disabled={!capture.region || capture.region.width < 1 || capture.region.height < 1 || busy} data-testid="human-board-capture-confirm" onClick={() => {
            const session = capture; setBusy(true);
            void renderBoardRegion(session.scene, session.region).then(blob => produceImage(blob, "画板区域.png")).then(() => setCapture(null)).catch(report).finally(() => setBusy(false));
          }}>生成 PNG</button>
          <button className={wbButton.secondary} onClick={() => setCapture(null)}>取消</button>
        </div>
        {capture.screen && <div className="pointer-events-none absolute border-2 border-accent bg-accent/10" style={{ left: capture.screen.x, top: capture.screen.y, width: capture.screen.width, height: capture.screen.height }} />}
      </div>}
      {browser && <BoardBrowser element={browser} onClose={() => { setBrowser(null); requestAnimationFrame(() => host.current?.querySelector<HTMLElement>(".excalidraw")?.focus()); }} onError={report} onSnapshot={async (blob, url) => {
        const resource = await retainBoardBlob(board.current.id, blob, `${String(browser.customData?.name ?? "网页")}-视口.png`);
        await refreshResources();
        await updateDocument(browser.id, { snapshotResourceId: resource.id, ...(boardDocumentBinding(browser)?.kind === "webpage" && /^https?:\/\//i.test(url) ? { url } : {}) });
      }} />}
      {output && <BoardFileOutput key={output.resource?.id ?? output.text} board={board.current} output={output} onClose={() => setOutput(null)} onError={report}
        onAddImage={() => { void append([{ name: output.name, kind: "image", resource: output.resource! }]).then(() => setOutput(null)).catch(report); }} />}
      {busy && !capture && <div className="pointer-events-none absolute left-1/2 top-20 z-40 -translate-x-1/2 rounded bg-bg-1 px-4 py-2 text-xs shadow" role="status">{busyLabel}</div>}
      {repair?.type === "image" && <BoardImageRepair element={repair} files={api!.getFiles()} onHistoryReady={setRepairHistory} onClose={() => setRepair(null)} onSave={async blob => {
        const resource = await retainBoardBlob(board.current.id, blob, "修补图片.png");
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
