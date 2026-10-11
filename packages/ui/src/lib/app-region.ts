import type React from "react"

// Electron composes the custom title bar's drag region from
// -webkit-app-region rectangles and ignores stacking order entirely, so a
// portal-rendered overlay that crosses the title bar keeps that intersection
// draggable and swallows clicks as window drags unless it opts out here.
// Browsers ignore the property, so this is a no-op on the web build.
export const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties
