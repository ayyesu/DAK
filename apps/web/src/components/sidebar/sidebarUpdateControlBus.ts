/**
 * Points the user at the sidebar control that owns the desktop update flow.
 * A notice elsewhere on screen (the island) raises this so a press lands them on
 * the thing it is about, instead of leaving them to hunt the footer.
 */

const REVEAL_UPDATE_CONTROL_EVENT = "dak:reveal-update-control";

export function revealSidebarUpdateControl(): void {
  window.dispatchEvent(new Event(REVEAL_UPDATE_CONTROL_EVENT));
}

/** Runs when a notice asks the control to show itself. Returns an unsubscribe. */
export function onRevealSidebarUpdateControl(listener: () => void): () => void {
  window.addEventListener(REVEAL_UPDATE_CONTROL_EVENT, listener);
  return () => window.removeEventListener(REVEAL_UPDATE_CONTROL_EVENT, listener);
}
