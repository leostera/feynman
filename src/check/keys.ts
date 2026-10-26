// State identity for deduplication: when two worlds behave the same from here on.
//
// - Ids are left out, and so is absolute time until a step reads the clock (World.stamped):
//   before that no state can hold a time, so what matters is what is pending and how soon.
// - A pending event already due fires at the current time however overdue it is, so only
//   the order of the overdue ones is kept, not by how much they are overdue.
// - Instances of one actor that are interchangeable (symmetry) are renamed to a canonical
//   order, so "Alice did it, then Bob" and "Bob did it, then Alice" are one state.
import { actorNamed, type Spec, type World } from "../spec/index.ts";

type Pending = World["pending"][number];

/** Each frozen value's JSON, once: states and payloads are shared between worlds. */
const texts = new WeakMap<object, string>();

export function textOf(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  let text = texts.get(value);
  if (text === undefined) texts.set(value, (text = JSON.stringify(value)));
  return text;
}

/** What is pending, apart from when: entries are shared between worlds, so worked out once each. */
const pendingTexts = new WeakMap<object, string>();

export function pendingText(p: Pending): string {
  let text = pendingTexts.get(p);
  if (text === undefined) pendingTexts.set(p, (text = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${textOf(p.payload)}` : `t|${p.to}|${p.timer}`));
  return text;
}

/**
 * When each pending event is due, as part of a key: how far ahead, or, once due, its rank
 * among the overdue ones ("late0" is the most overdue). Ties share a rank: nothing depends on
 * the order events due at once were sent in (the search and the system left alone take them
 * in every order).
 */
export function dueTimes(world: World): Map<Pending, string> {
  const out = new Map<Pending, string>();
  const overdue = world.pending.filter((p) => p.at <= world.clock);
  const ranks = [...new Set(overdue.map((p) => p.at))].sort((a, b) => a - b);
  for (const p of world.pending) out.set(p, p.at <= world.clock ? `late${ranks.indexOf(p.at)}` : String(p.at - world.clock));
  return out;
}

/** The lines a world's key is made of, before renaming and sorting. */
function keyParts(world: World): { instances: string[]; pending: string[]; rest: string } {
  const due = dueTimes(world);
  return {
    instances: world.instances.map((i) => `${i.id}=${textOf(i.state)}`),
    pending: world.pending.map((p) => `${due.get(p)}|${pendingText(p)}`),
    // Once a state may hold an absolute time, when the world is matters too.
    rest: `${JSON.stringify(world.fresh)}|${world.rng}${world.stamped ? `|@${world.clock}` : ""}`,
  };
}

function joinParts(instances: string[], pending: string[], rest: string): string {
  return `${instances.sort().join("\n")}\n--\n${pending.sort().join("\n")}\n--\n${rest}`;
}

/** A world's identity for deduplication: instances and what is pending, without ids or absolute times. */
export function canonical(world: World): string {
  const { instances, pending, rest } = keyParts(world);
  return joinParts(instances, pending, rest);
}

// Symmetry -------------------------------------------------------------------------------------------

/** Instances of one actor that can stand in for each other, by id; their labels go with them. */
export interface Symmetry {
  classes: { ids: string[]; labels: string[] }[];
  /** Every renaming that permutes instances within their classes, worked out once. */
  renamings: Map<string, string>[];
}

/** Most interchangeable instances in one class; beyond this the renamings are not worth trying. */
const MAX_CLASS = 4;

/**
 * Classes of interchangeable instances in a world: several instances of one actor declared
 * `symmetric`, whose initial states are the same once their ids and labels are swapped. The
 * declaration is a claim about the handlers, which no look at the data can confirm (a spec
 * that elects the highest id has symmetric initial states); the search tests it as it goes.
 */
export function symmetryOf(spec: Spec, world: World): Symmetry {
  const byActor = new Map<string, World["instances"]>();
  for (const i of world.instances) byActor.set(i.actor, [...(byActor.get(i.actor) ?? []), i]);
  const classes: Symmetry["classes"] = [];
  for (const [name, instances] of byActor) {
    const actor = actorNamed(spec, name);
    if (!actor.symmetric || actor.singleton || instances.length < 2 || instances.length > MAX_CLASS) continue;
    const initial = instances.map((i) => JSON.stringify(actor.initialState({ id: i.id, label: i.label })));
    const swapsCleanly = instances.every((a, n) => instances.every((b, m) => rename(initial[n], new Map([[a.id, b.id], [a.label, b.label], [b.id, a.id], [b.label, a.label]])) === initial[m]));
    if (swapsCleanly) classes.push({ ids: instances.map((i) => i.id), labels: instances.map((i) => i.label) });
  }
  return { classes, renamings: renamings(classes) };
}

/**
 * The key of a world up to symmetry: the least key among the renamings of every class. Two
 * worlds that are renamings of each other get the same key.
 */
export function symmetricKey(world: World, symmetry: Symmetry): string {
  if (!symmetry.classes.length) return canonical(world);
  const { instances, pending, rest } = keyParts(world);
  let best: string | undefined;
  for (const renaming of symmetry.renamings) {
    const key = joinParts(
      instances.map((line) => rename(line, renaming)),
      pending.map((line) => rename(line, renaming)),
      rest,
    );
    if (best === undefined || key < best) best = key;
  }
  return best!;
}

/** Every renaming that permutes instances within their classes, ids and labels together. */
function renamings(classes: Symmetry["classes"]): Map<string, string>[] {
  let out: Map<string, string>[] = [new Map()];
  for (const { ids, labels } of classes) {
    out = out.flatMap((base) =>
      permutations(ids.length).map((perm) => {
        const map = new Map(base);
        perm.forEach((to, from) => {
          map.set(ids[from], ids[to]);
          map.set(labels[from], labels[to]);
        });
        return map;
      }),
    );
  }
  return out;
}

function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  return permutations(n - 1).flatMap((perm) => Array.from({ length: n }, (_, at) => [...perm.slice(0, at), n - 1, ...perm.slice(at)]));
}

const patterns = new WeakMap<Map<string, string>, RegExp | null>();

/** Replace every whole-word occurrence of a name, all at once, so swaps do not collide. */
function rename(text: string, renaming: Map<string, string>): string {
  let pattern = patterns.get(renaming);
  if (pattern === undefined) {
    const names = [...renaming].filter(([from, to]) => from !== to && from).map(([from]) => from);
    pattern = names.length ? new RegExp(`(?<![\\w-])(${names.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\w-])`, "g") : null;
    patterns.set(renaming, pattern);
  }
  return pattern ? text.replace(pattern, (name) => renaming.get(name)!) : text;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const NO_SYMMETRY: Symmetry = { classes: [], renamings: [] };
