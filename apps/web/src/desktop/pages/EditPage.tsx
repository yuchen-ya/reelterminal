import { LEGACY_LS_DESKTOP_MEDIA_WIDTH, LEGACY_LS_DESKTOP_INSPECTOR_WIDTH, LEGACY_LS_DESKTOP_TIMELINE_HEIGHT } from "../../services/legacy-storage-keys";
import { AgentInspectionPanel } from "../editor/AgentInspectionPanel";
import type { JSX } from "react";
import type React from "react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftText as Text } from "@reelterminal/ui";

import { AssetsPanel } from "../../components/editor/AssetsPanel";
import { InspectorPanel } from "../../components/editor/InspectorPanel";
import { ExternalAgentFloatingWindow } from "../../components/editor/agent/ExternalAgentFloatingWindow";
import { AgentMediaTaskDialog } from "../../components/editor/dialogs/AgentMediaTaskDialog";
import { AgentMediaTaskRuntime } from "../../components/editor/dialogs/AgentMediaTaskRuntime";
import { PanelErrorBoundary } from "../../components/ErrorBoundary";
import { CollabStatusBar } from "../editor/CollabStatusBar";
import { Icon } from "@/icons/Icon";
import { useResizable } from "../editor/useResizable";

const Preview = lazy(() =>
  import("../../components/editor/Preview").then((m) => ({ default: m.Preview })),
);
const Timeline = lazy(() =>
  import("../../components/editor/Timeline").then((m) => ({ default: m.Timeline })),
);

function PanelLoading(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid h-full place-items-center">
      <Text type="supporting" color="secondary" className="text-xs">
        {t("common.loading")}
      </Text>
    </div>
  );
}

function DockRegion({
  label,
  name,
  area,
  icon,
  className,
  children,
}: {
  label: string;
  name: string;
  area: string;
  icon: string;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden ${className ?? "bg-bg-1"}`}
      style={{ gridArea: area }}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-bg-1 px-3 text-[11px] font-medium uppercase tracking-wide text-fg-2">
        <Icon name={icon} size={12} className="text-fg-muted" />
        <Text type="supporting" color="secondary" weight="medium" className="text-[11px] uppercase tracking-wide">
          {label}
        </Text>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelErrorBoundary name={name}>{children}</PanelErrorBoundary>
      </div>
    </div>
  );
}

function ColumnHandle({
  edge,
  onPointerDown,
}: {
  edge: "left" | "right";
  onPointerDown(e: React.PointerEvent): void;
}): JSX.Element {
  const position = edge === "left" ? "left-0" : "right-0";
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={`absolute top-0 ${position} z-10 h-full w-1.5 cursor-col-resize bg-border transition-colors hover:bg-accent/40`}
    />
  );
}

function RowHandle({
  onPointerDown,
}: {
  onPointerDown(e: React.PointerEvent): void;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      className="absolute left-0 top-0 z-10 h-1.5 w-full cursor-row-resize bg-border transition-colors hover:bg-accent/40"
    />
  );
}

/** Height of the CollabStatusBar row wrapper below (`h-8`, grid row "collab"). */
const COLLAB_ROW_HEIGHT = 32;

export function EditPage(): JSX.Element {
  const { t } = useTranslation();
  const mediaW = useResizable({
    initial: 320,
    min: 220,
    max: 520,
    axis: "x",
    direction: 1,
    storageKey: LEGACY_LS_DESKTOP_MEDIA_WIDTH,
  });
  const inspectorW = useResizable({
    initial: 340,
    min: 260,
    max: 560,
    axis: "x",
    direction: -1,
    storageKey: LEGACY_LS_DESKTOP_INSPECTOR_WIDTH,
  });
  const timelineH = useResizable({
    initial: 320,
    min: 160,
    max: 640,
    axis: "y",
    direction: -1,
    storageKey: LEGACY_LS_DESKTOP_TIMELINE_HEIGHT,
  });

  // The optional external-session surface floats above the editor as a
  // draggable window; ReelTerminal does not own its model or conversation
  // history. The grid below is always the three-column editor layout.
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `${mediaW.value}px 1fr ${inspectorW.value}px`,
    gridTemplateRows: `1fr auto ${timelineH.value}px`,
    gridTemplateAreas:
      "'media stage inspector' 'collab collab collab' 'timeline timeline timeline'",
  };

  return (
    <div className="grid h-full min-h-0 w-full gap-px overflow-hidden bg-border" style={gridStyle}>
      <DockRegion label={t("desktop.editor.media")} name={t("desktop.editor.media")} area="media" icon="photo.on.rectangle">
        <AssetsPanel />
        <ColumnHandle edge="right" onPointerDown={mediaW.onHandlePointerDown} />
      </DockRegion>

      <DockRegion label={t("desktop.editor.viewer")} name={t("desktop.editor.viewer")} area="stage" icon="play.fill" className="bg-stage-bg">
        <Suspense fallback={<PanelLoading />}>
          <Preview />
        </Suspense>
      </DockRegion>

      <DockRegion label={t("desktop.editor.inspector")} name={t("desktop.editor.inspector")} area="inspector" icon="slider.horizontal.3">
        <InspectorPanel />
        <ColumnHandle edge="left" onPointerDown={inspectorW.onHandlePointerDown} />
      </DockRegion>

      <div className="h-8 min-h-0" style={{ gridArea: "collab" }}>
        <CollabStatusBar />
        <AgentInspectionPanel />
      </div>

      <DockRegion label={t("desktop.editor.timeline")} name={t("desktop.editor.timeline")} area="timeline" icon="rectangle.split.3x1" className="bg-tl-bg">
        <Suspense fallback={<PanelLoading />}>
          <Timeline />
        </Suspense>
        <RowHandle onPointerDown={timelineH.onHandlePointerDown} />
      </DockRegion>

      {/* Occlusion reserve: the never-dragged agent window keeps its default
          rectangle above the collab row + timeline dock so the strip's
          right-side entries stay clickable while the window is open. */}
      <ExternalAgentFloatingWindow
        defaultBottomReserve={COLLAB_ROW_HEIGHT + timelineH.value}
      />
      {/* The voiceover/music task surface must exist on the desktop too, not
          only in the web editor shell. The runtime arms
          the receipt correlator and recommended-root source for the session;
          the dialog renders null while closed and portals to document.body
          when open, so neither has any footprint in the grid above. The
          CollabStatusBar hosts the entry button. */}
      <AgentMediaTaskRuntime />
      <AgentMediaTaskDialog />
    </div>
  );
}

export default EditPage;
