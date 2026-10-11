/**
 * Remembering a design's zoom, per document.
 *
 * Local storage rather than the panel store because this is a reading position, not app state: it
 * belongs to the user looking at that design on that machine, and it should survive a reload without
 * a server round trip or a migration. A corrupt or absent value reads as null, which the panel treats
 * as "fit it", so a bad entry can only ever cost the user their zoom — never break the view.
 */

const KEY_PREFIX = "dak.canvas.zoom.";

const isBrowser = typeof window !== "undefined" && typeof window.localStorage !== "undefined";

export const readStoredZoom = (documentId: string): number | null => {
  if (!isBrowser) return null;
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${documentId}`);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    // Private browsing and a full quota both throw here, and neither is worth failing a render over.
    return null;
  }
};

export const writeStoredZoom = (documentId: string, zoom: number): void => {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${documentId}`, String(zoom));
  } catch {
    // Nothing to do: the zoom is applied in memory either way, it just will not survive a reload.
  }
};
