/**
 * Shared constants for the text presets panel: the default title style used
 * by the "Add Title" button and the read-only built-in style presets. The
 * panel merges these built-ins (never editable) with the user's custom text
 * presets from the cross-project preset store.
 */
import type { TextStyle } from "@reelterminal/core";

export const DEFAULT_TITLE_STYLE: Partial<TextStyle> = {
  fontSize: 96,
  fontWeight: 800,
  letterSpacing: -1,
};

export const TEXT_STYLE_PRESETS: ReadonlyArray<{
  name: string;
  text: string;
  style: Partial<TextStyle>;
}> = [
  { name: "Heading", text: "Heading", style: { fontSize: 72, fontWeight: 700 } },
  { name: "Subtitle", text: "Subtitle text", style: { fontSize: 36, fontWeight: 400 } },
  {
    name: "Lower Third",
    text: "Name Here",
    style: {
      fontSize: 32,
      fontWeight: 600,
      textAlign: "left",
      verticalAlign: "bottom",
      backgroundColor: "rgba(0, 0, 0, 0.7)",
    },
  },
  {
    name: "Caption",
    text: "Caption text here",
    style: {
      fontSize: 24,
      fontWeight: 400,
      verticalAlign: "bottom",
      shadowColor: "rgba(0, 0, 0, 0.8)",
      shadowBlur: 4,
      shadowOffsetX: 1,
      shadowOffsetY: 1,
    },
  },
  {
    name: "Hero",
    text: "MAKE IT MOVE",
    style: {
      fontSize: 112,
      fontWeight: 900,
      letterSpacing: -2,
      lineHeight: 0.95,
      strokeWidth: 3,
    },
  },
  {
    name: "Quote",
    text: "“Tell a better story.”",
    style: {
      fontSize: 54,
      fontWeight: 600,
      fontStyle: "italic",
      lineHeight: 1.25,
      shadowColor: "rgba(0, 0, 0, 0.65)",
      shadowBlur: 10,
      shadowOffsetY: 4,
    },
  },
  {
    name: "Outline",
    text: "OUTLINE",
    style: {
      fontSize: 80,
      fontWeight: 900,
      letterSpacing: 2,
      strokeColor: "#111827",
      strokeWidth: 5,
    },
  },
  {
    name: "Badge",
    text: "NEW RELEASE",
    style: {
      fontSize: 28,
      fontWeight: 800,
      letterSpacing: 3,
      backgroundColor: "rgba(17, 24, 39, 0.88)",
    },
  },
];
