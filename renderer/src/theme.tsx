import { useEffect, useState } from "react";

export type Mode = "light" | "dark";

function currentMode(): Mode {
  return document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "light";
}

export function initialMode(): Mode {
  const stored = localStorage.getItem("feynman.mode");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setMode(mode: Mode): void {
  localStorage.setItem("feynman.mode", mode);
  document.documentElement.setAttribute("data-mode", mode);
}

/** Tracks Kumo's `data-mode` attribute so canvas charts can pick matching colours. */
export function useDarkMode(): boolean {
  const [mode, setModeState] = useState<Mode>(currentMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setModeState(currentMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => observer.disconnect();
  }, []);
  return mode === "dark";
}
