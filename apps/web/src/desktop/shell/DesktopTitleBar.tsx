import type { JSX } from "react";
import type React from "react";
import { WindowControls } from "./WindowControls";
import { ReelTerminalMark } from "@/components/brand/ReelTerminalMark";
import { useTranslation } from "react-i18next";

export function DesktopTitleBar({ platform, projectControl, children }: { platform: string; projectControl?: React.ReactNode; children?: React.ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const isMac = platform === "darwin";
  return (
    <header
      className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-1 text-fg"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: isMac ? 76 : 12 }}>
        <ReelTerminalMark size={16} className="text-accent shrink-0" />
        <span className="text-xs font-semibold tracking-wide text-fg-2 shrink-0">{t("desktop.appName")}</span>
        {projectControl != null ? (
          <div
            className="flex min-w-0 items-center"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {projectControl}
          </div>
        ) : null}
      </div>
      <div className="flex items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {children}
      </div>
      <WindowControls platform={platform} />
    </header>
  );
}
