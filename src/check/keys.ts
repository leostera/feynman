// State identity for deduplication: when two worlds behave the same from here on.
//
// - Ids are left out. Messages in flight are a bag: any may arrive next (RFD0004). Timers
//   that are set are a sequence, oldest first: any may fire next too, but the system left
//   alone fires the oldest (judge.ts), so how old each is decides what it does from here.
// - Instances of one actor that are interchangeable (symmetry) are renamed to a canonical
//   order, so "Alice did it, then Bob" and "Bob did it, then Alice" are one state.
// - Object keys are sorted: a map that gained its entries in another order is the same map.
//   This assumes no handler's behaviour depends on key order, which is safe for messages
//   (in flight they are a bag) and true of any spec that uses an object as a map.
import { actorNamed, type Spec, type World } from "../spec/index.ts";

type Pending = World["pending"][number];

/** Each frozen value's JSON, once: states and payloads are shared between worlds. */
const texts = new WeakMap<object, string>();

export function textOf(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  let text = texts.get(value);
  if (text === undefined) texts.set(value, (text = sortedJson(value)));
  return text;
}

/** JSON with every object's keys in order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)) ?? "null";
}

/** A key line after renaming: names that were object keys may now be out of order, so sort them again. */
function resorted(line: string, renamedLine: string): string {
  if (line === renamedLine) return line;
  // Instance lines are `id=json`; message lines `d|to|from|message|json`; timer lines hold no JSON.
  const at = renamedLine.startsWith("d|") ? nthIndex(renamedLine, "|", 4) : renamedLine.startsWith("timers ") || renamedLine.startsWith("t|") ? -1 : renamedLine.indexOf("=");
  if (at < 0) return renamedLine;
  return renamedLine.slice(0, at + 1) + sortedJson(JSON.parse(renamedLine.slice(at + 1)));
}

function nthIndex(text: string, char: string, n: number): number {
  let at = -1;
  for (let i = 0; i < n; i++) if ((at = text.indexOf(char, at + 1)) < 0) return -1;
  return at;
}

/** What a pending event carries: entries are shared between worlds, so worked out once each. */
const pendingTexts = new WeakMap<object, string>();

export function pendingText(p: Pending): string {
  let text = pendingTexts.get(p);
  if (text === undefined) pendingTexts.set(p, (text = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${textOf(p.payload)}` : `t|${p.to}|${p.timer}`));
  return text;
}

/** The lines a world's key is made of, before renaming and sorting: timers make one line, in age order. */
function keyParts(world: World): { instances: string[]; pending: string[]; rest: string } {
  const timers = world.pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id);
  const messages = world.pending.filter((p) => p.kind === "deliver").map(pendingText);
  return {
    instances: world.instances.map((i) => `${i.id}=${textOf(i.state)}`),
    pending: timers.length ? [...messages, `timers ${timers.map(pendingText).join(" ")}`] : messages,
    rest: `${JSON.stringify(world.fresh)}|${world.rng}`,
  };
}

function joinParts(instances: string[], pending: string[], rest: string): string {
  return `${instances.sort().join("\n")}\n--\n${pending.sort().join("\n")}\n--\n${rest}`;
}

/** A world's identity for deduplication: instances and what is pending, without ids. */
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
    const initial = instances.map((i) => sortedJson(actor.initialState({ id: i.id, label: i.label })));
    const swapsCleanly = instances.every((a, n) => instances.every((b, m) => sortedJson(JSON.parse(rename(initial[n], new Map([[a.id, b.id], [a.label, b.label], [b.id, a.id], [b.label, a.label]])))) === initial[m]));
    if (swapsCleanly) classes.push({ ids: instances.map((i) => i.id), labels: instances.map((i) => i.label) });
  }
  return { classes, renamings: renamings(classes) };
}

/**
 * The key of a world up to symmetry: the least key among the renamings of every class. Two
 * worlds that are renamings of each other get the same key.
 */
export function symmetricKey(world: World, symmetry: Symmetry): string {
  return leastRenaming(world, symmetry).key;
}

/** The renaming that gives a world its least key, and that key; no renaming without symmetry. */
export function leastRenaming(world: World, symmetry: Symmetry): { key: string; renaming: Map<string, string> } {
  if (!symmetry.classes.length) return { key: canonical(world), renaming: new Map() };
  const { instances, pending, rest } = keyParts(world);
  let best: { key: string; renaming: Map<string, string> } | undefined;
  for (const renaming of symmetry.renamings) {
    const key = joinParts(
      instances.map((line) => resorted(line, rename(line, renaming))),
      pending.map((line) => resorted(line, rename(line, renaming))),
      rest,
    );
    if (best === undefined || key < best.key) best = { key, renaming };
  }
  return best!;
}

/** A name, or text holding names, as the renaming has it. */
export function renamed(text: string, renaming: Map<string, string>): string {
  return renaming.size ? rename(text, renaming) : text;
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
