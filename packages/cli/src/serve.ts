// The explorer: the prebuilt view, plus `feynman.json` and a browser module per spec.
// `feynman build` writes them all into one self-contained HTML file; `feynman dev` serves
// them from memory and reloads the page when a spec (or anything it imports) changes.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { check } from "@feynman/check";
import { scenarioSeeds } from "./shape.ts";
import { callTrees, checkSources, git, withWorktree, type CallNode } from "@feynman/code";
import type { Spec } from "@feynman/spec";
import type { Bundle, Embedded, SourceEntry, SpecEntry } from "@feynman/view/data";
import { specSources, type Context } from "./commands.ts";
import { dim, green, red, yellow } from "./format.ts";
import { playgroundFor } from "./discover.ts";
import { bundle as bundleModule, loadSpec } from "./load.ts";

const VIEW = dirname(Bun.resolveSync("@feynman/view/package.json", import.meta.dir));

export interface Prepared {
  bundle: Bundle;
  /** Page-relative path → JavaScript, for each spec module. */
  modules: Map<string, string>;
}

interface Options {
  base?: string;
  /** Run the checker (slow); dev runs it after the first page is up. */
  check?: boolean;
  calls?: boolean;
}

/** Build the view if its sources are newer than its last build. */
export function ensureView() {
  const dist = join(VIEW, "dist", "index.html");
  // An installed package ships the view prebuilt, without its sources.
  if (!existsSync(join(VIEW, "vite.config.ts"))) return;
  const newest = (dir: string): number => Math.max(...readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? newest(join(dir, d.name)) : statSync(join(dir, d.name)).mtimeMs)));
  // The explorer bundles @feynman/spec too: a change to either means a rebuild.
  const sources = Math.max(newest(join(VIEW, "src")), newest(join(VIEW, "..", "spec", "src")));
  if (existsSync(dist) && statSync(dist).mtimeMs >= sources) return;
  console.log(dim("building the explorer…"));
  const out = spawnSync("bun", ["run", "build"], { cwd: VIEW, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`could not build the explorer:\n${out.stderr || out.stdout}`);
}

/** Bundle a spec file for the browser; `@feynman/spec` resolves to this installation. */
function bundleSpec(path: string): Promise<string> {
  return bundleModule(path, "browser");
}

function specId(path: string, taken: Set<string>): string {
  let id = basename(path, ".ts");
  for (let n = 2; taken.has(id); n++) id = `${basename(path, ".ts")}-${n}`;
  taken.add(id);
  return id;
}

export async function prepare(ctx: Context, options: Options): Promise<Prepared> {
  const { repository } = ctx;
  const modules = new Map<string, string>();
  const taken = new Set<string>();
  const baseCommit = options.base ? git(repository.root, "rev-parse", "--verify", `${options.base}^{commit}`) : null;
  const bases = new Map<string, string>();
  if (options.base) {
    await withWorktree(repository.root, options.base, async (dir) => {
      for (const path of ctx.found) if (existsSync(join(dir, path))) bases.set(path, await bundleSpec(join(dir, path)).catch(() => ""));
    });
  }
  const specs: SpecEntry[] = [];
  for (const path of ctx.found) {
    const id = specId(path, taken);
    const entry: SpecEntry = { id, path, module: null, playModule: null, baseModule: null, error: null, sources: {}, calls: {}, report: null };
    specs.push(entry);
    try {
      const spec = await loadSpec(join(repository.root, path));
      modules.set(`specs/${id}.js`, await bundleSpec(join(repository.root, path)));
      entry.module = `specs/${id}.js`;
      const play = playgroundFor(repository.root, path);
      if (play) {
        modules.set(`specs/${id}.play.js`, await bundleModule(join(repository.root, play), "browser"));
        entry.playModule = `specs/${id}.play.js`;
      }
      if (bases.get(path)) {
        modules.set(`specs/${id}.base.js`, bases.get(path)!);
        entry.baseModule = `specs/${id}.base.js`;
      }
      entry.sources = sourceEntries(ctx, spec);
      if (options.calls) entry.calls = callTrees(repository.root, specSources(spec)).trees as Record<string, CallNode>;
      if (options.check) entry.report = check(spec, { ...ctx.config.check }, scenarioSeeds(spec));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  const bundle: Bundle = {
    generatedAt: new Date().toISOString(),
    dev: false,
    repository: { name: basename(repository.root), commit: repository.commit, dirty: repository.dirty, branch: repository.branch, fileUrl: repository.fileUrl },
    base: options.base && baseCommit ? { ref: options.base, commit: baseCommit } : null,
    specs,
  };
  return { bundle, modules };
}

function sourceEntries(ctx: Context, spec: Spec): Record<string, SourceEntry> {
  const out: Record<string, SourceEntry> = {};
  const { fileUrl } = ctx.repository;
  for (const s of checkSources(ctx.repository.root, specSources(spec))) {
    if (s.status === "missing") {
      out[s.source] = { status: "missing", reason: s.reason };
      continue;
    }
    const { path, start, end, text } = s.resolved;
    const url = fileUrl ? `${fileUrl.replace("{path}", path)}${/gitlab/.test(fileUrl) ? `#L${start}-${end}` : `#L${start}-L${end}`}` : undefined;
    out[s.source] = { status: s.status, start, end, text, url };
  }
  return out;
}

/**
 * The explorer as one HTML file: the view's script and stylesheet inlined, and the bundle and
 * every module embedded as JSON, which the page imports through blob URLs. It opens from disk.
 */
export function singlePage(prepared: Prepared): string {
  const dist = join(VIEW, "dist");
  const page = readFileSync(join(dist, "index.html"), "utf8");
  const asset = (href: string) => readFileSync(join(dist, href.replace(/^\.\//, "")), "utf8");
  const embedded: Embedded = { bundle: prepared.bundle, modules: Object.fromEntries(prepared.modules) };
  // Inside a <script>, "</script" or "<!--" would end or confuse it; both escape harmlessly in JS and JSON strings.
  const inScript = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  const data = JSON.stringify(embedded).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\u0021--");
  let scripts = 0;
  let styles = 0;
  const out = page
    .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_, src: string) => (scripts++, `<script type="module">${inScript(asset(src))}</script>`))
    .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_, href: string) => (styles++, `<style>${asset(href).replace(/<\/style/gi, "<\\/style")}</style>`))
    .replace("</head>", () => `<script type="application/json" id="feynman">${data}</script>\n  </head>`);
  if (scripts !== 1 || styles !== 1) throw new Error(`the explorer's index.html has ${scripts} script(s) and ${styles} stylesheet(s); expected one of each`);
  return out;
}

export async function buildCommand(ctx: Context, options: { out?: string; base?: string; open?: boolean }): Promise<number> {
  ensureView();
  const prepared = await prepare(ctx, { base: options.base, check: true, calls: true });
  const out = resolve(ctx.cwd, options.out ?? join(ctx.repository.root, ".feynman", "index.html"));
  mkdirSync(dirname(out), { recursive: true });
  const page = singlePage(prepared);
  writeFileSync(out, page);
  for (const s of prepared.bundle.specs) if (s.error) console.log(red(`${s.path}: ${s.error}`));
  console.log(`wrote ${relative(ctx.cwd, out)} ${dim(`(${prepared.bundle.specs.length} spec(s), ${(page.length / 1e6).toFixed(1)} MB)`)}`);
  if (options.open) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [out]);
  return 0;
}

export async function devCommand(ctx: Context, options: { port: number; base?: string }): Promise<number> {
  return serve(ctx, { ...options, watch: true, open: false });
}

async function serve(ctx: Context, options: { port: number; base?: string; open: boolean; watch: boolean }): Promise<number> {
  ensureView();
  let prepared = await prepare(ctx, { base: options.base, check: false, calls: false });
  prepared.bundle.dev = options.watch;
  const clients = new Set<ReadableStreamDefaultController<string>>();
  const reload = () => clients.forEach((c) => c.enqueue("event: reload\ndata: {}\n\n"));

  const server = Bun.serve({
    port: options.port,
    idleTimeout: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
      if (path === "__feynman/events") {
        let self: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(controller) {
            self = controller;
            clients.add(controller);
            controller.enqueue(": connected\n\n");
          },
          cancel() {
            clients.delete(self);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (path === "feynman.json") return Response.json(prepared.bundle, { headers: { "cache-control": "no-store" } });
      const module = prepared.modules.get(path);
      if (module) return new Response(module, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      const file = join(VIEW, "dist", path || "index.html");
      if (file.startsWith(join(VIEW, "dist")) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
      return new Response(Bun.file(join(VIEW, "dist", "index.html")));
    },
  });
  const url = `http://localhost:${server.port}/`;
  console.log(`${green("feynman")} ${url}  ${dim(`${prepared.bundle.specs.length} spec(s)${options.watch ? ", watching for changes" : ""}`)}`);
  if (options.open) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);

  // The slow parts (checker, call trees) run after the page is up, then reload it.
  const enrich = async () => {
    const started = Date.now();
    const full = await prepare(ctx, { base: options.base, check: true, calls: true });
    full.bundle.dev = options.watch;
    prepared = full;
    const problems = full.bundle.specs.filter((s) => s.error || s.report?.properties.some((p) => !p.holds));
    console.log(dim(`checked in ${Math.round((Date.now() - started) / 1000)}s`) + (problems.length ? yellow(`  ${problems.length} spec(s) with problems`) : ""));
    reload();
  };
  void enrich();

  if (options.watch) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dirs = [...new Set(ctx.found.map((p) => dirname(join(ctx.repository.root, p))))];
    for (const dir of dirs)
      watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const next = await prepare(ctx, { base: options.base, check: false, calls: false });
            // Keep what the last full pass found until the next one finishes.
            for (const s of next.bundle.specs) {
              const was = prepared.bundle.specs.find((p) => p.id === s.id);
              if (was) s.calls = was.calls;
            }
            next.bundle.dev = true;
            prepared = next;
            console.log(dim("spec changed, reloading"));
            reload();
            void enrich();
          } catch (error) {
            console.log(red(String(error)));
          }
        }, 150);
      });
  }
  await new Promise(() => {});
  return 0;
}
