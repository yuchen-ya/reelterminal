/** Keep a deferred close callback from taking focus owned by a newer popup. */
export function preservePopupFocus(event: Event): void {
  const focusedPopup = document.activeElement?.closest(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
  )
  if (focusedPopup) event.preventDefault()
}
