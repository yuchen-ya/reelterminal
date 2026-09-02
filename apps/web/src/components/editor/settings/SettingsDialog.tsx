import React from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "@/icons/lucide-compat";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@openreel/ui";
import { ToolcraftLayout as Layout, ToolcraftLayoutContent as LayoutContent } from "@openreel/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import { GeneralPanel } from "./GeneralPanel";

export const SettingsDialog: React.FC = () => {
  const { t } = useTranslation();
  const { settingsOpen, closeSettings } = useSettingsStore();

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
            <div className="mt-4">
              <GeneralPanel />
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
};
