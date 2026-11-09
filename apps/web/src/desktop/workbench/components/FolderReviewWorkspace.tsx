import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { File, FileImage, FileText, FileVideo, Folder } from "lucide-react";
import { useWorkbenchTabsStore } from "../../../stores/workbench-tabs-store";
import { wbButton } from "../wb-button";

type Bridge = NonNullable<
  NonNullable<typeof window.reelterminal>["folderReview"]
>;
type Snapshot = Awaited<ReturnType<Bridge["refresh"]>>;
type Entry = Snapshot["entries"][number];
type Status = Entry["review"]["status"];
type Result = Awaited<ReturnType<Bridge["review"]>>;
type Preview = Awaited<ReturnType<Bridge["preview"]>>;
const dragType = "application/x-reelterminal-folder-review";
const parentPath = (value: string) =>
  value.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
const baseName = (value: string) =>
  value.replace(/\\/g, "/").split("/").at(-1) ?? value;
const normalized = (value: string) => value.replace(/\\/g, "/");
const entryVersion = (item: Entry) =>
  `${item.id}:${item.mtimeMs}:${item.size}:${item.review.versionHash ?? ""}`;
const labels: Record<Status, string> = {
  pending: "待审",
  kept: "采用",
  rework: "返工",
  discarded: "不采用",
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const fileIcon = (entry: Entry) => {
  if (entry.kind === "directory") return Folder;
  if (/\.(png|jpg|jpeg|webp|gif|avif|bmp)$/i.test(entry.relativePath))
    return FileImage;
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(entry.relativePath)) return FileVideo;
  if (/\.(txt|md|csv|json|log)$/i.test(entry.relativePath)) return FileText;
  return File;
};

/**
 * File-backed task review. The snapshot is the only source of persisted decisions.
 *
 * `mode="files"` keeps the genuine file management (tree, preview, drag in and
 * out, create/rename/move/copy/reveal) but hides every legacy file-level
 * review decision and note entry, so review authority stays with the task
 * domain that embeds this component. `mode="review"` (default) preserves the
 * standalone legacy behaviour. `sceneVisible=false` pauses polling and preview
 * media while another scene covers this one; selection and expansion survive.
 */
export function FolderReviewWorkspace({
  root,
  onClose,
  onFlush,
  mode = "review",
  sceneVisible = true,
  onOpenMedia,
}: {
  root: string;
  onClose?: () => void;
  onFlush?: (callback: () => Promise<void>) => void;
  mode?: "review" | "files";
  sceneVisible?: boolean;
  onOpenMedia?: (entryId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const bridge = window.reelterminal!.folderReview!;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const current = useRef<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const refreshing = useRef(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Status | "all">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverTarget = useRef<string | null>(null);
  const nativeDrag = useRef<{ root: string; ids: string[] } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{
    x: number;
    y: number;
    pointerId: number;
    ids: string[];
    dragging: boolean;
    outside: boolean;
    token?: string;
    prepareError?: unknown;
    element: HTMLElement;
  } | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [dialog, setDialog] = useState<{
    mode: "rename" | "mkdir" | "renameTask";
    value: string;
    id?: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [notes, setNotes] = useState<
    Record<string, { version: string; value: string }>
  >({});
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const setData = useCallback((value: Snapshot) => {
    current.current = value;
    setSnapshot(value);
    useWorkbenchTabsStore.getState().rename(`folder:${value.root}`, value.name);
  }, []);

  const trashEntries = async (targetIds: string[]) => {
    if (!targetIds.length || busyRef.current || !current.current) return;
    const names = targetIds
      .map((id) => {
        const item = current.current?.entries.find((e) => e.id === id);
        return item ? baseName(item.relativePath) : id;
      })
      .slice(0, 3)
      .join("、");
    const label =
      targetIds.length > 3
        ? `${names} 等 ${targetIds.length} 项`
        : names;
    const confirmed = window.confirm(
      t("确定要将 {{name}} 移入回收站吗？", { name: label }),
    );
    if (!confirmed) return;

    busyRef.current = true;
    setBusy(true);
    generation.current++;
    setError("");
    try {
      const updated = await bridge.trash({ root, ids: targetIds });
      if ("entries" in updated) {
        setData(updated);
      }
      setSelected((old) => old.filter((id) => !targetIds.includes(id)));
      if (activeId && targetIds.includes(activeId)) {
        setActiveId(null);
      }
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const refresh = useCallback(async () => {
    if (busyRef.current || refreshing.current) return;
    refreshing.current = true;
    const request = ++generation.current;
    try {
      const value = await bridge.refresh(root);
      if (request === generation.current && !busyRef.current) setData(value);
    } catch (problem) {
      if (request === generation.current) setError(errorText(problem));
    } finally {
      refreshing.current = false;
    }
  }, [bridge, root, setData]);
  useEffect(() => {
    current.current = null;
    setSnapshot(null);
    setSelected([]);
    setActiveId(null);
    setNotes({});
    setExpanded(new Set());
    setDestination("");
    let disposed = false;
    const request = ++generation.current;
    void bridge
      .open(root)
      .then((value) => {
        if (!disposed && request === generation.current && value)
          setData(value);
      })
      .catch((problem) => {
        if (!disposed) setError(errorText(problem));
      });
    return () => {
      disposed = true;
      window.clearTimeout(hoverTimer.current);
      generation.current++;
    };
  }, [bridge, root, setData]);
  // Polling runs only while the scene is visible; a hidden scene does no
  // background work, and reactivation catches external changes up once.
  useEffect(() => {
    if (!sceneVisible) return;
    if (current.current) void refresh();
    const timer = window.setInterval(() => {
      if (current.current) void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sceneVisible, refresh]);
  const mutate = async (
    operation: (revision: number) => Promise<Result | null>,
  ) => {
    if (busyRef.current || !current.current) return false;
    busyRef.current = true;
    setBusy(true);
    generation.current++;
    setError("");
    try {
      const result = await operation(current.current.revision);
      if (!result) return false;
      setData(result.snapshot);
      const failures = result.results.filter((item) => !item.success);
      if (failures.length) {
        setError(
          failures
            .map((item) => `${item.source}: ${item.error ?? t("操作失败")}`)
            .join("\n"),
        );
        return false;
      }
      return true;
    } catch (problem) {
      setError(errorText(problem));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const entries = snapshot?.entries ?? [];
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  const reviewedCount = entries.filter(
    (entry) => entry.kind === "file" && entry.review.status !== "pending",
  ).length;
  const active = entries.find((item) => item.id === activeId);
  const versionKey = active ? entryVersion(active) : "";
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    if (active?.kind === "file")
      void bridge
        .preview({ root, id: active.id })
        .then((value) => {
          if (!cancelled) setPreview(value);
        })
        .catch((problem) => {
          if (!cancelled) setPreviewError(errorText(problem));
        });
    return () => {
      cancelled = true;
    };
  }, [bridge, root, active?.id, active?.kind, versionKey]);
  const previewVideo = useRef<HTMLVideoElement | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  // A hidden scene must not keep playing media alongside the covering scene.
  useEffect(() => {
    if (sceneVisible) return;
    previewVideo.current?.pause();
    previewAudio.current?.pause();
  }, [sceneVisible, activeId, preview]);
  const matchingFiles = useMemo(
    () =>
      entries.filter(
        (item) =>
          item.kind === "file" &&
          (filter === "all" || item.review.status === filter) &&
          normalized(item.relativePath)
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [entries, filter, query],
  );
  const searching = filter !== "all" || !!query;
  const visible = useMemo(() => {
    const matches = new Set(matchingFiles.map((item) => item.id));
    const paths = matchingFiles.map((item) => normalized(item.relativePath));
    return entries
      .filter((item) => {
        const path = normalized(item.relativePath);
        if (searching)
          return item.kind === "file"
            ? matches.has(item.id)
            : paths.some((name) => name.startsWith(`${path}/`));
        let parent = parentPath(path);
        while (parent) {
          if (!expanded.has(parent)) return false;
          parent = parentPath(parent);
        }
        return true;
      })
      .sort((a, b) =>
        normalized(a.relativePath).localeCompare(
          normalized(b.relativePath),
          undefined,
          { numeric: true },
        ),
      );
  }, [entries, expanded, matchingFiles, searching]);
  const visibleIds = new Set(visible.map((item) => item.id));
  const selectedVisible = selected.filter((id) => visibleIds.has(id));
  const selectedFiles = selectedVisible.filter((id) =>
    entries.some((item) => item.id === id && item.kind === "file"),
  );
  const select = (
    item: Entry,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    if (event.shiftKey && anchor.current) {
      const start = visible.findIndex((entry) => entry.id === anchor.current),
        end = visible.findIndex((entry) => entry.id === item.id);
      if (start >= 0 && end >= 0)
        setSelected(
          visible
            .slice(Math.min(start, end), Math.max(start, end) + 1)
            .map((entry) => entry.id),
        );
      else setSelected([item.id]);
    } else if (event.ctrlKey || event.metaKey)
      setSelected((old) =>
        old.includes(item.id)
          ? old.filter((id) => id !== item.id)
          : [...old, item.id],
      );
    else setSelected([item.id]);
    anchor.current = item.id;
    setActiveId(item.id);
  };
  const toggle = (path: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const rename = (item: Entry) =>
    setDialog({
      mode: "rename",
      id: item.id,
      value: baseName(item.relativePath),
    });
  const submitDialog = () => {
    if (!dialog || !dialog.value.trim()) return;
    const value = dialog.value.trim();
    if (dialog.mode === "renameTask") {
      void mutate((revision) => bridge.renameTask({ root, expectedRevision: revision, name: value }));
    } else if (dialog.mode === "rename" && dialog.id) {
      void mutate((revision) =>
        bridge.rename({
          root,
          expectedRevision: revision,
          id: dialog.id!,
          name: value,
        }),
      );
    } else {
      void mutate((revision) =>
        bridge.mkdir({
          root,
          expectedRevision: revision,
          parent: destination,
          name: value,
        }),
      );
    }
    setDialog(null);
  };
  const onKey = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (event.key === "F2" && active) {
      event.preventDefault();
      rename(active);
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "a" &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      setSelected(
        visible.filter((item) => item.kind === "file").map((item) => item.id),
      );
    }
  };
  const dragIds = (item: Entry) =>
    selectedVisible.includes(item.id) ? selectedVisible : [item.id];
  const clearPointerDrag = () => {
    const gesture = pointerDrag.current;
    pointerDrag.current = null;
    if (gesture?.token) bridge.cancelDrag(gesture.token);
    if (gesture?.element.hasPointerCapture(gesture.pointerId))
      gesture.element.releasePointerCapture(gesture.pointerId);
    window.clearTimeout(hoverTimer.current);
    hoverTarget.current = null;
    setHover(null);
  };
  const startPreparedDrag = (gesture: NonNullable<typeof pointerDrag.current>) => {
    if (pointerDrag.current !== gesture || !gesture.outside) return;
    if (gesture.prepareError) {
      clearPointerDrag();
      setError(errorText(gesture.prepareError));
      return;
    }
    if (!gesture.token) return;
    const token = gesture.token;
    gesture.token = undefined;
    clearPointerDrag();
    const request = { root, ids: gesture.ids };
    nativeDrag.current = request;
    void bridge.startDrag(token)
      .catch((problem) => setError(errorText(problem)))
      .finally(() => {
        if (nativeDrag.current === request) nativeDrag.current = null;
      });
  };
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && pointerDrag.current) {
        suppressClick.current = true;
        clearPointerDrag();
      }
    };
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("keydown", cancel);
      clearPointerDrag();
    };
  }, []);
  const pointerTarget = (x: number, y: number): string | null => {
    const tree = treeRef.current;
    const hit = document.elementFromPoint(x, y);
    if (!tree || !hit || !tree.contains(hit)) return null;
    const row = hit.closest<HTMLElement>("[data-path]");
    if (!row) return "";
    const path = row.dataset.path!;
    return entries.some(
      (entry) =>
        entry.kind === "directory" && normalized(entry.relativePath) === path,
    )
      ? path
      : null;
  };
  const showPointerTarget = (target: string | null) => {
    setHover(target);
    if (hoverTarget.current === target) return;
    hoverTarget.current = target;
    window.clearTimeout(hoverTimer.current);
    if (target)
      hoverTimer.current = window.setTimeout(
        () => setExpanded((old) => new Set(old).add(target)),
        650,
      );
  };
  const drop = (event: DragEvent, target: string) => {
    event.preventDefault();
    event.stopPropagation();
    setHover(null);
    hoverTarget.current = null;
    window.clearTimeout(hoverTimer.current);
    const raw = event.dataTransfer.getData(dragType);
    const internal = nativeDrag.current;
    if (raw || internal) {
      try {
        const source = raw
          ? (JSON.parse(raw) as { root: string; ids: string[] })
          : internal!;
        nativeDrag.current = null;
        if (
          source.root === root &&
          Array.isArray(source.ids) &&
          source.ids.length
        )
          void mutate((revision) =>
            bridge.transfer({
              root,
              expectedRevision: revision,
              ids: source.ids,
              destination: target,
              copy: false,
            }),
          );
      } catch (problem) {
        setError(errorText(problem));
      }
      return;
    }
    const paths = Array.from(event.dataTransfer.files).map((file) =>
      window.reelterminal!.fs.getPathForFile(file),
    );
    if (paths.length && paths.every(Boolean))
      void mutate((revision) =>
        bridge.importFiles({
          root,
          expectedRevision: revision,
          paths,
          destination: target,
        }),
      );
    else if (paths.length) setError(t("无法读取拖入文件的路径"));
  };
  const dragOver = (event: DragEvent, target: string) => {
    if (
      nativeDrag.current ||
      event.dataTransfer.types.includes(dragType) ||
      event.dataTransfer.types.includes("Files")
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = nativeDrag.current
        ? "copy"
        : event.dataTransfer.types.includes(dragType)
          ? "move"
          : "copy";
      setHover(target);
      if (target && hoverTarget.current !== target) {
        hoverTarget.current = target;
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(
          () => setExpanded((old) => new Set(old).add(target)),
          650,
        );
      }
    }
  };
  const flushDrafts = useCallback(async () => {
    if (busyRef.current) throw new Error(t("操作尚未完成，请稍后重试"));
    const drafts = Object.entries(notesRef.current);
    if (!drafts.length) return;
    if (!current.current) throw new Error(t("文件夹尚未加载"));
    busyRef.current = true;
    setBusy(true);
    setSaveState("saving");
    generation.current++;
    try {
      for (const [id, draft] of drafts) {
        const entry = current.current.entries.find(
          (item) => item.id === id && item.kind === "file",
        );
        if (!entry || entryVersion(entry) !== draft.version)
          throw new Error(t("文件已变化，请重新检查未保存的备注"));
        let nextVersion = draft.version;
        if (draft.value !== entry.review.note) {
          const result = await bridge.review({
            root,
            expectedRevision: current.current.revision,
            ids: [id],
            status: entry.review.status,
            note: draft.value,
          });
          setData(result.snapshot);
          const failure = result.results.find((item) => !item.success);
          if (failure) throw new Error(failure.error ?? t("保存备注失败"));
          const updated = result.snapshot.entries.find(
            (item) => item.id === id,
          );
          if (updated) nextVersion = entryVersion(updated);
        }
        setNotes((old) => {
          const currentDraft = old[id];
          if (!currentDraft || currentDraft.version !== draft.version)
            return old;
          const next = { ...old };
          if (currentDraft.value === draft.value) delete next[id];
          else next[id] = { ...currentDraft, version: nextVersion };
          return next;
        });
      }
      setSaveState("saved");
    } catch (problem) {
      setSaveState("error");
      setError(errorText(problem));
      throw problem;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bridge, root, setData, t]);
  useEffect(() => {
    onFlush?.(flushDrafts);
  }, [onFlush, flushDrafts]);
  useEffect(() => {
    if (!Object.keys(notes).length || busy || saveState === "error") return;
    const timer = window.setTimeout(() => {
      void flushDrafts().catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [notes, busy, saveState, flushDrafts]);
  const decide = (status: Status) => {
    // The legacy file-level verdicts exist only in the standalone review
    // mode; the task domain owns every decision in file-management mode.
    if (mode !== "review") return;
    if (!selectedFiles.length) return;
    const draft = active && notes[active.id];
    const note =
      selectedFiles.length === 1 && selectedFiles[0] === active?.id
        ? draft?.version === versionKey
          ? draft.value
          : active.review.note
        : undefined;
    void mutate((revision) =>
      bridge.review({
        root,
        expectedRevision: revision,
        ids: selectedFiles,
        status,
        note,
      }),
    ).then((saved) => {
      if (saved && active && note !== undefined)
        setNotes((old) => {
          if (old[active.id]?.value !== note) return old;
          const next = { ...old };
          delete next[active.id];
          return next;
        });
    });
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-xs text-fg"
      onKeyDown={onKey}
      data-testid="folder-review-workspace"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        {mode === "review" && <strong>{snapshot?.name ?? t("文件夹审阅")}</strong>}
        <button className={wbButton.ghost} disabled={busy || !snapshot} onClick={() => setDialog({ mode: "renameTask", value: snapshot!.name })}>{t("重命名任务")}</button>
        <span className="min-w-0 flex-1 truncate text-fg-3" title={root}>
          {root}
        </span>
        <span className="shrink-0 text-fg-3" role="status">
          {mode === "review"
            ? t("共 {{files}} 文件 · 已审 {{reviewed}} · 待审 {{pending}}", {
                files: fileCount,
                reviewed: reviewedCount,
                pending: fileCount - reviewedCount,
              })
            : t("共 {{files}} 文件", { files: fileCount })}
        </span>
        <button
          className={wbButton.ghost}
          onClick={() =>
            void bridge
              .showInFolder({ root })
              .catch((problem) => setError(errorText(problem)))
          }
        >
          {t("打开位置")}
        </button>
        <button className={wbButton.ghost} onClick={() => void refresh()}>
          {t("刷新")}
        </button>
        {onClose && (
          <button className={wbButton.ghost} onClick={onClose}>
            {t("关闭")}
          </button>
        )}
      </div>
      {dialog && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
          role="presentation"
        >
          <form
            className="flex w-80 flex-col gap-3 rounded-lg border border-border bg-bg-1 p-4 shadow-lg"
            role="dialog"
            aria-modal="true"
            aria-label={t(dialog.mode === "renameTask" ? "重命名任务" : dialog.mode === "rename" ? "重命名" : "新建文件夹")}
            onSubmit={(event) => {
              event.preventDefault();
              submitDialog();
            }}
          >
            <label className="flex flex-col gap-1">
              {t(dialog.mode === "renameTask" ? "任务名称" : dialog.mode === "rename" ? "新名称" : "文件夹名称")}
              <input
                autoFocus
                className="rounded border border-border bg-bg-2 p-2"
                value={dialog.value}
                onChange={(event) =>
                  setDialog({ ...dialog, value: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDialog(null);
                }}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={wbButton.ghost}
                onClick={() => setDialog(null)}
              >
                {t("取消")}
              </button>
              <button
                className={wbButton.primary}
                disabled={!dialog.value.trim() || busy}
              >
                {t("确定")}
              </button>
            </div>
          </form>
        </div>
      )}
      {contextMenu && (() => {
        const entry = entries.find((e) => e.id === contextMenu.id);
        if (!entry) return null;
        return (
          <div
            role="menu"
            className="fixed z-[9999] w-40 rounded-md border border-border bg-bg-1 py-1 shadow-lg text-xs"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-fg-2 hover:bg-bg-2 hover:text-fg"
              onClick={() => {
                setContextMenu(null);
                void bridge
                  .showInFolder({ root, id: entry.id })
                  .catch((problem) => setError(errorText(problem)));
              }}
            >
              {t("在文件夹中显示")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-fg-2 hover:bg-bg-2 hover:text-fg"
              onClick={() => {
                setContextMenu(null);
                rename(entry);
              }}
            >
              {t("重命名")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-status-error hover:bg-bg-2 hover:text-status-error"
              onClick={() => {
                setContextMenu(null);
                void trashEntries([entry.id]);
              }}
            >
              {t("移入回收站")}
            </button>
          </div>
        );
      })()}
      {error && (
        <div
          role="alert"
          className="whitespace-pre-wrap border-b border-border p-2 text-status-error"
        >
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <section className="flex w-[320px] max-w-[45%] shrink-0 flex-col border-r border-border">
          <div className="flex flex-wrap gap-1 border-b border-border p-2">
            <input
              className="min-w-24 flex-1 rounded border border-border bg-bg-2 px-2"
              aria-label={t("搜索文件")}
              placeholder={t("搜索文件")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {mode === "review" && (
              <select
                className="rounded border border-border bg-bg-2 p-1"
                aria-label={t("审阅结果筛选")}
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as Status | "all")
                }
              >
                <option value="all">{t("全部")}</option>
                {(Object.keys(labels) as Status[]).map((status) => (
                  <option key={status} value={status}>
                    {t(labels[status])}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={busy || !snapshot}
              className={wbButton.secondary}
              onClick={() => setDialog({ mode: "mkdir", value: "" })}
            >
              {t("新建文件夹")}
            </button>
          </div>
          <div
            className={`flex-1 overflow-auto p-1 ${hover === "" ? "bg-accent/10" : ""}`}
            onDragOver={(event) => dragOver(event, "")}
            onDragLeave={() => setHover(null)}
            onDrop={(event) => drop(event, "")}
            ref={treeRef}
            data-testid="folder-review-tree"
            role="tree"
            aria-label={t("任务文件")}
          >
            {!snapshot && (
              <p className="p-2 text-fg-3">{t("正在读取文件夹…")}</p>
            )}
            {visible.map((item) => {
              const path = normalized(item.relativePath),
                directory = item.kind === "directory";
              const Icon = fileIcon(item);
              return (
                <div
                  key={item.id}
                  role="treeitem"
                  tabIndex={0}
                  data-testid="folder-review-row"
                  data-path={path}
                  aria-selected={selected.includes(item.id)}
                  className={`group flex min-w-0 select-none items-center gap-1 rounded py-1 pr-1 ${selected.includes(item.id) ? "bg-bg-3 text-fg" : "hover:bg-bg-2"} ${hover === path ? "ring-1 ring-accent" : ""}`}
                  style={{
                    paddingLeft: `${4 + path.split("/").length * 14 - 14}px`,
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!selected.includes(item.id)) {
                      setSelected([item.id]);
                      setActiveId(item.id);
                      anchor.current = item.id;
                    }
                    const x = Math.min(event.clientX, window.innerWidth - 180);
                    const y = Math.min(event.clientY, window.innerHeight - 150);
                    setContextMenu({ id: item.id, x, y });
                  }}
                  onClick={(event) => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    select(item, event);
                  }}
                  onPointerDown={(event) => {
                    if (
                      busy ||
                      event.button !== 0 ||
                      (event.target as Element).closest(
                        "button, input, textarea, select",
                      )
                    )
                      return;
                    suppressClick.current = false;
                    const gesture: NonNullable<typeof pointerDrag.current> = {
                      x: event.clientX,
                      y: event.clientY,
                      pointerId: event.pointerId,
                      ids: dragIds(item),
                      dragging: false,
                      outside: false,
                      element: event.currentTarget,
                    };
                    pointerDrag.current = gesture;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    void bridge.prepareDrag({ root, ids: gesture.ids }).then((token) => {
                      if (pointerDrag.current !== gesture) {
                        bridge.cancelDrag(token);
                        return;
                      }
                      gesture.token = token;
                      startPreparedDrag(gesture);
                    }, (problem) => {
                      if (pointerDrag.current !== gesture) return;
                      gesture.prepareError = problem;
                      startPreparedDrag(gesture);
                    });
                  }}
                  onPointerMove={(event) => {
                    const gesture = pointerDrag.current;
                    if (
                      !gesture ||
                      gesture.pointerId !== event.pointerId ||
                      !(event.buttons & 1)
                    )
                      return;
                    if (
                      !gesture.dragging &&
                      Math.hypot(
                        event.clientX - gesture.x,
                        event.clientY - gesture.y,
                      ) <= 5
                    )
                      return;
                    gesture.dragging = true;
                    suppressClick.current = true;
                    const bounds = treeRef.current!.getBoundingClientRect();
                    const inside =
                      event.clientX >= bounds.left &&
                      event.clientX < bounds.right &&
                      event.clientY >= bounds.top &&
                      event.clientY < bounds.bottom;
                    gesture.outside = !inside;
                    if (inside) {
                      showPointerTarget(pointerTarget(event.clientX, event.clientY));
                      return;
                    }
                    showPointerTarget(null);
                    startPreparedDrag(gesture);
                  }}
                  onPointerUp={(event) => {
                    const gesture = pointerDrag.current;
                    if (!gesture || gesture.pointerId !== event.pointerId)
                      return;
                    const target = gesture.dragging && !gesture.outside
                      ? pointerTarget(event.clientX, event.clientY)
                      : null;
                    clearPointerDrag();
                    if (gesture.dragging && target !== null) {
                      void mutate((revision) =>
                        bridge.transfer({
                          root,
                          expectedRevision: revision,
                          ids: gesture.ids,
                          destination: target,
                          copy: false,
                        }),
                      );
                    }
                  }}
                  onPointerCancel={clearPointerDrag}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select(item, event);
                      if (event.key === "Enter" && onOpenMedia && (fileIcon(item) === FileImage || fileIcon(item) === FileVideo)) {
                        event.stopPropagation();
                        void onOpenMedia(item.id).catch((problem) => setError(errorText(problem)));
                      }
                    }
                    if (directory && event.key === "ArrowRight") {
                      event.preventDefault();
                      setExpanded((old) => new Set(old).add(path));
                    }
                    if (directory && event.key === "ArrowLeft") {
                      event.preventDefault();
                      setExpanded((old) => {
                        const next = new Set(old);
                        next.delete(path);
                        return next;
                      });
                    }
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      const rows = Array.from(
                        event.currentTarget.parentElement!.querySelectorAll<HTMLElement>(
                          '[role="treeitem"]',
                        ),
                      );
                      const index = rows.indexOf(event.currentTarget);
                      rows[index + (event.key === "ArrowUp" ? -1 : 1)]?.focus();
                    }
                  }}
                  onDoubleClick={(event) => {
                    if (directory) toggle(path);
                    else if (onOpenMedia && (fileIcon(item) === FileImage || fileIcon(item) === FileVideo)) {
                      event.stopPropagation();
                      void onOpenMedia(item.id).catch((problem) => setError(errorText(problem)));
                    }
                  }}
                  onDragOver={(event) => {
                    if (directory) dragOver(event, path);
                  }}
                  onDragLeave={(event) => {
                    if (
                      directory &&
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      window.clearTimeout(hoverTimer.current);
                      hoverTarget.current = null;
                    }
                  }}
                  onDrop={(event) => {
                    if (directory) drop(event, path);
                  }}
                >
                  {directory ? (
                    <button
                      className="w-5 shrink-0"
                      aria-label={t(expanded.has(path) ? "收起" : "展开")}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(path);
                      }}
                    >
                      {expanded.has(path) || searching ? "▾" : "▸"}
                    </button>
                  ) : (
                    <span className="w-5 shrink-0 text-center">·</span>
                  )}
                  <Icon
                    className={`h-3.5 w-3.5 shrink-0 ${directory ? "text-accent" : "text-fg-3"}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate" title={path}>
                    {baseName(path)}
                  </span>
                  {!directory && mode === "review" && (
                    <span className="shrink-0 text-fg-3">
                      {t(labels[item.review.status])}
                    </span>
                  )}
                  <button
                    className="px-1 text-fg-3 opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
                    aria-label={t("重命名")}
                    onClick={(event) => {
                      event.stopPropagation();
                      rename(item);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="px-1 text-fg-3 opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
                    aria-label={t("更多操作")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!selected.includes(item.id)) {
                        setSelected([item.id]);
                        setActiveId(item.id);
                        anchor.current = item.id;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      setContextMenu({
                        id: item.id,
                        x: Math.min(rect.left, window.innerWidth - 180),
                        y: Math.min(rect.bottom + 4, window.innerHeight - 150),
                      });
                    }}
                  >
                    ···
                  </button>
                </div>
              );
            })}
          </div>
          {selectedVisible.length > 0 && (
          <div className="space-y-1 border-t border-border p-2">
            <div className="flex items-center gap-1">
              <span>{t("目标文件夹")}</span>
              <select
                className="min-w-0 flex-1 rounded border border-border bg-bg-2 p-1"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="">/</option>
                {entries
                  .filter((item) => item.kind === "directory")
                  .map((item) => (
                    <option key={item.id} value={normalized(item.relativePath)}>
                      {normalized(item.relativePath)}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1">
              <span className="self-center text-fg-3">
                {t("已选 {{count}} 项", { count: selectedVisible.length })}
              </span>
              <button
                className={wbButton.secondary}
                disabled={busy || !selectedVisible.length}
                onClick={() =>
                  void mutate((revision) =>
                    bridge.transfer({
                      root,
                      expectedRevision: revision,
                      ids: selectedVisible,
                      destination,
                      copy: false,
                    }),
                  )
                }
              >
                {t("移动到")}
              </button>
              <button
                className={wbButton.secondary}
                disabled={busy || !selectedVisible.length}
                onClick={() =>
                  void mutate((revision) =>
                    bridge.transfer({
                      root,
                      expectedRevision: revision,
                      ids: selectedVisible,
                      destination,
                      copy: true,
                    }),
                  )
                }
              >
                {t("复制到")}
              </button>
              <button
                className={wbButton.secondary}
                disabled={busy || !selectedVisible.length}
                onClick={() =>
                  void mutate((revision) =>
                    bridge.copyOut({
                      root,
                      expectedRevision: revision,
                      ids: selectedVisible,
                    }),
                  )
                }
              >
                {t("复制到外部…")}
              </button>
              <button
                className={`${wbButton.secondary} text-status-error hover:text-status-error`}
                disabled={busy || !selectedVisible.length}
                onClick={() => void trashEntries(selectedVisible)}
              >
                {t("移入回收站")}
              </button>
            </div>
          </div>
          )}
        </section>
        <section className="flex min-w-0 flex-1 flex-col p-3">
          {active?.kind === "file" ? (
            <>
              {!visibleIds.has(active.id) && (
                <p className="text-fg-3">
                  {t("当前文件不符合筛选条件，预览仍然保留。")}
                </p>
              )}
              <div className="flex items-center gap-2">
                <strong
                  className="min-w-0 flex-1 truncate"
                  title={active.relativePath}
                >
                  {baseName(active.relativePath)}
                </strong>
                <button
                  className={wbButton.ghost}
                  onClick={() =>
                    void bridge
                      .showInFolder({ root, id: active.id })
                      .catch((problem) => setError(errorText(problem)))
                  }
                >
                  {t("在文件夹中显示")}
                </button>
              </div>
              <div className="flex min-h-0 flex-1 overflow-auto rounded bg-bg-2 p-2">
                {previewError ? (
                  <p role="alert" className="text-status-error">
                    {previewError}
                  </p>
                ) : !preview ? (
                  <p className="text-fg-3">{t("正在加载预览…")}</p>
                ) : preview.kind === "image" && preview.url ? (
                  <img
                    className="m-auto max-h-full max-w-full object-contain"
                    src={preview.url}
                    alt={baseName(active.relativePath)}
                    draggable={false}
                  />
                ) : preview.kind === "video" && preview.url ? (
                  <video
                    ref={previewVideo}
                    className="m-auto max-h-full max-w-full"
                    src={preview.url}
                    controls
                    controlsList="nofullscreen"
                    data-testid="folder-review-preview-video"
                  />
                ) : preview.kind === "audio" && preview.url ? (
                  <audio
                    ref={previewAudio}
                    className="m-auto"
                    src={preview.url}
                    controls
                    data-testid="folder-review-preview-audio"
                  />
                ) : preview.kind === "text" ? (
                  <pre className="whitespace-pre-wrap break-all">
                    {preview.text}
                  </pre>
                ) : (
                  <div className="m-auto text-fg-3">
                    <p>{t("此文件暂不支持预览。")}</p>
                    <button
                      className={wbButton.secondary}
                      onClick={() =>
                        void bridge
                          .openFile({ root, id: active.id })
                          .catch((problem) => setError(errorText(problem)))
                      }
                    >
                      {t("使用系统应用打开")}
                    </button>
                  </div>
                )}
              </div>
              {mode === "review" && (
                <>
                  <label className="mt-2 flex flex-col gap-1">
                    {t("审阅备注")}
                    <textarea
                      className="min-h-16 rounded border border-border bg-bg-2 p-2"
                      value={
                        notes[active.id]?.version === versionKey
                          ? notes[active.id].value
                          : active.review.note
                      }
                      onChange={(event) => {
                        setSaveState("idle");
                        setNotes((old) => ({
                          ...old,
                          [active.id]: {
                            version: versionKey,
                            value: event.target.value,
                          },
                        }));
                      }}
                    />
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      className={wbButton.secondary}
                      disabled={busy || !Object.keys(notes).length}
                      onClick={() => void flushDrafts().catch(() => undefined)}
                    >
                      {t("保存备注")}
                    </button>
                    <span role="status" className="text-fg-3">
                      {t(
                        saveState === "saving"
                          ? "正在保存"
                          : saveState === "error"
                            ? "保存失败，请重试"
                            : Object.keys(notes).length
                              ? "未保存"
                              : saveState === "saved"
                                ? "已保存"
                                : "",
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(Object.keys(labels) as Status[]).map((status) => (
                      <button
                        key={status}
                        className={
                          status === active.review.status
                            ? wbButton.primary
                            : wbButton.secondary
                        }
                        disabled={busy || !selectedFiles.length}
                        onClick={() => decide(status)}
                      >
                        {selectedFiles.length > 1
                          ? t("{{status}}选中的 {{count}} 项", {
                              status: t(labels[status]),
                              count: selectedFiles.length,
                            })
                          : t(labels[status])}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-fg-3">
                {t(
                  mode === "files"
                    ? "选择左侧文件预览内容"
                    : "选择文件以预览和审阅",
                )}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
