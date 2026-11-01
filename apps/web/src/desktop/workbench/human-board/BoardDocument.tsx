import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
import { useEffect, useRef, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import ReviewMarkdown from "../components/ReviewMarkdown";
import { boardDocumentBinding, captureBoardDocument, documentPreviewSource, type BoardDocumentBinding } from "../../../services/human-board/documents";
import { boardResourceUrl } from "../../../services/human-board/media";
import type { MediaCapture } from "../../../services/human-board/render";

export function BoardDocument({ element, register, onUpdate, onBrowse, onLink, onError }: {
  element: ExcalidrawElement;
  register: (id: string, capture: MediaCapture | null) => void;
  onUpdate: (id: string, patch: Partial<BoardDocumentBinding>) => Promise<void>;
  onBrowse: (element: ExcalidrawElement) => void;
  onLink: (binding: BoardDocumentBinding, href: string) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const binding = boardDocumentBinding(element)!;
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState(binding.source ?? "");
  const [saving, setSaving] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    register(element.id, async () => {
      if (editing) throw new Error(translate("Save or cancel document source edits before capturing"));
      if (binding.kind === "markdown") return captureBoardDocument(host.current!.querySelector<HTMLElement>("[data-document-scroll]")!, Math.ceil(element.width), Math.max(1, Math.ceil(element.height) - 32));
      if (!binding.snapshotResourceId) throw new Error(translate("Enter browse mode and capture the current viewport first: {{v0}}", { v0: binding.name }));
      const response = await fetch(boardResourceUrl(binding.snapshotResourceId));
      if (!response.ok) throw new Error(translate("Unable to read the saved webpage viewport: {{v0}}", { v0: binding.name }));
      return response.blob();
    });
    return () => register(element.id, null);
  }, [element.id, element.width, element.height, binding.kind, binding.name, binding.snapshotResourceId, binding.source, editing, register]);
  const missing = binding.assets?.filter(asset => asset.missing) ?? [];
  return <div ref={host} className="human-board-document flex h-full w-full flex-col overflow-hidden rounded border border-border bg-white text-slate-900" data-testid="human-board-document" data-document-kind={binding.kind}>
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-200 px-2 text-xs">
      <span className="min-w-0 flex-1 truncate">{binding.name} · {binding.kind === "markdown" ? "Markdown" : binding.kind === "html" ? "HTML" : t("Webpage")}</span>
      {binding.kind !== "webpage" && !editing && <button data-testid="human-board-document-edit" onClick={() => { setSource(binding.source ?? ""); setEditing(true); }}>{t("Edit source")}</button>}
      {binding.kind !== "markdown" && !editing && <button data-testid="human-board-document-browse" onClick={() => onBrowse(element)}>{t("Enter browse")}</button>}
      {editing && <><button disabled={saving} data-testid="human-board-document-save" onClick={() => {
        if (source.length > 200000) { onError(new Error(translate("A document supports at most 200000 characters"))); return; }
        setSaving(true);
        void onUpdate(element.id, { source, snapshotResourceId: undefined }).then(() => setEditing(false)).catch(onError).finally(() => setSaving(false));
      }}>{saving ? t("Generating preview…") : t("Save source")}</button><button disabled={saving} data-testid="human-board-document-cancel" onClick={() => setEditing(false)}>{t("review.cancel")}</button></>}
    </div>
    {editing ? <textarea disabled={saving} className="min-h-0 w-full flex-1 resize-none bg-white p-3 font-mono text-xs text-slate-900 outline-none" data-testid="human-board-document-source" aria-label={t("{{v0}} source", { v0: binding.kind === "markdown" ? "Markdown" : "HTML" })} value={source} onChange={event => setSource(event.target.value)} onKeyDown={event => event.stopPropagation()} />
      : binding.kind === "markdown" ? <div data-document-scroll className="min-h-0 flex-1 overflow-auto p-4"><ReviewMarkdown source={documentPreviewSource(binding)} boardResources onLink={href => onLink(binding, href)} /></div>
        : binding.snapshotResourceId ? <img src={boardResourceUrl(binding.snapshotResourceId)} alt={t("Saved page viewport snapshot")} className="min-h-0 w-full flex-1 object-contain object-top" />
          : <div className="grid min-h-0 flex-1 place-content-center gap-3 p-6 text-center text-sm"><p className="break-all">{binding.url ?? binding.name}</p><p>{t("Enter browse mode to scroll, click and capture the current viewport.")}<br />{t("The board stores the URL / HTML source and captured viewport.")}</p><button className="text-blue-700 underline" onClick={() => onBrowse(element)}>{t("Open in a Chromium content view")}</button></div>}
    {!editing && missing.length > 0 && <details className="max-h-24 shrink-0 overflow-auto border-t border-amber-200 bg-amber-50 px-2 py-1 text-xs"><summary>{t("Missing or restricted references: {{v0}}", { v0: missing.length })}</summary>{missing.map(asset => <div key={asset.path}>{asset.path}：<LocalizedMessage>{asset.missing}</LocalizedMessage></div>)}</details>}
  </div>;
}

/** Fixed native content view. Chromium owns rendering, links, scrolling and forms. */
export function BoardBrowser({ element, onClose, onSnapshot, onError }: {
  element: ExcalidrawElement;
  onClose: () => void;
  onSnapshot: (blob: Blob, url: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const binding = boardDocumentBinding(element)!;
  const viewport = useRef<HTMLDivElement>(null);
  const id = useRef(crypto.randomUUID());
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const close = async () => {
    await window.reelterminal?.humanBoardDocuments?.close(id.current);
    onClose();
  };
  useEffect(() => {
    const bridge = window.reelterminal?.humanBoardDocuments;
    if (!bridge) { setState("error"); setMessage(translate("Browsing requires the desktop app")); return; }
    let cancelled = false;
    let opened = false;
    const bounds = () => {
      const rect = viewport.current!.getBoundingClientRect();
      return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    };
    const unsubscribe = bridge.onLoadError(error => { if (error.id === id.current && !cancelled) { setMessage(error.message); setState("error"); } });
    void bridge.open({ id: id.current, bounds: bounds(), ...(binding.kind === "webpage" ? { url: binding.url } : { source: binding.source, documentPath: binding.documentPath, assets: binding.assets }) }).then(() => {
      opened = true;
      if (!cancelled) setState("ready");
    }).catch(error => { if (!cancelled) { setState("error"); setMessage(error instanceof Error ? error.message : String(error)); } });
    const observer = new ResizeObserver(() => { if (opened && !cancelled) void bridge.resize({ id: id.current, bounds: bounds() }).catch(onError); });
    observer.observe(viewport.current!);
    return () => { cancelled = true; observer.disconnect(); unsubscribe(); void bridge.close(id.current).catch(onError); };
  }, []);
  return <div className="fixed inset-8 z-50 flex flex-col rounded border border-border bg-bg shadow-2xl" data-testid="human-board-browser" data-state={state}>
    <div className="flex h-14 shrink-0 items-center gap-3 px-4 text-xs">
      <span className="min-w-0 flex-1 truncate">{binding.name} · <LocalizedMessage>{state === "loading" ? t("review.loading") : state === "error" ? message : t("Chromium content view")}</LocalizedMessage></span>
      <button data-testid="human-board-browser-capture" disabled={state !== "ready" || busy} onClick={() => {
        setBusy(true);
        void window.reelterminal!.humanBoardDocuments!.capture(id.current).then(async result => {
          await onSnapshot(new Blob([new Uint8Array(result.png)], { type: "image/png" }), result.url);
          await close();
        }).catch(onError).finally(() => setBusy(false));
      }}>{t("Capture viewport and return to board")}</button>
      <button data-testid="human-board-browser-close" disabled={busy} onClick={() => { void close().catch(onError); }}>{t("Return to board")}</button>
    </div>
    <div ref={viewport} className="min-h-0 flex-1 bg-white" />
  </div>;
}
