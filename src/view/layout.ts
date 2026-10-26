// The playground's topology, over the scene's nodes. ELK orders it: zones left to right in
// the direction messages flow, nodes within a zone so links cross least. That order is then spread over the
// canvas: one column per zone, filling its width, and each column's instances spread down
// its height. A zone holding a singleton (the service everyone talks to) is drawn as a
// tinted region; the others are captioned columns. Nothing is placed by hand.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Spec, World } from "../spec/index.ts";
import { labelInside } from "../play/index.ts";
import { nodeLook, type Scene, type SceneNode } from "./scene";

/** Every node's column: its shape, and its name and status under it. */
export const NODE_W = 128;
export const NODE_H = 100;
/** A card beside the node, for nodes with rows that are not singletons (a Mac's host_link). */
export const SIDE_W = 150;
/** A card under the node, for singletons with rows (the relay's accounts). */
export const HUB_W = 300;

export type NodeShape = "plain" | "side" | "hub";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a node's shape sits in its box, and how far its rim is from the centre. */
export interface Anchor {
  x: number;
  y: number;
  r: number;
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
export const RESERVE = { top: 64, bottom: 68, side: 40, caption: 28 };

export interface Layout {
  width: number;
  height: number;
  zones: ZoneBox[];
  /** Nodes by id. */
  nodes: Map<string, Box & { kind: NodeShape; anchor: Anchor }>;
  /** Open groups, outlined around their members. */
  groups: { id: string; label: string; box: Box }[];
}

/** Custom sizes a playground file gives nodes, by node id. */
export type Sizes = Map<string, { w: number; h: number }>;

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

/** Which nodes talk to which, from which actors do. */
export function nodeLinks(spec: Spec, scene: Scene): [string, string][] {
  const nodesOf = new Map<string, Set<string>>();
  for (const node of scene.nodes) for (const m of node.members) nodesOf.set(m.actor, (nodesOf.get(m.actor) ?? new Set()).add(node.id));
  const out = new Set<string>();
  for (const [a, b] of actorLinks(spec)) for (const x of nodesOf.get(a) ?? []) for (const y of nodesOf.get(b) ?? []) if (x !== y) out.add([x, y].sort().join("\u0000"));
  return [...out].map((l) => l.split("\u0000") as [string, string]);
}

/** A node's box: its shape and name, and its rows beside it or under it. */
export function nodeBox(spec: Spec, world: World, node: SceneNode, sizes: Sizes): { width: number; height: number; kind: NodeShape; anchor: Anchor } {
  const look = nodeLook(spec, world, node);
  const inside = labelInside(look.shape, look.icon, node.label);
  const shape = look.shape === "gate" ? { w: 60, h: inside ? 84 : 68 } : look.shape === "card" ? { w: 132, h: 48 } : look.shape === "device" ? { w: 54, h: 54 } : inside ? { w: 72, h: 72 } : { w: 60, h: 60 };
  const r = Math.max(shape.w, shape.h) / 2 + 2;
  const custom = sizes.get(node.id);
  if (custom) return { width: custom.w, height: custom.h, kind: "plain", anchor: { x: custom.w / 2, y: Math.min(custom.h / 2, 40), r: Math.min(custom.w, custom.h) / 2 } };
  const under = inside && look.shape !== "circle" ? 0 : 30;
  const plainW = look.shape === "card" ? 140 : look.shape === "gate" && inside ? 76 : NODE_W;
  const plain = { width: plainW, height: shape.h + under + 8 };
  if (!look.rows.length) return { ...plain, kind: "plain", anchor: { x: plainW / 2, y: shape.h / 2 + 2, r } };
  if (node.singleton) return { width: HUB_W, height: plain.height + 12 + rowsHeight(look.rows), kind: "hub", anchor: { x: HUB_W / 2, y: shape.h / 2 + 2, r } };
  return { width: plainW + SIDE_W, height: Math.max(plain.height, 24 + Math.min(3, look.rows.length) * 20), kind: "side", anchor: { x: plainW / 2, y: shape.h / 2 + 2, r } };
}

/** Rows under a hub: each group's header, and up to six rows. */
function rowsHeight(rows: { group?: string }[]): number {
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(r.group ?? "", (groups.get(r.group ?? "") ?? 0) + 1);
  let h = 0;
  for (const [group, n] of groups) h += (group ? 24 : 4) + Math.min(n, 6) * 26 + (n > 6 ? 16 : 0) + 12;
  return h;
}

/** What the layout depends on: which nodes exist, and how big each is. */
export function layoutKey(spec: Spec, world: World, scene: Scene, view: View, sizes: Sizes): string {
  const boxes = scene.nodes.map((n) => {
    const b = nodeBox(spec, world, n, sizes);
    return `${n.id}=${b.width}x${b.height}`;
  });
  return `${spec.name}:${boxes.join(",")}:${Math.round(view.w / 16)}x${Math.round(view.h / 16)}`;
}

export async function layout(spec: Spec, world: World, scene: Scene, view: View, sizes: Sizes): Promise<Layout> {
  const boxes = new Map(scene.nodes.map((n) => [n.id, nodeBox(spec, world, n, sizes)]));
  return arrange(spec, scene, boxes, await order(spec, scene, boxes), view);
}

type Boxes = Map<string, ReturnType<typeof nodeBox>>;

/** ELK's answer to "in which order": zones by x, nodes within a zone by y. */
async function order(spec: Spec, scene: Scene, boxes: Boxes): Promise<{ zones: ZoneBox[]; nodes: Map<string, Box> }> {
  const zones: ElkNode[] = spec.zones.map((zone) => ({
    id: `zone:${zone.name}`,
    layoutOptions: { "elk.padding": "[top=48,left=28,bottom=28,right=28]", "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.spacing.nodeNode": "28" },
    children: scene.nodes.filter((n) => n.zone === zone.name).map((n) => ({ id: n.id, width: boxes.get(n.id)!.width, height: boxes.get(n.id)!.height })),
  }));
  const zoneOf = new Map(scene.nodes.map((n) => [n.id, n.zone]));
  const zoneIndex = (id: string) => spec.zones.findIndex((z) => z.name === zoneOf.get(id));
  const edges: ElkExtendedEdge[] = nodeLinks(spec, scene).map(([a, b]) => {
    // Left to right in the order zones were declared.
    const [from, to] = zoneIndex(a) <= zoneIndex(b) ? [a, b] : [b, a];
    return { id: `${from}->${to}`, sources: [from], targets: [to] };
  });
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
  const result = { zones: [] as ZoneBox[], nodes: new Map<string, Box>() };
  for (const zone of out.children ?? []) {
    result.zones.push({ name: zone.id.slice(5), region: false, x: zone.x!, y: zone.y!, w: zone.width!, h: zone.height! });
    for (const node of zone.children ?? []) result.nodes.set(node.id, { x: node.x!, y: node.y!, w: node.width!, h: node.height! });
  }
  return result;
}

const GAP = 28;

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
  // A column nobody asked for takes the next zone without one, else the next asked-for zone further right.
  const next = (i: number): ZoneBox | undefined => {
    const asked = placed.get(i);
    if (asked) return placed.delete(i), asked;
    if (rest.length) return rest.shift();
    const later = [...placed.keys()].filter((c) => c > i).sort((a, b) => a - b)[0];
    if (later === undefined) return undefined;
    const zone = placed.get(later)!;
    placed.delete(later);
    return zone;
  };
  for (let i = 0; out.length < zones.length; i++) {
    const zone = next(i);
    if (zone) out.push(zone);
  }
  return out;
}

/** Lay out a zone's nodes by its `arrange`, relative to the top left of their block. */
function block(arrange: "stack" | "row" | "grid" | "ring", boxes: Box[], vgap: number): { places: { x: number; y: number }[]; w: number; h: number } {
  if (arrange === "ring" && boxes.length > 2) return ring(boxes);
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
 * Peers around a circle, the first at the top, the rest clockwise. The radius keeps
 * neighbours a box and two gaps apart (the chord between them), so the ring grows with the
 * cluster instead of crowding.
 */
function ring(boxes: Box[]): { places: { x: number; y: number }[]; w: number; h: number } {
  const cw = Math.max(...boxes.map((b) => b.w));
  const ch = Math.max(...boxes.map((b) => b.h));
  const r = (Math.max(cw, ch) + 2 * GAP) / (2 * Math.sin(Math.PI / boxes.length));
  const places = boxes.map((b, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / boxes.length;
    return { x: r + cw / 2 + r * Math.cos(angle) - b.w / 2, y: r + ch / 2 + r * Math.sin(angle) - b.h / 2 };
  });
  return { places, w: 2 * r + cw, h: 2 * r + ch };
}

/**
 * Spread the ordered zones over the canvas: a column per zone, filling the width, and each
 * zone's nodes lined up by its `place` hints. Nodes on a zone's edge straddle its border.
 * Members of an open group sit together, outlined.
 */
function arrange(spec: Spec, scene: Scene, boxes: Boxes, ordered: { zones: ZoneBox[]; nodes: Map<string, Box> }, view: View): Layout {
  const nodeOf = new Map(scene.nodes.map((n) => [n.id, n]));
  const openOf = new Map(scene.open.flatMap((g) => g.nodes.map((id) => [id, g.id] as const)));
  const columns = columnOrder(spec, ordered.zones).map((zone) => {
    const place = spec.zones.find((z) => z.name === zone.name)?.place ?? {};
    const all = [...ordered.nodes]
      .filter(([id]) => nodeOf.get(id)?.zone === zone.name)
      // By order, then open groups together, then by label, so things named alike sit together ("Studio app", "Studio daemon").
      .sort(([a], [b]) => {
        const x = nodeOf.get(a)!;
        const y = nodeOf.get(b)!;
        return x.order - y.order || (openOf.get(a) ?? x.label).localeCompare(openOf.get(b) ?? y.label, undefined, { numeric: true }) || x.label.localeCompare(y.label, undefined, { numeric: true });
      });
    const inner = all.filter(([id]) => !nodeOf.get(id)!.edge);
    const edges = all.filter(([id]) => nodeOf.get(id)!.edge);
    const region = place.region ?? all.some(([id]) => nodeOf.get(id)!.singleton);
    const arrange = place.arrange ?? "stack";
    const sized = block(arrange, inner.map(([, b]) => b), GAP);
    return { zone, place, inner, edges, region, arrange, width: sized.w + (region ? 64 : 0), height: sized.h };
  });
  const used = columns.reduce((sum, c) => sum + c.width, 0);
  const minGap = columns.some((c) => c.edges.length) ? 120 : 72;
  const gap = columns.length > 1 ? Math.min(260, Math.max(minGap, (view.w - RESERVE.side * 2 - used) / (columns.length - 1))) : 0;
  const width = Math.max(view.w, used + gap * (columns.length - 1) + RESERVE.side * 2);
  const top = RESERVE.top + RESERVE.caption;
  const tallest = Math.max(...columns.map((c) => c.height + (c.region ? 80 : 0)));
  const height = Math.max(view.h, top + tallest + RESERVE.bottom);
  const room = height - top - RESERVE.bottom;
  const out: Layout = { width, height, zones: [], nodes: new Map(), groups: [] };
  const put = (id: string, at: Box) => {
    const b = boxes.get(id)!;
    out.nodes.set(id, { ...at, kind: b.kind, anchor: b.anchor });
  };
  let x = (width - used - gap * (columns.length - 1)) / 2;
  for (const column of columns) {
    const inner = column.region ? room - 80 : room;
    // Spread a stack down the room it has, within reason; rows and grids keep their spacing.
    const vgap = column.arrange === "stack" && column.inner.length > 1 ? Math.min(96, Math.max(GAP, (inner - column.inner.reduce((s, [, b]) => s + b.h, 0)) / column.inner.length)) : GAP;
    const laid = block(column.arrange, column.inner.map(([, b]) => b), vgap);
    const align = column.place.align ?? (column.region ? "start" : "center");
    const free = Math.max(0, inner - laid.h);
    const y0 = top + (column.region ? 32 : 0) + (align === "start" ? 0 : align === "end" ? free : free / 2);
    const x0 = x + (column.width - laid.w) / 2;
    column.inner.forEach(([id, box], i) => put(id, { x: x0 + laid.places[i].x, y: y0 + laid.places[i].y, w: box.w, h: box.h }));
    const zone: ZoneBox = column.region ? { name: column.zone.name, region: true, x, y: top - 12, w: column.width, h: room + 12 } : { name: column.zone.name, region: false, x, y: top, w: column.width, h: room };
    // On the edge: straddling the border, spread around the middle of the zone's height.
    for (const side of ["left", "right"] as const) {
      const list = column.edges.filter(([id]) => nodeOf.get(id)!.edge === side);
      const stack = block("stack", list.map(([, b]) => b), GAP);
      list.forEach(([id, box], i) => put(id, { x: (side === "left" ? zone.x : zone.x + zone.w) - box.w / 2, y: zone.y + (zone.h - stack.h) / 2 + stack.places[i].y, w: box.w, h: box.h }));
    }
    out.zones.push(zone);
    x += column.width + gap;
  }
  for (const group of scene.open) {
    const members = group.nodes.map((id) => out.nodes.get(id)).filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (!members.length) continue;
    const x0 = Math.min(...members.map((b) => b.x)) - 12;
    const y0 = Math.min(...members.map((b) => b.y)) - 22;
    const x1 = Math.max(...members.map((b) => b.x + b.w)) + 12;
    const y1 = Math.max(...members.map((b) => b.y + b.h)) + 8;
    out.groups.push({ id: group.id, label: group.label, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return out;
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
