import { useEffect, useMemo } from "react";

import { useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { countUnseenCompletedThreads } from "./appIconBadge.logic";

/**
 * Mirrors the sidebar's unread completions onto the app icon: the dock or
 * launcher badge and Windows taskbar overlay on desktop, and the app badge
 * when the web app is installed as a PWA.
 */
export function AppIconBadgeSync() {
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const count = useMemo(
    () => countUnseenCompletedThreads(threads, lastVisitedAtByThreadKey),
    [threads, lastVisitedAtByThreadKey],
  );

  useEffect(() => {
    const setDesktopBadge = window.desktopBridge?.setAppBadgeCount;
    if (setDesktopBadge) {
      void setDesktopBadge(count).catch(() => undefined);
      return;
    }
    if (typeof navigator.setAppBadge !== "function") return;
    const update = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    void update.catch(() => undefined);
  }, [count]);

  return null;
}
