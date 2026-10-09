import React from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftSelectControl as Selector } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import type { CloseRetentionPreference } from "../../../stores/settings-store";

/**
 * "Projects & Saving" settings panel. Currently hosts the close-retention
 * preference (docs/VERSION-NODES-UX.md 关闭应用时留存版本): the workspace save
 * on close is mandatory and not configurable here — only whether versions
 * are retained, asked about, or skipped.
 */
export const SavingPanel: React.FC = () => {
  const { t } = useTranslation();
  const closeRetention = useSettingsStore((s) => s.closeRetention);
  const setCloseRetention = useSettingsStore((s) => s.setCloseRetention);

  return (
    <div className="space-y-6 pb-4">
      <div className="space-y-3">
        <div>
          <Text type="body" color="primary" className="text-sm font-medium">
            {t("settings.closeRetentionLabel")}
          </Text>
          <Text type="supporting" color="secondary" className="mt-0.5 text-xs">
            {t("closeRetention.body")}
          </Text>
        </div>
        <Selector<CloseRetentionPreference>
          label={t("settings.closeRetentionLabel")}
          ariaLabel={t("settings.closeRetentionLabel")}
          size="md"
          width={280}
          value={closeRetention}
          onChange={(value) => setCloseRetention(value)}
          options={[
            { label: t("closeRetention.ask"), value: "ask" },
            { label: t("closeRetention.auto"), value: "retain" },
            { label: t("closeRetention.skip"), value: "skip" },
          ]}
        />
      </div>
    </div>
  );
};
