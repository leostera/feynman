// The explorer: the prebuilt view, plus `feynman.json` and a browser module per spec.
// `feynman build` writes them all into one self-contained HTML file; `feynman dev` serves
// them from memory and reloads the page when a spec (or anything it imports) changes.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { check } from "../check/index.ts";
import { scenarioSeeds } from "./shape.ts";
import { callTrees, checkSources, git, withWorktree, type CallNode } from "../code/index.ts";
import type { Spec } from "../spec/index.ts";
import type { Bundle, Embedded, SourceEntry, SpecEntry } from "../view/data.ts";
import { specSources, type Context } from "./commands.ts";
import { dim, green, red, yellow } from "./format.ts";
import { playgroundFor } from "./discover.ts";
import type { EnrichMessage, EnrichRequest } from "./enrich-worker.ts";
import { functionCode } from "./functions.ts";
import { highlightLines } from "./highlight.ts";
import { bundleBrowser } from "./bundle-browser.ts";
import { loadSpec } from "./load.ts";

/** This installation: the package root, and the view as built. */
const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "dist", "view");

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

/**
 * What `prepare` says as it goes: a line per spec, and with `detail` a line per phase of it,
 * timed, which `feynman build` prints and `feynman dev` keeps quiet.
 */
export type Progress = (message: string, detail?: boolean) => void;

/** Runs one phase, then reports how it went and how long it took. */
async function timed<T>(log: Progress | undefined, run: () => T | Promise<T>, done: (result: T) => string): Promise<T> {
  const started = performance.now();
  const result = await run();
  log?.(`${done(result)} ${dim(ms(performance.now() - started))}`, true);
  return result;
}

function ms(duration: number): string {
  return duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`;
}

function kb(text: string): string {
  const bytes = Buffer.byteLength(text);
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line on a check: how many properties held, and how far exploration got. */
function checkSummary(report: ReturnType<typeof check>): string {
  const failed = report.properties.filter((p) => !p.holds);
  const reach = report.exhaustive ? "exhaustive" : `stopped by ${report.stoppedBy ?? "bounds"}`;
  const verdict = failed.length ? red(`${failed.length}/${report.properties.length} properties fail: ${failed.map((p) => p.id).join(", ")}`) : green(`${report.properties.length} properties hold`);
  return `checked: ${verdict} ${dim(`(${report.states} states, depth ${report.depthReached}, ${reach})`)}`;
}

/**
 * Build the view if its sources are newer than its last build. Only in a checkout of
 * Feynman: an installed copy (under node_modules) ships the view built.
 */
export function ensureView() {
  const dist = join(DIST, "index.html");
  if (ROOT.split(/[\\/]/).includes("node_modules")) {
    if (!existsSync(dist)) throw new Error(`this installation has no built view at ${dist}`);
    return;
  }
  const newest = (dir: string): number => Math.max(...readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? newest(join(dir, d.name)) : statSync(join(dir, d.name)).mtimeMs)));
  // The view bundles the spec engine and the playground kit too: a change to any means a rebuild.
  const sources = Math.max(...["view", "spec", "play"].map((dir) => newest(join(ROOT, "src", dir))));
  if (existsSync(dist) && statSync(dist).mtimeMs >= sources) return;
  console.log(dim(existsSync(dist) ? "the explorer's sources changed; rebuilding it…" : "building the explorer…"));
  const started = performance.now();
  const out = spawnSync("bun", ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`could not build the explorer:\n${out.stderr || out.stdout}`);
  console.log(dim(`  built the explorer ${ms(performance.now() - started)}`));
}

function specId(path: string, taken: Set<string>): string {
  let id = basename(path, ".ts");
  for (let n = 2; taken.has(id); n++) id = `${basename(path, ".ts")}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Whether nothing listens on this port, on either loopback address. "localhost" is both ::1
 * and 127.0.0.1, and a server can bind one while another holds the other: both start, and
 * the browser reaches whichever its resolver picks. So a port is free only if both are.
 */
export async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const free = await new Promise<boolean>((done) => {
      const probe = createNetServer();
      probe.once("error", (error: NodeJS.ErrnoException) => done(error.code === "EADDRNOTAVAIL"));
      probe.listen(port, host, () => probe.close(() => done(true)));
    });
    if (!free) return false;
  }
  return true;
}

/** How many ports past the asked-for one `feynman dev` tries before giving up. */
const PORT_TRIES = 50;

/**
 * A server on the first port from `first` that is free on every loopback address. Another
 * server can take a port between the check and the listen; then the next one is tried.
 */
async function listenOnFreePort(first: number, create: (port: number) => Promise<ViteDevServer>): Promise<ViteDevServer> {
  for (let port = first; port < first + PORT_TRIES; port++) {
    if (!(await portFree(port))) continue;
    const server = await create(port);
    try {
      await server.listen();
      return server;
    } catch (error) {
      await server.close();
      if (!/already in use|EADDRINUSE/.test(String(error))) throw error;
    }
  }
  throw new Error(`no free port from ${first} to ${first + PORT_TRIES - 1}`);
}

export async function prepare(ctx: Context, options: Options, onProgress?: Progress): Promise<Prepared> {
  const { repository } = ctx;
  const modules = new Map<string, string>();
  const taken = new Set<string>();
  const baseCommit = options.base ? git(repository.root, "rev-parse", "--verify", `${options.base}^{commit}`) : null;
  const bases = new Map<string, string>();
  if (options.base) {
    onProgress?.(`compiling specs at ${options.base} ${dim(`(${baseCommit?.slice(0, 8)})`)}`);
    await withWorktree(repository.root, options.base, async (dir) => {
      for (const path of ctx.found) {
        if (!existsSync(join(dir, path))) {
          onProgress?.(`${path} ${dim("not there; new on this branch")}`, true);
          continue;
        }
        const module = await timed(onProgress, () => bundleBrowser(join(dir, path)).catch(() => ""), (m) => m ? `${path} ${dim(kb(m))}` : yellow(`${path} did not compile there; no diff for it`));
        bases.set(path, module);
      }
    });
  }
  const specs: SpecEntry[] = [];
  for (const [index, path] of ctx.found.entries()) {
    onProgress?.(`[${index + 1}/${ctx.found.length}] ${path}`);
    const id = specId(path, taken);
    const entry: SpecEntry = { id, path, module: null, playModule: null, baseModule: null, error: null, sources: {}, calls: {}, functions: {}, report: null };
    specs.push(entry);
    try {
      const spec = await timed(onProgress, () => loadSpec(join(repository.root, path)), (s) => `loaded ${s.name} ${dim(`(${plural(s.actors.length, "actor")}, ${plural(s.scenarios.length, "scenario")}, ${s.invariants.length} ${s.invariants.length === 1 ? "property" : "properties"})`)}`);
      const module = await timed(onProgress, () => bundleBrowser(join(repository.root, path)), (m) => `bundled the spec ${dim(kb(m))}`);
      modules.set(`specs/${id}.js`, module);
      entry.module = `specs/${id}.js`;
      const play = playgroundFor(repository.root, path);
      if (play) {
        const playModule = await timed(onProgress, () => bundleBrowser(join(repository.root, play)), (m) => `bundled its playground ${relative(repository.root, join(repository.root, play))} ${dim(kb(m))}`);
        modules.set(`specs/${id}.play.js`, playModule);
        entry.playModule = `specs/${id}.play.js`;
      }
      if (bases.get(path)) {
        modules.set(`specs/${id}.base.js`, bases.get(path)!);
        entry.baseModule = `specs/${id}.base.js`;
      }
      const linked = specSources(spec).length > 0;
      entry.sources = await timed(linked ? onProgress : undefined, () => sourceEntries(ctx, spec), (sources) => {
        const all = Object.values(sources);
        const missing = Object.entries(sources).filter(([, s]) => s.status === "missing");
        const text = `read ${plural(all.length, "source")}`;
        return missing.length ? `${text} ${yellow(`(${missing.length} missing: ${missing.map(([s]) => s).join(", ")})`)}` : text;
      });
      if (!linked) onProgress?.(dim("no sources linked: no code to show"), true);
      if (options.calls && linked) {
        const { trees, problems } = await timed(onProgress, () => callTrees(repository.root, specSources(spec)), ({ trees, problems }) => {
          const text = `traced calls from ${plural(Object.keys(trees).length, "source")}`;
          return Object.keys(problems).length ? `${text} ${yellow(`(${plural(Object.keys(problems).length, "problem")})`)}` : text;
        });
        for (const [source, problem] of Object.entries(problems)) onProgress?.(yellow(`  ${source}: ${problem}`), true);
        entry.calls = trees as Record<string, CallNode>;
        entry.functions = await timed(onProgress, () => functionCode(repository.root, repository.fileUrl, entry.calls), (f) => `collected ${plural(Object.keys(f).length, "function")} they reach`);
      }
      if (options.check) entry.report = await timed(onProgress, () => check(spec, { ...ctx.config.check }, scenarioSeeds(spec)), checkSummary);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      onProgress?.(red(`failed: ${entry.error.split("\n")[0]}`), true);
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

async function sourceEntries(ctx: Context, spec: Spec): Promise<Record<string, SourceEntry>> {
  const out: Record<string, SourceEntry> = {};
  const { fileUrl } = ctx.repository;
  for (const s of checkSources(ctx.repository.root, specSources(spec))) {
    if (s.status === "missing") {
      out[s.source] = { status: "missing", reason: s.reason };
      continue;
    }
    const { path, start, end, text } = s.resolved;
    const url = fileUrl ? `${fileUrl.replace("{path}", path)}${/gitlab/.test(fileUrl) ? `#L${start}-${end}` : `#L${start}-L${end}`}` : undefined;
    const lines = await highlightLines(path, text).catch(() => null);
    out[s.source] = { status: s.status, start, end, text, url, ...(lines ? { lines } : {}) };
  }
  return out;
}

/**
 * The explorer as one HTML file: the view's script and stylesheet inlined, and the bundle and
 * every module embedded as JSON, which the page imports through blob URLs. It opens from disk.
 */
export function singlePage(prepared: Prepared): string {
  const dist = DIST;
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
  const started = performance.now();
  const { repository } = ctx;
  console.log(`${green("feynman build")} ${repository.branch ?? "detached"} ${dim(`${repository.commit?.slice(0, 8) ?? "no commit"}${repository.dirty ? ", with uncommitted changes" : ""}`)}`);
  ensureView();
  console.log(dim(`building ${plural(ctx.found.length, "spec")}…`));
  const prepared = await prepare(ctx, { base: options.base, check: true, calls: true }, (message, detail) => console.log(detail ? `    ${message}` : `  ${message}`));
  const out = resolve(ctx.cwd, options.out ?? join(repository.root, ".feynman", "index.html"));
  mkdirSync(dirname(out), { recursive: true });
  const page = singlePage(prepared);
  writeFileSync(out, page);
  const failed = prepared.bundle.specs.filter((s) => s.error);
  for (const s of failed) console.log(red(`${s.path}: ${s.error}`));
  const modules = [...prepared.modules.values()].reduce((sum, m) => sum + m, "");
  const ok = prepared.bundle.specs.length - failed.length;
  const shown = relative(ctx.cwd, out).startsWith("..") ? out : relative(ctx.cwd, out);
  console.log(`wrote ${shown} ${dim(`(${kb(page)}: ${kb(modules)} of spec modules) in ${ms(performance.now() - started)}`)}`);
  console.log(failed.length ? red(`${ok}/${prepared.bundle.specs.length} specs built; ${failed.length} failed`) : green(`${plural(ok, "spec")} built`));
  if (options.open) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [out]);
  // The page shows a spec that failed to load as an error; a build that ships one has failed.
  return prepared.bundle.specs.some((s) => s.error) ? 1 : 0;
}

export async function devCommand(ctx: Context, options: { port: number; base?: string }): Promise<number> {
  return serve(ctx, { ...options, watch: true, open: false });
}

async function serve(ctx: Context, options: { port: number; base?: string; open: boolean; watch: boolean }): Promise<number> {
  console.log(dim(`compiling ${ctx.found.length} spec(s)…`));
  let prepared = await prepare(ctx, { base: options.base, check: false, calls: false }, (message, detail) => detail || console.log(dim(`  ${message}`)));
  prepared.bundle.dev = options.watch;
  const clients = new Set<import("node:http").ServerResponse>();
  const reload = () => clients.forEach((client) => client.write("event: reload\ndata: {}\n\n"));
  const api: Plugin = {
    name: "feynman-dev-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let path: string;
        try {
          path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname).replace(/^\/+/, "");
        } catch {
          next();
          return;
        }
        if (path === "__feynman/events") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream");
          response.setHeader("cache-control", "no-store");
          response.write(": connected\n\n");
          clients.add(response);
          request.on("close", () => clients.delete(response));
          return;
        }
        if (path === "feynman.json") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify(prepared.bundle));
          return;
        }
        const module = prepared.modules.get(path);
        if (module) {
          response.statusCode = 200;
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(module);
          return;
        }
        next();
      });
    },
  };
  // In a checkout of Feynman, Vite serves the view from source with hot reload; an installed copy
  // ships only the built view (package.json leaves src/view out), which Vite serves as it is.
  const viewConfig = join(ROOT, "src", "view", "vite.config.ts");
  const fromSource = existsSync(viewConfig);
  if (!fromSource) ensureView();
  const vite = await listenOnFreePort(options.port, (port) =>
    createViteServer({
      ...(fromSource ? { configFile: viewConfig } : { configFile: false, root: DIST, appType: "spa" as const }),
      plugins: [api],
      server: { port, strictPort: true },
    }),
  );
  const address = vite.httpServer?.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  const url = vite.resolvedUrls?.local[0] ?? `http://localhost:${port}/`;
  console.log(`${green("feynman")} ${url}  ${dim(`${prepared.bundle.specs.length} spec(s)${options.watch ? ", watching for changes" : ""}`)}`);
  if (options.open) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);

  // The slow parts (checks, call trees) run on a worker so the server keeps answering; each
  // lands in the bundle, and reloads the page, as soon as it is ready. One run at a time: a
  // change during a run asks for another once it ends.
  const worker = new Worker(join(import.meta.dir, "enrich-worker.ts"));
  let running = false;
  let again = false;
  const enrich = () => {
    if (running) return void (again = true);
    running = true;
    worker.postMessage({ cwd: ctx.cwd } satisfies EnrichRequest);
  };
  worker.onmessage = (event: MessageEvent<EnrichMessage>) => {
    const message = event.data;
    if (message.kind === "progress") return console.log(dim(`  ${message.message}`));
    if (message.kind === "reports") {
      for (const s of prepared.bundle.specs) s.report = message.reports[s.path] ?? s.report;
      const problems = prepared.bundle.specs.filter((s) => s.error || s.report?.properties.some((p) => !p.holds));
      console.log(dim("checks ready") + (problems.length ? yellow(`  ${problems.length} spec(s) with problems`) : ""));
      return reload();
    }
    if (message.kind === "calls") {
      for (const s of prepared.bundle.specs) {
        s.calls = message.calls[s.path] ?? s.calls;
        s.functions = message.functions[s.path] ?? s.functions;
      }
      console.log(dim("call trees ready"));
      return reload();
    }
    if (message.error) console.log(red(`checking stopped: ${message.error}`));
    else console.log(dim(`checked in ${message.seconds.toFixed(1)}s`));
    running = false;
    if (again) {
      again = false;
      enrich();
    }
  };
  enrich();

  if (options.watch) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dirs = [...new Set(ctx.found.map((p) => dirname(join(ctx.repository.root, p))))];
    for (const dir of dirs)
      watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            console.log(dim("compiling changed specs…"));
            const next = await prepare(ctx, { base: options.base, check: false, calls: false }, (message, detail) => detail || console.log(dim(`  ${message}`)));
            // Keep what the last checks and call trees found until the next ones are ready.
            for (const s of next.bundle.specs) {
              const was = prepared.bundle.specs.find((p) => p.path === s.path);
              if (was) {
                s.calls = was.calls;
                s.functions = was.functions;
                s.report = was.report;
              }
            }
            next.bundle.dev = true;
            prepared = next;
            console.log(dim("spec changed, reloading"));
            reload();
            enrich();
          } catch (error) {
            console.log(red(String(error)));
          }
        }, 150);
      });
  }
  await new Promise(() => {});
  return 0;
}
