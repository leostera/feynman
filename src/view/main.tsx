import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Kumo from "@cloudflare/kumo";
import * as Play from "../play/index.ts";
import { isPlayground, type Playground } from "../play/index.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Spec } from "../spec/index.ts";
import { App } from "./App";
import type { Bundle, Embedded } from "./data";
import type { Loaded } from "./ui";
import "./index.css";

document.documentElement.dataset.mode = localStorage.getItem("feynman.mode") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** A built page carries its data and modules; a served one (`feynman dev`) fetches them. */
const embedded: Embedded | null = (() => {
  const tag = document.getElementById("feynman");
  return tag?.textContent ? (JSON.parse(tag.textContent) as Embedded) : null;
})();

/** Import a page-relative module: from the page itself when built, else from the server. */
async function importModule(url: string): Promise<{ default: unknown }> {
  const code = embedded?.modules[url];
  if (embedded && code === undefined) throw new Error(`${url} is not in this page`);
  const href = code !== undefined ? URL.createObjectURL(new Blob([code], { type: "text/javascript" })) : new URL(url, location.href).href;
  return import(/* @vite-ignore */ href);
}

async function importSpec(url: string | null): Promise<Spec | null> {
  if (!url) return null;
  return (await importModule(url)).default as Spec;
}

/**
 * Playground modules are bundled with these left out: they use the page's own copies, so
 * there is one React, and the kit's classes are in the page's stylesheet.
 */
(globalThis as { __feynman?: unknown }).__feynman = {
  modules: { react: React, "react/jsx-runtime": JsxRuntime, "@cloudflare/kumo": Kumo, play: Play },
};

async function importPlayground(url: string | null): Promise<Playground | null> {
  if (!url) return null;
  const module = await importModule(url);
  if (!isPlayground(module.default)) throw new Error(`${url} does not export a playground by default: export default definePlayground(spec, …)`);
  return module.default;
}

async function start() {
  const bundle: Bundle = embedded?.bundle ?? (await (await fetch("./feynman.json", { cache: "no-store" })).json());
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
