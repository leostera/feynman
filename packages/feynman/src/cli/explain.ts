// `feynman explain <spec>` (RFD0013, spike): a story an agent writes in <spec>.explainer.md,
// told around figures Feynman records from the spec. With no explainer yet, it prints a brief
// of what the spec holds; with one, it checks every directive and builds one HTML page.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { check, checkRules, type Bounds, type Counterexample, type PropertyBroken, type Report } from "../check/index.ts";
import { scenarioSeeds } from "../check/seeds.ts";
import { verdictOf, type Verdict } from "../check/verdict.ts";
type Spec = SpecType;
import type { At } from "../explain/index.ts";
import { runScenario, type Spec as SpecType } from "../spec/index.ts";
import type { BrokenRun, Explainer, ExplainerBlock, FigureRun } from "../view/data.ts";
import { bundleBrowser } from "./bundle-browser.ts";
import { loadSelected, type Context } from "./commands.ts";
import { bold, dim, green, red, yellow } from "./format.ts";
import { ensureView, prepare, singlePage } from "./serve.ts";

/** `:::finding` … `:::`: a box of prose, its lead in bold. */
const CALLOUTS = ["decision", "finding", "incident", "note"] as const;
type Callout = (typeof CALLOUTS)[number];

const DIRECTIVES = ["map", "still", "steps", "play", "flow", "figure", "verdicts", "rules"] as const;
type DirectiveName = (typeof DIRECTIVES)[number];

/** A directive as written: `::play{breaks="idempotencyKey"}`, alone on its line. */
interface Directive {
  name: DirectiveName;
  attributes: Record<string, string>;
  line: number;
}

/** The explainer file, parsed: front matter, and the body as markdown and directives in order. */
interface Draft {
  title: string | null;
  lede: string | null;
  depth: number | null;
  parts: ({ kind: "markdown"; text: string; line: number } | { kind: "directive"; directive: Directive } | { kind: "callout"; tone: Callout; text: string; line: number })[];
}

interface Problem {
  line: number;
  message: string;
}

export function explainerPath(specPath: string): string {
  return specPath.replace(/\.ts$/, ".explainer.md");
}

export async function explainCommand(ctx: Context, named: string[], options: { out?: string }): Promise<number> {
  // An explainer file named itself stands alone: its figures are data, with no spec to draw from.
  const standalone = named[0]?.endsWith(".md") ?? false;
  let path: string | null = null;
  let spec: Spec | null = null;
  let file: string;
  if (standalone) {
    file = relative(ctx.repository.root, resolvePath(ctx.cwd, named[0]!));
    if (!existsSync(join(ctx.repository.root, file))) throw new Error(`No explainer at ${file}`);
  } else {
    const [selected] = await loadSelected(ctx, named.slice(0, 1));
    ({ path, spec } = selected!);
    file = explainerPath(path);
    if (!existsSync(join(ctx.repository.root, file))) return brief(ctx, path, spec, file);
  }
  const absolute = join(ctx.repository.root, file);

  const problems: Problem[] = [];
  const draft = parseDraft(readFileSync(absolute, "utf8"), problems);
  if (!draft.title) problems.push({ line: 1, message: "the front matter needs a title" });
  if (!draft.lede) problems.push({ line: 1, message: "the front matter needs a lede: what the reader will understand, in a sentence" });
  const depth = draft.depth ?? ctx.config.check?.depth ?? 14;
  const bounds = { ...ctx.config.check, depth };
  console.log(`${green("feynman explain")} ${file} ${dim(spec ? `(depth ${depth})` : "(no spec)")}`);

  ensureView();
  const prepared = await prepare({ ...ctx, found: path ? [path] : [], config: { ...ctx.config, check: bounds } }, { check: true, calls: false });
  const entry = prepared.bundle.specs[0] ?? null;
  if (entry && (entry.error || !entry.report)) {
    console.log(red(`${path}: ${entry.error ?? "the check did not run"}`));
    return 1;
  }
  const id = entry?.id ?? basename(file).replace(/(\.explainer)?\.md$/, "");
  const runs = spec ? await brokenRuns(spec, bounds) : {};
  const figuresPath = file.replace(/\.md$/, ".tsx");
  const figures = existsSync(join(ctx.repository.root, figuresPath)) ? readFileSync(join(ctx.repository.root, figuresPath), "utf8") : null;
  let module: string | null = null;
  if (figures !== null) {
    try {
      prepared.modules.set(`specs/${id}.explainer.js`, await bundleBrowser(join(ctx.repository.root, figuresPath)));
      module = `specs/${id}.explainer.js`;
    } catch (error) {
      problems.push({ line: 0, message: `${figuresPath} did not compile: ${error instanceof Error ? error.message : String(error)}` });
    }
    // The runs its components ask for, by the literal names they pass to useRun, Still and the rest.
    for (const m of figures.matchAll(/\b(scenario|breaks):\s*"([^"]+)"/g)) {
      const known = m[1] === "scenario" ? (spec?.scenarios.some((x) => x.name === m[2]) ?? false) : m[2]! in runs;
      if (!known) problems.push({ line: 0, message: `${figuresPath} asks for ${m[1]} "${m[2]}", which ${m[1] === "scenario" ? "is not a scenario of the spec" : "is not a rule some property needs"}` });
    }
  }
  const blocks = resolve(spec, entry?.report ?? null, draft, runs, figures, problems);
  if (spec && entry?.report) for (const warning of warnings(spec, entry.report, draft, figures)) console.log(yellow(`  ! ${warning}`));
  if (problems.length) {
    for (const p of problems.sort((a, b) => a.line - b.line)) console.log(red(`  ${p.line ? `${file}:${p.line}` : file.replace(/\.md$/, ".tsx")}  ✗ ${p.message}`));
    console.log(red(`${problems.length} problem(s); no page written`));
    return 1;
  }
  const explainer: Explainer = {
    title: draft.title!,
    lede: draft.lede!,
    blocks,
    module,
    runs,
    provenance: { commit: ctx.repository.commit ?? "", dirty: ctx.repository.dirty, depth },
  };
  const out = options.out ?? join(ctx.repository.root, ".feynman", "explainers", `${id}.html`);
  mkdirSync(dirname(out), { recursive: true });
  const page = singlePage(prepared, explainer);
  writeFileSync(out, page);
  console.log(`wrote ${relative(ctx.cwd, out)} ${dim(`(${(page.length / 1024).toFixed(0)} KB)`)}`);
  return 0;
}

// The file ---------------------------------------------------------------------------------------

function parseDraft(text: string, problems: Problem[]): Draft {
  const lines = text.split("\n");
  const draft: Draft = { title: null, lede: null, depth: null, parts: [] };
  let at = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) problems.push({ line: 1, message: "the front matter is not closed with ---" });
    for (const [i, line] of lines.slice(1, end < 0 ? lines.length : end).entries()) {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "title") draft.title = value!.trim();
      else if (key === "lede") draft.lede = value!.trim();
      else if (key === "depth") draft.depth = Number(value);
      else problems.push({ line: i + 2, message: `unknown front matter ${key}: title, lede and depth are known` });
    }
    at = end < 0 ? lines.length : end + 1;
  }
  let markdown: string[] = [];
  let markdownStart = at + 1;
  const flush = () => {
    if (markdown.join("").trim()) draft.parts.push({ kind: "markdown", text: markdown.join("\n"), line: markdownStart });
    markdown = [];
  };
  for (let i = at; i < lines.length; i++) {
    const line = lines[i]!;
    const open = /^:::(\w+)\s*$/.exec(line);
    if (open) {
      flush();
      const end = lines.findIndex((l, j) => j > i && /^:::\s*$/.test(l));
      if (!(CALLOUTS as readonly string[]).includes(open[1]!)) problems.push({ line: i + 1, message: `unknown callout :::${open[1]}; known: ${CALLOUTS.map((c) => `:::${c}`).join(" ")}` });
      else if (end < 0) problems.push({ line: i + 1, message: `:::${open[1]} is not closed with a line of :::` });
      else draft.parts.push({ kind: "callout", tone: open[1] as Callout, text: lines.slice(i + 1, end).join("\n"), line: i + 1 });
      i = end < 0 ? lines.length : end;
      continue;
    }
    const m = /^::(\w+)(?:\{(.*)\})?\s*$/.exec(line);
    if (!m) {
      if (!markdown.length) markdownStart = i + 1;
      markdown.push(line);
      continue;
    }
    flush();
    const [, name, body = ""] = m;
    if (!(DIRECTIVES as readonly string[]).includes(name!)) {
      problems.push({ line: i + 1, message: `unknown directive ::${name}; known: ${DIRECTIVES.map((d) => `::${d}`).join(" ")}` });
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const a of body.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) attributes[a[1]!] = a[2] ?? a[3]!;
    draft.parts.push({ kind: "directive", directive: { name: name as DirectiveName, attributes, line: i + 1 } });
  }
  flush();
  return draft;
}

/** Markdown to HTML, with raw HTML escaped: the page's look and safety are not the prose's to change. */
function html(markdown: string): string {
  return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true, tables: true });
}

// Figures ----------------------------------------------------------------------------------------

function resolve(spec: Spec | null, report: Report | null, draft: Draft, runs: Record<string, BrokenRun>, figures: string | null, problems: Problem[]): ExplainerBlock[] {
  const blocks: ExplainerBlock[] = [];
  let sections = 0;
  for (const part of draft.parts) {
    if (part.kind === "markdown") {
      // Level-2 headings are the numbered sections; the rest is prose between them.
      let prose: string[] = [];
      const flush = () => {
        if (prose.join("").trim()) blocks.push({ kind: "prose", html: html(prose.join("\n")) });
        prose = [];
      };
      for (const line of part.text.split("\n")) {
        const heading = /^## (.+)$/.exec(line);
        if (!heading) {
          prose.push(line);
          continue;
        }
        flush();
        const title = heading[1]!.trim();
        blocks.push({ kind: "section", id: slug(title), number: ++sections, title });
      }
      flush();
      continue;
    }
    if (part.kind === "callout") {
      blocks.push({ kind: "callout", tone: part.tone, html: html(part.text) });
      continue;
    }
    const { name, attributes, line } = part.directive;
    const fail = (message: string) => problems.push({ line, message: `::${name}: ${message}` });
    if (!spec || !report) {
      if (name === "figure") {
        const figure = attributes.name;
        if (!figure || figures === null || !new RegExp(`export\\s+(function|const)\\s+${figure}\\b`).test(figures)) fail(`the explainer's .tsx exports no component ${figure ?? "(no name given)"}`);
        else blocks.push({ kind: "figure", name: figure });
      } else fail("this explainer has no spec to draw it from: only ::figure, prose, tables and callouts");
      continue;
    }
    if (name === "map") {
      const { scenario } = attributes;
      if (scenario !== undefined && !spec.scenarios.some((s) => s.name === scenario)) fail(`no scenario named "${scenario}"; there are ${spec.scenarios.map((s) => `"${s.name}"`).join(", ") || "none"}`);
      blocks.push(scenario === undefined ? { kind: "map" } : { kind: "map", scenario });
      continue;
    }
    if (name === "verdicts" || name === "rules") {
      if (name === "rules" && !report.rules?.length) fail("the spec has no rules that properties need");
      blocks.push({ kind: name });
      continue;
    }
    if (name === "figure") {
      const figure = attributes.name;
      if (!figure) fail('name the component: ::figure{name="DoubleCharge"}');
      else if (figures === null) fail(`there is no explainer file with figures: write ${"<spec>.explainer.tsx"}, exporting ${figure}`);
      else if (!new RegExp(`export\\s+(function|const)\\s+${figure}\\b`).test(figures)) fail(`the explainer's .tsx exports no component ${figure}`);
      else blocks.push({ kind: "figure", name: figure });
      continue;
    }
    const run = figureRun(spec, runs, attributes, fail);
    if (!run) continue;
    if (name === "still") {
      const at = parseAt(attributes.at, length(spec, runs, run), fail);
      if (at !== null) blocks.push(at === undefined ? { kind: "still", run } : { kind: "still", run, at });
    } else if (name === "steps") {
      const events = length(spec, runs, run);
      const at = (attributes.at ?? "").split(",").filter(Boolean).map((a) => parseAt(a.trim(), events, fail));
      if (!at.length) fail('say which events: at="5,6,broke"');
      else if (at.every((a) => a !== null && a !== undefined)) blocks.push({ kind: "steps", run, at: at as At[] });
    } else blocks.push({ kind: name, run });
  }
  return blocks;
}

function figureRun(spec: Spec, runs: Record<string, BrokenRun>, attributes: Record<string, string>, fail: (message: string) => void): FigureRun | null {
  const { scenario, breaks } = attributes;
  if ((scenario === undefined) === (breaks === undefined)) {
    fail('name exactly one of scenario="…" or breaks="rule"');
    return null;
  }
  if (scenario !== undefined) {
    if (spec.scenarios.some((s) => s.name === scenario)) return { scenario };
    fail(`no scenario named "${scenario}"; there are ${spec.scenarios.map((s) => `"${s.name}"`).join(", ") || "none"}`);
    return null;
  }
  if (breaks! in runs) return { breaks: breaks! };
  const rule = spec.rules.find((r) => r.name === breaks);
  fail(rule ? `without ${breaks}, every property that needs it still holds: there is nothing to show breaking` : `no rule named ${breaks}; there are ${spec.rules.map((r) => r.name).join(", ") || "none"}`);
  return null;
}

function length(spec: Spec, runs: Record<string, BrokenRun>, run: FigureRun): number {
  return "breaks" in run ? runs[run.breaks]!.events.length : runScenario(spec, spec.scenarios.find((s) => s.name === run.scenario)!).events.length;
}

/** `at=7`, `at=-1`, `at=broke`, `at=end`; undefined when not given, null when wrong. */
function parseAt(value: string | undefined, events: number, fail: (message: string) => void): At | undefined | null {
  if (value === undefined) return undefined;
  if (value === "broke" || value === "end") return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n > events || n < -events) {
    fail(`at=${value}: the run has ${events} events; give 0 (the start) to ${events}, a negative number from the end, "broke" or "end"`);
    return null;
  }
  return n;
}

/** For every rule some property needs, the design without it, checked as `feynman check --without` does. */
async function brokenRuns(spec: Spec, bounds: Partial<Bounds>): Promise<Record<string, BrokenRun>> {
  const out: Record<string, BrokenRun> = {};
  for (const rule of spec.rules.filter((r) => r.neededBy.length)) {
    const variant = spec.withoutRules([rule.name]);
    const report = await check(variant, bounds, scenarioSeeds(variant));
    const broken = report.properties.find((p): p is PropertyBroken => !p.holds && rule.neededBy.includes(p.id));
    if (!broken) continue;
    const ce = withLoop(broken.counterexample, broken.loop);
    const violated = broken.counterexample.events.findIndex((e) => e.violations.includes(broken.id));
    out[rule.name] = {
      property: broken.id,
      initial: ce.initial,
      events: ce.events,
      worlds: ce.worlds,
      brokeAt: violated >= 0 ? violated + 1 : broken.counterexample.events.length,
      ending: !broken.loop ? "breaks" : broken.loop.events.length ? "loops" : "stays",
    };
  }
  return out;
}

function withLoop(ce: Counterexample, loop: Counterexample | undefined): Counterexample {
  if (!loop?.events.length) return ce;
  return { ...ce, choices: [...ce.choices, ...loop.choices], events: [...ce.events, ...loop.events], worlds: [...ce.worlds, ...loop.worlds] };
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Lint -------------------------------------------------------------------------------------------

/** What the story leaves out that a reader would want: they don't stop the build. */
function warnings(spec: Spec, report: Report, draft: Draft, figures: string | null): string[] {
  const directives = draft.parts.flatMap((p) => (p.kind === "directive" ? [p.directive] : []));
  const shown = new Set([...directives.flatMap((d) => (d.attributes.breaks ? [d.attributes.breaks] : [])), ...[...(figures ?? "").matchAll(/\bbreaks:\s*"([^"]+)"/g)].map((m) => m[1]!)]);
  const allRules = directives.some((d) => d.name === "rules");
  const out: string[] = [];
  for (const rule of report.rules ?? []) {
    if (!shown.has(rule.name) && !allRules) out.push(`rule ${rule.name} is not explained: no figure shows it breaking, and no ::rules`);
  }
  for (const p of report.properties) if (!p.holds && !p.known) out.push(`${p.id} is broken, and the explainer doesn't say so`);
  if (!directives.some((d) => d.name === "map")) out.push("no ::map: the reader never sees the parts");
  if (!directives.some((d) => d.name === "verdicts")) out.push("no ::verdicts: the reader never learns what holds, or within which bounds");
  // A figure with nothing after it before the next section is a picture nobody explained.
  draft.parts.forEach((part, i) => {
    if (part.kind !== "directive" || part.directive.name === "verdicts" || part.directive.name === "rules") return;
    const next = draft.parts[i + 1];
    const explained = next?.kind === "markdown" && !/^\s*## /.test(next.text.trim().split("\n")[0] ?? "") && next.text.trim().length > 0;
    const before = draft.parts[i - 1];
    const introduced = before?.kind === "markdown" && !/## [^\n]*\s*$/.test(before.text.trimEnd());
    if (!explained && !introduced) out.push(`line ${part.directive.line}: ::${part.directive.name} has no prose around it`);
  });
  return out;
}

const MARK: Record<Verdict, string> = { holds: "✓", unfinished: "~", untested: "?", broken: "✗", known: "✗ (known)", fixed: "! (fixed)" };

// The brief --------------------------------------------------------------------------------------

async function brief(ctx: Context, path: string, spec: Spec, file: string): Promise<number> {
  const bounds = ctx.config.check ?? {};
  const report = await check(spec, bounds, scenarioSeeds(spec));
  const rules = await checkRules(spec, bounds);
  const line = (label: string, items: string[]) => console.log(`  ${label.padEnd(11)} ${items.length ? items.join(`\n  ${" ".repeat(11)} `) : dim("none")}`);
  console.log(`No explainer for ${bold(spec.name)} yet. Write ${file}, then run this again.\n`);
  console.log("What the spec holds, by the ids directives take:");
  line("scenarios", spec.scenarios.map((s) => `"${s.name}"`));
  line(
    "rules",
    rules.map((r) => `${r.name.padEnd(Math.max(...rules.map((x) => x.name.length)))}  ${r.neededBy.map((n) => (n.verdict === "breaks" ? `without it, ${n.property} breaks in ${n.events} events` : `${n.property} ${n.verdict} without it`)).join("; ")}`),
  );
  line("findings", report.properties.filter((p) => !p.holds).map((p) => `${p.id}${p.known ? " (known)" : ""}`));
  const verdicts = report.properties.map((p) => ({ p, verdict: verdictOf(p, { report, brokenBy: new Map() }) }));
  line("properties", verdicts.map(({ p, verdict }) => `${MARK[verdict]} ${p.id}  ${dim(p.description)}`));
  if (verdicts.some((v) => v.verdict === "unfinished"))
    console.log(yellow(`  ~ held to depth ${report.bounds.depth}, but some paths were cut off there. Set depth: in the front matter until
    every property is ✓, so the page doesn't claim more than the check showed.`));
  console.log(`
A shape that works:
  front matter   title: and lede: (what the reader will understand, in a sentence)
  1. What it is, and for whom, in two sentences; then the parts.       ::map
  2. The happy path, told as it plays.                                  ::play{scenario="…"}
  3. A section per rule: what goes wrong without it, and what stops it. ::play{breaks="rule"}
     Tell the counterexample as a story: who did what, and what was lost.
  4. What holds, and within which bounds.                               ::verdicts
  5. What the spec leaves out: what the reader should not conclude.

Directives, each alone on its line. A run is scenario="name" or breaks="rule" (the shortest
way the design breaks without the rule):
  ::map{scenario="name"}        the parts, before anything happens (no scenario: the spec's start)
  ::still{RUN at=N}             the stage frozen after event N (0 the start, -1 the last,
                                at=broke the event that broke the property; default the end)
  ::steps{RUN at="5,6,broke"}   the run told in the events that matter, one line each
  ::flow{RUN}                   the run as a sequence diagram
  ::figure{name="Component"}    a figure you compose, exported from <spec>.explainer.tsx
  ::play{RUN}                   the whole playground, to play with: use sparingly, it's busy
  ::verdicts                    every property's verdict, with the bounds
  ::rules                       every rule, and what breaks without it

Prefer a still, or a figure of a few parts, to the playground. In <spec>.explainer.tsx,
compose figures from the explorer's own pieces, fed by runs, rather than drawing your own:
  import { Actor, Diagram, Message, Moments, Still, useRun, moment } from "@leostera/feynman/explain";
  import { Card, Node, Rows, Ticket } from "@leostera/feynman/play";
  export function DoubleCharge() {
    return (
      <Diagram>
        <Actor run={{ breaks: "idempotencyKey" }} at="broke" name="Box office" rows={false} />
        <Message name="Charge order-1" fate="twice" />
        <Actor run={{ breaks: "idempotencyKey" }} at="broke" name="Bank" />
      </Diagram>
    );
  }
  <Moments run={{ breaks: "rule" }} at={[5, 6, "broke"]} /> tells a run in the steps that matter.

Every figure comes from the spec; write the story, not the facts. Don't quote traces or
counts the figures already show. Say why each part matters.`);
  return 0;
}
