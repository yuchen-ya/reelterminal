import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Film,
  FolderPlus,
  Grid2X2,
  List,
  MoreHorizontal,
  Search,
  Trash2,
} from "../../icons/lucide-compat";
import type { ProjectLibraryEntry } from "../../services/workspace-manager";
import {
  loadProjectLibrary,
  previewLibraryPurge,
  projectLibraryActions,
  purgeLibraryProjects,
  recycleLibraryProjects,
  type ProjectLibraryData,
} from "./project-library-service";

type SortKey = "modifiedAt" | "createdAt" | "name" | "engineeringBytes";
type Preferences = {
  layout: "list" | "grid";
  sort: SortKey;
  direction: "asc" | "desc";
};
type LibraryDialog = (
  | { kind: "rename"; id: string; name: string }
  | { kind: "newFolder"; name: string }
  | { kind: "renameFolder"; id: string; name: string }
  | { kind: "deleteFolder"; id: string; name: string }
  | { kind: "move"; ids: string[] }
  | { kind: "recycle"; ids: string[] }
  | { kind: "purge"; ids: string[]; bytes: number }
) & { projectNames?: string[] };

const PREFERENCES_KEY = "reelterminal-project-library-preferences";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-bg-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "min-w-0 rounded-md border border-border bg-bg-1 px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none";

function readPreferences(): Preferences {
  const defaults: Preferences = {
    layout: "list",
    sort: "modifiedAt",
    direction: "desc",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null");
    if (
      saved &&
      ["list", "grid"].includes(saved.layout) &&
      ["modifiedAt", "createdAt", "name", "engineeringBytes"].includes(
        saved.sort,
      ) &&
      ["asc", "desc"].includes(saved.direction)
    )
      return saved;
  } catch {
    /* A browser storage restriction does not prevent project access. */
  }
  return defaults;
}

export function formatProjectBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

export function ProjectLibrary({
  onOpen,
  isDisabled = false,
}: {
  onOpen: (id: string) => Promise<void>;
  isDisabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<ProjectLibraryData>({
    projects: [],
    folders: [],
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preferences, setPreferences] = useState(readPreferences);
  const [folder, setFolder] = useState("all");
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [name, setName] = useState("");
  const [moveFolder, setMoveFolder] = useState("");
  const modal = useRef<HTMLDivElement>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const disabled = isDisabled || busy || loading;
  const inTrash = folder === "trash";

  const refresh = useCallback(async () => {
    const result = await loadProjectLibrary();
    if (alive.current) setData(result);
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh()
      .catch((failure) => {
        if (alive.current)
          setError(
            String(failure instanceof Error ? failure.message : failure),
          );
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      /* View preferences are optional on restricted browser profiles. */
    }
  }, [preferences]);

  useEffect(() => {
    setSelected(new Set());
    setMenuId(null);
  }, [folder, query]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!(event.target as Element).closest("[data-project-menu]"))
        setMenuId(null);
    };
    document.addEventListener("click", closeMenu);
    return () => document.removeEventListener("click", closeMenu);
  }, []);

  useEffect(() => {
    if (!menuId) return;
    const menu = document.querySelector<HTMLElement>(
      '[data-project-menu] [role="menu"]',
    )!;
    const trigger =
      menu.parentElement!.querySelector<HTMLButtonElement>("button")!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    items[0].focus();
    const navigate = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        trigger.focus();
        setMenuId(null);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next].focus();
      }
    };
    menu.addEventListener("keydown", navigate);
    return () => menu.removeEventListener("keydown", navigate);
  }, [menuId]);

  useEffect(() => {
    if (!dialog) return;
    const previous = dialogReturnFocus.current;
    const first = modal.current?.querySelector<HTMLElement>(
      "input, select, button",
    );
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setDialog(null);
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...modal.current!.querySelectorAll<HTMLElement>(
          "input:not(:disabled), select:not(:disabled), button:not(:disabled)",
        ),
      ];
      const firstControl = controls[0];
      const lastControl = controls[controls.length - 1];
      if (!firstControl) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === firstControl) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && document.activeElement === lastControl) {
        event.preventDefault();
        firstControl.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (previous?.isConnected) previous.focus();
      else heading.current?.focus();
    };
  }, [dialog, busy]);

  const visible = useMemo(
    () =>
      data.projects
        .filter((project) => {
          if ((project.recycledAt !== undefined) !== inTrash) return false;
          if (!inTrash && folder === "ungrouped" && project.folderId)
            return false;
          if (
            !inTrash &&
            folder !== "all" &&
            folder !== "ungrouped" &&
            project.folderId !== folder
          )
            return false;
          return project.name
            .toLocaleLowerCase(i18n.language)
            .includes(query.trim().toLocaleLowerCase(i18n.language));
        })
        .sort((a, b) => {
          const result =
            preferences.sort === "name"
              ? a.name.localeCompare(b.name, i18n.language, { numeric: true })
              : a[preferences.sort] - b[preferences.sort];
          return (
            (preferences.direction === "asc" ? result : -result) ||
            a.id.localeCompare(b.id)
          );
        }),
    [data.projects, folder, inTrash, query, preferences, i18n.language],
  );
  const selectedIds = visible
    .filter((project) => selected.has(project.id))
    .map((project) => project.id);
  const allSelected =
    visible.length > 0 && selectedIds.length === visible.length;
  const currentFolder = data.folders.find((entry) => entry.id === folder);

  const run = async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setMenuId(null);
    try {
      await operation();
      setDialog(null);
      setSelected(new Set());
      if (success) setNotice(success);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      try {
        await refresh();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      setBusy(false);
    }
  };

  const currentActionFocus = (): HTMLElement | null => {
    const active = document.activeElement as HTMLElement;
    if (active === document.body) return heading.current;
    return active.closest("[data-project-menu]")?.querySelector<HTMLElement>("button") ?? active;
  };

  const showDialog = (next: LibraryDialog, returnFocus = currentActionFocus()) => {
    dialogReturnFocus.current = returnFocus;
    setName("name" in next ? next.name : "");
    setMoveFolder(currentFolder?.id ?? "");
    setError(null);
    setDialog({
      ...next,
      projectNames:
        "ids" in next
          ? next.ids.map(
              (id) => data.projects.find((project) => project.id === id)!.name,
            )
          : undefined,
    });
    setMenuId(null);
  };
  const preparePurge = (ids: string[]) => {
    const returnFocus = currentActionFocus();
    setBusy(true);
    setError(null);
    setMenuId(null);
    previewLibraryPurge(ids)
      .then((bytes) => showDialog({ kind: "purge", ids, bytes }, returnFocus))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };
  const confirm = async () => {
    if (!dialog) return;
    const command = dialog;
    await run(async () => {
      switch (command.kind) {
        case "rename":
          await projectLibraryActions.rename(command.id, name);
          break;
        case "newFolder":
          await projectLibraryActions.saveFolder(name);
          break;
        case "renameFolder":
          await projectLibraryActions.saveFolder(name, command.id);
          break;
        case "deleteFolder":
          await projectLibraryActions.deleteFolder(command.id);
          setFolder("ungrouped");
          break;
        case "move":
          await projectLibraryActions.move(
            command.ids,
            moveFolder || undefined,
          );
          break;
        case "recycle":
          await recycleLibraryProjects(command.ids);
          break;
        case "purge": {
          const result = await purgeLibraryProjects(command.ids);
          setNotice(
            t(
              result.incomplete
                ? "projectLibrary.cleanupIncomplete"
                : "projectLibrary.purged",
              { size: formatProjectBytes(result.reclaimedBytes) },
            ),
          );
          break;
        }
      }
    });
  };
  const naming =
    dialog && ["rename", "newFolder", "renameFolder"].includes(dialog.kind);
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const renderProject = (project: ProjectLibraryEntry) => {
    const metadata = `${formatDuration(project.duration)} · ${project.width} × ${project.height} · ${formatProjectBytes(project.engineeringBytes)}`;
    return (
      <li
        key={project.id}
        className={`relative rounded-lg border ${selected.has(project.id) ? "border-accent bg-accent-soft" : "border-border bg-bg-1"} ${preferences.layout === "list" ? "flex items-center gap-3 p-3" : "flex flex-col p-3"}`}
      >
        {managing && (
          <input
            type="checkbox"
            aria-label={t("projectLibrary.selectProject", {
              name: project.name,
            })}
            checked={selected.has(project.id)}
            disabled={disabled}
            onChange={() => toggle(project.id)}
            className={`h-4 w-4 accent-accent ${preferences.layout === "grid" ? "absolute left-5 top-5 z-10" : "shrink-0"}`}
          />
        )}
        <button
          type="button"
          disabled={disabled || (inTrash && !managing)}
          aria-label={
            managing
              ? t("projectLibrary.selectProject", { name: project.name })
              : t("desktop.start.openProject", { name: project.name })
          }
          onClick={() =>
            managing ? toggle(project.id) : void onOpen(project.id)
          }
          className={`min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-accent disabled:cursor-default ${preferences.layout === "list" ? "flex items-center gap-3" : "w-full"}`}
        >
          <span
            className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg-3 text-fg-muted ${preferences.layout === "list" ? "h-14 w-20" : "aspect-video w-full"}`}
          >
            {project.thumbnail ? (
              <img
                src={project.thumbnail}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <Film
                size={preferences.layout === "list" ? 22 : 34}
                aria-hidden
              />
            )}
          </span>
          <span
            className={`block min-w-0 ${preferences.layout === "grid" ? "mt-3" : "flex-1"}`}
          >
            <span className="block truncate text-sm font-semibold text-fg">
              {project.name}
            </span>
            <span
              className="mt-1 block text-xs text-fg-muted"
              title={t("projectLibrary.sizeHelp")}
            >
              {metadata}
            </span>
            <span className="mt-1 block text-xs text-fg-muted">
              {t(
                inTrash
                  ? "projectLibrary.deletedOn"
                  : "projectLibrary.modifiedOn",
                {
                  date: new Date(
                    inTrash ? project.recycledAt! : project.modifiedAt,
                  ).toLocaleString(i18n.language, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }),
                },
              )}
            </span>
          </span>
        </button>
        {!managing && (
          <div
            data-project-menu
            className={
              preferences.layout === "grid"
                ? "absolute right-4 top-4"
                : "relative shrink-0"
            }
          >
            <button
              type="button"
              className={`${buttonClass} bg-bg-1 !p-1.5`}
              aria-label={t("projectLibrary.projectActions", {
                name: project.name,
              })}
              aria-expanded={menuId === project.id}
              disabled={disabled}
              onClick={() =>
                setMenuId(menuId === project.id ? null : project.id)
              }
            >
              <MoreHorizontal size={18} />
            </button>
            {menuId === project.id && (
              <div
                role="menu"
                onBlur={(event) => {
                  if (
                    !event.currentTarget.parentElement!.contains(
                      event.relatedTarget as Node,
                    )
                  )
                    setMenuId(null);
                }}
                aria-label={t("projectLibrary.projectActions", {
                  name: project.name,
                })}
                className="absolute right-0 top-full z-30 mt-1 w-44 rounded-md border border-border bg-bg-2 p-1 shadow-xl"
              >
                {(inTrash
                  ? ["restore", "purge"]
                  : ["rename", "copy", "move", "recycle"]
                ).map((action) => (
                  <button
                    key={action}
                    role="menuitem"
                    type="button"
                    className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-bg-3 ${action === "recycle" || action === "purge" ? "text-red-400" : "text-fg"}`}
                    onClick={() => {
                      if (action === "rename")
                        showDialog({
                          kind: "rename",
                          id: project.id,
                          name: project.name,
                        });
                      if (action === "copy")
                        void run(
                          () => projectLibraryActions.copy(project.id),
                          t("projectLibrary.copied"),
                        );
                      if (action === "move")
                        showDialog({ kind: "move", ids: [project.id] });
                      if (action === "recycle")
                        showDialog({ kind: "recycle", ids: [project.id] });
                      if (action === "restore")
                        void run(
                          () => projectLibraryActions.restore([project.id]),
                          t("projectLibrary.restored"),
                        );
                      if (action === "purge") preparePurge([project.id]);
                    }}
                  >
                    {t(`projectLibrary.${action}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section
      aria-label={t("projectLibrary.title")}
      data-testid="project-library"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg"
        >
          {t("projectLibrary.title")}{" "}
          <span className="ml-2 text-sm font-normal text-fg-muted">
            {
              data.projects.filter(
                (project) => project.recycledAt === undefined,
              ).length
            }
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search
              size={15}
              aria-hidden
              className="absolute left-3 top-2.5 text-fg-muted"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("projectLibrary.search")}
              aria-label={t("projectLibrary.search")}
              disabled={disabled}
              className={`${inputClass} w-44 !pl-9`}
            />
          </label>
          <select
            aria-label={t("projectLibrary.sort")}
            className={inputClass}
            value={preferences.sort}
            disabled={disabled}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                sort: event.target.value as SortKey,
              })
            }
          >
            {(
              ["modifiedAt", "createdAt", "name", "engineeringBytes"] as const
            ).map((key) => (
              <option key={key} value={key}>
                {t(`projectLibrary.sort_${key}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            aria-label={t(`projectLibrary.${preferences.direction}`)}
            onClick={() =>
              setPreferences({
                ...preferences,
                direction: preferences.direction === "asc" ? "desc" : "asc",
              })
            }
          >
            {preferences.direction === "asc" ? "↑" : "↓"}
          </button>
          <div
            className="flex gap-1"
            role="group"
            aria-label={t("projectLibrary.layout")}
          >
            {(["list", "grid"] as const).map((layout) => (
              <button
                type="button"
                key={layout}
                aria-label={t(`projectLibrary.${layout}`)}
                aria-pressed={preferences.layout === layout}
                disabled={disabled}
                className={`${buttonClass} !p-2 ${preferences.layout === layout ? "border-accent text-accent" : ""}`}
                onClick={() => setPreferences({ ...preferences, layout })}
              >
                {layout === "list" ? <List size={17} /> : <Grid2X2 size={17} />}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            aria-pressed={managing}
            onClick={() => {
              setManaging(!managing);
              setSelected(new Set());
              setMenuId(null);
            }}
          >
            {t(managing ? "projectLibrary.exit" : "projectLibrary.manage")}
          </button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          aria-label={t("projectLibrary.folder")}
          value={folder}
          disabled={disabled}
          className={`${inputClass} max-w-64`}
          onChange={(event) => setFolder(event.target.value)}
        >
          <option value="all">{t("projectLibrary.all")}</option>
          <option value="ungrouped">{t("projectLibrary.ungrouped")}</option>
          {data.folders.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
          <option value="trash">
            {t("projectLibrary.trash")} (
            {
              data.projects.filter(
                (project) => project.recycledAt !== undefined,
              ).length
            }
            )
          </option>
        </select>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled}
          onClick={() => showDialog({ kind: "newFolder", name: "" })}
        >
          <FolderPlus size={16} />
          {t("projectLibrary.newFolder")}
        </button>
        {currentFolder && (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={disabled}
              onClick={() =>
                showDialog({ kind: "renameFolder", ...currentFolder })
              }
            >
              {t("projectLibrary.renameFolder")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={disabled}
              onClick={() =>
                showDialog({ kind: "deleteFolder", ...currentFolder })
              }
            >
              {t("projectLibrary.deleteFolder")}
            </button>
          </>
        )}
        <span className="text-xs text-fg-muted">
          {t(inTrash ? "projectLibrary.trashHelp" : "projectLibrary.localHelp")}
        </span>
      </div>
      {managing && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-accent/40 bg-accent-soft px-3 py-2">
          <strong className="text-sm text-accent">
            {t("projectLibrary.selected", { count: selectedIds.length })}
          </strong>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={disabled || !visible.length}
              onChange={() =>
                setSelected(
                  allSelected
                    ? new Set()
                    : new Set(visible.map((project) => project.id)),
                )
              }
              className="accent-accent"
            />
            {t("projectLibrary.selectAll")}
          </label>
          {inTrash ? (
            <>
              <button
                type="button"
                className={buttonClass}
                disabled={disabled || !selectedIds.length}
                onClick={() =>
                  void run(
                    () => projectLibraryActions.restore(selectedIds),
                    t("projectLibrary.restored"),
                  )
                }
              >
                {t("projectLibrary.restore")}
              </button>
              <button
                type="button"
                className={`${buttonClass} text-red-400`}
                disabled={disabled || !selectedIds.length}
                onClick={() => preparePurge(selectedIds)}
              >
                {t("projectLibrary.purge")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={buttonClass}
                disabled={disabled || !selectedIds.length}
                onClick={() => showDialog({ kind: "move", ids: selectedIds })}
              >
                {t("projectLibrary.move")}
              </button>
              <button
                type="button"
                className={`${buttonClass} text-red-400`}
                disabled={disabled || !selectedIds.length}
                onClick={() =>
                  showDialog({ kind: "recycle", ids: selectedIds })
                }
              >
                <Trash2 size={15} />
                {t("projectLibrary.recycle")}
              </button>
            </>
          )}
        </div>
      )}
      {error && !dialog && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 rounded border border-red-400/40 p-3 text-sm text-red-400"
        >
          {error}
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            {t("projectLibrary.retry")}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-accent">
          {notice}
        </p>
      )}
      {loading ? (
        <p className="py-8 text-sm text-fg-muted">{t("common.loading")}</p>
      ) : !visible.length ? (
        <p className="rounded-lg border border-border bg-bg-1 px-4 py-10 text-center text-sm text-fg-muted">
          {t(
            query
              ? "projectLibrary.noMatch"
              : inTrash
                ? "projectLibrary.emptyTrash"
                : "projectLibrary.empty",
          )}
        </p>
      ) : (
        <ul
          className={
            preferences.layout === "grid"
              ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              : "flex flex-col gap-2"
          }
        >
          {visible.map(renderProject)}
        </ul>
      )}
      {dialog &&
        createPortal(
          <div
            className="reelterminal-desktop fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-black/60 px-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !busy)
                setDialog(null);
            }}
          >
            <div
              ref={modal}
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-library-dialog-title"
              aria-describedby="project-library-dialog-description"
              className="w-full max-w-md rounded-lg border border-border bg-bg-1 p-5 text-fg shadow-xl"
            >
              <h3
                id="project-library-dialog-title"
                className="mb-3 text-base font-semibold"
              >
                {t(`projectLibrary.${dialog.kind}`)}
              </h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void confirm();
                }}
              >
                <p
                  id="project-library-dialog-description"
                  className="mb-4 text-sm leading-relaxed text-fg-muted"
                >
                  {t(`projectLibrary.${dialog.kind}Help`, {
                    count: "ids" in dialog ? dialog.ids.length : 1,
                    name: "name" in dialog ? dialog.name : "",
                    size:
                      dialog.kind === "purge"
                        ? formatProjectBytes(dialog.bytes)
                        : "",
                  })}
                </p>
                {"ids" in dialog && (
                  <ul className="mb-4 max-h-32 overflow-y-auto rounded-md border border-border px-3 py-2 text-sm">
                    {dialog.projectNames!.map((projectName, index) => (
                      <li key={index} className="truncate py-0.5">
                        {projectName}
                      </li>
                    ))}
                  </ul>
                )}
                {naming && (
                  <input
                    autoComplete="off"
                    aria-label={t("projectLibrary.nameInput")}
                    className={`${inputClass} w-full`}
                    value={name}
                    required
                    maxLength={120}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
                {dialog.kind === "move" && (
                  <select
                    aria-label={t("projectLibrary.destination")}
                    className={`${inputClass} w-full`}
                    value={moveFolder}
                    disabled={busy}
                    onChange={(event) => setMoveFolder(event.target.value)}
                  >
                    <option value="">{t("projectLibrary.ungrouped")}</option>
                    {data.folders.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                )}
                {error && (
                  <p role="alert" className="mt-3 text-sm text-red-400">
                    {error}
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    className={`${buttonClass} ${dialog.kind === "purge" ? "border-red-400 bg-red-400/10 text-red-400" : "border-accent bg-accent text-accent-fg"}`}
                    disabled={busy || Boolean(naming && !name.trim())}
                  >
                    {t(busy ? "common.loading" : "projectLibrary.confirm")}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
