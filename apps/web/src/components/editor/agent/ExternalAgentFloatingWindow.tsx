import type { JSX } from "react";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { Bot } from "@/icons/lucide-compat";
import {
  clampBoundsToViewport,
  DEFAULT_MIN_SIZE,
  FLOATING_WINDOW_MARGIN,
  FloatingWindow,
  type WindowBounds,
} from "../../floating/FloatingWindow";
import { PanelErrorBoundary } from "../../ErrorBoundary";
import { useUIStore } from "../../../stores/ui-store";

const ExternalAgentPanel = lazy(() =>
  import("./ExternalAgentPanelContainer").then((module) => ({
    default: module.ExternalAgentPanelContainer,
  })),
);

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 560;
const DEFAULT_TOP = 72;
const DEFAULT_RIGHT_MARGIN = 24;

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

/**
 * Hosts the external-session surface in a floating window above the editor.
 * Only window geometry is persisted here: ReelTerminal does not own the
 * external Agent's model or conversation history (docs/adr/0005), so closing
 * just hides the view. Because the panel stays mounted while the window is
 * dragged, resized, or minimized (display:none), the live conversation event
 * listener, composer draft, and numbered references survive all of those.
 */
export function ExternalAgentFloatingWindow({
  defaultBottomReserve = 0,
}: {
  /**
   * Vertical space (px) at the viewport bottom that the factory-default
   * window must stay above. The desktop Edit page passes its collab strip +
   * timeline dock height: the strip's right-side entries (voiceover/
   * music, agent session) must stay clickable while the window is open.
   * Only the never-dragged default geometry shrinks; once the user drags or
   * resizes, their persisted bounds win.
   */
  defaultBottomReserve?: number;
} = {}): JSX.Element | null {
  const { t } = useTranslation();
  const panel = useUIStore((state) => state.panels.externalAgent);
  const setPanelVisible = useUIStore((state) => state.setPanelVisible);
  const setPanelGeometry = useUIStore((state) => state.setPanelGeometry);
  const setPanelMinimized = useUIStore((state) => state.setPanelMinimized);
  const setPanelMaximized = useUIStore((state) => state.setPanelMaximized);

  // The desktop shell scopes its dark Resolve theme under .openreel-desktop;
  // portaling there keeps the window on the same theme tokens as the shell.
  const portalContainer = useMemo(
    () => document.querySelector(".openreel-desktop") ?? document.body,
    [],
  );

  if (!panel.visible) return null;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const width = panel.width ?? DEFAULT_WIDTH;
  // Occlusion reserve: with no persisted position the user has never dragged
  // the window, so keep its default rectangle above the reserved bottom strip
  // (desktop collab bar + timeline) instead of covering the strip's entries.
  // Any drag or resize commits x/y, which opts out of this default sizing.
  const atDefaultPosition = panel.x == null && panel.y == null;
  const height = atDefaultPosition
    ? Math.max(
        DEFAULT_MIN_SIZE.height,
        Math.min(
          panel.height ?? DEFAULT_HEIGHT,
          viewport.height -
            DEFAULT_TOP -
            FLOATING_WINDOW_MARGIN -
            defaultBottomReserve,
        ),
      )
    : (panel.height ?? Math.min(DEFAULT_HEIGHT, viewport.height - 80));
  const bounds = clampBoundsToViewport({
    x: panel.x ?? viewport.width - width - DEFAULT_RIGHT_MARGIN,
    y: panel.y ?? DEFAULT_TOP,
    width,
    height,
  });
  const minimized = panel.minimized ?? false;
  const maximized = panel.maximized ?? false;

  return (
    <PanelErrorBoundary name={t("externalAgent.title")}>
      <FloatingWindow
        title={t("externalAgent.title")}
        icon={<Bot size={14} className="shrink-0 text-accent" aria-hidden />}
        bounds={bounds}
        minimized={minimized}
        maximized={maximized}
        onBoundsChange={(next: WindowBounds) =>
          setPanelGeometry("externalAgent", next)
        }
        onMinimize={() => setPanelMinimized("externalAgent", !minimized)}
        onToggleMaximize={() =>
          setPanelMaximized("externalAgent", !maximized, bounds)
        }
        onClose={() => setPanelVisible("externalAgent", false)}
        portalContainer={portalContainer}
      >
        <Suspense fallback={<PanelLoading />}>
          <ExternalAgentPanel hideHeader />
        </Suspense>
      </FloatingWindow>
    </PanelErrorBoundary>
  );
}

export default ExternalAgentFloatingWindow;
