// useGlobalShortcut.ts — Keyboard shortcut management
// In dev mode: listens to document keydown (browser doesn't support global shortcuts).
// In production (Tauri): delegates to tauri-plugin-global-shortcut.
//
// Alt+Space → toggle overlay visibility
// Escape    → close overlay (handled in CommandBar as well)

import { useEffect } from "react";

type ShortcutCallback = () => void;

/**
 * Registers a browser-level keyboard shortcut.
 * Used in dev mode — production uses the Tauri global shortcut plugin via Rust.
 */
export function useBrowserShortcut(
  keys: string[],
  callback: ShortcutCallback,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const pressed = new Set<string>();
      if (e.altKey)   pressed.add("Alt");
      if (e.ctrlKey)  pressed.add("Control");
      if (e.shiftKey) pressed.add("Shift");
      if (e.metaKey)  pressed.add("Meta");
      pressed.add(e.key === " " ? "Space" : e.key);

      const match = keys.every((k) => pressed.has(k));
      if (match) {
        e.preventDefault();
        callback();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keys, callback, enabled]);
}
