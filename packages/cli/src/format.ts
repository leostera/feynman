// Text output: what agents and people read in a terminal.
import type { Report } from "@feynman/check";
import type { SourceStatus } from "@feynman/code";
import type { Event, RunDiff, Spec, World } from "@feynman/spec";

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
  const head = [dim(String(position).padStart(4)), dim(seconds(event.at).padStart(7)), bold(who), stepName(spec, event)];
  if (event.inputs && Object.keys(event.inputs).length) head.push(dim(value(event.inputs)));
  else if (event.payload !== undefined && event.kind !== "spawn") head.push(dim(value(event.payload)));
  if (event.from) head.push(dim(`from ${label(world, event.from)}`));
  const lines = [head.join("  ")];
  const pad = " ".repeat(14);
  if (event.kind !== "spawn") lines.push(pad + dim(event.description));
  for (const note of event.notes) lines.push(pad + dim(`“${note}”`));
  if (event.kind !== "spawn") for (const c of event.changes) lines.push(`${pad}${c.path || "state"}: ${value(c.before)} → ${value(c.after)}`);
  for (const s of event.sent) lines.push(`${pad}→ ${label(world, s.to)}: ${spec.messages[s.message]?.name ?? s.message} ${dim(value(s.payload))}`);
  for (const t of event.started) lines.push(`${pad}${dim(`⏱ ${t.timer} at ${seconds(t.at)}`)}`);
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

/**
 * The checker's report. `brokenBy` names invariants a scenario already breaks, which show as
 * broken whatever exploration found. A property that held while exploration stopped early
 * says so, rather than claiming to hold.
 */
export function formatReport(spec: Spec, report: Report, brokenBy: Map<string, string> = new Map()): string {
  const b = report.bounds;
  const instances = Object.entries(b.instances).map(([actor, n]) => `${n} ${actor}`).join(", ");
  const scope = [instances || "1 of each actor", ...(report.seeds ? [`and from the end of ${report.seeds} scenario(s)`] : []), `depth ${b.depth}`, `${b.faults} fault(s)`, `actions repeated up to ${b.repeats}×`].join(", ");
  const lines = [
    `${bold(spec.name)}: explored ${report.states.toLocaleString()} states (${scope}) in ${seconds(report.durationMs)}${report.exhaustive ? "" : yellow(` — stopped at ${report.stoppedBy}; raise it or lower depth to explore everything`)}`,
  ];
  for (const p of report.properties) {
    const scenario = brokenBy.get(p.id);
    if (p.holds && scenario) {
      lines.push(red(`  ✗ ${p.id}`) + `  ${p.description}` + dim(`  broken by scenario "${scenario}"; exploration did not reach it within these bounds`));
      continue;
    }
    if (p.holds && !report.exhaustive) {
      lines.push(yellow(`  ~ ${p.id}`) + dim(`  ${p.description}  held in the states explored, not all of them`));
      continue;
    }
    if (p.holds) {
      lines.push(green(`  ✓ ${p.id}`) + dim(`  ${p.description}`));
      continue;
    }
    lines.push(red(`  ✗ ${p.id}`) + `  ${p.description}`);
    const ce = p.counterexample!;
    lines.push(dim(`    shortest counterexample, ${ce.events.length} event(s)${ce.from ? `, from the end of scenario "${ce.from}"` : ""}:`));
    lines.push(indent(formatEvents(spec, ce.events, ce.worlds), 4));
    if (p.then?.length) {
      lines.push(dim(`    then, left to run by itself, it never holds:`));
      const last = ce.worlds.at(-1);
      lines.push(indent(p.then.map((e) => formatEvent(spec, e, last)).join("\n"), 4));
    }
  }
  for (const e of report.errors) {
    lines.push(red(`  ✗ spec error: ${e.message}`));
    lines.push(indent(formatEvents(spec, e.counterexample.events, e.counterexample.worlds), 4));
  }
  if (report.coverage.missed.length) lines.push(yellow(`  never ran: ${report.coverage.missed.join(", ")}`));
  return lines.join("\n");
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
