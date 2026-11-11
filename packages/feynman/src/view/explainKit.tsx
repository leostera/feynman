// The explain kit (src/explain/index.ts declares it): figures an explainer composes from the
// playground's own pieces, fed by recorded runs. Nothing here is interactive: a figure is a
// picture of a moment, drawn exactly as the stage would draw it then.
import { cn } from "@cloudflare/kumo";
import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import type * as Declared from "../explain/index.ts";
import type { At, RecordedRun, RunSource } from "../explain/index.ts";
import { groupsOf, identityColors, Node, PlayProvider, Rows, toneColor } from "../play/index.ts";
import { runScenario, type Event, type World } from "../spec/index.ts";
import type { BrokenRun } from "./data";
import { Blocks } from "./explainBlocks";
import { Anatomy, Bars, Caption, Columns, compact, Ranges, Scale, Share, Source, Stat, Stats } from "./explainCharts";
import { isFault, labelOf } from "./format";
import type { Layout, Layouts } from "./layout";
import { bubbleText, fitOf, sizesOf, Stage, TokenChip, useLayout, useView } from "./playground/Stage";
import { nodeDisplay, sceneOf } from "./scene";
import { useExplorer } from "./ui";

export const RunsContext = createContext<Record<string, BrokenRun>>({});
export const RunsProvider = RunsContext.Provider;

export function useRun(source: RunSource): RecordedRun {
  const { spec } = useExplorer();
  const runs = useContext(RunsContext);
  const key = "breaks" in source ? `breaks:${source.breaks}` : `scenario:${source.scenario}`;
  return useMemo(() => {
    if ("breaks" in source) {
      const run = runs[source.breaks];
      if (!run) throw new Error(`No run without ${source.breaks}: it is not a rule some property needs`);
      return { initial: run.initial, events: run.events, worlds: run.worlds, broke: { at: run.brokeAt, property: run.property } };
    }
    const scenario = spec.scenarios.find((s) => s.name === source.scenario);
    if (!scenario) throw new Error(`No scenario named "${source.scenario}"`);
    const { initial, events, worlds } = runScenario(spec, scenario);
    return { initial, events, worlds };
    // `key` names the source; the object itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, runs, key]);
}

export function moment(run: RecordedRun, at: At = "end"): { index: number; world: World; event: Event | null } {
  const last = run.events.length;
  const index = at === "end" ? last : at === "broke" ? (run.broke?.at ?? last) : at < 0 ? last + at + 1 : Math.min(at, last);
  return index <= 0 ? { index: 0, world: run.initial, event: null } : { index, world: run.worlds[index - 1]!, event: run.events[index - 1]! };
}

function pickLayout(layouts: Layouts, view: { w: number; h: number }): Layout {
  const across = fitOf(layouts.horizontal, { x: 0, y: 0, ...view }).scale;
  const down = fitOf(layouts.vertical, { x: 0, y: 0, ...view }).scale;
  return down > across * 1.15 ? layouts.vertical : layouts.horizontal;
}

const NOTHING = () => {};

export function Still({ run: source, at, height = 360, bubble = true }: { run: RunSource; at?: At; height?: number; bubble?: boolean }) {
  const run = useRun(source);
  return <StageStill {...moment(run, at)} height={height} bubble={bubble} />;
}

/** The stage drawing one world, after `event` (the `index`th), with nothing to click. */
export function StageStill({ index, world, event, height = 360, bubble = true }: { index: number; world: World; event: Event | null; height?: number; bubble?: boolean }) {
  const { spec, playground } = useExplorer();
  const { ref, view } = useView();
  const scene = sceneOf(spec, world, groupsOf(spec, playground), new Set());
  const layouts = useLayout(spec, world, scene, view, sizesOf(playground, scene));
  const graph = layouts && pickLayout(layouts, view);
  const fit = fitOf(graph, { x: 0, y: 0, ...view });
  const said = bubble && event && event.kind !== "spawn" ? { key: String(index), instance: event.instance, text: bubbleText(spec, event, world), tone: toneOf(event), fading: false } : null;
  return (
    <div ref={ref} style={{ height }} className="pointer-events-none relative w-full select-none overflow-hidden" aria-label={event ? `After event ${index}: ${bubbleText(spec, event, world)}` : "The start"}>
      {graph && (
        <Stage
          world={world}
          scene={scene}
          graph={graph}
          fit={fit}
          flight={null}
          live={false}
          focus={event ? { event, index: index - 1 } : null}
          bubble={said}
          next={null}
          pulse={null}
          selected={null}
          picking={null}
          dragging={null}
          spent={new Set()}
          onSelect={NOTHING}
          onPick={NOTHING}
          onToken={NOTHING}
          onDrop={NOTHING}
          onPacket={NOTHING}
          onAct={NOTHING}
          bar={null}
        />
      )}
    </div>
  );
}

function toneOf(event: Event): "action" | "message" | "bad" | "quiet" {
  if (event.error || event.violations.length || isFault(event)) return "bad";
  return event.kind === "action" ? "action" : event.kind === "timer" ? "quiet" : "message";
}

export function Actor({ run: source, at, name, rows = true }: { run: RunSource; at?: At; name: string; rows?: boolean }) {
  const { spec, playground } = useExplorer();
  const run = useRun(source);
  const { world } = moment(run, at);
  const scene = sceneOf(spec, world, groupsOf(spec, playground), new Set());
  const instance = world.instances.find((i) => i.label === name || i.id === name) ?? world.instances.find((i) => i.actor === name);
  const node = instance && scene.nodes.find((n) => n.id === scene.of.get(instance.id));
  if (!node) return <span className="text-xs text-kumo-danger">No {name} in this world</span>;
  const display = nodeDisplay(spec, world, node);
  const colors = identityColors(spec, world);
  const colorOf = (ref: string | null | undefined) => {
    const found = ref ? world.instances.find((i) => i.id === ref || i.label === ref) : undefined;
    return found ? colors.get(found.id) : undefined;
  };
  const identity = node.members.map((m) => colors.get(m.id)).find(Boolean);
  return (
    <PlayProvider value={{ colorOf }}>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className="relative">
          <Node shape={display.shape} icon={display.icon} label={node.label} status={display.status} mood={display.mood} badge={identity ? { text: node.label.charAt(0).toUpperCase(), color: identity } : null} />
          {display.held.length > 0 && (
            <div className="absolute left-full top-0 ml-1.5 flex flex-col gap-1">
              {display.held.map(({ token, from }) => (
                <TokenChip key={`${token.kind}:${String(token.value)}`} token={token} holder={world.instances.find((i) => i.id === from)} />
              ))}
            </div>
          )}
        </div>
        {rows && display.rows.length > 0 && <Rows rows={display.rows.map((r) => ({ ...r, label: labelOf(world, r.label) }))} className="w-[210px]" />}
      </div>
    </PlayProvider>
  );
}

export function Message({ name, tone = "request", fate, back = false, note }: { name: string; tone?: "request" | "reply" | "refused" | "stream"; fate?: "lost" | "twice"; back?: boolean; note?: string }) {
  const color = fate === "lost" ? "var(--color-kumo-danger)" : toneColor(tone);
  const head = { width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", [back ? "borderRight" : "borderLeft"]: `10px solid ${color}` };
  const arrow = (
    <div className={cn("flex w-full items-center", back && "flex-row-reverse")} aria-hidden>
      <div className="h-0 flex-1" style={{ borderTop: `2px ${fate === "lost" ? "dashed" : "solid"} ${color}` }} />
      <div style={head} />
    </div>
  );
  return (
    <div className="flex min-w-[140px] flex-1 flex-col items-center gap-1 self-start px-2 pt-6">
      <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold text-kumo-inverse" style={{ background: color }}>
        {name}
        {fate === "twice" ? " ×2" : ""}
      </span>
      <div className="relative w-full">
        {arrow}
        {fate === "lost" && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-kumo-base px-1 text-sm font-bold text-kumo-danger">✕</span>}
      </div>
      {note && <span className="text-center text-[11px] text-kumo-subtle">{note}</span>}
    </div>
  );
}

export function Diagram({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8">
      <div className="flex w-full max-w-[56rem] items-start justify-center">{children}</div>
      {caption && <p className="text-xs text-kumo-subtle">{caption}</p>}
    </div>
  );
}

export function Moment({ run: source, at }: { run: RunSource; at: At }) {
  const { spec } = useExplorer();
  const run = useRun(source);
  const { index, world, event } = moment(run, at);
  if (!event) return <MomentRow index={0} text="The start" />;
  const broke = run.broke?.at === index;
  // A step's own words (`say`) don't name who said them; the line does.
  const said = bubbleText(spec, event, world);
  const who = labelOf(world, event.instance);
  const text = said.startsWith(`${who}:`) ? said : `${who}: ${said}`;
  return <MomentRow index={index} text={text} fault={isFault(event)} broke={broke ? (run.broke?.property ?? null) : null} />;
}

function MomentRow({ index, text, fault, broke }: { index: number; text: string; fault?: boolean; broke?: string | null }) {
  return (
    <div className={cn("flex items-baseline gap-3 rounded-lg px-3 py-2", broke ? "bg-kumo-danger-tint" : fault ? "bg-kumo-warning-tint" : "")}>
      <span className="w-7 shrink-0 text-right font-mono text-xs text-kumo-subtle">#{index}</span>
      <span className={cn("min-w-0 flex-1 text-sm", broke && "font-medium text-kumo-danger")}>{text}</span>
      {fault && <span className="text-xs font-medium text-kumo-warning">fault</span>}
      {broke && <span className="font-mono text-xs font-medium text-kumo-danger">{broke} breaks</span>}
    </div>
  );
}

export function Moments({ run, at }: { run: RunSource; at: At[] }) {
  const recorded = useRun(run);
  const indexes = at.map((a) => moment(recorded, a).index);
  return (
    <div className="flex flex-col gap-0.5 px-3 py-3">
      {at.map((a, i) => (
        <Fragment key={i}>
          {i > 0 && indexes[i]! > indexes[i - 1]! + 1 && <span className="pl-[3.25rem] text-xs text-kumo-subtle">⋮</span>}
          <Moment run={run} at={a} />
        </Fragment>
      ))}
    </div>
  );
}

/** What the page hands explainer modules, checked against what src/explain declares. */
export const EXPLAIN_KIT = { useRun, moment, Still, Actor, Message, Diagram, Moment, Moments, Stats, Stat, Columns, Bars, Share, Ranges, Scale, Anatomy, Blocks, Source, Caption, compact } satisfies Record<Exclude<keyof typeof Declared, "Tone" | "Block" | "Edge">, unknown>;
