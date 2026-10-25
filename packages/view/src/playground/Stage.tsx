// The stage: zones, the wires between actors that can talk, the live links instances hold,
// one node per instance (icon, status, rows), messages travelling the wires, and speech
// bubbles for what just happened. Everything is placed by the computed layout.
import { cn } from "@cloudflare/kumo";
import { TimerIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { appearance, declaresLinks, liveLinks, type Event, type Pending, type Row, type Spec, type World } from "@feynman/spec";
import { labelOf, messageName, short, time } from "../format";
import { along, edgeKey, ICON_W, layout, layoutKey, pathOf, shapeOf, type Box, type Layout } from "../layout";
import { useExplorer } from "../ui";
import { iconFor, moodColor, toneColor } from "./look";

export interface Bubble {
  key: string;
  instance: string;
  text: string;
  tone: "action" | "message" | "bad" | "quiet";
  age: number;
}

/** Wraps a node's icon in its menu: the trigger element and what it shows. */
export type MenuFor = (id: string, trigger: ReactElement, children: ReactNode) => ReactNode;

export interface Fit {
  scale: number;
  x: number;
  y: number;
}

export function useLayout(spec: Spec, world: World): Layout | null {
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

/** Scale the drawing to fit its box with room for the overlays, centred; never above 1.15. */
export function useFit(width: number, height: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const top = 120;
  const bottom = 48;
  const side = 48;
  const scale = width && height && box.w ? Math.min(1.2, (box.w - side * 2) / width, (box.h - top - bottom) / height) : 1;
  const fit: Fit = { scale, x: (box.w - width * scale) / 2, y: top + Math.max(0, (box.h - top - bottom - height * scale) / 2) };
  return { ref, fit };
}

export function Stage({
  world,
  graph,
  fit,
  clock,
  live,
  focus,
  bubbles,
  next,
  pulse,
  menu,
  onPacket,
}: {
  world: World;
  graph: Layout;
  fit: Fit;
  clock: number;
  live: boolean;
  focus: Event | null;
  bubbles: Bubble[];
  next: number | null;
  pulse: string | null;
  menu: MenuFor;
  onPacket: (pending: Extract<Pending, { kind: "deliver" }>) => void;
}) {
  const { spec } = useExplorer();
  const links = liveLinks(spec, world);
  const quietWires = declaresLinks(spec);
  const changed = new Set((focus?.changes ?? []).map((c) => c.instance));
  return (
    <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`, width: graph.width, height: graph.height }}>
      <svg width={graph.width} height={graph.height} className="absolute inset-0 overflow-visible">
        {graph.zones.map((z) => (
          <Zone key={z.name} zone={z} description={spec.zones.find((x) => x.name === z.name)?.description} />
        ))}
        {[...graph.edges].map(([key, points]) => (
          <path key={key} d={pathOf(points)} fill="none" stroke="var(--color-kumo-line)" strokeWidth={1} opacity={quietWires ? 0.35 : 0.8} />
        ))}
        {links.map((link, i) => {
          const a = graph.nodes.get(link.from);
          const b = graph.nodes.get(link.target);
          if (!a || !b) return null;
          const [p, q] = [anchor(a, b), anchor(b, a)];
          return (
            <line
              key={i}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={moodColor(link.mood ?? "busy")}
              strokeWidth={2}
              strokeDasharray={link.style === "dotted" ? "2 6" : link.style === "solid" ? undefined : "8 6"}
              strokeLinecap="round"
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
            touched={changed.has(instance.id)}
            pulse={live && pulse === instance.id}
            menu={menu}
          />
        ) : null;
      })}
      {world.pending.map((p) =>
        p.kind === "deliver" ? <Packet key={p.id} pending={p} graph={graph} clock={clock} next={next === p.id} live={live} onClick={() => onPacket(p)} /> : null,
      )}
      {[...new Set(bubbles.map((b) => b.instance))].map((instance) => {
        const box = graph.nodes.get(instance);
        return box ? <SpeechBubbles key={instance} bubbles={bubbles.filter((b) => b.instance === instance)} box={box} /> : null;
      })}
    </div>
  );
}

function Zone({ zone, description }: { zone: Box & { name: string }; description?: string }) {
  return (
    <g>
      <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={24} fill="var(--color-kumo-tint)" fillOpacity={0.35} stroke="var(--color-kumo-line)" strokeDasharray="6 6" />
      <text x={zone.x + 8} y={zone.y - 12} fill="currentColor" className="text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">
        {zone.name}
        {description ? ` · ${description}` : ""}
      </text>
    </g>
  );
}

/** Where a straight link leaves box `a` towards box `b`: the edge of a's icon circle. */
function anchor(a: Box, b: Box): { x: number; y: number } {
  const ca = iconCenter(a);
  const cb = iconCenter(b);
  const d = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
  return { x: ca.x + ((cb.x - ca.x) / d) * 36, y: ca.y + ((cb.y - ca.y) / d) * 36 };
}

function iconCenter(box: Box): { x: number; y: number } {
  return { x: box.x + Math.min(box.w, ICON_W) / 2 + (box.w > ICON_W + 200 ? (box.w - ICON_W) / 2 : 0), y: box.y + 40 };
}

// Nodes -------------------------------------------------------------------------------------------------

function Node({ id, world, box, touched, pulse, menu }: { id: string; world: World; box: Box; touched: boolean; pulse: boolean; menu: MenuFor }) {
  const { spec } = useExplorer();
  const instance = world.instances.find((i) => i.id === id)!;
  const actor = spec.actors.find((a) => a.name === instance.actor)!;
  const look = appearance(spec, world, id);
  const shape = shapeOf(actor);
  const Icon = iconFor(look.icon);
  const timers = world.pending.filter((p): p is Extract<Pending, { kind: "timer" }> => p.kind === "timer" && p.to === id);
  const ring = moodColor(look.mood);
  const trigger = <button type="button" className="group flex w-[136px] shrink-0 cursor-pointer flex-col items-center gap-1 outline-none" onClick={(e) => e.stopPropagation()} />;
  const iconBlock = menu(
    id,
    trigger,
    <>
      <span
        className={cn(
          "relative flex size-[72px] items-center justify-center rounded-full bg-kumo-base transition-transform group-hover:scale-105 group-data-[popup-open]:scale-105 group-data-[popup-open]:outline-3 group-data-[popup-open]:outline-offset-4 group-data-[popup-open]:outline-kumo-brand",
          pulse && "feynman-pulse",
        )}
        style={{ boxShadow: `0 0 0 3px ${ring}` }}
      >
        <Icon size={30} weight="duotone" className="text-kumo-default" />
        {touched && <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full ring-2 ring-kumo-base" style={{ background: "var(--color-kumo-warning)" }} />}
      </span>
      <span className="max-w-full truncate text-[13px] font-semibold leading-tight">{instance.label}</span>
      {look.status && <span className="max-w-full truncate text-[11px] leading-tight text-kumo-subtle">{look.status}</span>}
      {timers.length > 0 && (
        <span className="flex items-center gap-0.5 font-mono text-[10px] text-kumo-subtle" title={timers.map((t) => `${t.timer} in ${time(Math.max(0, t.at - world.clock))}`).join(", ")}>
          <TimerIcon size={10} />
          {timers[0].timer} {time(Math.max(0, timers[0].at - world.clock))}
        </span>
      )}
    </>,
  );
  if (shape === "hub") {
    return (
      <div className="absolute flex flex-col items-center gap-3" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        {iconBlock}
        <Rows rows={look.rows} className="w-full flex-1" />
      </div>
    );
  }
  if (shape === "side") {
    return (
      <div className="absolute flex items-start gap-1" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        {iconBlock}
        <Rows rows={look.rows} className="mt-3 w-[160px]" compact />
      </div>
    );
  }
  return (
    <div className="absolute flex justify-center" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      {iconBlock}
    </div>
  );
}

/** State as structure: rows boxed by group, each with its mood as a dot. */
function Rows({ rows, className, compact }: { rows: Row[]; className?: string; compact?: boolean }) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.group ?? "", [...(groups.get(row.group ?? "") ?? []), row]);
  if (!rows.length) return compact ? null : <div className={cn("rounded-xl border border-dashed border-kumo-line p-3 text-center text-[11px] text-kumo-subtle", className)}>empty</div>;
  return (
    <div className={cn("flex min-h-0 flex-col gap-2 overflow-hidden", className)}>
      {[...groups].map(([group, items]) => (
        <div key={group} className="overflow-hidden rounded-xl bg-kumo-elevated ring-1 ring-kumo-line">
          {group && (
            <div className="flex items-center gap-1.5 border-b border-kumo-hairline px-3 py-1.5">
              <span className="size-2 rounded-full" style={{ background: "var(--color-kumo-brand)" }} />
              <span className="truncate text-[12px] font-semibold">{group}</span>
            </div>
          )}
          {items.slice(0, compact ? 3 : 6).map((row, i) =>
            compact ? (
              <div key={i} className="flex flex-col px-2.5 py-1">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: moodColor(row.mood) }} />
                  <span className="truncate font-mono text-[10px] text-kumo-subtle">{row.label}</span>
                </span>
                {row.detail && <span className="truncate font-mono text-[11px]">{row.detail}</span>}
              </div>
            ) : (
              <div key={i} className="flex items-center gap-1.5 px-3 py-1.5">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: moodColor(row.mood) }} />
                <span className="min-w-0 truncate text-[12px]">{row.label}</span>
                {row.detail && <span className="ml-auto truncate pl-2 text-[11px] text-kumo-subtle">{row.detail}</span>}
              </div>
            ),
          )}
          {items.length > (compact ? 3 : 6) && <div className="px-3 pb-1.5 text-[10px] text-kumo-subtle">+{items.length - (compact ? 3 : 6)} more</div>}
        </div>
      ))}
    </div>
  );
}

// Messages in flight ------------------------------------------------------------------------------------

function Packet({ pending, graph, clock, next, live, onClick }: { pending: Extract<Pending, { kind: "deliver" }>; graph: Layout; clock: number; next: boolean; live: boolean; onClick: () => void }) {
  const { spec } = useExplorer();
  const from = graph.nodes.get(pending.from);
  const to = graph.nodes.get(pending.to);
  if (!from || !to) return null;
  const latency = spec.messages[pending.message]?.latency ?? spec.latency;
  const progress = Math.min(1, Math.max(0, (clock - (pending.at - latency)) / Math.max(1, latency)));
  const a = iconCenter(from);
  const b = iconCenter(to);
  const route = graph.edges.get(edgeKey(pending.from, pending.to));
  const points = route ? (dist(route[0], a) <= dist(route[0], b) ? route : [...route].reverse()) : [a, b];
  const at = along([a, ...points.slice(1, -1), b], 0.12 + progress * 0.76);
  const color = toneColor(spec.messages[pending.message]?.tone);
  return (
    <button
      type="button"
      disabled={!live}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-kumo-base py-0.5 pl-1 pr-2 text-[11px] font-medium shadow-md ring-1 ring-kumo-line", next && live && "feynman-pulse")}
      style={{ left: at.x, top: at.y }}
      title={`${messageName(spec, pending.message)} ${short(pending.payload, 80)}. Click to deliver it now or lose it.`}
    >
      <span className="size-2.5 rounded-full" style={{ background: color }} />
      {messageName(spec, pending.message)}
    </button>
  );
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// Speech bubbles ----------------------------------------------------------------------------------------

/** A node's recent bubbles, newest nearest the node, stacked upwards from just above it. */
function SpeechBubbles({ bubbles, box }: { bubbles: Bubble[]; box: Box }) {
  const c = iconCenter(box);
  return (
    <div className="pointer-events-none absolute z-20 flex w-max max-w-[260px] -translate-x-1/2 -translate-y-full flex-col-reverse items-center gap-1.5" style={{ left: c.x, top: c.y - 46 }}>
      {bubbles.map((bubble) => {
        const ring = bubble.tone === "bad" ? "var(--color-kumo-danger)" : bubble.tone === "action" ? "var(--color-kumo-brand)" : bubble.tone === "quiet" ? "var(--color-kumo-line)" : "var(--color-kumo-info)";
        return (
          <div key={bubble.key} className="rounded-xl bg-kumo-base px-3 py-1.5 text-center text-[12px] leading-snug shadow-lg" style={{ boxShadow: `0 0 0 1.5px ${ring}`, opacity: Math.max(0.45, 1 - bubble.age * 0.28) }}>
            {bubble.text}
          </div>
        );
      })}
    </div>
  );
}

export function bubbleText(spec: Spec, event: Event, world: World | undefined): string {
  if (event.text) return event.text;
  if (event.notes.length) return event.notes[0];
  if (event.kind === "lose") return event.description;
  return `${labelOf(world, event.instance)}: ${event.description.replace(/\.$/, "")}`;
}
