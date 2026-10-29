// Text output: what agents and people read in a terminal.
import { faultsIn, placeText, type PropertyBroken, type PropertyResult, type Report } from "../check/index.ts";
import type { SourceStatus } from "../code/index.ts";
import type { Event, RunDiff, Spec, World } from "../spec/index.ts";
import { verdictOf, type Verdict } from "../check/verdict.ts";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = paint(2);
export const bold = paint(1);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);

export function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms % 1000 ? 2 : 0)}s` : `${(ms / 60_000).toFixed(1)}min`;
}

function value(v: unknown): string {
  const text = JSON.stringify(v);
  return text === undefined ? "—" : text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function label(world: World | undefined, id: string): string {
  return world?.instances.find((i) => i.id === id)?.label ?? id;
}

function stepName(spec: Spec, event: Event): string {
  if (event.kind === "spawn" || event.kind === "restart" || event.kind === "lose") return event.kind;
  if (event.key.startsWith("message:")) return spec.messages[event.key]?.name ?? event.key;
  return event.key;
}

/** One event, with what it changed and sent. */
export function formatEvent(spec: Spec, event: Event, world?: World, position = event.index): string {
  const who = `${label(world, event.instance)} (${event.actor})`;
  const head = [dim(String(position).padStart(4)), bold(who), stepName(spec, event)];
  if (event.inputs && Object.keys(event.inputs).length) head.push(dim(value(event.inputs)));
  else if (event.payload !== undefined && event.kind !== "spawn") head.push(dim(value(event.payload)));
  if (event.from) head.push(dim(`from ${label(world, event.from)}`));
  const lines = [head.join("  ")];
  const pad = " ".repeat(6);
  if (event.kind !== "spawn") lines.push(pad + dim(event.description));
  for (const note of event.notes) lines.push(pad + dim(`“${note}”`));
  if (event.kind !== "spawn") for (const c of event.changes) lines.push(`${pad}${c.path || "state"}: ${value(c.before)} → ${value(c.after)}`);
  for (const s of event.sent) lines.push(`${pad}→ ${label(world, s.to)}: ${spec.messages[s.message]?.name ?? s.message} ${dim(value(s.payload))}`);
  for (const t of event.started) lines.push(`${pad}${dim(`⏱ ${t.timer} set`)}`);
  for (const t of event.cancelled) lines.push(`${pad}${dim(`⏱ ${t} cancelled`)}`);
  if (event.error) lines.push(`${pad}${red(`spec error: ${event.error}`)}`);
  for (const v of event.violations) lines.push(`${pad}${red(`✗ breaks ${v}`)}`);
  return lines.join("\n");
}

export function formatEvents(spec: Spec, events: Event[], worlds: World[]): string {
  return events.map((e, i) => formatEvent(spec, e, worlds[i], i + 1)).join("\n");
}

export function formatSources(statuses: SourceStatus[]): string[] {
  const lines: string[] = [];
  const missing = statuses.filter((s) => s.status === "missing");
  const stale = statuses.filter((s) => s.status === "stale");
  const fresh = statuses.filter((s) => s.status === "new");
  for (const s of missing) lines.push(red(`  ✗ source ${s.source} ${s.status === "missing" ? s.reason : ""}`));
  for (const s of stale) lines.push(yellow(`  ! stale: ${s.source} changed since the spec was last locked; check the steps that name it, then run feynman lock`));
  if (fresh.length) lines.push(dim(`  ${fresh.length} source(s) not in feynman.lock yet; run feynman lock once the spec is right`));
  return lines;
}

/** What else the search did: random runs, and the work its reductions saved. */
function searchNotes(report: Report): string[] {
  const notes: string[] = [];
  if (report.walks.runs) notes.push(`  also ${report.walks.runs.toLocaleString()} random run(s), ${report.walks.steps.toLocaleString()} steps, up to ${report.walks.deepest} deep: they find bugs deeper than the search, but prove nothing`);
  const saved = report.reductions.orders + report.reductions.inputs;
  const symmetric = report.reductions.symmetric.map((labels) => labels.join(" = ")).join(", ");
  if (saved) notes.push(`  skipped ${saved.toLocaleString()} step(s) whose result was known`);
  if (symmetric) notes.push(`  treated as interchangeable: ${symmetric}`);
  const out = notes.map((n) => dim(n));
  if (report.reductions.refuted?.length)
    out.push(yellow(`  ! ${report.reductions.refuted.join(", ")} declared symmetric, but swapping two instances changed what happens next; checked without symmetry. Remove symmetric: true.`));
  return out;
}

export interface ReportOptions {
  /** Properties a scenario breaks: broken whatever exploration found. */
  brokenBy?: Map<string, string>;
  /** Verdicts and counterexample sizes, without the traces. */
  brief?: boolean;
  /** How each property is read; by default from the report alone. */
  verdict?: (p: PropertyResult) => Verdict;
  /** The command that checked this spec, to say how to see one counterexample. */
  command?: string;
}

/**
 * The checker's report. Properties a scenario already breaks show as broken whatever
 * exploration found. A property that held while exploration stopped early says so, rather
 * than claiming to hold.
 */
export function formatReport(spec: Spec, report: Report, options: ReportOptions = {}): string {
  const brokenBy = options.brokenBy ?? new Map<string, string>();
  const verdict = options.verdict ?? ((p: PropertyResult) => verdictOf(p, { report, brokenBy }));
  const b = report.bounds;
  const instances = Object.entries(b.instances).map(([actor, n]) => `${n} ${actor}`).join(", ");
  const scope = [instances || "1 of each actor", ...seedsText(report.seeds), `depth ${b.depth}`, `${b.faults} fault(s)`, `actions repeated up to ${b.repeats}×`].join(", ");
  const lines = [
    `${bold(spec.name)}: explored ${report.states.toLocaleString()} states (${scope}) in ${seconds(report.durationMs)}${report.threads > 1 ? ` on ${report.threads} threads` : ""}${report.exhaustive ? "" : yellow(` — stopped at ${report.stoppedBy}; raise it or lower depth to explore everything`)}`,
    ...(options.brief ? [] : searchNotes(report)),
  ];
  for (const p of report.properties) {
    const scenario = brokenBy.get(p.id);
    const v = verdict(p);
    if (v === "fixed") {
      lines.push(red(`  ✓ ${p.id}`) + `  ${p.description}` + red(`  marked known ("${p.known}"), but holds now: remove known`));
      continue;
    }
    if (v === "untested") {
      lines.push(yellow(`  ? ${p.id}`) + dim(`  ${p.description}  never tested: exploration never reached a world where it applies`));
      continue;
    }
    if (v === "unfinished") {
      lines.push(yellow(`  ~ ${p.id}`) + dim(`  ${p.description}  ${unfinishedWhy(report)}`));
      continue;
    }
    if (v === "holds") {
      lines.push(green(`  ✓ ${p.id}`) + dim(`  ${p.description}`));
      continue;
    }
    const mark = v === "known" ? yellow(`  ✗ ${p.id}`) + `  ${p.description}` + yellow(`  known bug: ${p.known}`) : red(`  ✗ ${p.id}`) + `  ${p.description}`;
    // Broken, or known, yet held: a scenario broke it (any other held verdict is handled above).
    if (p.holds) {
      lines.push(mark + dim(`  broken by scenario "${scenario}"; exploration did not reach it within these bounds`));
      continue;
    }
    lines.push(mark, ...formatBroken(spec, p, options));
  }
  for (const e of report.errors) {
    lines.push(red(`  ✗ spec error: ${e.message}`));
    if (!options.brief) lines.push(indent(formatEvents(spec, e.counterexample.events, e.counterexample.worlds), 4));
  }
  if (report.stuck) {
    lines.push(red(`  ✗ stuck: nothing can happen, and the spec does not call this world final (defineFinalState)`));
    if (!options.brief) lines.push(indent(formatEvents(spec, report.stuck.counterexample.events, report.stuck.counterexample.worlds), 4));
    const lost = lostHint(spec, report.stuck.counterexample);
    if (lost) lines.push(yellow(`    ${lost}`));
  }
  if (report.coverage.missed.length) lines.push(yellow(`  never ran: ${report.coverage.missed.join(", ")}`));
  return lines.join("\n");
}

/** Which scenario worlds a search also started from: "and from the end of 4 scenario(s) and the setup of 1". */
function seedsText(seeds: Report["seeds"]): string[] {
  const ends = seeds.filter((s) => s.at === "end").length;
  const starts = seeds.length - ends;
  const parts = [...(ends ? [`the end of ${ends} scenario(s)`] : []), ...(starts ? [`the setup of ${starts}`] : [])];
  return parts.length ? [`and from ${parts.join(" and ")}`] : [];
}

/** Why a property that held is not proved: exploration stopped early, or paths were cut off at the depth bound. */
function unfinishedWhy(report: Report): string {
  if (report.stoppedBy) return `held in the ${report.states.toLocaleString()} states explored before the ${report.stoppedBy === "maxStates" ? "state" : "time"} limit, not all of them`;
  return `held to depth ${report.bounds.depth}, but paths that had not got there yet were cut off at that depth: it may break further on`;
}

/** What to do about the unfinished verdicts in a report, for the line under them. */
export function unfinishedHint(report: Report): string {
  if (report.stoppedBy === "maxStates") return `"~" is not a proof: raise --max-states (check.maxStates in feynman.config.ts), or lower --depth, until exploration finishes.`;
  if (report.stoppedBy === "timeLimit") return `"~" is not a proof: raise --time-limit (check.timeLimit in feynman.config.ts), or lower --depth, until exploration finishes.`;
  return `"~" is not a proof: raise --depth (check.depth in feynman.config.ts; it is ${report.bounds.depth} now) until no path is cut off before it gets there or loops.`;
}

/** How a broken property breaks: the counterexample, how it was found, and for liveness the loop. */
function formatBroken(spec: Spec, p: PropertyBroken, options: ReportOptions): string[] {
  const { counterexample: ce, loop } = p;
  const faults = faultsIn(ce.events);
  const found = p.foundBy === "walk" ? `found by a random run past the search's depth, shrunk to ${ce.events.length} event(s)` : `shortest counterexample, ${ce.events.length} event(s)`;
  const needs = faults ? `needs ${faults} fault(s)` : "needs no faults";
  const shorter = p.shorter ? `; a shorter one, ${p.shorter.events} event(s), needs ${p.shorter.faults} fault(s)` : "";
  const from = ce.from ? `, from ${placeText(ce.from)}` : "";
  if (options.brief) return [dim(`    ${found}, ${needs}${from}${shorter}${options.command ? `; see it with ${options.command} --only ${p.id}` : ""}`)];
  const lines = [dim(`    ${found}, ${needs}${from}${shorter}:`), indent(formatEvents(spec, ce.events, ce.worlds), 4)];
  if (loop?.events.length) lines.push(dim(`    then this repeats forever, and it never holds:`), indent(formatEvents(spec, loop.events, loop.worlds), 4));
  else if (loop) lines.push(dim(`    then nothing fair can happen: it stays there forever, and never holds`));
  const lost = loop && !loop.events.length ? lostHint(spec, ce) : null;
  if (lost) lines.push(yellow(`    ${lost}`));
  return lines;
}

/**
 * For a path that ends with nothing left to happen after a message was lost: the sender is
 * waiting for an answer that cannot come. Agents tend to make this go away by weakening the
 * property or calling every quiet world final; say what the code does instead.
 */
function lostHint(spec: Spec, path: { events: readonly Event[]; worlds: readonly World[] }): string | null {
  const lost = path.events.find((e) => e.kind === "lose");
  if (!lost || !lost.message) return null;
  const message = spec.messages[lost.message];
  const labelOf = (id: string | undefined) => path.worlds.at(-1)?.instances.find((i) => i.id === id)?.label ?? id;
  // A lost request leaves its sender waiting; a lost reply, the one it was for.
  const waiting = labelOf(message?.tone && message.tone !== "request" ? lost.instance : lost.from);
  return [
    `The lost ${message?.name ?? lost.message} to ${labelOf(lost.instance)} is never sent again, so ${waiting} waits for an answer that cannot come.`,
    `Model what the code does when none comes: a timer that retries, or the error the call raises. If it cannot be lost here, check with --faults 0.`,
    `If the code has no answer for it, that is a finding: report it, rather than weaken the property or call this world final.`,
  ].join("\n    ");
}

export function formatDiff(spec: Spec, scenario: string, diff: RunDiff | "added" | "removed"): string {
  if (diff === "added" || diff === "removed") return `${bold(scenario)}: ${diff === "added" ? green("new scenario") : red("scenario removed")}`;
  if (diff.status === "same") return `${bold(scenario)}: ${dim("unchanged")}`;
  const lines = [`${bold(scenario)}: ${yellow("changed")}`];
  for (const step of diff.steps) {
    const e = (step.head ?? step.base)!;
    const mark = { same: dim("  "), changed: yellow("~ "), added: green("+ "), removed: red("- ") }[step.status];
    const text = `${e.actor}.${stepName(spec, e)}`;
    lines.push(`  ${mark}${step.status === "same" ? dim(text) : text}`);
    if (step.status === "changed" && step.base && step.head) {
      const before = new Map(step.base.changes.map((c) => [c.path, c.after]));
      for (const c of step.head.changes) if (JSON.stringify(before.get(c.path)) !== JSON.stringify(c.after)) lines.push(`      ${c.path}: was ${value(before.get(c.path))}, now ${value(c.after)}`);
      const sentBefore = step.base.sent.map((s) => s.message).join(", ") || "nothing";
      const sentNow = step.head.sent.map((s) => s.message).join(", ") || "nothing";
      if (sentBefore !== sentNow) lines.push(`      sent: was ${sentBefore}, now ${sentNow}`);
    }
  }
  return lines.join("\n");
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}
