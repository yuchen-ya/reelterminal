import type { JSX } from "react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { toast } from "../../stores/notification-store";
import { ToolcraftIconButton, ToolcraftTextInputControl } from "@openreel/ui";
import { ProjectSwitcher } from "../../components/editor/ProjectSwitcher";
import { useTranslation } from "react-i18next";

/**
 * Project name control for the desktop shell's title bar: the delivered
 * desktop chrome must expose a mouse-discoverable rename entry, so the
 * rename input + switcher cannot stay web-Toolbar-only. It mirrors
 * the web toolbar's semantics exactly: a borderless draft input that commits
 * on blur/Enter, cancels on Escape, and a pencil button that focuses and
 * selects the name, with the same ProjectSwitcher dropdown beside it.
 */
export function DesktopProjectNameControl(): JSX.Element {
  const { t } = useTranslation();
  const { project, renameProject } = useProjectStore();
  const projectNameRef = useRef<HTMLInputElement>(null);

  // Local editable project name (committed onBlur / Enter) — same draft
  // lifecycle as components/editor/Toolbar.tsx.
  const [projectNameDraft, setProjectNameDraft] = useState(project.name);
  useEffect(() => {
    setProjectNameDraft(project.name);
  }, [project.name]);

  // Escape cancels the draft; the blur() below fires onBlur synchronously,
  // while its closure still holds the discarded draft — this flag tells
  // onBlur to skip the commit.
  const cancellingRef = useRef(false);

  const commitProjectName = useCallback(async () => {
    const next = projectNameDraft.trim();
    if (next && next !== project.name) {
      const result = await renameProject(next);
      if (!result.success) {
        setProjectNameDraft(project.name);
        toast.error(t("Rename project"), result.error?.message);
      }
    } else {
      setProjectNameDraft(project.name);
    }
  }, [projectNameDraft, project.name, renameProject, t]);

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-testid="desktop-project-name-control"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <ToolcraftTextInputControl
        ref={projectNameRef}
        label={t("Project name")}
        isLabelHidden
        value={projectNameDraft}
        onChange={setProjectNameDraft}
        onBlur={() => {
          if (cancellingRef.current) {
            cancellingRef.current = false;
            return;
          }
          void commitProjectName();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLElement).blur();
          } else if (e.key === "Escape") {
            cancellingRef.current = true;
            setProjectNameDraft(project.name);
            (e.currentTarget as HTMLElement).blur();
          }
        }}
        width={Math.min(Math.max(projectNameDraft.length, 6) * 8 + 40, 180)}
        title={t("Rename project")}
        size="sm"
        className="max-w-[180px] border border-transparent bg-transparent text-center font-medium text-[13px] tracking-tight text-fg-2 px-2 py-0.5 rounded-md min-w-[60px] hover:border-border hover:bg-bg-2/60 focus-within:border-accent focus-within:bg-bg-2"
      />
      <ToolcraftIconButton
        label={t("Rename project")}
        icon={<Pencil size={12} aria-hidden />}
        size="sm"
        variant="ghost"
        onClick={() => {
          projectNameRef.current?.focus();
          projectNameRef.current?.select();
        }}
        className="h-6 w-6 rounded-md text-fg-muted hover:bg-bg-2 hover:text-fg"
      />
      <ProjectSwitcher />
    </div>
  );
}
