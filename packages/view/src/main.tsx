import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Spec } from "@feynman/spec";
import { App } from "./App";
import type { Bundle } from "./data";
import type { Loaded } from "./ui";
import "./index.css";

document.documentElement.dataset.mode = localStorage.getItem("feynman.mode") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

async function importSpec(url: string | null): Promise<Spec | null> {
  if (!url) return null;
  const module = await import(/* @vite-ignore */ new URL(url, location.href).href);
  return module.default as Spec;
}

async function start() {
  const bundle: Bundle = await (await fetch("./feynman.json", { cache: "no-store" })).json();
  const loaded: Loaded[] = await Promise.all(
    bundle.specs.map(async (entry) => {
      try {
        return { entry, spec: await importSpec(entry.module), base: await importSpec(entry.baseModule).catch(() => null) };
      } catch (error) {
        return { entry: { ...entry, error: entry.error ?? String(error) }, spec: null, base: null };
      }
    }),
  );
  document.title = `${loaded[0]?.spec?.name ?? "Specs"} · Feynman`;
  if (bundle.dev) new EventSource("./__feynman/events").addEventListener("reload", () => location.reload());
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App bundle={bundle} loaded={loaded} />
    </StrictMode>,
  );
}

start();
