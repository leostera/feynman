// What a reader can set, kept in this browser: the theme, whether the playground starts
// playing, and whether things move. Applied to the page as data attributes (data-mode,
// data-reduce-motion) so CSS and Kumo follow; read in components with useSettings().
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

export interface Settings {
  theme: Theme;
  /** The playground starts with Play on: whatever happens plays out by itself. */
  autoPlay: boolean;
  /** No animations: events land at once and nothing pulses or slides. */
  reduceMotion: boolean;
}

const KEY = "feynman.settings";

const defaults = (): Settings => ({
  theme: "system",
  autoPlay: true,
  reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
});

/** The saved settings, parsed: anything missing or malformed falls back to the default. */
function parse(text: string | null): Settings {
  const base = defaults();
  if (!text) return base;
  try {
    const saved = JSON.parse(text) as Partial<Record<keyof Settings, unknown>>;
    return {
      theme: saved.theme === "light" || saved.theme === "dark" || saved.theme === "system" ? saved.theme : base.theme,
      autoPlay: typeof saved.autoPlay === "boolean" ? saved.autoPlay : base.autoPlay,
      reduceMotion: typeof saved.reduceMotion === "boolean" ? saved.reduceMotion : base.reduceMotion,
    };
  } catch {
    return base;
  }
}

let current: Settings = parse(localStorage.getItem(KEY));
const listeners = new Set<() => void>();

/** Put the settings on the page: the colour mode Kumo reads, and whether motion is reduced. */
export function applySettings(settings: Settings = current) {
  const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.mode = dark ? "dark" : "light";
  if (settings.reduceMotion) document.documentElement.dataset.reduceMotion = "";
  else delete document.documentElement.dataset.reduceMotion;
}

export function saveSettings(change: Partial<Settings>) {
  current = { ...current, ...change };
  localStorage.setItem(KEY, JSON.stringify(current));
  applySettings(current);
  for (const listener of listeners) listener();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => current,
  );
}

// The system's theme can change while the page is open.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => current.theme === "system" && applySettings());
