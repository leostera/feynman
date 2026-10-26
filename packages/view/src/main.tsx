import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Kumo from "@cloudflare/kumo";
import * as Play from "@feynman/play";
import { isPlayground, type Playground } from "@feynman/play";
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

/**
 * Playground modules are bundled with these left out: they use the page's own copies, so
 * there is one React, and the kit's classes are in the page's stylesheet.
 */
(globalThis as { __feynman?: unknown }).__feynman = {
  modules: { react: React, "react/jsx-runtime": JsxRuntime, "@cloudflare/kumo": Kumo, "@feynman/play": Play },
};

async function importPlayground(url: string | null): Promise<Playground | null> {
  if (!url) return null;
  const module = await import(/* @vite-ignore */ new URL(url, location.href).href);
  if (!isPlayground(module.default)) throw new Error(`${url} does not export a playground by default: export default definePlayground(spec, …)`);
  return module.default;
}

async function start() {
  const bundle: Bundle = await (await fetch("./feynman.json", { cache: "no-store" })).json();
  const loaded: Loaded[] = await Promise.all(
    bundle.specs.map(async (entry) => {
      try {
        const spec = await importSpec(entry.module);
        const playground = await importPlayground(entry.playModule ?? null).catch((error) => {
          console.warn(`feynman: the playground for ${entry.path} did not load; using the defaults`, error);
          return null;
        });
        return { entry, spec, base: await importSpec(entry.baseModule).catch(() => null), playground };
      } catch (error) {
        return { entry: { ...entry, error: entry.error ?? String(error) }, spec: null, base: null, playground: null };
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
