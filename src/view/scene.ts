// The scene: the world as the playground draws it. Most instances are one node each; the
// members of a closed group are one node between them (the relay, rather than its Worker
// and Durable Objects; one Mac, rather than its app and daemon). Messages between members
// of one node are internal to it, and links between them are not drawn.
import { appearance, liveLinks, type Appearance, type GroupInfo, type InstanceState, type LiveLink, type Shape, type Spec, type Token, type World } from "../spec/index.ts";
import { shapeFor, telling } from "../play/index.ts";

export interface SceneNode {
  id: string;
  label: string;
  members: InstanceState[];
  /** The group it stands for, closed; null for a single instance. */
  group: GroupInfo | null;
  zone: string;
  /** Exactly one in every world: everyone talks to it. */
  singleton: boolean;
  order: number;
  edge?: "left" | "right";
}

export interface OpenGroup {
  /** The node id it has while closed. */
  id: string;
  group: GroupInfo;
  label: string;
  /** The nodes its members are drawn as while open. */
  nodes: string[];
}

export interface Scene {
  nodes: SceneNode[];
  /** Instance id → the id of the node it is drawn in. */
  of: Map<string, string>;
  open: OpenGroup[];
  /** Every group in this world, open or not, by its node id: what can be opened or closed. */
  groups: Map<string, { group: GroupInfo; label: string }>;
}

export function groupNodeId(group: GroupInfo, key: string | null): string {
  return key === null ? `group:${group.name}` : `group:${group.name}:${key}`;
}

/** The group an instance belongs to, and its key in it: "Studio app" is "Studio" in a group with suffix "app". */
function membership(groups: GroupInfo[], instance: InstanceState): { group: GroupInfo; key: string | null } | null {
  for (const group of groups) {
    const member = group.members.find((m) => m.actor === instance.actor);
    if (!member) continue;
    if (member.suffix === null) return { group, key: null };
    const tail = ` ${member.suffix}`;
    return { group, key: instance.label.toLowerCase().endsWith(tail.toLowerCase()) ? instance.label.slice(0, -tail.length) : instance.label };
  }
  return null;
}

export function sceneOf(spec: Spec, world: World, groups: GroupInfo[], opened: ReadonlySet<string>): Scene {
  const actorOf = (name: string) => spec.actors.find((a) => a.name === name)!;
  const nodes: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();
  const of = new Map<string, string>();
  const open = new Map<string, OpenGroup>();
  const all = new Map<string, { group: GroupInfo; label: string }>();
  const single = (instance: InstanceState): SceneNode => {
    const actor = actorOf(instance.actor);
    return { id: instance.id, label: instance.label, members: [instance], group: null, zone: actor.zone, singleton: actor.singleton, order: actor.place.order ?? 0, edge: actor.place.edge };
  };
  for (const instance of world.instances) {
    const found = membership(groups, instance);
    if (!found) {
      const node = single(instance);
      nodes.push(node);
      of.set(instance.id, node.id);
      continue;
    }
    const id = groupNodeId(found.group, found.key);
    const label = found.key ?? found.group.name;
    all.set(id, { group: found.group, label });
    // Closed unless opened, or open unless closed, as the group starts.
    const isOpen = found.group.collapsed ? opened.has(id) : !opened.has(id);
    if (isOpen) {
      const node = single(instance);
      nodes.push(node);
      of.set(instance.id, node.id);
      const entry = open.get(id) ?? { id, group: found.group, label, nodes: [] };
      entry.nodes.push(node.id);
      open.set(id, entry);
      continue;
    }
    let node = byId.get(id);
    if (!node) {
      const actor = actorOf(instance.actor);
      node = { id, label, members: [], group: found.group, zone: actor.zone, singleton: found.key === null, order: actor.place.order ?? 0 };
      byId.set(id, node);
      nodes.push(node);
    }
    node.members.push(instance);
    node.order = Math.min(node.order, actorOf(instance.actor).place.order ?? 0);
    of.set(instance.id, id);
  }
  return { nodes, of, open: [...open.values()], groups: all };
}

/** How a node is displayed: one instance's display, or its members' merged. */
export interface NodeDisplay extends Appearance {
  shape: Shape;
  /** Tokens with the instance holding each. */
  held: { token: Token; from: string }[];
}

const RANK = { bad: 4, warn: 3, busy: 2, ok: 1 } as const;

export function nodeDisplay(spec: Spec, world: World, node: SceneNode): NodeDisplay {
  const displays = node.members.map((m) => ({ member: m, display: appearance(spec, world, m.id) }));
  if (!node.group) {
    const [{ member, display }] = displays;
    const actor = spec.actors.find((a) => a.name === member.actor)!;
    return { ...display, shape: shapeFor({ icon: display.icon, shape: actor.display.shape }, Boolean(node.edge)), held: display.tokens.map((token) => ({ token, from: member.id })) };
  }
  // The most telling mood speaks for the node, and its status with it; on a tie, the later
  // member, which is usually the one doing the work (the daemon, not the app).
  const told = [...displays].reverse().filter((l) => telling(l.display.mood)).sort((a, b) => RANK[b.display.mood as keyof typeof RANK] - RANK[a.display.mood as keyof typeof RANK])[0];
  const keyed = node.group.members.some((m) => m.suffix !== null);
  const icon = node.group.icon ?? displays.find((l) => l.display.icon)?.display.icon ?? null;
  return {
    icon,
    shape: node.group.shape ?? shapeFor({ icon }),
    status: told?.display.status ?? (keyed ? (displays.at(-1)?.display.status ?? null) : null),
    mood: told?.display.mood ?? null,
    rows: displays.flatMap((l) => l.display.rows),
    tokens: displays.flatMap((l) => l.display.tokens),
    held: displays.flatMap((l) => l.display.tokens.map((token) => ({ token, from: l.member.id }))),
    owner: displays.find((l) => l.display.owner !== undefined)?.display.owner,
  };
}

/** Live links between nodes: a link within one node is not drawn. */
export function sceneLinks(spec: Spec, world: World, scene: Scene): (LiveLink & { fromNode: string; toNode: string })[] {
  const out: (LiveLink & { fromNode: string; toNode: string })[] = [];
  for (const link of liveLinks(spec, world)) {
    const fromNode = scene.of.get(link.from);
    const toNode = scene.of.get(link.target);
    if (fromNode && toNode && fromNode !== toNode) out.push({ ...link, fromNode, toNode });
  }
  return out;
}

/**
 * A name as the scene shows it: an instance drawn inside a closed group reads as the
 * group's node ("Studio daemon" is "Studio" while the Mac is one node). Other text is left.
 */
export function shownAs(scene: Scene, world: World, text: string): string {
  const instance = world.instances.find((i) => i.label === text || i.id === text);
  const node = instance && scene.nodes.find((n) => n.id === scene.of.get(instance.id));
  return node?.group ? node.label : text;
}
