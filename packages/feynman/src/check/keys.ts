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
import { sortedJson } from "../spec/json.ts";

type Pending = World["pending"][number];

/** Each frozen value's JSON, once: states and payloads are shared between worlds. */
const texts = new WeakMap<object, string>();

export function textOf(value: unknown): string {
  if (value === null || typeof value !== "object") return sortedJson(value);
  let text = texts.get(value);
  if (text === undefined) texts.set(value, (text = sortedJson(value)));
  return text;
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
  if (text === undefined) pendingTexts.set(p, (text = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${textOf(p.payload)}${p.answers ? `|a|${p.answers.message}|${textOf(p.answers.payload)}` : ""}` : `t|${p.to}|${p.timer}`));
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
export function leastRenaming(world: World, symmetry: Symmetry): { key: string; renaming: Map<string, string>; plain: string } {
  if (!symmetry.classes.length) {
    const key = canonical(world);
    return { key, renaming: new Map(), plain: key };
  }
  const { instances, pending, rest } = keyParts(world);
  let best: { key: string; renaming: Map<string, string> } | undefined;
  let plain = "";
  for (const renaming of symmetry.renamings) {
    const key = joinParts(
      instances.map((line) => renamedLine(line, renaming)),
      pending.map((line) => renamedLine(line, renaming)),
      rest,
    );
    if (isIdentity(renaming)) plain = key;
    if (best === undefined || key < best.key) best = { key, renaming };
  }
  return { ...best!, plain };
}

const identities = new WeakMap<Map<string, string>, boolean>();

function isIdentity(renaming: Map<string, string>): boolean {
  let out = identities.get(renaming);
  if (out === undefined) identities.set(renaming, (out = [...renaming].every(([from, to]) => from === to)));
  return out;
}

/**
 * Each renaming's renamed key lines, once each: worlds share most of their lines (states and
 * payloads are frozen and shared), and renaming one means parsing and sorting its JSON again.
 * Bounded, so a long search does not keep every line it ever saw.
 */
const renamedLines = new WeakMap<Map<string, string>, Map<string, string>>();
const RENAMED_LINES = 100_000;

export function renamedLine(line: string, renaming: Map<string, string>): string {
  let cache = renamedLines.get(renaming);
  if (!cache) renamedLines.set(renaming, (cache = new Map()));
  let out = cache.get(line);
  if (out === undefined) {
    out = resorted(line, rename(line, renaming));
    if (cache.size >= RENAMED_LINES) cache.clear();
    cache.set(line, out);
  }
  return out;
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

// Fingerprints ---------------------------------------------------------------------------------------

/**
 * A state's 64-bit fingerprint, as two 32-bit halves: what the search remembers of each state
 * (as TLC does), and all that crosses between threads. Two states share one with odds of
 * about n²/2⁶⁵ for n states: one in 36 million at a million states.
 */
export function fingerprint(text: string): [number, number] {
  return halves(Bun.hash.wyhash(text, SEED));
}

/** A 52-bit hash of a short name (a step's name in a sleep set, a fair step's identity), exact as a number. */
export function nameHash(text: string): number {
  return Number(Bun.hash.wyhash(text, 0x2545f4914f6cdd1dn) & 0xfffffffffffffn);
}

/**
 * A state's fingerprint: its world up to symmetry, plus `extra` (the budget spent and what
 * `never` properties remember); and the fingerprint of the world without renaming, which
 * renamed twins do not share.
 *
 * Without symmetry it is taken without writing the world's key: each instance's and each
 * pending entry's line has a hash of its own, kept on the (frozen, shared) object, and the
 * fingerprint is a hash of those hashes, sorted. With symmetry, the least key among the
 * renamings has to be written out to be found.
 */
export function statePrint(world: World, symmetry: Symmetry, extra: string): { print: [number, number]; plain: [number, number] } {
  if (symmetry.classes.length) {
    const { key, plain } = leastRenaming(world, symmetry);
    return { print: fingerprint(key + extra), plain: fingerprint(plain) };
  }
  const print = halves(Bun.hash.wyhash(extra, worldHash(world)));
  return { print, plain: print };
}

/** A hash of a world as `canonical` writes it, from the hashes of its lines. */
function worldHash(world: World): bigint {
  const pending = world.pending;
  let messages = 0;
  let timers = 0;
  for (const p of pending) p.kind === "deliver" ? messages++ : timers++;
  const n = world.instances.length;
  // [instances, their lines' hashes (sorted), messages' hashes (sorted), timers in age order, the counters]
  const words = new BigUint64Array(1 + n + messages + 2);
  words[0] = BigInt(n);
  for (let i = 0; i < n; i++) words[1 + i] = instanceHash(world.instances[i]);
  let at = 1 + n;
  for (const p of pending) if (p.kind === "deliver") words[at++] = pendingHash(p);
  words.subarray(1, 1 + n).sort();
  words.subarray(1 + n, at).sort();
  words[at++] = timers ? Bun.hash.wyhash(pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id).map(pendingText).join(" "), SEED) : 0n;
  words[at] = Bun.hash.wyhash(`${JSON.stringify(world.fresh)}|${world.rng}`, SEED);
  return Bun.hash.wyhash(words, SEED);
}

const SEED = 0x9e3779b97f4a7c15n;
const lineHashes = new WeakMap<object, bigint>();

/** An instance's line (`id=state`), hashed once per instance object: unchanged instances are shared between worlds. */
function instanceHash(instance: World["instances"][number]): bigint {
  let h = lineHashes.get(instance);
  if (h === undefined) lineHashes.set(instance, (h = Bun.hash.wyhash(`${instance.id}=${textOf(instance.state)}`, SEED)));
  return h;
}

function pendingHash(p: Pending): bigint {
  let h = lineHashes.get(p);
  if (h === undefined) lineHashes.set(p, (h = Bun.hash.wyhash(pendingText(p), SEED)));
  return h;
}

function halves(h: bigint): [number, number] {
  return [Number(h >> 32n), Number(h & 0xffffffffn)];
}
