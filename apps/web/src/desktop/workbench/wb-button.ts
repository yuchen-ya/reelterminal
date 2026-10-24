/**
 * Workbench button design tokens.
 *
 * Provides consistent 28px height, 12px text, 6px radius, and standard states:
 * - primary: solid accent green
 * - secondary: bg-2 with border
 * - ghost: transparent, borderless, reveals bg on hover
 * - danger: status-error red text, soft red tint on hover
 * - segmented: container and item states for segmented switchers
 */

export const primary =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] bg-accent px-3 text-xs font-semibold text-accent-fg whitespace-nowrap transition-colors hover:brightness-110 active:brightness-95 disabled:opacity-40";

export const secondary =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] border border-border bg-bg-2 px-2.5 text-xs text-fg-2 hover:bg-bg-3 hover:text-fg whitespace-nowrap transition-colors disabled:opacity-40";

export const ghost =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] bg-transparent px-2.5 text-xs text-fg-2 hover:bg-bg-2 hover:text-fg whitespace-nowrap transition-colors disabled:opacity-40";

export const danger =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] bg-transparent px-2.5 text-xs text-status-error hover:bg-status-error/10 whitespace-nowrap transition-colors disabled:opacity-40";

export const segmentedContainer =
  "inline-flex items-center gap-0.5 rounded-[6px] border border-border bg-bg-1 p-0.5 text-xs";

export function segmentedItem(active: boolean): string {
  return `inline-flex h-6 items-center justify-center rounded-[4px] px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
    active ? "bg-bg-3 text-fg shadow-sm" : "text-fg-3 hover:text-fg-2"
  }`;
}

export const segmented = {
  container: segmentedContainer,
  item: segmentedItem,
  active: "bg-bg-3 text-fg font-medium shadow-sm",
  inactive: "text-fg-3 hover:text-fg-2",
};

export const wbButton = {
  primary,
  secondary,
  ghost,
  danger,
  segmented,
  segmentedContainer,
  segmentedItem,
};

export default wbButton;
