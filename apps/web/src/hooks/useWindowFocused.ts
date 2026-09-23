import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/** Whether this window has focus; false while the user is in another app or tab. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.hasFocus(),
    () => true,
  );
}
