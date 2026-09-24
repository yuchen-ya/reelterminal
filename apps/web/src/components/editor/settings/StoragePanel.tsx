import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { toast } from "../../../stores/notification-store";

interface DataRootMigrationItem {
  kind: "appData" | "workspace";
  from: string;
  to: string;
  status:
    | "moved"
    | "copied-backup-left"
    | "skipped-missing"
    | "skipped-target-exists"
    | "failed";
  error?: string;
}

interface DataRootInfo {
  active: boolean;
  root: string;
  source: "env" | "pointer" | "default";
  appData: string;
  projects: string;
  agentWorkspace: string;
  logs: string;
  machineConfigDir: string;
  migrationItems: DataRootMigrationItem[];
}

const MIGRATION_STATUS_KEYS: Record<string, string> = {
  moved: "settings.storage.statusMoved",
  "copied-backup-left": "settings.storage.statusCopiedBackup",
  "skipped-target-exists": "settings.storage.statusSkippedTarget",
  failed: "settings.storage.statusFailed",
};

const SOURCE_KEYS: Record<DataRootInfo["source"], string> = {
  env: "settings.storage.sourceEnv",
  pointer: "settings.storage.sourcePointer",
  default: "settings.storage.sourceDefault",
};

const PathRow: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="flex items-start justify-between gap-4 py-1.5">
    <Text type="supporting" color="secondary" display="block" className="text-[12px] shrink-0">
      {label}
    </Text>
    <span className="text-[11px] font-mono text-fg-2 text-right break-all">
      {value}
    </span>
  </div>
);

/**
 * Settings → Storage: shows every user-scoped location under the data root
 * (docs/DATA-ROOT.md) and lets the user point the root at another folder.
 * Changing the root only records the pointer — the actual move runs on the
 * next launch before the profile opens, so in-use data is never copied live.
 */
export const StoragePanel: React.FC = () => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DataRootInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.reelterminal?.dataRoot
      ?.getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChangeRoot = useCallback(async () => {
    const bridge = window.reelterminal;
    if (!bridge?.dataRoot) return;
    setBusy(true);
    try {
      const picked = await bridge.fs.showOpenDialog({
        filters: [],
        directory: true,
      });
      if (!picked) return;
      const result = await bridge.dataRoot.change(picked);
      if (!result.ok) {
        toast.error(t("settings.storage.changeFailed"), result.error ?? "");
        return;
      }
      if (result.requiresRestart) {
        toast.success(t("settings.storage.restartRequired"), picked);
      } else {
        toast.success(t("settings.storage.sameLocation"));
      }
    } finally {
      setBusy(false);
    }
  }, [t]);

  if (!window.reelterminal?.dataRoot) {
    return (
      <div className="mt-2">
        <Text type="supporting" color="secondary" display="block" className="text-[12px]">
          {t("settings.storage.browserNote")}
        </Text>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="mt-2">
        <Text type="supporting" color="secondary" display="block" className="text-[12px]">
          {t("settings.storage.loading")}
        </Text>
      </div>
    );
  }

  const interestingItems = info.migrationItems.filter(
    (item) => item.status !== "skipped-missing",
  );

  return (
    <div className="mt-2 space-y-4">
      <div>
        <Text type="body" weight="bold" display="block" className="text-[13px] text-fg mb-1">
          {t("settings.storage.title")}
        </Text>
        <Text type="supporting" color="secondary" display="block" className="text-[12px] mb-3">
          {t("settings.storage.description")}
        </Text>

        <div className="rounded-lg border border-border bg-bg-1 px-3 py-2">
          <PathRow label={t("settings.storage.root")} value={info.root || "—"} />
          <PathRow label={t("settings.storage.appData")} value={info.appData} />
          <PathRow
            label={t("settings.storage.projects")}
            value={info.projects || "—"}
          />
          <PathRow
            label={t("settings.storage.agentWorkspace")}
            value={info.agentWorkspace}
          />
          <PathRow label={t("settings.storage.logs")} value={info.logs || "—"} />
          <PathRow
            label={t("settings.storage.machineConfig")}
            value={info.machineConfigDir}
          />
        </div>

        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void handleChangeRoot()}
          >
            {t("settings.storage.change")}
          </Button>
          <Text type="supporting" color="secondary" display="block" className="text-[11px]">
            {t(SOURCE_KEYS[info.source])}
          </Text>
        </div>
      </div>

      {interestingItems.length > 0 && (
        <div>
          <Text type="body" weight="bold" display="block" className="text-[13px] text-fg mb-1">
            {t("settings.storage.migrationTitle")}
          </Text>
          <div className="space-y-1">
            {interestingItems.map((item) => (
              <div key={`${item.kind}:${item.from}`} className="text-[11px] text-fg-2">
                <span className={item.status === "failed" ? "text-red-400" : ""}>
                  {t(MIGRATION_STATUS_KEYS[item.status] ?? "settings.storage.statusFailed")}
                </span>
                {" — "}
                <span className="font-mono break-all">{item.from}</span>
                {item.error ? (
                  <span className="block text-fg-3 font-mono break-all">{item.error}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
