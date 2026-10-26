import type { JSX } from "react";
import { lazy, Suspense } from "react";
import { EditorBootstrapGate } from "../editor/EditorBootstrapGate";
import { useUIStore } from "../../stores/ui-store";
import { useTranslation } from "react-i18next";

const EditPage = lazy(() =>
  import("../pages/EditPage").then((module) => ({ default: module.EditPage })),
);
const MotionPage = lazy(() =>
  import("../pages/MotionPage").then((module) => ({
    default: module.MotionPage,
  })),
);
const ExportCleanupPage = lazy(() =>
  import("../pages/ExportCleanupPage").then((module) => ({
    default: module.ExportCleanupPage,
  })),
);

export function Workspace(): JSX.Element {
  const { t } = useTranslation();
  const desktopPage = useUIStore((state) => state.desktopPage);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="desktop-workspace"
    >
      <EditorBootstrapGate>
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-sm text-fg-muted">
              {t("desktop.workspace.loading")}
            </div>
          }
        >
          <div className="min-h-0 flex-1">
            {desktopPage === "motion" ? (
              <MotionPage />
            ) : (
              <>
                <div className="h-full" hidden={desktopPage === "deliver"}>
                  <EditPage />
                </div>
                {desktopPage === "deliver" ? <ExportCleanupPage /> : null}
              </>
            )}
          </div>
        </Suspense>
      </EditorBootstrapGate>
    </div>
  );
}
