// Flows: a tree of specs, their scenarios, and each scenario's flows (what each thing someone
// did set off, spec/flows.ts), beside the chosen scenario or flow drawn as a sequence diagram:
// one lifeline per instance, arrows from each send to its delivery. With a base commit, steps
// are marked as changed, new, or gone. Clicking a step shows what it did and its code.
import { Badge, Button, cn, Switch } from "@cloudflare/kumo";
import { CaretRightIcon, PlayIcon } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { diffRuns, flowsOf, runScenario, type Event, type Flow, type Run, type RunDiff, type ScenarioInfo, type Spec, type StepStatus, type World } from "../spec/index.ts";
import { labelOf, ordinal, stepTitle } from "./format";
import { EventDetail, useExplorer } from "./ui";

export interface FlowRun {
  scenario: ScenarioInfo;
  run: Run & { error?: string };
  base: (Run & { error?: string }) | null;
  diff: RunDiff | null;
  /** "added" when the scenario did not exist at the base commit. */
  status: "same" | "changed" | "added" | "error";
}

export function useFlows(): FlowRun[] {
  const { spec, loaded } = useExplorer();
  return useMemo(
    () =>
      spec.scenarios.map((scenario): FlowRun => {
        const run = runScenario(spec, scenario);
        const before = loaded.base?.scenarios.find((s) => s.name === scenario.name);
        const base = before && loaded.base ? runScenario(loaded.base, before) : null;
        const diff = base ? diffRuns(base, run) : null;
        const broken = run.error || run.events.some((e) => e.error || e.violations.length);
        return { scenario, run, base, diff, status: broken ? "error" : !loaded.base ? "same" : !base ? "added" : diff!.status };
      }),
    [spec, loaded.base],
  );
}

const STATUS_BADGE = {
  same: null,
  changed: <Badge variant="warning">changed</Badge>,
  added: <Badge variant="success">new</Badge>,
  error: <Badge variant="error">broken</Badge>,
};

/** A spec in the tree: its id and name. Only the open spec's scenarios are run and listed. */
export interface SpecNode {
  id: string;
  name: string;
}

/** What the flows page shows: a scenario, and maybe one of its flows (1-based). */
export interface FlowSelection {
  scenario: string | null;
  flow: number | null;
}

/** A route item as the flows page writes it: "scenario", or "scenario/2" for its second flow. */
export function parseSelection(item: string | null): FlowSelection {
  if (!item) return { scenario: null, flow: null };
  const match = /^(.*)\/(\d+)$/.exec(item);
  return match ? { scenario: match[1], flow: Number(match[2]) } : { scenario: item, flow: null };
}

export function selectionItem(s: FlowSelection): string | null {
  return s.scenario === null ? null : s.flow === null ? s.scenario : `${s.scenario}/${s.flow}`;
}

/** A flow's name, from the event that started it: "Alice · Pair a host", "Studio daemon restarts". */
export function flowTitle(spec: Spec, run: Run, flow: Flow): string {
  const first = run.events[flow.start];
  const world = run.worlds[flow.start];
  if (flow.kind === "spawn") return `${flow.events.map((i) => labelOf(run.worlds[i], run.events[i].instance)).join(", ")} appear`;
  if (flow.kind === "restart") return `${labelOf(world, first.instance)} restarts`;
  return `${labelOf(world, first.instance)} · ${stepTitle(spec, first)}`;
}

export function Flows({ tree, selection, onSelect, onOpen }: { tree: SpecNode[]; selection: FlowSelection; onSelect: (spec: string, selection: FlowSelection) => void; onOpen: (flow: FlowRun) => void }) {
  const { spec, bundle, loaded, playground } = useExplorer();
  const flows = useFlows();
  const flow = flows.find((f) => f.scenario.name === selection.scenario) ?? flows[0];
  const parts = useMemo(() => (flow ? flowsOf(flow.run) : []), [flow]);
  const part = flow && selection.flow !== null && selection.scenario === flow.scenario.name ? parts[selection.flow - 1] : undefined;
  const [compare, setCompare] = useState(true);
  const [step, setStep] = useState<number | null>(null);
  const select = (specId: string, next: FlowSelection) => (onSelect(specId, next), setStep(null));
  const nav = <FlowTree tree={tree} current={loaded.entry.id} flows={flows} open={flow?.scenario.name ?? null} parts={parts} part={part ? selection.flow : null} onSelect={select} />;
  if (!flow) {
    return (
      <div className="flex h-full min-h-0">
        {nav}
        <div className="flex min-w-0 flex-1 items-center justify-center bg-kumo-canvas p-6">
          <div className="max-w-md rounded-xl bg-kumo-base p-8 ring-1 ring-kumo-hairline">
            <h1 className="text-base font-semibold">No flows yet</h1>
            <p className="mt-1 text-sm text-kumo-subtle">Add a scenario with <code>spec.defineScenario</code> to show how events move through this system.</p>
          </div>
        </div>
      </div>
    );
  }
  const showDiff = compare && flow.diff !== null;
  const inPart = (e: Event | undefined) => !part || (e !== undefined && part.events.includes(flow.run.events.indexOf(e)));
  const rows: Row[] = (
    showDiff
      ? flow.diff!.steps.map((s) => ({ status: s.status, event: (s.head ?? s.base)!, head: s.head, position: positionIn(s.head ? flow.run : flow.base!, (s.head ?? s.base)!), compare: s.status === "changed" ? s.base : undefined, world: worldAfter(s.head ? flow.run : flow.base!, (s.head ?? s.base)!) }))
      : flow.run.events.map((e, i) => ({ status: "same" as StepStatus, event: e, head: e, position: i + 1, world: worldAfter(flow.run, e) }))
  ).filter((r) => inPart(r.head));
  const chosen = step !== null ? rows[step] : null;
  return (
    <div className="flex h-full min-h-0">
      {nav}
      <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
        <div className="flex items-start gap-4 border-b border-kumo-hairline bg-kumo-base px-5 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{part ? flowTitle(spec, flow.run, part) : flow.scenario.name}</h1>
            {part ? (
              <p className="max-w-3xl text-sm text-kumo-subtle">
                {part.events.length} events of “{flow.scenario.name}”: what it set off.
              </p>
            ) : (
              flow.scenario.description && <p className="max-w-3xl text-sm text-kumo-subtle">{flow.scenario.description}</p>
            )}
            {flow.run.error && <p className="mt-1 text-sm text-kumo-danger">The scenario stopped: {flow.run.error}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="neutral">{rows.length} events</Badge>
              <Badge variant="neutral">{new Set(rows.map((row) => row.event.actor)).size} participants</Badge>
            </div>
          </div>
          {flow.diff && bundle.base && <Switch size="sm" label={`Compare with ${bundle.base.ref}`} checked={compare} onCheckedChange={setCompare} />}
          <Button size="sm" icon={<PlayIcon />} onClick={() => onOpen(flow)}>
            Open in playground
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
          {rows.length ? (
            <Sequence rows={rows} run={flow.run} actorOrder={playground?.flowOrder[flow.scenario.name] ?? []} chosen={step} onChoose={setStep} />
          ) : (
            <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center rounded-xl bg-kumo-base p-8 text-center ring-1 ring-kumo-hairline">
              <h2 className="text-sm font-semibold">No events in this flow</h2>
              <p className="mt-1 text-sm text-kumo-subtle">Choose a scenario or flow from the list to see its sequence.</p>
            </div>
          )}
        </div>
      </div>
      {chosen && (
        <aside className="w-[24rem] shrink-0 overflow-y-auto border-l border-kumo-hairline bg-kumo-base px-4 py-4">
          {chosen.status !== "same" && (
            <p className="mb-3 text-xs text-kumo-subtle">
              {chosen.status === "added" ? "New: this step did not happen at the base commit." : chosen.status === "removed" ? "Gone: this step happened at the base commit but no longer does." : "Changed: the same step does something different now."}
            </p>
          )}
          <EventDetail event={chosen.event} world={chosen.world} compare={chosen.compare} />
        </aside>
      )}
      {!spec.scenarios.length && null}
    </div>
  );
}

interface Row {
  status: StepStatus;
  event: Event;
  /** The event as it happens now; absent for a step that no longer happens. */
  head?: Event;
  /** Its place in its scenario's run, from 1. */
  position: number;
  compare?: Event;
  world: World;
}

/** The tree: specs, then the open spec's scenarios, then the open scenario's flows. */
function FlowTree({
  tree,
  current,
  flows,
  open,
  parts,
  part,
  onSelect,
}: {
  tree: SpecNode[];
  current: string;
  flows: FlowRun[];
  open: string | null;
  parts: Flow[];
  part: number | null;
  onSelect: (spec: string, selection: FlowSelection) => void;
}) {
  const { spec } = useExplorer();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setClosed((c) => (c.has(key) ? new Set([...c].filter((k) => k !== key)) : new Set([...c, key])));
  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-kumo-hairline bg-kumo-base p-2" aria-label="Specs, scenarios and flows">
      {tree.map((node) => {
        const isCurrent = node.id === current;
        const specOpen = isCurrent && !closed.has(node.id);
        return (
          <div key={node.id}>
            <TreeRow depth={0} open={specOpen} active={isCurrent && open === null} onClick={() => (isCurrent ? toggle(node.id) : onSelect(node.id, { scenario: null, flow: null }))}>
              <span className="truncate font-medium">{node.name}</span>
            </TreeRow>
            {specOpen &&
              flows.map((f) => {
                const scenarioOpen = f.scenario.name === open && !closed.has(`${node.id}/${f.scenario.name}`);
                return (
                  <div key={f.scenario.name}>
                    <TreeRow
                      depth={1}
                      open={scenarioOpen}
                      active={f.scenario.name === open && part === null}
                      onClick={() => (f.scenario.name === open && part === null ? toggle(`${node.id}/${f.scenario.name}`) : onSelect(node.id, { scenario: f.scenario.name, flow: null }))}
                    >
                      <span className="min-w-0 flex-1 truncate">{f.scenario.name}</span>
                      {STATUS_BADGE[f.status]}
                    </TreeRow>
                    {scenarioOpen &&
                      parts.map((p, i) => (
                        <TreeRow key={i} depth={2} active={part === i + 1} onClick={() => onSelect(node.id, { scenario: f.scenario.name, flow: i + 1 })}>
                          <span className="min-w-0 flex-1 truncate">{flowTitle(spec, f.run, p)}</span>
                          <span className="shrink-0 text-xs tabular-nums text-kumo-subtle">{p.events.length}</span>
                        </TreeRow>
                      ))}
                  </div>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}

/** One row of the tree: indented by depth, with a caret when it has children (open is set). */
function TreeRow({ depth, open, active, onClick, children }: { depth: number; open?: boolean; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={cn("flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-kumo-tint", active && "bg-kumo-tint")}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {open === undefined ? <span className="w-3.5 shrink-0" /> : <CaretRightIcon size={14} className={cn("shrink-0 text-kumo-subtle", open && "rotate-90")} />}
      {children}
    </button>
  );
}

function positionIn(run: Run, event: Event): number {
  return run.events.indexOf(event) + 1;
}

function worldAfter(run: Run, event: Event): World {
  const i = run.events.indexOf(event);
  return i >= 0 ? run.worlds[i] : run.initial;
}

const ROW = 46;
const COL = 196;
const LEFT = 76;

function Sequence({ rows, run, actorOrder, chosen, onChoose }: { rows: Row[]; run: Run; actorOrder: string[]; chosen: number | null; onChoose: (i: number) => void }) {
  const { spec } = useExplorer();
  // A lifeline for each instance the rows involve: those present from the start first, in
  // their order, then the rest as they appear.
  const lanes: { id: string; label: string; actor: string; appearance: number }[] = [];
  const addLane = (id: string, world: World) => {
    if (lanes.some((lane) => lane.id === id)) return;
    const instance = world.instances.find((item) => item.id === id);
    lanes.push({ id, label: labelOf(world, id), actor: instance?.actor ?? id, appearance: lanes.length });
  };
  const involved = new Set(rows.map((r) => r.event.instance));
  run.initial.instances.filter((i) => involved.has(i.id)).forEach((i) => addLane(i.id, run.initial));
  rows.forEach((r) => addLane(r.event.instance, r.world));
  const preferredOrder = new Map(actorOrder.map((actor, index) => [actor, index]));
  lanes.sort((a, b) => (preferredOrder.get(a.actor) ?? Infinity) - (preferredOrder.get(b.actor) ?? Infinity) || a.appearance - b.appearance);
  const x = (id: string) => LEFT + lanes.findIndex((l) => l.id === id) * COL + COL / 2;
  const y = (i: number) => 56 + i * ROW + ROW / 2;
  const width = LEFT + lanes.length * COL + 48;
  const height = 56 + rows.length * ROW + 24;
  const arrows = messageArrows(rows);
  return (
    <div className="relative mx-auto" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--text-color-kumo-subtle)" />
          </marker>
        </defs>
        {lanes.map((lane) => (
          <line key={lane.id} x1={x(lane.id)} x2={x(lane.id)} y1={44} y2={height - 8} stroke="var(--color-kumo-hairline)" strokeDasharray="4 4" />
        ))}
        {arrows.map((a, i) => (
          <line
            key={i}
            x1={x(a.from)}
            y1={y(a.sentAt)}
            x2={x(a.to) + (x(a.to) > x(a.from) ? -8 : 8)}
            y2={y(a.at)}
            stroke={a.lost ? "var(--color-kumo-danger)" : "var(--text-color-kumo-subtle)"}
            strokeDasharray={a.lost ? "5 4" : undefined}
            strokeWidth={1.25}
            markerEnd={a.lost ? undefined : "url(#arrow)"}
          />
        ))}
      </svg>
      {lanes.map((lane) => (
        <div key={lane.id} className="absolute top-3 -translate-x-1/2 truncate rounded-md bg-kumo-elevated px-2 py-1 text-center text-xs font-medium ring-1 ring-kumo-line" style={{ left: x(lane.id), maxWidth: COL - 12 }}>
          {lane.label}
        </div>
      ))}
      {rows.map((row, i) => {
        const e = row.event;
        const bad = e.error || e.violations.length;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChoose(i)}
            className={cn("absolute left-0 flex items-center hover:bg-kumo-tint", chosen === i && "bg-kumo-tint", row.status === "removed" && "opacity-60")}
            style={{ top: y(i) - ROW / 2, height: ROW, width }}
          >
            <span className={cn("absolute left-0 top-1 bottom-1 w-1 rounded-r", { same: "", changed: "bg-kumo-warning", added: "bg-kumo-success", removed: "bg-kumo-danger" }[row.status])} />
            <span className="absolute left-3 w-16 text-right font-mono text-[10.5px] text-kumo-subtle">{ordinal(row.position)}</span>
            <span
              className={cn("absolute size-2.5 -translate-x-1/2 rounded-full ring-2 ring-kumo-base", bad ? "bg-kumo-danger" : e.kind === "action" ? "bg-kumo-brand" : e.kind === "lose" || e.kind === "restart" ? "bg-kumo-warning" : "bg-(--text-color-kumo-subtle)")}
              style={{ left: x(e.instance) }}
            />
            <span className={cn("absolute truncate pl-3 text-left text-xs", row.status === "removed" && "line-through")} style={{ left: x(e.instance), maxWidth: 360 }}>
              <span className={cn("font-medium", bad && "text-kumo-danger")}>{stepTitle(spec, e)}</span>
              <span className="text-kumo-subtle"> {e.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Each send, matched to the delivery (or loss) of the same message to the same instance. */
function messageArrows(rows: Row[]): { from: string; to: string; sentAt: number; at: number; lost: boolean }[] {
  const arrows = [];
  const used = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    for (const sent of rows[i].event.sent) {
      // A call's failure is sent by the loss that caused it, but comes from the callee (RFD0009).
      const failure = sent.message.startsWith("failed:");
      const j = rows.findIndex(
        (r, k) =>
          k > i &&
          !used.has(k) &&
          (r.event.kind === "deliver" || r.event.kind === "lose") &&
          r.event.instance === sent.to &&
          (r.event.message ?? r.event.key) === sent.message &&
          (failure || r.event.from === rows[i].event.instance),
      );
      if (j < 0) continue;
      used.add(j);
      arrows.push({ from: failure ? rows[j].event.from ?? rows[i].event.instance : rows[i].event.instance, to: sent.to, sentAt: i, at: j, lost: rows[j].event.kind === "lose" });
    }
  }
  return arrows;
}
