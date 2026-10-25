// The playground's topology, laid out by ELK: zones are boxes, instances are nodes inside
// their actor's zone, and an edge joins two instances whose actors exchange messages.
// Nothing is placed by hand; the layout depends only on which instances exist.
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

export interface Layout {
  width: number;
  height: number;
  zones: (Box & { name: string })[];
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
export function layoutKey(spec: Spec, world: World): string {
  const hubs = world.instances.filter((i) => shapeOf(spec.actors.find((a) => a.name === i.actor)!) === "hub").map((i) => hubHeight(appearance(spec, world, i.id).rows));
  return `${spec.name}:${world.instances.map((i) => i.id).join(",")}:${hubs.join(",")}`;
}

export async function layout(spec: Spec, world: World): Promise<Layout> {
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
    result.zones.push({ name: zone.id.slice(5), x: zone.x!, y: zone.y!, w: zone.width!, h: zone.height! });
    for (const node of zone.children ?? []) result.nodes.set(node.id, { x: node.x!, y: node.y!, w: node.width!, h: node.height! });
  }
  for (const edge of out.edges ?? []) {
    const [section] = edge.sections ?? [];
    if (!section) continue;
    result.edges.set(edgeKey(edge.sources[0], edge.targets[0]), [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
  }
  return result;
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
