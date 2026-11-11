// feynman conform: is a log of what the system did a run of the spec (RFD0016)? The reading
// that fits, with the steps the log does not show and the properties it breaks; or the line
// where the log leaves the spec, and what the spec could have done there.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { conform, DEFAULT_GAP, LogError, parseLog, type Conformance, type ConformOptions, type LogEvent, type LogStep } from "../check/conform.ts";
import { readSpans, traceFormat, traceLog, type TraceFormat, type TraceMapping } from "../check/trace.ts";
import type { Spec } from "../spec/index.ts";
import { loadSelected, type Context } from "./commands.ts";
import { importFresh } from "./load.ts";
import { dim, formatEvent, green, red, yellow } from "./format.ts";
import { scenarioCode } from "./scenario-code.ts";

export interface ConformCommandOptions extends ConformOptions {
  set: Record<string, unknown>;
  output: "text" | "json" | "scenario";
  /** A module whose default export maps spans to steps (TraceMapping). */
  map?: string;
  /** Only this trace, of the ones in the file. */
  trace?: string;
  /** How a trace's steps are ordered: by what caused what (the default), or by the clocks. */
  order?: "causal" | "time";
}

export async function conformCommand(ctx: Context, positionals: string[], options: ConformCommandOptions): Promise<number> {
  if (positionals.length !== 2) throw new Error("conform takes a spec and a log: feynman conform <spec> <log.jsonl>");
  const [named, logPath] = positionals as [string, string];
  const selected = await loadSelected(ctx, [named]);
  if (selected.length !== 1) throw new Error(`conform checks one spec against a log; ${named} names ${selected.length}`);
  const { path } = selected[0]!;
  const spec = Object.keys(options.set).length ? selected[0]!.spec.setting(options.set) : selected[0]!.spec;
  const file = isAbsolute(logPath) ? logPath : join(ctx.cwd, logPath);
  // Named as the spec is, from the repository's root; a log outside it, as given.
  const inside = relative(ctx.repository.root, file);
  const shown = inside && !inside.startsWith("..") ? inside : logPath;
  const text = readFileSync(file, "utf8");
  const format = traceFormat(text);
  if (!format && (options.map || options.trace || options.order)) throw new Error(`${shown} is a JSON Lines log, not a trace: --map, --trace and --order are for traces (OTLP, Jaeger, Zipkin)`);
  const map = options.map ? await loadMapping(isAbsolute(options.map) ? options.map : join(ctx.cwd, options.map)) : undefined;
  let result: Conformance;
  let log: LogEvent[];
  try {
    log = format ? traceLog(readSpans(text, format), spec, { map, traceId: options.trace, order: options.order }) : parseLog(text, spec);
    if (format && !log.some((e) => e.kind !== "spawn")) throw new LogError(0, `has no span that is a step of the spec: mark them with a feynman.step attribute, or map them with --map`, "");
    result = conform(spec, log, options);
  } catch (error) {
    if (!(error instanceof LogError)) throw error;
    console.log(red(`${shown}: ${error.message}`));
    return 1;
  }
  // Where each event came from: a line of the file, or a span of the trace.
  const at = new Map(log.map((e) => [e.line, e.at ?? `line ${e.line}`]));
  const whereIs = (line: number | undefined) => (line === undefined ? undefined : at.get(line)!);
  const fails = !result.conforms || result.broken.length > 0;
  if (options.output === "json") console.log(JSON.stringify(jsonOf(path, shown, result, whereIs), null, 2));
  else if (options.output === "scenario") {
    if (!result.conforms) {
      console.log(red(`${shown} is not a run of ${path}: there is no scenario to write. Without --as-scenario, check says where it leaves the spec.`));
      return 1;
    }
    const notes = result.lines.map((line) => whereIs(line) ?? `not in the ${format ? "trace" : "log"}`);
    console.log(scenarioCode(spec, { id: "log", description: `What ${shown} recorded, as a run of the spec.`, counterexample: result.run, log: shown, notes }));
  } else console.log(textOf(spec, path, format ? `${shown} (${FORMATS[format]})` : shown, result, options.gap ?? DEFAULT_GAP, whereIs, format ? "trace" : "log"));
  return fails ? 1 : 0;
}

const FORMATS: Record<TraceFormat, string> = { otlp: "OpenTelemetry", jaeger: "Jaeger", zipkin: "Zipkin" };

/** A mapping module: its default export, a function from a span to a log line or undefined. */
async function loadMapping(path: string): Promise<TraceMapping> {
  // Bundled as a config is, so @leostera/feynman/config resolves from any repository.
  const mod = (await importFresh(path)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error(`${path} must export default a function from a span to a log line (defineTraceMapping)`);
  return mod.default as TraceMapping;
}

/** `noun` is what was read, a log or a trace, as the report calls it. */
function textOf(spec: Spec, path: string, log: string, result: Conformance, gap: number, whereIs: (line: number | undefined) => string | undefined, noun: "log" | "trace"): string {
  const lines = [`${path}, against ${log}`];
  const unlogged = result.lines.filter((l) => l === undefined).length;
  const logged = result.lines.length - unlogged;
  const events = result.run.events.map((e, i) => {
    const [first, ...rest] = formatEvent(spec, e, result.run.worlds[i], i + 1).split("\n");
    const where = result.lines[i] === undefined ? yellow(`  not in the ${noun}`) : dim(`  ${whereIs(result.lines[i])}`);
    return [first + where, ...rest].join("\n");
  });
  if (result.conforms) {
    lines.push(green(`✓ the ${noun} is a run of the spec: ${logged} logged event(s)${unlogged ? `, and ${unlogged} the ${noun} does not show` : ""}`));
    lines.push(...events);
    for (const b of result.broken) {
      const at = b.at < 0 ? "where it starts" : `at event ${b.at + 1}${result.lines[b.at] === undefined ? `, which the ${noun} does not show` : ` (${whereIs(result.lines[b.at])})`}`;
      lines.push(red(`  ✗ ${b.id}`) + dim(`  ${b.description}`) + red(`  broken ${at}`));
    }
    if (!result.broken.length) lines.push(dim("  no property breaks on it"));
    if (unlogged) lines.push(dim(`  Of the readings that fit, this has the fewest steps the ${noun} does not show; another may differ in them.`));
    return lines.join("\n");
  }
  if (result.stop.kind === "limit") {
    lines.push(yellow(`~ not decided: the search met its limit of ${result.stop.states.toLocaleString("en")} states, having matched ${logged} event(s). Fewer unlogged steps (--gap) make it smaller.`));
    return lines.join("\n");
  }
  const { line, could, near, errors } = result.stop;
  lines.push(red(`✗ the ${noun} leaves the spec at ${line.at ?? `line ${line.line}`}: ${describeLine(line)}`));
  if (events.length) lines.push(dim(`  it fits up to there:`), ...events);
  const header = (what: string) => dim(`  ${what}${gap ? `, after up to ${gap} step(s) the ${noun} does not show` : ""}:`);
  if (errors.length) lines.push(header(`there, that step fails in the spec`), ...errors.map((e) => red(`    ${e}`)));
  if (near.length) lines.push(header(`${line.instance} can take ${line.key} there, but not as logged`), ...near.map((n) => `    ${n}`));
  if (could.length) lines.push(header(`what else could happen there`), ...could.map((c) => dim(`    ${c}`)));
  if (!near.length && !could.length && !errors.length) lines.push(dim(`  nothing can happen there: the run has ended`));
  return lines.join("\n");
}

function describeLine(line: LogStep): string {
  const parts = [`${line.instance} ${line.key}`];
  if (line.inputs) parts.push(JSON.stringify(line.inputs));
  if (line.message) parts.push(line.message.replace(/^message:/, ""));
  if ("payload" in line) parts.push(JSON.stringify(line.payload));
  if (line.from) parts.push(`from ${line.from}`);
  return parts.join("  ");
}

function jsonOf(path: string, log: string, r: Conformance, whereIs: (line: number | undefined) => string | undefined) {
  const events = r.run.events.map((e, i) => ({ ...(r.lines[i] !== undefined && whereIs(r.lines[i])?.startsWith("span") ? { span: whereIs(r.lines[i]) } : {}), instance: e.instance, actor: e.actor, kind: e.kind, key: e.key, ...(e.inputs ? { inputs: e.inputs } : {}), ...(e.message ? { message: e.message, payload: e.payload, from: e.from } : {}), line: r.lines[i] ?? null }));
  if (r.conforms) return { spec: path, log, conforms: true, events, broken: r.broken.map((b) => ({ id: b.id, event: b.at + 1, line: b.at >= 0 ? (r.lines[b.at] ?? null) : null, ...(b.at >= 0 && r.lines[b.at] !== undefined && whereIs(r.lines[b.at])?.startsWith("span") ? { span: whereIs(r.lines[b.at]) } : {}) })), states: r.states };
  return { spec: path, log, conforms: false, events, stop: r.stop.kind === "limit" ? { limit: r.stop.states } : { line: r.stop.line.line, ...(r.stop.line.at ? { span: r.stop.line.at } : {}), near: r.stop.near, could: r.stop.could, errors: r.stop.errors }, states: r.states };
}
