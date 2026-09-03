import type { CSSProperties, JSX } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectMarker } from "@openreel/core";

export type ProjectMarkerBadgeSize = "sm" | "md";

interface ProjectMarkerBadgeProps {
  number: number;
  label?: string;
  /** Light ring shown when the owning entity is selected. */
  selected?: boolean;
  size?: ProjectMarkerBadgeSize;
  className?: string;
  style?: CSSProperties;
}

/**
 * Amber numbered pill for a persisted project review marker. Mirrors the
 * AgentReferenceBadge pattern (violet, top-left) but anchored top-right and
 * backed by `project.markers` instead of the ephemeral agent-references store.
 */
export function ProjectMarkerBadge({
  number,
  label,
  selected = false,
  size = "sm",
  className = "",
  style,
}: ProjectMarkerBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const fallback = t("reviewMarkers.badgeLabel", { number });
  const tooltip = label && label.trim().length > 0 ? label : fallback;

  return (
    <span
      className={`pointer-events-none inline-block rounded-[4px] bg-[#f59e0b] font-bold leading-none text-[#201300] shadow-[0_1px_5px_rgba(0,0,0,0.35)] ${
        size === "md" ? "px-2 py-1 text-[10px]" : "px-1.5 py-0.5 text-[9px]"
      } ${selected ? "ring-2 ring-white/90" : ""} ${className}`}
      style={style}
      aria-label={tooltip}
      title={tooltip}
    >
      #{number}
    </span>
  );
}

interface ProjectMarkerBadgeStackProps {
  markers: readonly ProjectMarker[];
  selected?: boolean;
  size?: ProjectMarkerBadgeSize;
  className?: string;
}

/** Top-right stack of review-marker pills for one entity (clip, asset, …). */
export function ProjectMarkerBadgeStack({
  markers,
  selected = false,
  size = "sm",
  className = "",
}: ProjectMarkerBadgeStackProps): JSX.Element | null {
  if (markers.length === 0) return null;

  return (
    <span
      className={`pointer-events-none absolute right-1 top-1 z-30 flex items-center gap-0.5 ${className}`}
    >
      {markers.map((marker) => (
        <ProjectMarkerBadge
          key={marker.id}
          number={marker.number}
          label={marker.label}
          selected={selected}
          size={size}
        />
      ))}
    </span>
  );
}
