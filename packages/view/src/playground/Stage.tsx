// The stage: the service's zone as a tinted region and the others as captioned columns, one
// node per instance, the live links instances hold, messages travelling between them, and a
// speech bubble for what just happened. Colour follows people: an instance wears its own
// colour, or its owner's, and its links and rows carry it. Rings show how a node is doing
// only when that says something (connected, failing); otherwise they show whose it is.
import { cn } from "@cloudflare/kumo";
import { TicketIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import { appearance, declaresLinks, liveLinks, type Event, type Mood, type Pending, type Row, type Spec, type Token, type World } from "@feynman/spec";
import { labelOf, messageName, short, time } from "../format";
import { actorLinks, along, ICON_W, layout, layoutKey, shapeOf, type Box, type Layout, type View, type ZoneBox } from "../layout";
import { useExplorer } from "../ui";
import { iconFor, identityColors, moodColor, toneColor } from "./look";

export interface Bubble {
  key: string;
  instance: string;
  text: string;
  tone: "action" | "message" | "bad" | "quiet";
}

/** A token being carried, by dragging it or by picking it up: which nodes would take it. */
export interface Dragging {
  from: string;
  token: Token;
  targets: Set<string>;
  /** Picked up with a click or the keyboard, rather than held under the pointer. */
  carried: boolean;
}

/** Wraps a node's icon in its menu: the trigger element and what it shows. */
export type MenuFor = (id: string, trigger: ReactElement, children: ReactNode) => ReactNode;

export interface Fit {
  scale: number;
  x: number;
  y: number;
}

/** The size of the canvas, which the layout fills. */
export function useView() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setView({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, view };
}

export function useLayout(spec: Spec, world: World, view: View): Layout | null {
  const key = layoutKey(spec, world, view);
  const [state, setState] = useState<{ key: string; layout: Layout } | null>(null);
  const latest = useRef({ world, view });
  latest.current = { world, view };
  useEffect(() => {
    if (!latest.current.view.w) return;
    let live = true;
    layout(spec, latest.current.world, latest.current.view).then((l) => live && setState({ key, layout: l }));
    return () => {
      live = false;
    };
  }, [key, spec]);
  return state?.layout ?? null;
}

/** The layout already fills the canvas; scale down only when it could not fit. */
export function fitOf(graph: Layout | null, view: View): Fit {
  if (!graph || !view.w) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(1, view.w / graph.width, view.h / graph.height);
  return { scale, x: (view.w - graph.width * scale) / 2, y: (view.h - graph.height * scale) / 2 };
}

export function Stage({
  world,
  graph,
  fit,
  clock,
  live,
  focus,
  bubble,
  next,
  pulse,
  menu,
  dragging,
  onToken,
  onDrop,
  onPacket,
}: {
  world: World;
  graph: Layout;
  fit: Fit;
  clock: number;
  live: boolean;
  focus: { event: Event; index: number } | null;
  bubble: (Bubble & { fading: boolean }) | null;
  next: number | null;
  pulse: string | null;
  menu: MenuFor;
  dragging: Dragging | null;
  onToken: (from: string, token: Token, e: ReactPointerEvent | null) => void;
  onDrop: (target: string) => void;
  onPacket: (pending: Extract<Pending, { kind: "deliver" }>) => void;
}) {
  const { spec } = useExplorer();
  const links = liveLinks(spec, world);
  const colors = identityColors(spec, world);
  const changed = new Set((focus?.event.changes ?? []).map((c) => c.instance));
  const { ref, rows } = useRowAnchors(fit.scale, `${layoutKey(spec, world, { w: graph.width, h: graph.height })}:${JSON.stringify(world.instances.map((i) => appearance(spec, world, i.id).rows.map((r) => r.label)))}`);
  return (
    <div ref={ref} className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`, width: graph.width, height: graph.height }}>
      <svg width={graph.width} height={graph.height} className="absolute inset-0 overflow-visible" aria-hidden>
        {graph.zones.map((z) => (
          <Zone key={z.name} zone={z} description={spec.zones.find((x) => x.name === z.name)?.description} />
        ))}
        {!declaresLinks(spec) && <Wires spec={spec} world={world} graph={graph} />}
        {links.map((link, i) => {
          const a = graph.nodes.get(link.from);
          const b = graph.nodes.get(link.target);
          if (!a || !b) return null;
          const row = link.row ? rows.get(`${link.target}::${link.row}`) : undefined;
          const q = row ? rowAnchor(row, iconCenter(a)) : rim(iconCenter(b), iconCenter(a));
          const p = rim(iconCenter(a), q);
          const stroke = link.mood && link.mood !== "ok" ? moodColor(link.mood) : (colors.get(link.from) ?? "var(--color-kumo-brand)");
          return (
            <line
              key={i}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={stroke}
              strokeWidth={2}
              strokeDasharray={link.style === "dotted" ? "2 6" : link.style === "solid" ? undefined : "7 7"}
              strokeLinecap="round"
              className={link.style === "solid" ? undefined : "feynman-flow"}
            />
          );
        })}
      </svg>
      {world.instances.map((instance) => {
        const box = graph.nodes.get(instance.id);
        return box ? (
          <Node
            key={instance.id}
            id={instance.id}
            world={world}
            box={box}
            region={graph.zones.some((z) => z.region && z.name === spec.actors.find((a) => a.name === instance.actor)?.zone)}
            flash={live && changed.has(instance.id) ? (focus?.index ?? null) : null}
            pulse={live && !dragging && pulse === instance.id}
            menu={menu}
            colors={colors}
            drop={dragging ? (dragging.targets.has(instance.id) ? "target" : dragging.from === instance.id ? "source" : "other") : null}
            carrying={dragging?.carried ? dragging.token : null}
            onToken={live ? onToken : null}
            onDrop={onDrop}
          />
        ) : null;
      })}
      {world.pending.map((p) =>
        p.kind === "deliver" ? <Packet key={p.id} pending={p} graph={graph} world={world} clock={clock} next={next === p.id} live={live} onClick={() => onPacket(p)} /> : null,
      )}
      {bubble && graph.nodes.get(bubble.instance) && <SpeechBubble key={bubble.key} bubble={bubble} box={graph.nodes.get(bubble.instance)!} />}
    </div>
  );
}

function Zone({ zone, description }: { zone: ZoneBox; description?: string }) {
  if (zone.region) {
    return (
      <g>
        <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={32} fill="var(--color-kumo-warning-tint)" stroke="var(--color-kumo-warning)" strokeOpacity={0.55} strokeDasharray="5 6" />
        <text x={zone.x + zone.w / 2} y={zone.y + zone.h - 18} textAnchor="middle" fill="var(--text-color-kumo-warning)" className="text-[13px] font-medium">
          {zone.name}
          {description ? ` · ${description}` : ""}
        </text>
      </g>
    );
  }
  return (
    <text x={zone.x + zone.w / 2} y={zone.y - 12} textAnchor="middle" fill="var(--text-color-kumo-subtle)" className="text-[11px]">
      <tspan className="font-medium uppercase tracking-wider">{zone.name}</tspan>
      {description && <tspan> · {description}</tspan>}
    </text>
  );
}

/** Without declared links, which actors can talk is drawn faintly, straight between nodes. */
function Wires({ spec, world, graph }: { spec: Spec; world: World; graph: Layout }) {
  const lines: { a: Box; b: Box; key: string }[] = [];
  for (const [x, y] of actorLinks(spec))
    for (const i of world.instances.filter((w) => w.actor === x))
      for (const j of world.instances.filter((w) => w.actor === y)) {
        const a = graph.nodes.get(i.id);
        const b = graph.nodes.get(j.id);
        if (a && b) lines.push({ a, b, key: `${i.id}|${j.id}` });
      }
  return (
    <>
      {lines.map(({ a, b, key }) => {
        const p = rim(iconCenter(a), iconCenter(b));
        const q = rim(iconCenter(b), iconCenter(a));
        return <line key={key} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--color-kumo-line)" strokeWidth={1} />;
      })}
    </>
  );
}

/** The point on the icon circle at `c` facing `towards`. */
function rim(c: { x: number; y: number }, towards: { x: number; y: number }): { x: number; y: number } {
  const d = Math.hypot(towards.x - c.x, towards.y - c.y) || 1;
  return { x: c.x + ((towards.x - c.x) / d) * 38, y: c.y + ((towards.y - c.y) / d) * 38 };
}

function iconCenter(box: Box): { x: number; y: number } {
  return { x: box.x + Math.min(box.w, ICON_W) / 2 + (box.w > ICON_W + 200 ? (box.w - ICON_W) / 2 : 0), y: box.y + 36 };
}

// Nodes -------------------------------------------------------------------------------------------------

type DropState = "target" | "source" | "other" | null;

/** A mood worth a ring: how it is doing says something. "info" and "off" leave the ring to identity. */
const telling = (mood: Mood | null): boolean => mood === "ok" || mood === "bad" || mood === "warn" || mood === "busy";

function Node({
  id,
  world,
  box,
  region,
  flash,
  pulse,
  menu,
  colors,
  drop,
  carrying,
  onToken,
  onDrop,
}: {
  id: string;
  world: World;
  box: Box;
  region: boolean;
  /** The event that just changed this node, to flash it once. */
  flash: number | null;
  pulse: boolean;
  menu: MenuFor;
  colors: Map<string, string>;
  drop: DropState;
  carrying: Token | null;
  onToken: ((from: string, token: Token, e: ReactPointerEvent | null) => void) | null;
  onDrop: (target: string) => void;
}) {
  const { spec } = useExplorer();
  const instance = world.instances.find((i) => i.id === id)!;
  const actor = spec.actors.find((a) => a.name === instance.actor)!;
  const look = appearance(spec, world, id);
  const shape = shapeOf(actor);
  const Icon = iconFor(look.icon);
  const identity = colors.get(id);
  const ring = telling(look.mood) ? moodColor(look.mood) : (identity ?? (region ? "var(--color-kumo-warning)" : "var(--color-kumo-line)"));
  const timers = world.pending.filter((p): p is Extract<Pending, { kind: "timer" }> => p.kind === "timer" && p.to === id);
  const waiting = timers.map((t) => `${t.timer} in ${time(Math.max(0, t.at - world.clock))}`).join(", ");
  const trigger = <button type="button" title={waiting ? `Waiting: ${waiting}` : undefined} className="group flex w-[136px] shrink-0 cursor-pointer flex-col items-center gap-1 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus" onClick={(e) => e.stopPropagation()} />;
  const iconBlock = menu(
    id,
    trigger,
    <>
      <span
        key={flash ?? "still"}
        className={cn(
          "relative flex size-[72px] items-center justify-center rounded-full bg-kumo-base transition-transform duration-200 ease-out group-hover:scale-105 group-data-[popup-open]:scale-105",
          pulse && "feynman-pulse",
          flash !== null && "feynman-flash",
          drop === "target" && "scale-110",
        )}
        style={{ boxShadow: `0 0 0 ${drop === "target" ? 4 : 3}px ${drop === "target" ? "var(--color-kumo-brand)" : ring}` }}
      >
        <Icon size={30} weight="duotone" style={{ color: region && !identity ? "var(--text-color-kumo-warning)" : undefined }} />
        {identity && telling(look.mood) && <span className="absolute left-0.5 top-0.5 size-3.5 rounded-full ring-2 ring-kumo-canvas" style={{ background: identity }} />}
      </span>
      <span className="max-w-full truncate text-[13px] font-semibold leading-tight">{instance.label}</span>
      {look.status && <span className="max-w-full truncate text-[11px] leading-tight text-kumo-subtle">{look.status}</span>}
    </>,
  );
  const tokens = look.tokens.length > 0 && (
    <div className={cn("absolute left-[92px] -top-3 z-10 flex flex-col items-start gap-1", drop === "source" && "opacity-30")}>
      {look.tokens.slice(0, 3).map((token) => (
        <TokenChip key={`${token.kind}:${String(token.value)}`} token={token} color={identity} onPick={onToken && ((e) => onToken(id, token, e))} />
      ))}
    </div>
  );
  const dropHere = carrying && drop === "target" && (
    <button
      type="button"
      autoFocus
      onClick={(e) => {
        e.stopPropagation();
        onDrop(id);
      }}
      className="absolute left-1/2 top-0 z-20 size-[88px] -translate-x-1/2 -translate-y-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
      aria-label={`Drop ${carrying.label ?? String(carrying.value)} on ${instance.label}`}
    />
  );
  const head = (
    <div className="relative">
      {iconBlock}
      {tokens}
      {dropHere}
    </div>
  );
  const frame = cn("absolute transition-opacity duration-200", drop === "other" && "opacity-35");
  const place = { left: box.x, top: box.y, width: box.w, height: box.h };
  if (shape === "hub") {
    return (
      <div data-instance={id} className={cn(frame, "flex flex-col items-center gap-3")} style={place}>
        {head}
        <Rows id={id} rows={look.rows} world={world} colors={colors} className="w-full flex-1" />
      </div>
    );
  }
  if (shape === "side") {
    return (
      <div data-instance={id} className={cn(frame, "flex items-start gap-1")} style={place}>
        {head}
        <Rows id={id} rows={look.rows} world={world} colors={colors} className="mt-3 w-[160px]" compact />
      </div>
    );
  }
  return (
    <div data-instance={id} className={cn(frame, "flex justify-center")} style={place}>
      {head}
    </div>
  );
}

/** Something to carry to another node: drag it, or click it (or press Enter) to pick it up. */
export function TokenChip({ token, color, onPick }: { token: Token; color?: string; onPick?: ((e: ReactPointerEvent | null) => void) | null }) {
  const accent = moodColor(token.mood ?? "warn");
  const name = token.label ?? String(token.value);
  const body = (
    <>
      <TicketIcon size={14} weight="duotone" style={{ color: color ?? accent }} />
      {name}
    </>
  );
  const look = "flex select-none items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 font-mono text-[12px] font-semibold";
  const style = { background: "var(--color-kumo-warning-tint)", boxShadow: `0 0 0 1.5px ${accent}, 0 3px 8px var(--color-kumo-shadow-drop)`, rotate: "-4deg" } as const;
  if (!onPick) {
    return (
      <span className={look} style={style}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Drag ${name} onto another node, or click to pick it up`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onPick(e);
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(null);
      }}
      className={cn(look, "cursor-grab touch-none transition-transform duration-150 ease-out hover:scale-110 focus-visible:outline-2 focus-visible:outline-kumo-focus active:cursor-grabbing")}
      style={style}
    >
      {body}
    </button>
  );
}

/** Where rows sit on the stage, in stage coordinates, so links can end at them. Measured when they move. */
function useRowAnchors(scale: number, key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Map<string, Box>>(new Map());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const origin = el.getBoundingClientRect();
    const next = new Map<string, Box>();
    for (const row of el.querySelectorAll<HTMLElement>("[data-row]")) {
      const r = row.getBoundingClientRect();
      next.set(row.dataset.row!, { x: (r.left - origin.left) / scale, y: (r.top - origin.top) / scale, w: r.width / scale, h: r.height / scale });
    }
    setRows(next);
  }, [scale, key]);
  return { ref, rows };
}

/** The side of a row facing a point: where a link from there meets it. */
function rowAnchor(row: Box, from: { x: number; y: number }): { x: number; y: number } {
  const left = Math.abs(from.x - row.x) < Math.abs(from.x - (row.x + row.w));
  return { x: left ? row.x : row.x + row.w, y: row.y + row.h / 2 };
}

/** State as structure: rows boxed by group. A group belonging to someone wears their colour. */
function Rows({ id, rows, world, colors, className, compact }: { id: string; rows: Row[]; world: World; colors: Map<string, string>; className?: string; compact?: boolean }) {
  const colorOf = (ref?: string) => {
    const owner = ref && world.instances.find((i) => i.id === ref || i.label === ref);
    return owner ? colors.get(owner.id) : undefined;
  };
  const dot = (row: Row) => (row.mood ? moodColor(row.mood) : (colorOf(row.owner) ?? moodColor(null)));
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.group ?? "", [...(groups.get(row.group ?? "") ?? []), row]);
  if (!rows.length) return compact ? null : <p className={cn("pt-2 text-center text-[12px] text-kumo-subtle", className)}>Nothing yet</p>;
  const limit = compact ? 3 : 6;
  return (
    <div className={cn("flex min-h-0 flex-col gap-2.5 overflow-hidden", className)}>
      {[...groups].map(([group, items]) => {
        const owner = colorOf(items.find((r) => r.owner)?.owner);
        return (
          <div key={group} className="overflow-hidden rounded-xl bg-kumo-base shadow-sm" style={{ boxShadow: `0 0 0 ${owner ? 1.5 : 1}px ${owner ?? "var(--color-kumo-line)"}` }}>
            {group && (
              <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                <span className="size-2.5 rounded-full" style={{ background: owner ?? "var(--color-kumo-line)" }} />
                <span className="truncate text-[13px] font-semibold">{group}</span>
              </div>
            )}
            {items.slice(0, limit).map((row, i) =>
              compact ? (
                <div key={i} data-row={`${id}::${row.label}`} className="flex flex-col px-2.5 py-1">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot(row) }} />
                    <span className="truncate text-[11px] text-kumo-subtle">{row.label}</span>
                  </span>
                  {row.detail && <span className="truncate font-mono text-[11px]">{row.detail}</span>}
                </div>
              ) : (
                <div key={i} data-row={`${id}::${row.label}`} className="mx-1.5 mb-1.5 flex items-center gap-2 rounded-lg bg-kumo-elevated px-2.5 py-1.5">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: dot(row) }} />
                  <span className="min-w-0 truncate text-[12.5px]">{row.label}</span>
                  {row.detail && <span className="ml-auto truncate pl-2 text-[11px] text-kumo-subtle">{row.detail}</span>}
                </div>
              ),
            )}
            {items.length > limit && <div className="px-3 pb-2 text-[11px] text-kumo-subtle">+{items.length - limit} more</div>}
          </div>
        );
      })}
    </div>
  );
}

// Messages in flight ------------------------------------------------------------------------------------

function Packet({ pending, graph, world, clock, next, live, onClick }: { pending: Extract<Pending, { kind: "deliver" }>; graph: Layout; world: World; clock: number; next: boolean; live: boolean; onClick: () => void }) {
  const { spec } = useExplorer();
  const from = graph.nodes.get(pending.from);
  const to = graph.nodes.get(pending.to);
  if (!from || !to) return null;
  const latency = spec.messages[pending.message]?.latency ?? spec.latency;
  const progress = Math.min(1, Math.max(0, (clock - (pending.at - latency)) / Math.max(1, latency)));
  const a = iconCenter(from);
  const b = iconCenter(to);
  const at = along([rim(a, b), rim(b, a)], 0.1 + progress * 0.8);
  const color = toneColor(spec.messages[pending.message]?.tone);
  const name = messageName(spec, pending.message);
  if (routineDelivery(spec, world, pending)) {
    return <span className="pointer-events-none absolute z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70" style={{ left: at.x, top: at.y, background: color }} title={name} />;
  }
  return (
    <button
      type="button"
      disabled={!live}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-kumo-base py-0.5 pl-1.5 pr-2.5 text-[11.5px] font-medium shadow-md ring-1 ring-kumo-line", next && live && "feynman-pulse")}
      style={{ left: at.x, top: at.y }}
      title={`${name} ${short(pending.payload, 80)}. Click to deliver it now or lose it.`}
    >
      <span className="size-2.5 rounded-full" style={{ background: color }} />
      {name}
    </button>
  );
}

/** Whether a message in flight lands on a routine step, like a heartbeat. */
export function routineDelivery(spec: Spec, world: World, pending: Pending): boolean {
  const actor = spec.actors.find((a) => a.name === world.instances.find((i) => i.id === pending.to)?.actor);
  const key = pending.kind === "deliver" ? `message:${pending.message}` : pending.timer;
  return Boolean(actor?.transitions[key]?.routine);
}

// The speech bubble -------------------------------------------------------------------------------------

/** What just happened, above whoever did it; while time runs it fades after a moment. */
function SpeechBubble({ bubble, box }: { bubble: Bubble & { fading: boolean }; box: Box }) {
  const c = iconCenter(box);
  const ring = bubble.tone === "bad" ? "var(--color-kumo-danger)" : bubble.tone === "action" ? "var(--color-kumo-brand)" : "var(--color-kumo-line)";
  return (
    <div
      className={cn("pointer-events-none absolute z-20 w-max max-w-[280px] -translate-x-1/2 -translate-y-full rounded-xl bg-kumo-base px-3 py-1.5 text-center text-[12.5px] leading-snug shadow-lg", bubble.fading && "feynman-bubble")}
      style={{ left: c.x, top: c.y - 48, boxShadow: `0 0 0 1.5px ${ring}, 0 6px 16px var(--color-kumo-shadow-drop)` }}
    >
      {bubble.text}
    </div>
  );
}

export function bubbleText(spec: Spec, event: Event, world: World | undefined): string {
  if (event.text) return event.text;
  if (event.notes.length) return event.notes[0];
  if (event.kind === "lose") return event.description;
  return `${labelOf(world, event.instance)}: ${event.description.replace(/\.$/, "")}`;
}
