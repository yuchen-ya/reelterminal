import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "@/icons/lucide-compat";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@reelterminal/ui";
import { ToolcraftSegmentedControl } from "@reelterminal/ui";
import { ToolcraftLayout as Layout, ToolcraftLayoutContent as LayoutContent } from "@reelterminal/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import { GeneralPanel } from "./GeneralPanel";
import { StoragePanel } from "./StoragePanel";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";

type SettingsPanelId = "general" | "storage" | "shortcuts";

export const SettingsDialog: React.FC = () => {
  const { t } = useTranslation();
  const { settingsOpen, closeSettings } = useSettingsStore();
  const [activePanel, setActivePanel] = useState<SettingsPanelId>("general");

  // Every open starts on the General panel so the dialog reads the same way
  // for users who never visit the shortcuts tab.
  useEffect(() => {
    if (settingsOpen) {
      setActivePanel("general");
    }
  }, [settingsOpen]);

  return (
    <Dialog
      isOpen={settingsOpen}
      onOpenChange={(open) => !open && closeSettings()}
      width={720}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            closeLabel={t("Close dialog")}
            title={t("settingsDialog.title")}
            subtitle={t("settingsDialog.subtitle")}
            onOpenChange={(open) => !open && closeSettings()}
            startContent={<Settings size={18} className="text-primary" aria-hidden />}
          />
        }
        content={
          <LayoutContent className="max-h-[70vh] overflow-y-auto">
            <div className="mt-4 space-y-4">
              <ToolcraftSegmentedControl<SettingsPanelId>
                ariaLabel={t("settingsDialog.ariaLabel")}
                value={activePanel}
                onChange={setActivePanel}
                options={[
                  { value: "general", label: t("settingsDialog.general") },
                  { value: "storage", label: t("settingsDialog.storage") },
                  { value: "shortcuts", label: t("settingsDialog.shortcuts") },
                ]}
              />
              {activePanel === "general" ? (
                <GeneralPanel />
              ) : activePanel === "storage" ? (
                <StoragePanel />
              ) : (
                <KeyboardShortcutsPanel />
              )}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
};
