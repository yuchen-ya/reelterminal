/** Excalidraw uses the platform's primary modifier even for toolbar undo. */
export function dispatchBoardHistory(target: HTMLElement | null | undefined, direction: "undo" | "redo", platform = navigator.platform): void {
  const mac = /Mac|iPhone|iPad|iPod/.test(platform);
  target?.focus();
  target?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "z", code: "KeyZ", ctrlKey: !mac, metaKey: mac,
    shiftKey: direction === "redo", bubbles: true, cancelable: true,
  }));
}
