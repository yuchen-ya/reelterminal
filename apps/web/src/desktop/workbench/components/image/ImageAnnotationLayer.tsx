import type { JSX } from "react";
import type { WorkbenchSpatialAnnotation } from "@reelterminal/core";
import {
  ANNOTATION_COLOR_ARROW,
  LABEL_CHIP_BG,
} from "./image-canvas-utils";

export interface ImageAnnotationLayerProps {
  readonly natural: { readonly w: number; readonly h: number } | null;
  readonly holdOriginal: boolean;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
  readonly selectedAnnotationId: string | null;
  readonly isDraftBoxVisible: boolean;
  readonly isDraftArrowVisible: boolean;
  readonly draftStart: { readonly x: number; readonly y: number } | null;
  readonly draftCurrent: { readonly x: number; readonly y: number } | null;
}

export function ImageAnnotationLayer({
  natural,
  holdOriginal,
  annotations,
  selectedAnnotationId,
  isDraftBoxVisible,
  isDraftArrowVisible,
  draftStart,
  draftCurrent,
}: ImageAnnotationLayerProps): JSX.Element | null {
  if (!natural || holdOriginal) return null;
  const u = natural.w / 640;
  const accentStyle = { fill: "var(--accent)", stroke: "var(--accent)" } as const;

  return (
    <svg
      viewBox={`0 0 ${natural.w} ${natural.h}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        <marker
          id="rt-image-arrowhead"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill={ANNOTATION_COLOR_ARROW} />
        </marker>
      </defs>

      {annotations.map((ann, idx) => {
        const isSelected = selectedAnnotationId === ann.id;
        if (ann.tool === "box") {
          const rx = ann.x * natural.w;
          const ry = ann.y * natural.h;
          const rw = (ann.w ?? 0.15) * natural.w;
          const rh = (ann.h ?? 0.15) * natural.h;
          return (
            <g key={ann.id}>
              <rect
                x={rx}
                y={ry}
                width={rw}
                height={rh}
                rx={4 * u}
                fill={isSelected ? undefined : ann.color}
                fillOpacity={isSelected ? 0.16 : 0.08}
                stroke={isSelected ? undefined : ann.color}
                strokeWidth={(isSelected ? 3 : 2) * u}
                strokeDasharray={isSelected ? undefined : `${6 * u} ${4 * u}`}
                style={isSelected ? accentStyle : undefined}
              />
              <rect
                x={rx}
                y={Math.max(2 * u, ry - 24 * u)}
                width={34 * u}
                height={20 * u}
                rx={4 * u}
                fill={LABEL_CHIP_BG}
                stroke={isSelected ? undefined : ann.color}
                strokeWidth={1 * u}
                style={isSelected ? { stroke: "var(--accent)" } : undefined}
              />
              <text
                x={rx + 8 * u}
                y={Math.max(16 * u, ry - 10 * u)}
                fill={isSelected ? undefined : ann.color}
                fontSize={11 * u}
                fontWeight={700}
                style={isSelected ? { fill: "var(--accent)" } : undefined}
              >
                #{idx + 1}
              </text>
            </g>
          );
        }
        if (ann.tool === "arrow") {
          const x1 = ann.x * natural.w;
          const y1 = ann.y * natural.h;
          const x2 = (ann.endX ?? ann.x + 0.1) * natural.w;
          const y2 = (ann.endY ?? ann.y + 0.1) * natural.h;
          return (
            <g key={ann.id}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={isSelected ? undefined : ann.color}
                strokeWidth={(isSelected ? 3.5 : 2.5) * u}
                markerEnd="url(#rt-image-arrowhead)"
                style={isSelected ? accentStyle : undefined}
              />
              <text
                x={x1 + 4 * u}
                y={Math.max(16 * u, y1 - 8 * u)}
                fontSize={12 * u}
                fontWeight={700}
                fill={isSelected ? undefined : ann.color}
                stroke={LABEL_CHIP_BG}
                strokeWidth={3 * u}
                paintOrder="stroke"
                style={isSelected ? { fill: "var(--accent)" } : undefined}
              >
                #{idx + 1}
                {isSelected && ann.label ? ` ${ann.label.slice(0, 20)}` : ""}
              </text>
            </g>
          );
        }
        const tx = ann.x * natural.w;
        const ty = ann.y * natural.h;
        return (
          <g key={ann.id}>
            <circle
              cx={tx}
              cy={ty}
              r={6 * u}
              fill={isSelected ? undefined : ann.color}
              style={isSelected ? { fill: "var(--accent)" } : undefined}
            />
            <text
              x={tx + 10 * u}
              y={ty + 4 * u}
              fontSize={12 * u}
              fontWeight={700}
              fill={isSelected ? undefined : ann.color}
              stroke={LABEL_CHIP_BG}
              strokeWidth={3 * u}
              paintOrder="stroke"
              style={isSelected ? { fill: "var(--accent)" } : undefined}
            >
              #{idx + 1}
              {isSelected && ann.label ? ` ${ann.label.slice(0, 20)}` : ""}
            </text>
          </g>
        );
      })}

      {isDraftBoxVisible && draftStart && draftCurrent && (
        <rect
          x={Math.min(draftStart.x, draftCurrent.x) * natural.w}
          y={Math.min(draftStart.y, draftCurrent.y) * natural.h}
          width={Math.abs(draftCurrent.x - draftStart.x) * natural.w}
          height={Math.abs(draftCurrent.y - draftStart.y) * natural.h}
          fill="var(--accent)"
          fillOpacity={0.16}
          strokeWidth={2.5 * u}
          style={{ stroke: "var(--accent)" }}
        />
      )}
      {isDraftArrowVisible && draftStart && draftCurrent && (
        <line
          x1={draftStart.x * natural.w}
          y1={draftStart.y * natural.h}
          x2={draftCurrent.x * natural.w}
          y2={draftCurrent.y * natural.h}
          strokeWidth={2.5 * u}
          markerEnd="url(#rt-image-arrowhead)"
          style={{ stroke: "var(--accent)" }}
        />
      )}
    </svg>
  );
}
