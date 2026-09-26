import type { JSX } from "react";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { KeyboardShortcutsOverlay } from "../../components/editor/KeyboardShortcutsOverlay";

/**
 * Mounts the shared keyboard-shortcut service on the desktop edit page.
 * The web shell does this inside EditorInterface; the desktop component
 * tree never did, so the window keydown listener was never attached there
 * and every shortcut (arrows, space, delete, cmd+s, …) stayed dead.
 *
 * Kept as its own tiny component so the hook's whole-store subscriptions
 * re-render only this overlay, not the editor grid around it. The motion
 * page is intentionally not covered: it registers its own key handling.
 */
export function DesktopKeyboardShortcuts(): JSX.Element {
  const { showShortcutsOverlay, setShowShortcutsOverlay } =
    useKeyboardShortcuts();

  return (
    <KeyboardShortcutsOverlay
      isOpen={showShortcutsOverlay}
      onClose={() => setShowShortcutsOverlay(false)}
    />
  );
}
