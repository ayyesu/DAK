import { useEffect, useState } from "react";

const readDisplayHasNotch = (): boolean => {
  if (typeof window === "undefined") return false;
  const getDisplayHasNotch = window.desktopBridge?.getDisplayHasNotch;
  return typeof getDisplayHasNotch === "function" ? getDisplayHasNotch() : false;
};

/**
 * Whether the display this window is on has a physical camera notch. Always false in
 * the browser and on desktop builds that predate the bridge methods. Follows the window
 * across displays and display setup changes.
 */
export function useDisplayHasNotch(): boolean {
  const [hasNotch, setHasNotch] = useState(readDisplayHasNotch);

  useEffect(() => {
    const onChange = window.desktopBridge?.onDisplayHasNotchChange;
    if (typeof onChange !== "function") return;
    setHasNotch(readDisplayHasNotch());
    return onChange(setHasNotch);
  }, []);

  return hasNotch;
}
