import type { JSX } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { BootLoader } from "@/components/brand/BootLoader";
import { useDesktopEditorBootstrap } from "./useDesktopEditorBootstrap";

export function EditorBootstrapGate({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const { ready, error } = useDesktopEditorBootstrap();
  if (error) {
    return (
      <div className="grid h-full place-items-center bg-bg p-4 text-sm text-red-300">
        {t("desktop.editor.failed", { message: error.message })}
      </div>
    );
  }
  if (!ready) {
    return (
      <BootLoader message={t("desktop.editor.loading")} />
    );
  }
  return <>{children}</>;
}
