// Flows: every scenario's trace drawn as a sequence diagram, one lifeline per instance,
// arrows from each send to its delivery. With a base commit, steps are marked as changed,
// new, or gone. Clicking a step shows what it did and its code.
import { Badge, Button, cn, Switch } from "@cloudflare/kumo";
import { PlayIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { diffRuns, runScenario, type Event, type Run, type RunDiff, type ScenarioInfo, type StepStatus, type World } from "../spec/index.ts";
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

export function Flows({ selected, onSelect, onOpen }: { selected: string | null; onSelect: (name: string) => void; onOpen: (flow: FlowRun) => void }) {
  const { spec, bundle } = useExplorer();
  const flows = useFlows();
  const flow = flows.find((f) => f.scenario.name === selected) ?? flows[0];
  const [compare, setCompare] = useState(true);
  const [step, setStep] = useState<number | null>(null);
  if (!flow) {
    return <p className="p-8 text-sm text-kumo-subtle">This spec has no scenarios yet. Add one with spec.defineScenario.</p>;
  }
  const showDiff = compare && flow.diff !== null;
  const rows: Row[] = showDiff
    ? flow.diff!.steps.map((s) => ({ status: s.status, event: (s.head ?? s.base)!, compare: s.status === "changed" ? s.base : undefined, world: worldAfter(s.head ? flow.run : flow.base!, (s.head ?? s.base)!) }))
    : flow.run.events.map((e) => ({ status: "same" as StepStatus, event: e, world: worldAfter(flow.run, e) }));
  const chosen = step !== null ? rows[step] : null;
  return (
    <div className="flex h-full min-h-0">
      <nav className="w-64 shrink-0 overflow-y-auto border-r border-kumo-hairline bg-kumo-base py-2">
        {flows.map((f) => (
          <button
            key={f.scenario.name}
            type="button"
            onClick={() => (onSelect(f.scenario.name), setStep(null))}
            className={cn("flex w-full flex-col gap-0.5 border-l-2 border-transparent px-4 py-2 text-left hover:bg-kumo-tint", f === flow && "border-kumo-brand bg-kumo-tint")}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="min-w-0 flex-1 truncate">{f.scenario.name}</span>
              {STATUS_BADGE[f.status]}
            </span>
            <span className="text-xs text-kumo-subtle">{f.run.events.length} steps</span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-4 border-b border-kumo-hairline bg-kumo-base px-6 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{flow.scenario.name}</h1>
            {flow.scenario.description && <p className="max-w-3xl text-sm text-kumo-subtle">{flow.scenario.description}</p>}
            {flow.run.error && <p className="mt-1 text-sm text-kumo-danger">The scenario stopped: {flow.run.error}</p>}
          </div>
          {flow.diff && bundle.base && <Switch size="sm" label={`Compare with ${bundle.base.ref}`} checked={compare} onCheckedChange={setCompare} />}
          <Button size="sm" icon={<PlayIcon />} onClick={() => onOpen(flow)}>
            Open in playground
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <Sequence rows={rows} run={flow.run} chosen={step} onChoose={setStep} />
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
  compare?: Event;
  world: World;
}

function worldAfter(run: Run, event: Event): World {
  const i = run.events.indexOf(event);
  return i >= 0 ? run.worlds[i] : run.initial;
}

const ROW = 46;
const COL = 168;
const LEFT = 88;

function Sequence({ rows, run, chosen, onChoose }: { rows: Row[]; run: Run; chosen: number | null; onChoose: (i: number) => void }) {
  const { spec } = useExplorer();
  // Lifelines in order of appearance, starting with those present from the start.
  const lanes: { id: string; label: string }[] = [];
  const addLane = (id: string, world: World) => !lanes.some((l) => l.id === id) && lanes.push({ id, label: labelOf(world, id) });
  run.initial.instances.forEach((i) => addLane(i.id, run.initial));
  rows.forEach((r) => addLane(r.event.instance, r.world));
  const x = (id: string) => LEFT + lanes.findIndex((l) => l.id === id) * COL + COL / 2;
  const y = (i: number) => 56 + i * ROW + ROW / 2;
  const width = LEFT + lanes.length * COL + 280;
  const height = 56 + rows.length * ROW + 24;
  const arrows = messageArrows(rows);
  return (
    <div className="relative" style={{ width, height }}>
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
            <span className="absolute left-3 w-16 text-right font-mono text-[10.5px] text-kumo-subtle">{ordinal(e.index + 1)}</span>
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
      const j = rows.findIndex((r, k) => k > i && !used.has(k) && (r.event.kind === "deliver" || r.event.kind === "lose") && r.event.instance === sent.to && (r.event.message ?? r.event.key) === sent.message && r.event.from === rows[i].event.instance);
      if (j < 0) continue;
      used.add(j);
      arrows.push({ from: rows[i].event.instance, to: sent.to, sentAt: i, at: j, lost: rows[j].event.kind === "lose" });
    }
  }
  return arrows;
}
