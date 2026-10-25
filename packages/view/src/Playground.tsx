// The playground: the spec's world drawn as a topology you play with. Click a node to see
// what it can do; messages in flight sit on the wires and can be delivered or lost; the
// timeline on the right is the event log, where hovering previews and clicking rolls back.
import { Badge, Button, cn, Input, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, FastForwardIcon, LightningIcon, PlayIcon, PlusIcon, TimerIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { worldView, type ActionInfo, type Pending, type Spec, type World } from "@feynman/spec";
import { short, messageName, time, labelOf } from "./format";
import { along, edgeKey, GHOST_H, layout, layoutKey, pathOf, type Layout } from "./layout";
import { apply, current, nextHint, nextLabel, settle, type Hint, type Op, type Session } from "./session";
import { Timeline } from "./Timeline";
import { Sources, StateTree, useExplorer } from "./ui";

export function Playground({ session, setSession, scenarios }: { session: Session; setSession: (s: Session) => void; scenarios: ReactNodeMenu }) {
  const { spec } = useExplorer();
  const [preview, setPreview] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const live = current(session);
  const world = preview === null ? live : preview < 0 ? session.initial : session.steps[preview].world;
  const focus = preview === null ? session.steps.at(-1)?.event : preview >= 0 ? session.steps[preview].event : null;
  const run = (op: Op) => {
    setPreview(null);
    setSession(apply(spec, session, op));
  };
  const hint = nextHint(spec, live);
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1 overflow-hidden bg-kumo-canvas">
        <Canvas world={world} live={preview === null} focus={focus ?? null} hint={hint} selected={selected} onSelect={setSelected} onRun={run} />
        {selected && preview === null && (
          <NodePanel key={selected} id={selected} world={live} onClose={() => setSelected(null)} onRun={run} onSpawned={(id) => setSelected(id)} />
        )}
        <HintBar hint={hint} world={live} previewing={preview !== null} onRun={run} onSettle={() => setSession(settle(spec, session))} onSelect={setSelected} />
      </div>
      <Timeline session={session} preview={preview} onPreview={setPreview} onRollback={(n) => (setPreview(null), setSession({ ...session, steps: session.steps.slice(0, n), ops: session.ops?.slice(0, n) ?? null }))} scenarios={scenarios} />
    </div>
  );
}

/** The scenario menu the timeline shows: where a session can start from. */
export interface ReactNodeMenu {
  items: { value: string; label: string }[];
  onPick: (value: string) => void;
}

// Canvas ---------------------------------------------------------------------------------------------

function useLayout(spec: Spec, world: World): Layout | null {
  const key = layoutKey(spec, world);
  const [state, setState] = useState<{ key: string; layout: Layout } | null>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  useEffect(() => {
    let live = true;
    layout(spec, worldRef.current).then((l) => live && setState({ key, layout: l }));
    return () => {
      live = false;
    };
  }, [key, spec]);
  return state?.layout ?? null;
}

/** Scale the drawing to fit its box, centred; never above 1.25. */
function useFit(width: number, height: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const margin = 48;
  const bottom = 96;
  const scale = width && height && box.w ? Math.min(1.25, (box.w - margin * 2) / width, (box.h - margin - bottom) / height) : 1;
  const x = (box.w - width * scale) / 2;
  const y = margin + Math.max(0, (box.h - margin - bottom - height * scale) / 2);
  return { ref, scale, x, y };
}

function Canvas({
  world,
  live,
  focus,
  hint,
  selected,
  onSelect,
  onRun,
}: {
  world: World;
  live: boolean;
  focus: import("@feynman/spec").Event | null;
  hint: Hint;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRun: (op: Op) => void;
}) {
  const { spec } = useExplorer();
  const graph = useLayout(spec, world);
  const fit = useFit(graph?.width ?? 0, graph?.height ?? 0);
  const changed = new Map<string, Set<string>>();
  for (const c of focus?.changes ?? []) changed.set(c.instance, new Set([...(changed.get(c.instance) ?? []), c.path]));
  const pulse = hint.kind === "spawn" ? `+${hint.actor}` : hint.kind === "act" ? hint.instance : null;
  return (
    <div ref={fit.ref} className="absolute inset-0" onClick={() => onSelect(null)}>
      {graph && (
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`, width: graph.width, height: graph.height }}>
          <svg width={graph.width} height={graph.height} className="absolute inset-0 overflow-visible">
            {graph.zones.map((z) => (
              <g key={z.name}>
                <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={14} fill="var(--color-kumo-base)" stroke="var(--color-kumo-hairline)" strokeWidth={1} />
                <text x={z.x + 16} y={z.y + 25} fill="currentColor" className="text-[12px] font-medium text-kumo-subtle">
                  {z.name}
                </text>
              </g>
            ))}
            {[...graph.edges].map(([key, points]) => {
              const hot = focus && focus.sent.some((s) => edgeKey(focus.instance, s.to) === key);
              return <path key={key} d={pathOf(points)} fill="none" stroke={hot ? "var(--color-kumo-brand)" : "var(--color-kumo-line)"} strokeWidth={hot ? 2 : 1.25} />;
            })}
          </svg>
          {world.instances.map((instance) => {
            const box = graph.nodes.get(instance.id);
            if (!box) return null;
            return (
              <InstanceNode
                key={instance.id}
                box={box}
                world={world}
                id={instance.id}
                changed={changed.get(instance.id)}
                focused={focus?.instance === instance.id}
                selected={selected === instance.id}
                pulse={live && pulse === instance.id}
                onSelect={onSelect}
                onRun={onRun}
                live={live}
              />
            );
          })}
          {spec.actors
            .filter((a) => !a.singleton)
            .map((actor) => {
              const box = graph.nodes.get(`+${actor.name}`);
              if (!box || !live) return null;
              return (
                <button
                  key={actor.name}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const label = nextLabel(world, actor.name);
                    onRun({ op: "spawn", actor: actor.name, label });
                  }}
                  className={cn(
                    "absolute flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-kumo-line text-xs text-kumo-subtle hover:border-kumo-brand hover:text-kumo-default",
                    pulse === `+${actor.name}` && "feynman-pulse border-kumo-brand text-kumo-default",
                  )}
                  style={{ left: box.x, top: box.y, width: box.w, height: GHOST_H }}
                >
                  <PlusIcon size={14} /> Add a {actor.name}
                </button>
              );
            })}
          {world.pending.map((p) => (p.kind === "deliver" ? <MessageChip key={p.id} pending={p} world={world} graph={graph} next={hint.kind === "pending" && hint.pending.id === p.id} live={live} onRun={onRun} /> : null))}
        </div>
      )}
    </div>
  );
}

function InstanceNode({
  box,
  world,
  id,
  changed,
  focused,
  selected,
  pulse,
  live,
  onSelect,
  onRun,
}: {
  box: { x: number; y: number; w: number; h: number };
  world: World;
  id: string;
  changed?: Set<string>;
  focused: boolean;
  selected: boolean;
  pulse: boolean;
  live: boolean;
  onSelect: (id: string) => void;
  onRun: (op: Op) => void;
}) {
  const { spec } = useExplorer();
  const instance = world.instances.find((i) => i.id === id)!;
  const fields = instance.state && typeof instance.state === "object" ? Object.entries(instance.state as Record<string, unknown>) : [];
  const timers = world.pending.filter((p): p is Extract<Pending, { kind: "timer" }> => p.kind === "timer" && p.to === id);
  const actions = Object.values(spec.actors.find((a) => a.name === instance.actor)!.actions).filter((a) => !a.when || safe(() => a.when!(instance.state)));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onKeyDown={(e) => e.key === "Enter" && onSelect(id)}
      className={cn(
        "absolute flex cursor-pointer flex-col gap-1 overflow-hidden rounded-xl bg-kumo-elevated px-3 py-2 text-left shadow-sm ring-1 ring-kumo-line transition-shadow hover:ring-kumo-brand",
        selected && "ring-2 ring-kumo-brand",
        focused && !selected && "ring-2 ring-kumo-warning",
        pulse && "feynman-pulse",
      )}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium">{instance.label}</span>
        {instance.label !== instance.actor && <span className="truncate text-[11px] text-kumo-subtle">{instance.actor}</span>}
        {actions.length > 0 && live && (
          <span className="ml-auto flex items-center gap-0.5 text-[11px] text-kumo-subtle" title={`${actions.length} thing(s) to do`}>
            <LightningIcon size={12} />
            {actions.length}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden">
        {fields.slice(0, 4).map(([key, value]) => {
          const hot = changed && [...changed].some((c) => c === key || c.startsWith(`${key}.`) || c.startsWith(`${key}[`) || c === "");
          return (
            <div key={key} className={cn("truncate rounded px-1 font-mono text-[10.5px]", hot && "bg-kumo-warning/20")}>
              <span className="text-kumo-subtle">{key}</span> {summary(value)}
            </div>
          );
        })}
      </div>
      {timers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {timers.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={!live}
              onClick={(e) => {
                e.stopPropagation();
                onRun({ op: "fire", pending: t.id });
              }}
              className="flex items-center gap-1 rounded-full bg-kumo-recessed px-1.5 py-px font-mono text-[10px] text-kumo-subtle hover:text-kumo-default"
              title="Skip ahead to when this timer fires"
            >
              <TimerIcon size={10} /> {t.timer} {time(Math.max(0, t.at - world.clock))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A state field in a few characters: counts for collections, values otherwise. */
function summary(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `[${value.length}] ${short(value.at(-1), 18)}` : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    if (entries.every(([, v]) => v === null || typeof v !== "object")) return entries.map(([k, v]) => `${k}=${short(v, 12)}`).join(" ");
    return `{${entries.length}}`;
  }
  return short(value, 28);
}

function MessageChip({ pending, world, graph, next, live, onRun }: { pending: Extract<Pending, { kind: "deliver" }>; world: World; graph: Layout; next: boolean; live: boolean; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  const [open, setOpen] = useState(false);
  const points = graph.edges.get(edgeKey(pending.from, pending.to));
  const from = graph.nodes.get(pending.from);
  const to = graph.nodes.get(pending.to);
  if (!from || !to) return null;
  // Edges run left to right; a message's progress runs from its sender.
  const latency = spec.messages[pending.message]?.latency ?? spec.latency;
  const progress = Math.min(0.8, Math.max(0.2, 1 - (pending.at - world.clock) / Math.max(1, latency)));
  const route = points ?? [center(from), center(to)];
  const forward = dist(route[0], center(from)) <= dist(route[0], center(to));
  const at = along(route, forward ? progress : 1 - progress);
  const stack = world.pending.filter((p) => p.kind === "deliver" && edgeKey(p.from, p.to) === edgeKey(pending.from, pending.to));
  const offset = stack.findIndex((p) => p.id === pending.id) * 26 - ((stack.length - 1) * 26) / 2;
  const tone = spec.messages[pending.message]?.tone ?? "request";
  const rightward = center(from).x <= center(to).x;
  return (
    <div className="absolute" style={{ left: at.x, top: at.y + offset, transform: "translate(-50%, -50%)" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={!live}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium shadow-sm ring-1",
          tone === "refused" ? "bg-kumo-danger/10 text-kumo-danger ring-kumo-danger/40" : tone === "reply" ? "bg-kumo-success/10 text-kumo-success ring-kumo-success/40" : "bg-kumo-info/10 text-kumo-info ring-kumo-info/40",
          next && live && "feynman-pulse",
        )}
        title={`${messageName(spec, pending.message)} from ${labelOf(world, pending.from)} to ${labelOf(world, pending.to)}, due at ${time(pending.at)}`}
      >
        {!rightward && "← "}
        {messageName(spec, pending.message)}
        {rightward && " →"}
      </button>
      {open && live && (
        <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 flex-col gap-1 rounded-lg bg-kumo-elevated p-1.5 shadow-lg ring-1 ring-kumo-line">
          <p className="max-w-64 px-1 font-mono text-[10.5px] text-kumo-subtle">{short(pending.payload, 80)}</p>
          <div className="flex gap-1">
            <Button size="xs" variant="primary" icon={<PlayIcon />} onClick={() => onRun({ op: "fire", pending: pending.id })}>
              Deliver
            </Button>
            <Button size="xs" variant="secondary-destructive" icon={<XIcon />} onClick={() => onRun({ op: "lose", pending: pending.id })}>
              Lose it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

// What to do next ------------------------------------------------------------------------------------

function HintBar({ hint, world, previewing, onRun, onSettle, onSelect }: { hint: Hint; world: World; previewing: boolean; onRun: (op: Op) => void; onSettle: () => void; onSelect: (id: string) => void }) {
  const { spec } = useExplorer();
  if (previewing) {
    return (
      <Bar>
        <span className="text-xs text-kumo-subtle">Looking back. Click the event in the timeline to go back to it, or move away to return.</span>
      </Bar>
    );
  }
  let main = null;
  if (hint.kind === "pending") {
    const p = hint.pending;
    const text = p.kind === "deliver" ? `Deliver ${messageName(spec, p.message)} to ${labelOf(world, p.to)}` : `${labelOf(world, p.to)}: ${p.timer} fires${p.at > world.clock ? ` in ${time(p.at - world.clock)}` : ""}`;
    main = (
      <Button variant="primary" size="sm" icon={<PlayIcon />} onClick={() => onRun({ op: "fire", pending: p.id })}>
        {text}
      </Button>
    );
  } else if (hint.kind === "guard") {
    main = (
      <Button variant="primary" size="sm" icon={<PlayIcon />} onClick={() => onRun({ op: "guard", instance: hint.instance, key: hint.key })}>
        {labelOf(world, hint.instance)}: {hint.key}
      </Button>
    );
  } else if (hint.kind === "spawn") {
    main = (
      <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={() => onRun({ op: "spawn", actor: hint.actor, label: nextLabel(world, hint.actor) })}>
        Add a {hint.actor}
      </Button>
    );
  } else if (hint.kind === "act") {
    const instance = world.instances.find((i) => i.id === hint.instance)!;
    const action = spec.actors.find((a) => a.name === instance.actor)!.actions[hint.key];
    main = (
      <span className="text-xs text-kumo-subtle">
        Nothing is due. Try something: click{" "}
        <button type="button" className="font-medium text-kumo-link hover:underline" onClick={() => onSelect(hint.instance)}>
          {instance.label}
        </button>{" "}
        to {action.label.toLowerCase()}, or any other node.
      </span>
    );
  } else {
    main = <span className="text-xs text-kumo-subtle">Nothing is due and nobody can act.</span>;
  }
  const busy = hint.kind === "pending" || hint.kind === "guard";
  return (
    <Bar>
      {main}
      {busy && (
        <Button variant="ghost" size="sm" icon={<FastForwardIcon />} onClick={onSettle}>
          Run until quiet
        </Button>
      )}
      <span className="font-mono text-[11px] text-kumo-subtle">{time(world.clock)}</span>
    </Bar>
  );
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-kumo-elevated px-2 py-1.5 shadow-lg ring-1 ring-kumo-line">{children}</div>
    </div>
  );
}

// The node panel -------------------------------------------------------------------------------------

function NodePanel({ id, world, onClose, onRun }: { id: string; world: World; onClose: () => void; onRun: (op: Op) => void; onSpawned: (id: string) => void }) {
  const { spec } = useExplorer();
  const instance = world.instances.find((i) => i.id === id);
  if (!instance) return null;
  const actor = spec.actors.find((a) => a.name === instance.actor)!;
  const actions = Object.values(actor.actions);
  const handles = Object.values(actor.transitions);
  return (
    <aside className="absolute left-4 top-4 bottom-20 flex w-[22rem] flex-col overflow-hidden rounded-xl bg-kumo-elevated shadow-lg ring-1 ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-2 border-b border-kumo-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{instance.label}</p>
          <p className="text-xs text-kumo-subtle">{actor.description ?? `${actor.name}, in ${actor.zone}`}</p>
        </div>
        <Button variant="ghost" size="xs" shape="square" aria-label="Close" onClick={onClose} icon={<XIcon />} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {actions.length > 0 && (
          <div className="flex flex-col gap-2">
            {actions.map((action) => (
              <ActionForm key={action.key} action={action} world={world} instance={instance.id} onRun={onRun} />
            ))}
          </div>
        )}
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">State</p>
          <StateTree value={instance.state} />
        </div>
        {handles.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">What it does on its own</p>
            <div className="flex flex-col gap-2">
              {handles.map((t) => (
                <div key={t.key} className="flex flex-col gap-1">
                  <p className="text-xs">
                    <span className="font-medium">{t.message ? `On ${messageName(spec, t.message)}` : t.key}</span> <span className="text-kumo-subtle">{t.description}</span>
                  </p>
                  <Sources sources={t.sources} />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="border-t border-kumo-hairline pt-3">
          <Button size="xs" variant="secondary-destructive" icon={<ArrowCounterClockwiseIcon />} onClick={() => onRun({ op: "restart", instance: instance.id })}>
            Restart {instance.label}
          </Button>
          <p className="mt-1 text-[11px] text-kumo-subtle">
            A crash: {actor.durable.length ? `only ${actor.durable.join(", ")} survive${actor.durable.length === 1 ? "s" : ""}` : "its state starts over"}, and its timers stop.
          </p>
        </div>
      </div>
    </aside>
  );
}

function ActionForm({ action, world, instance, onRun }: { action: ActionInfo; world: World; instance: string; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  const state = world.instances.find((i) => i.id === instance)!.state;
  const enabled = !action.when || safe(() => action.when!(state));
  const examples = useMemo(() => {
    const view = worldView(spec, world);
    return Object.fromEntries(
      Object.entries(action.inputs).map(([name, input]) => {
        let values: unknown[] = [];
        try {
          values = input.examples ? input.examples(view as never) : input.type === "choice" ? (input.values ?? []) : input.type === "boolean" ? [true, false] : [];
        } catch {
          values = [];
        }
        return [name, [...new Set(values.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as unknown)];
      }),
    );
  }, [spec, world, action]);
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(action.inputs).map(([name, input]) => [name, String(examples[name]?.[0] ?? (input.type === "number" ? 0 : ""))])),
  );
  const parse = (name: string, raw: string): unknown => {
    const type = action.inputs[name].type;
    return type === "number" ? Number(raw) : type === "boolean" ? raw === "true" : raw;
  };
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg px-3 py-2 ring-1 ring-kumo-hairline", !enabled && "opacity-60")}>
      <div>
        <p className="text-sm font-medium">{action.label}</p>
        <p className="text-xs text-kumo-subtle">{action.description}</p>
      </div>
      {Object.entries(action.inputs).map(([name, input]) =>
        examples[name]?.length ? (
          <Select key={name} size="sm" label={name} hideLabel={false} value={inputs[name]} onValueChange={(v) => setInputs({ ...inputs, [name]: String(v) })}>
            {examples[name].map((v) => (
              <Select.Option key={String(v)} value={String(v)}>
                {String(v)}
              </Select.Option>
            ))}
          </Select>
        ) : (
          <Input key={name} size="sm" label={name} type={input.type === "number" ? "number" : "text"} value={inputs[name]} onChange={(e) => setInputs({ ...inputs, [name]: e.target.value })} />
        ),
      )}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="primary"
          disabled={!enabled}
          icon={<PlayIcon />}
          onClick={() => onRun({ op: "act", instance, key: action.key, inputs: Object.fromEntries(Object.keys(action.inputs).map((n) => [n, parse(n, inputs[n])])) })}
        >
          {action.label}
        </Button>
        {!enabled && <Badge variant="neutral">not now</Badge>}
      </div>
    </div>
  );
}
