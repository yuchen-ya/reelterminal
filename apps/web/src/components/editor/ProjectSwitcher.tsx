import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Plus,
  FolderOpen,
  Clock,
  Check,
  Pencil,
  FileVideo,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftIconButton as IconButton } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { ToolcraftTextInputControl } from "@reelterminal/ui";
import { useProjectStore } from "../../stores/project-store";
import { autoSaveManager, type AutoSaveMetadata } from "../../services/auto-save";
import { useAnchoredBelowStyle } from "../../utils/anchored-position";
import { useTranslation } from "react-i18next";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins}m ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days}d ago`;
}

export const ProjectSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const { project, createNewProject, recoverFromAutoSave, renameProject } = useProjectStore();
  const [isOpen, setIsOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState<AutoSaveMetadata[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [isLoading, setIsLoading] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The dropdown portals to document.body: inside the header it was trapped
  // in the header's z-30 stacking context (web timeline toolbar z-50 beat it
  // no matter the value). Portaled, it uses the --z-popover ladder.
  const dropdownStyle = useAnchoredBelowStyle(triggerRef, isOpen, 8);

  useEffect(() => {
    const loadSavedProjects = async () => {
      try {
        await autoSaveManager.initialize();
        const saves = await autoSaveManager.checkForRecovery();
        const uniqueProjects = saves.reduce((acc, save) => {
          const existing = acc.find((s) => s.projectId === save.projectId);
          if (!existing || save.timestamp > existing.timestamp) {
            return [...acc.filter((s) => s.projectId !== save.projectId), save];
          }
          return acc;
        }, [] as AutoSaveMetadata[]);
        setSavedProjects(uniqueProjects.sort((a, b) => b.timestamp - a.timestamp));
      } catch (err) {
        console.warn("[ProjectSwitcher] Failed to load saved projects:", err);
      }
    };

    if (isOpen) {
      loadSavedProjects();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Both the trigger (document flow) and the portaled dropdown must
      // count as "inside"; otherwise clicking the portaled menu would close it.
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
      setIsEditing(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Escape closes the dropdown; while renaming, the input keeps its own
  // Escape semantics (cancel the edit, dropdown stays open).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isEditing) return;
      e.stopPropagation();
      setIsOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditName(project.name);
  }, [project.name]);

  const handleSaveName = useCallback(async () => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== project.name) {
      await renameProject(trimmedName);
    }
    setIsEditing(false);
  }, [editName, project.name, renameProject]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleSaveName();
      } else if (e.key === "Escape") {
        setEditName(project.name);
        setIsEditing(false);
      }
    },
    [handleSaveName, project.name]
  );

  const handleNewProject = useCallback(() => {
    createNewProject();
    setIsOpen(false);
  }, [createNewProject]);

  const handleSwitchProject = useCallback(
    async (saveId: string) => {
      setIsLoading(true);
      try {
        await recoverFromAutoSave(saveId);
        setIsOpen(false);
      } catch (err) {
        console.error("[ProjectSwitcher] Failed to switch project:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [recoverFromAutoSave]
  );

  const otherProjects = savedProjects.filter((s) => s.projectId !== project.id);

  return (
    <div className="relative" ref={triggerRef}>
      <Button
        // Project names are user data, not catalog keys: a project literally
        // named "Horizontal" must never pick up the zh dictionary's "水平".
        label={project.name}
        onClick={() => setIsOpen(!isOpen)}
        variant="ghost"
        size="md"
        icon={<FileVideo className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
        endContent={
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
            aria-hidden
          />
        }
        className="max-w-[200px] justify-start truncate hover:bg-background-secondary"
      />

      {isOpen &&
        createPortal(
          <Card
            ref={dropdownRef}
            variant="default"
            padding={0}
            style={dropdownStyle}
            className="z-[var(--z-popover)] w-72 overflow-hidden border border-border bg-background shadow-2xl animate-in fade-in slide-in-from-top-2 duration-150"
          >
          <div className="p-3 border-b border-border">
            <Text
              type="supporting"
              color="secondary"
              className="mb-2 text-xs font-medium uppercase tracking-wider"
            >
              {t("Current Project")}</Text>
            {isEditing ? (
              <div className="flex items-center gap-2">
                <ToolcraftTextInputControl
                  ref={inputRef}
                  label={t("Project name")}
                  isLabelHidden
                  size="sm"
                  width="100%"
                  value={editName}
                  onChange={setEditName}
                  onBlur={handleSaveName}
                  onKeyDown={handleKeyDown}
                  className="flex-1 bg-background-secondary border-primary text-text-primary"
                />
                <IconButton
                  label={t("Save project name")}
                  onClick={handleSaveName}
                  variant="secondary"
                  size="sm"
                  icon={<Check className="h-4 w-4" aria-hidden />}
                  className="bg-primary text-white hover:bg-primary-hover"
                />
              </div>
            ) : (
              <Card
                variant="muted"
                padding={2}
                className="group flex items-center gap-2 bg-background-secondary"
              >
                <FileVideo className="w-4 h-4 text-primary shrink-0" />
                <Text
                  type="supporting"
                  color="primary"
                  className="flex-1 truncate text-sm font-medium"
                >
                  {project.name}
                </Text>
                <IconButton
                  label={t("Rename project")}
                  onClick={() => setIsEditing(true)}
                  variant="ghost"
                  size="sm"
                  icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                  className="text-text-muted hover:bg-background-tertiary hover:text-text-primary"
                />
              </Card>
            )}
          </div>

          <div className="p-2">
            <ClickableCard
              label={t("New Project")}
              onClick={handleNewProject}
              padding={3}
              variant="transparent"
              className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
            >
              <div className="p-1.5 bg-primary/10 rounded-md text-primary group-hover:bg-primary/20 transition-colors">
                <Plus className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("New Project")}</Text>
                <Text type="supporting" color="secondary" className="text-xs">
                  {t("Start fresh with a new canvas")}</Text>
              </div>
            </ClickableCard>
          </div>

          {otherProjects.length > 0 && (
            <>
              <div className="px-3 py-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  <Text
                    type="supporting"
                    color="secondary"
                    className="text-xs font-medium uppercase tracking-wider"
                  >
                  {t("Recent Projects")}</Text>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto px-2 pb-2">
                {otherProjects.map((save) => (
                  <ClickableCard
                    key={save.id}
                    label={`Open ${save.projectName}`}
                    onClick={() => handleSwitchProject(save.id)}
                    isDisabled={isLoading}
                    padding={3}
                    variant="transparent"
                    className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
                  >
                    <div className="p-1.5 bg-background-tertiary rounded-md text-text-muted group-hover:text-text-secondary transition-colors">
                      <FolderOpen className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Text
                        type="supporting"
                        color="primary"
                        className="truncate text-sm font-medium group-hover:text-primary"
                      >
                        {save.projectName}
                      </Text>
                      <Text type="supporting" color="secondary" className="text-xs">
                        {formatTimeAgo(save.timestamp)}
                      </Text>
                    </div>
                  </ClickableCard>
                ))}
              </div>
            </>
          )}
        </Card>,
          document.body,
        )}
    </div>
  );
};
