export function bindCanvasThemeBackground(editor, element) {
  let lastColor = null;
  const sync = (force = false) => {
    const color = parseCssColor(getComputedStyle(element).backgroundColor);
    if (!color || !force && sameColor(color, lastColor)) return;
    lastColor = color;
    editor.setPageColor(color);
  };
  const onTransition = (event) => {
    if (event.propertyName === "background-color") sync();
  };
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const unbindPage = editor.onEditorEvent?.("page:changed", () => sync(true));
  element.addEventListener("transitionend", onTransition);
  colorScheme.addEventListener?.("change", sync);
  sync();
  return () => {
    element.removeEventListener("transitionend", onTransition);
    colorScheme.removeEventListener?.("change", sync);
    unbindPage?.();
  };
}

export function parseCssColor(value) {
  const match = String(value).match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u);
  if (!match) return null;
  const channels = match.slice(1, 4).map((channel) => Number(channel) / 255);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (![...channels, alpha].every(Number.isFinite)) return null;
  return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
}

function sameColor(left, right) {
  return Boolean(right && ["r", "g", "b", "a"].every((channel) => left[channel] === right[channel]));
}
