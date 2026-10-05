import type { JSX } from "react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { toast } from "../../stores/notification-store";
import { ToolcraftIconButton, ToolcraftTextInputControl } from "@reelterminal/ui";
import { ProjectSwitcher } from "../../components/editor/ProjectSwitcher";
import { useTranslation } from "react-i18next";

/** One project title trigger with a single, discoverable rename affordance. */
export function DesktopProjectNameControl({ onNewProject }: { onNewProject?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const { project, renameProject } = useProjectStore();
  const projectNameRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(project.name);
  const cancellingRef = useRef(false);

  useEffect(() => {
    setProjectNameDraft(project.name);
  }, [project.name]);

  useEffect(() => {
    if (isEditing) {
      projectNameRef.current?.focus();
      projectNameRef.current?.select();
    }
  }, [isEditing]);

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
    setIsEditing(false);
  }, [projectNameDraft, project.name, renameProject, t]);

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-testid="desktop-project-name-control"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {isEditing ? (
        <ToolcraftTextInputControl
          ref={projectNameRef}
          label={t("Project name")}
          isLabelHidden
          value={projectNameDraft}
          onChange={setProjectNameDraft}
          onBlur={() => {
            if (cancellingRef.current) {
              cancellingRef.current = false;
              setIsEditing(false);
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
      ) : (
        <>
          <ProjectSwitcher onNewProject={onNewProject} />
          <ToolcraftIconButton
            label={t("Rename project")}
            icon={<Pencil size={12} aria-hidden />}
            size="sm"
            variant="ghost"
            onClick={() => setIsEditing(true)}
            className="h-6 w-6 rounded-md text-fg-muted hover:bg-bg-2 hover:text-fg"
          />
        </>
      )}
    </div>
  );
}
