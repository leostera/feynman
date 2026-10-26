// The playground's topology. ELK orders it: zones left to right in the direction messages
// flow, instances within a zone so links cross least. That order is then spread over the
// canvas: one column per zone, filling its width, and each column's instances spread down
// its height. A zone holding a singleton (the service everyone talks to) is drawn as a
// tinted region; the others are captioned columns. Nothing is placed by hand.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import { appearance, type Spec, type World } from "@feynman/spec";

/** The icon column of every node. */
export const ICON_W = 136;
export const NODE_H = 116;
/** A card beside the icon, for actors with rows that are not singletons (a Mac's host_link). */
export const SIDE_W = 168;
/** A card under the icon, for singletons with rows (the relay's accounts). */
export const HUB_W = 340;
export const HUB_H = 180;

export type NodeShape = "plain" | "side" | "hub";

export function shapeOf(actor: { singleton: boolean; look: { rows?: unknown } }): NodeShape {
  if (!actor.look.rows) return "plain";
  return actor.singleton ? "hub" : "side";
}

/** A hub grows with its rows: the icon, then each group's header and up to six rows. */
export function hubHeight(rows: { group?: string }[]): number {
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(r.group ?? "", (groups.get(r.group ?? "") ?? 0) + 1);
  let h = 132;
  for (const [group, n] of groups) h += (group ? 34 : 0) + Math.min(n, 6) * 31 + (n > 6 ? 20 : 0) + 10;
  return Math.max(HUB_H, h);
}

export function sizeOf(shape: NodeShape, rows: { group?: string }[] = []): { width: number; height: number } {
  if (shape === "hub") return { width: HUB_W, height: hubHeight(rows) };
  if (shape === "side") return { width: ICON_W + SIDE_W, height: NODE_H };
  return { width: ICON_W, height: NODE_H };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZoneBox extends Box {
  name: string;
  /** Drawn as a tinted region, rather than a caption over a column. */
  region: boolean;
}

/** The canvas the layout fills; room is kept at the top and bottom for the overlays. */
export interface View {
  w: number;
  h: number;
}

/** Room for the tip and docks over the canvas, and the margin at the sides. */
export const RESERVE = { top: 72, bottom: 76, side: 40, caption: 30 };

export interface Layout {
  width: number;
  height: number;
  zones: ZoneBox[];
  /** Instances by id. */
  nodes: Map<string, Box>;
  /** By `a|b`, sorted ids: the route between them. */
  edges: Map<string, { x: number; y: number }[]>;
}

const elk = new ELK();

/** Which actors talk to which: an actor that may send a message, to every actor that handles it. */
export function actorLinks(spec: Spec): [string, string][] {
  const handlers = new Map<string, string[]>();
  for (const actor of spec.actors) for (const t of Object.values(actor.transitions)) if (t.message) handlers.set(t.message, [...(handlers.get(t.message) ?? []), actor.name]);
  const links = new Set<string>();
  for (const actor of spec.actors) {
    const steps = [...Object.values(actor.actions), ...Object.values(actor.transitions)];
    for (const message of new Set(steps.flatMap((s) => s.sends)))
      for (const to of handlers.get(message) ?? []) if (to !== actor.name) links.add([actor.name, to].sort().join("\u0000"));
  }
  return [...links].map((l) => l.split("\u0000") as [string, string]);
}

export function edgeKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** What the layout depends on: which instances exist, and how tall each hub is. */
export function layoutKey(spec: Spec, world: World, view: View): string {
  const hubs = world.instances.filter((i) => shapeOf(spec.actors.find((a) => a.name === i.actor)!) === "hub").map((i) => hubHeight(appearance(spec, world, i.id).rows));
  return `${spec.name}:${world.instances.map((i) => i.id).join(",")}:${hubs.join(",")}:${Math.round(view.w / 16)}x${Math.round(view.h / 16)}`;
}

export async function layout(spec: Spec, world: World, view: View): Promise<Layout> {
  return arrange(spec, world, await order(spec, world), view);
}

/** ELK's answer to "in which order": zones by x, instances within a zone by y. */
async function order(spec: Spec, world: World): Promise<Layout> {
  const links = actorLinks(spec);
  const byActor = new Map<string, string[]>();
  for (const i of world.instances) byActor.set(i.actor, [...(byActor.get(i.actor) ?? []), i.id]);

  const zones: ElkNode[] = spec.zones.map((zone) => ({
    id: `zone:${zone.name}`,
    layoutOptions: { "elk.padding": "[top=48,left=28,bottom=28,right=28]", "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.spacing.nodeNode": "28" },
    children: world.instances
      .filter((i) => zoneOf(spec, i.actor) === zone.name)
      .map((i) => {
        const shape = shapeOf(spec.actors.find((a) => a.name === i.actor)!);
        return { id: i.id, ...sizeOf(shape, shape === "hub" ? appearance(spec, world, i.id).rows : []) };
      }),
  }));
  const edges: ElkExtendedEdge[] = [];
  for (const [a, b] of links) {
    // Lay out left to right in the order zones were declared.
    const [from, to] = zoneIndex(spec, a) <= zoneIndex(spec, b) ? [a, b] : [b, a];
    for (const x of byActor.get(from) ?? []) for (const y of byActor.get(to) ?? []) edges.push({ id: `${x}->${y}`, sources: [x], targets: [y] });
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.padding": "[top=28,left=12,bottom=12,right=12]",
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.nodeNode": "56",
      "elk.edgeRouting": "POLYLINE",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: zones.filter((z) => z.children!.length),
    edges,
  };
  const out = await elk.layout(graph);
  const result: Layout = { width: out.width ?? 0, height: out.height ?? 0, zones: [], nodes: new Map(), edges: new Map() };
  for (const zone of out.children ?? []) {
    result.zones.push({ name: zone.id.slice(5), region: false, x: zone.x!, y: zone.y!, w: zone.width!, h: zone.height! });
    for (const node of zone.children ?? []) result.nodes.set(node.id, { x: node.x!, y: node.y!, w: node.width!, h: node.height! });
  }
  for (const edge of out.edges ?? []) {
    const [section] = edge.sections ?? [];
    if (!section) continue;
    result.edges.set(edgeKey(edge.sources[0], edge.targets[0]), [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
  }
  return result;
}

const GAP = 32;

/** Zones left to right: those with a column where they ask, the rest in ELK's order around them. */
function columnOrder(spec: Spec, zones: ZoneBox[]): ZoneBox[] {
  const placed = new Map<number, ZoneBox>();
  const rest: ZoneBox[] = [];
  for (const zone of [...zones].sort((a, b) => a.x - b.x)) {
    const column = spec.zones.find((z) => z.name === zone.name)?.place.column;
    if (column === undefined || placed.has(column)) rest.push(zone);
    else placed.set(column, zone);
  }
  const out: ZoneBox[] = [];
  for (let i = 0; out.length < zones.length; i++) out.push(placed.get(i) ?? rest.shift() ?? [...placed].filter(([c]) => c >= i).sort(([a], [b]) => a - b).map(([c, z]) => (placed.delete(c), z))[0]);
  return out.filter(Boolean);
}

/** Lay out a zone's instances by its `arrange`, relative to the top left of their block. */
function block(arrange: "stack" | "row" | "grid", boxes: Box[], vgap: number): { places: { x: number; y: number }[]; w: number; h: number } {
  if (arrange === "row") {
    let x = 0;
    const h = Math.max(0, ...boxes.map((b) => b.h));
    const places = boxes.map((b) => ((x += b.w + GAP), { x: x - b.w - GAP, y: (h - b.h) / 2 }));
    return { places, w: Math.max(0, x - GAP), h };
  }
  if (arrange === "grid") {
    const cols = Math.ceil(Math.sqrt(boxes.length));
    const cw = Math.max(0, ...boxes.map((b) => b.w));
    const ch = Math.max(0, ...boxes.map((b) => b.h));
    const rows = Math.ceil(boxes.length / cols);
    const places = boxes.map((b, i) => ({ x: (i % cols) * (cw + GAP) + (cw - b.w) / 2, y: Math.floor(i / cols) * (ch + vgap) }));
    return { places, w: cols * cw + (cols - 1) * GAP, h: rows * ch + (rows - 1) * vgap };
  }
  const w = Math.max(0, ...boxes.map((b) => b.w));
  let y = 0;
  const places = boxes.map((b) => ((y += b.h + vgap), { x: (w - b.w) / 2, y: y - b.h - vgap }));
  return { places, w, h: Math.max(0, y - vgap) };
}

/**
 * Spread the ordered zones over the canvas: a column per zone, filling the width, and each
 * zone's instances lined up by its `place` hints. Instances on a zone's edge straddle its
 * border.
 */
function arrange(spec: Spec, world: World, ordered: Layout, view: View): Layout {
  const actorOf = (id: string) => spec.actors.find((a) => a.name === world.instances.find((i) => i.id === id)?.actor);
  const labelOf = (id: string) => world.instances.find((i) => i.id === id)?.label ?? id;
  const columns = columnOrder(spec, ordered.zones).map((zone) => {
    const place = spec.zones.find((z) => z.name === zone.name)?.place ?? {};
    const all = [...ordered.nodes]
      .filter(([id]) => zoneOfInstance(spec, world, id) === zone.name)
      // By order, then by label, so things named alike sit together ("Studio app", "Studio daemon").
      .sort(([a], [b]) => (actorOf(a)?.place.order ?? 0) - (actorOf(b)?.place.order ?? 0) || labelOf(a).localeCompare(labelOf(b), undefined, { numeric: true }));
    const inner = all.filter(([id]) => !actorOf(id)?.place.edge);
    const edges = all.filter(([id]) => actorOf(id)?.place.edge);
    const region = place.region ?? all.some(([id]) => actorOf(id)?.singleton);
    const arrange = place.arrange ?? "stack";
    const sized = block(arrange, inner.map(([, b]) => b), GAP);
    return { zone, place, inner, edges, region, arrange, width: sized.w + (region ? 64 : 0), height: sized.h };
  });
  const used = columns.reduce((sum, c) => sum + c.width, 0);
  const minGap = columns.some((c) => c.edges.length) ? 120 : 72;
  const gap = columns.length > 1 ? Math.min(280, Math.max(minGap, (view.w - RESERVE.side * 2 - used) / (columns.length - 1))) : 0;
  const width = Math.max(view.w, used + gap * (columns.length - 1) + RESERVE.side * 2);
  const top = RESERVE.top + RESERVE.caption;
  const tallest = Math.max(...columns.map((c) => c.height + (c.region ? 96 : 0)));
  const height = Math.max(view.h, top + tallest + RESERVE.bottom);
  const room = height - top - RESERVE.bottom;
  const out: Layout = { width, height, zones: [], nodes: new Map(), edges: new Map() };
  let x = (width - used - gap * (columns.length - 1)) / 2;
  for (const column of columns) {
    const inner = column.region ? room - 96 : room;
    // Spread a stack down the room it has, within reason; rows and grids keep their spacing.
    const vgap = column.arrange === "stack" && column.inner.length > 1 ? Math.min(120, Math.max(GAP, (inner - column.inner.reduce((s, [, b]) => s + b.h, 0)) / column.inner.length)) : GAP;
    const laid = block(column.arrange, column.inner.map(([, b]) => b), vgap);
    const align = column.place.align ?? (column.region ? "start" : "center");
    const free = Math.max(0, inner - laid.h);
    const y0 = top + (column.region ? 40 : 0) + (align === "start" ? 0 : align === "end" ? free : free / 2);
    const x0 = x + (column.width - laid.w) / 2;
    column.inner.forEach(([id, box], i) => out.nodes.set(id, { x: x0 + laid.places[i].x, y: y0 + laid.places[i].y, w: box.w, h: box.h }));
    const zone: ZoneBox = column.region ? { name: column.zone.name, region: true, x, y: top - 12, w: column.width, h: room + 12 } : { name: column.zone.name, region: false, x, y: top, w: column.width, h: room };
    // On the edge: straddling the border, spread around the middle of the zone's height.
    const sides = { left: column.edges.filter(([id]) => actorOf(id)?.place.edge === "left"), right: column.edges.filter(([id]) => actorOf(id)?.place.edge === "right") };
    for (const [side, list] of Object.entries(sides)) {
      const stack = block("stack", list.map(([, b]) => b), GAP);
      list.forEach(([id, box], i) =>
        out.nodes.set(id, { x: (side === "left" ? zone.x : zone.x + zone.w) - box.w / 2, y: zone.y + (zone.h - stack.h) / 2 + stack.places[i].y, w: box.w, h: box.h }),
      );
    }
    out.zones.push(zone);
    x += column.width + gap;
  }
  return out;
}

function zoneOfInstance(spec: Spec, world: World, id: string): string | undefined {
  const instance = world.instances.find((i) => i.id === id);
  return instance && zoneOf(spec, instance.actor);
}

function zoneOf(spec: Spec, actor: string): string {
  return spec.actors.find((a) => a.name === actor)!.zone;
}

function zoneIndex(spec: Spec, actor: string): number {
  return spec.zones.findIndex((z) => z.name === zoneOf(spec, actor));
}

/** A point `t` (0..1) along a polyline, from its first point. */
export function along(points: { x: number; y: number }[], t: number): { x: number; y: number } {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) * Math.min(1, Math.max(0, t));
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? left / lengths[i] : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
    }
    left -= lengths[i];
  }
  return points[0];
}

/** An SVG path through ELK's spline control points (1 + 3k of them), or straight segments. */
export function pathOf(points: { x: number; y: number }[]): string {
  const [first, ...rest] = points;
  if (rest.length >= 3 && rest.length % 3 === 0) {
    const curves = [];
    for (let i = 0; i < rest.length; i += 3) curves.push(`C${rest[i].x},${rest[i].y} ${rest[i + 1].x},${rest[i + 1].y} ${rest[i + 2].x},${rest[i + 2].y}`);
    return `M${first.x},${first.y} ${curves.join(" ")}`;
  }
  return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
}
