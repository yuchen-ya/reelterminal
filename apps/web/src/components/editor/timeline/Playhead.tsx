import React from "react";

interface PlayheadProps {
  position: number;
  pixelsPerSecond: number;
  scrollX: number;
  headerOffset: number;
}

// Brand playhead: thin accent vertical line with a pentagon drag handle at
// the top. Colors come from theme tokens (--accent / --accent-glow) so the
// playhead keeps stable high-contrast visibility on both light and dark
// timeline backgrounds, at any zoom level or scroll position.
export const Playhead: React.FC<PlayheadProps> = ({
  position,
  pixelsPerSecond,
  scrollX,
  headerOffset,
}) => {
  const pixelPosition = position * pixelsPerSecond - scrollX;

  if (pixelPosition < 0) return null;

  return (
    <div
      className="absolute top-0 bottom-0 z-50 pointer-events-none"
      data-testid="playhead"
      style={{
        left: headerOffset,
        transform: `translateX(${pixelPosition}px)`,
        willChange: "transform",
      }}
    >
      {/* pentagon handle at the top */}
      <div
        className="absolute"
        data-testid="playhead-handle"
        style={{
          top: 0,
          left: -7,
          width: 15,
          height: 13,
          backgroundColor: "var(--accent)",
          borderRadius: "3px 3px 0 0",
          clipPath: "polygon(0 0,100% 0,100% 65%,50% 100%,0 65%)",
          boxShadow: "0 0 0 1px var(--accent-glow), 0 1px 6px var(--accent-glow)",
        }}
      />
      {/* vertical line */}
      <div
        className="absolute"
        data-testid="playhead-line"
        style={{
          top: 0,
          bottom: 0,
          left: -1,
          width: 2,
          backgroundColor: "var(--accent)",
          boxShadow: "0 0 4px var(--accent-glow)",
        }}
      />
    </div>
  );
};
