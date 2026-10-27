// The breadth-first search's coordinator (RFD0007). It runs on the main thread and holds what
// the search knows of each node (its parent, depth, budget, which owner holds its world) and
// the fingerprint of every state seen. Owners (owner.ts) hold the worlds and expand them.
//
// The search goes one depth level at a time:
// 1. prepare: owners keep the successors found new last round, as the node ids given, wake
//    steps a revisit asks for, and hand nodes over to even out the work;
// 2. expand: each owner expands its share of the frontier, and reports a fingerprint per
//    successor, plus what each breaks;
// 3. merge: the coordinator goes through the successors in frontier order, as one thread
//    would, and decides which are new, which break a property first, which land on a state
//    seen before; so the result is the same however many owners there are;
// 4. query, when a successor lands on a state whose skipped steps it may wake (sleep sets),
//    or on a renamed twin whose symmetry claim is to be tested: what those need is asked of
//    the owners that hold them.
//
// The first owner runs on the main thread. Worker owners join once the frontier is big
// enough to share, if the spec can be loaded by them (by path: specs hold functions, which
// cannot be sent).
import type { Fairness, Spec, World } from "../spec/index.ts";
import { isLiveness } from "../spec/index.ts";
import { statePrint, type Symmetry } from "./keys.ts";
import { predicatesOf, type Edge, type FairId, type Graph, type LassoStep, type Predicate } from "./liveness.ts";
import { budgetText, FAILED, FAULT, rootMemory, SLEEPY, type Answer, type Entry, type Expansion, type Moved, type Note, type Prepared, type Query, type Ref, type Resolved, type Stats } from "./owner.ts";
import type { Driver, InlineDriver } from "./pool.ts";
import { PrintMap } from "./prints.ts";
import type { Choice } from "./steps.ts";
import type { Bounds, Report, Watch } from "./explore.ts";

/** Where paths start: the initial world, then each seed, with the symmetry of each. */
export interface Root {
  name?: string;
  world: World;
  symmetry: Symmetry;
}

export interface SearchSetup {
  spec: Spec;
  b: Bounds;
  roots: Root[];
  watch: Watch;
  started: number;
  /** The owner on the main thread. */
  inline: InlineDriver;
  /** Worker owners, when they can load the spec; started once the frontier is big enough to share. */
  spawn?: () => Promise<Driver[]>;
}

/** Frontier size at which worker owners are started: below it, starting them costs more than they save. */
const SPAWN_AT = 256;

/** A node to expand next: a new one, or one expanded before whose woken steps (`only`) are now to be tried. */
type Item = { gid: number; only?: number[] } | { revisit: number };

/** A successor that landed on a state with skipped steps: they may need waking. */
interface Revisit {
  existing: number;
  from: { owner: number; k: number };
  /** The arriving world without renaming: a renamed twin's step names do not match. */
  plain: [number, number];
}

/** A successor that landed on a renamed twin: both must have the same next steps. */
interface Twin {
  existing: number;
  from: { owner: number; k: number };
}

/** What a round of merging leaves for the next round. */
interface Round {
  /** Per owner: pairs of (candidate index, node id) to keep. */
  keep: number[][];
  /** Nodes made this round, still candidates of the owner that made them. */
  fresh: Map<number, { owner: number; k: number }>;
  next: Item[];
  revisits: Revisit[];
  twins: Twin[];
  /** Per node: hashes of step names to wake. */
  wake: Map<number, Set<number>>;
}

export class Search {
  // What the search knows of each node, by id.
  readonly parent: number[] = [];
  readonly root: number[] = [];
  readonly depth: number[] = [];
  readonly faults: number[] = [];
  /** Which of the parent's options leads here, and whether that step is a fault. */
  readonly option: number[] = [];
  readonly faultIn: boolean[] = [];
  /** The owner holding the node's world. */
  readonly holder: number[] = [];
  /** Stands only for a counterexample's last step (an error, a broken step), not for a state. */
  readonly shadow: boolean[] = [];
  readonly expanded: boolean[] = [];
  private readonly sleepy: boolean[] = [];
  /** Fingerprints of worlds without renaming, for roots with symmetry. */
  private readonly plains: [number, number][] = [];

  /** For liveness: edges out of each expanded node, the fair steps possible there, and which predicates hold. */
  readonly edges: Edge[][] = [];
  readonly enabled: Map<FairId, Fairness>[] = [];
  private readonly truths: number[][];
  private readonly predicates: Predicate[];

  /** The node where each property first broke, and where each spec error was first met. */
  readonly failures = new Map<string, number>();
  readonly errors = new Map<string, number>();
  stuckAt: number | undefined;
  states = 0;
  depthReached = 0;
  stoppedBy: Report["stoppedBy"];
  refuted = false;
  stats: Stats = { reached: [], orders: 0, inputs: 0 };

  private readonly spec: Spec;
  private readonly b: Bounds;
  readonly roots: Root[];
  private readonly watch: Watch;
  private readonly started: number;
  private readonly keepsEdges: boolean;
  private readonly seen = new PrintMap();
  private readonly owners: Driver[];
  private readonly broken = new Set<string>();
  /** Broken since the owners were last told. */
  private newlyBroken: string[] = [];
  private twinChecks = 0;
  private readonly spawn?: () => Promise<Driver[]>;
  /** Worker owners: not asked for yet, starting, ready to join (or failed to start), or joined. */
  private workers: { state: "idle" | "starting" | "joined" } | { state: "ready"; drivers: Driver[] } | { state: "failed"; error: unknown } = { state: "idle" };
  /** The frontier being expanded: items by slot. */
  private frontier: Item[] = [];

  constructor(setup: SearchSetup) {
    ({ spec: this.spec, b: this.b, roots: this.roots, watch: this.watch, started: this.started, spawn: this.spawn } = setup);
    this.owners = [setup.inline];
    this.keepsEdges = this.spec.properties.some(isLiveness);
    this.predicates = predicatesOf(this.spec.properties.filter(isLiveness));
    this.truths = this.predicates.map(() => []);
  }

  /** How many owners took part. */
  get ownerCount(): number {
    return this.owners.length;
  }

  async run(): Promise<void> {
    let round = this.start();
    while (true) {
      // The main thread's owner answers at once, so without this the workers' replies, which
      // arrive as events, would wait until the search is over.
      if (this.workers.state === "starting") await new Promise((resolve) => setImmediate(resolve));
      const imports = await this.prepare(round);
      if (this.stoppedBy || !round.next.length) break;
      round = this.merge(await this.expand(round, imports));
      if (!this.stoppedBy && (round.revisits.length || round.twins.length)) await this.query(round);
      if (this.refuted) return;
    }
    // Liveness needs the edges out of the worlds at the depth bound too. Where every step from
    // one lands on a known state, nothing lies past it, and its edges are added: in a space the
    // bound does not cut, liveness is then judged in full, as TLC would.
    if (this.keepsEdges && !this.stoppedBy) await this.close();
    this.stats = mergeStats(await all(this.owners, (owner) => owner.stats()));
  }

  /** The choices on the search's path to each node, from its root. */
  async paths(gids: number[]): Promise<Map<number, Choice[]>> {
    const steps = new Map<number, LassoStep[]>();
    for (const gid of gids) {
      const path: LassoStep[] = [];
      for (let i = gid; this.parent[i] >= 0; i = this.parent[i]) path.push({ from: this.parent[i], option: this.option[i] });
      steps.set(gid, path.reverse());
    }
    const resolved = await this.resolve([...steps.values()].flat(), false);
    return new Map([...steps].map(([gid, path]) => [gid, path.map((s) => resolved.get(stepKey(s))!.choice)]));
  }

  /** Steps as choices, with the world each is taken in when asked for. */
  async resolve(steps: LassoStep[], worlds: boolean): Promise<Map<string, Resolved>> {
    const byOwner = this.owners.map((): LassoStep[] => []);
    const unique = new Map(steps.map((s) => [stepKey(s), s]));
    for (const s of unique.values()) byOwner[this.holder[s.from]].push(s);
    const answers = await all(this.owners, (owner, w) => (byOwner[w].length ? owner.resolve(byOwner[w].map((s) => ({ gid: s.from, option: s.option })), worlds) : Promise.resolve([])));
    return new Map(byOwner.flatMap((list, w) => list.map((s, i): [string, Resolved] => [stepKey(s), answers[w][i]])));
  }

  graph(): Graph {
    const size = this.parent.length;
    const index = new Map(this.predicates.map((p, i) => [p, i]));
    return {
      size,
      holds: (predicate) => {
        const truths = this.truths[index.get(predicate)!];
        return (i) => truths[i] === 1;
      },
      roots: this.parent.flatMap((p, i) => (p < 0 ? [i] : [])),
      initial: 0,
      expanded: this.expanded,
      shadow: this.shadow,
      edges: Array.from({ length: size }, (_, i) => this.edges[i] ?? []),
      enabled: Array.from({ length: size }, (_, i) => this.enabled[i] ?? new Map()),
      parent: this.parent,
      optionFrom: this.option,
      faultFrom: this.faultIn,
    };
  }

  /** One node per distinct root, all held by the first owner. */
  private start(): Round {
    const round = emptyRound(1);
    const memory = rootMemory(this.spec);
    for (const [r, { world, symmetry }] of this.roots.entries()) {
      const { print, plain } = statePrint(world, symmetry, budgetText({ acts: {}, faults: 0 }, memory));
      const [hi, lo] = print;
      if (this.seen.get(hi, lo) !== undefined) continue;
      const gid = this.node({ parent: -1, root: r, option: -1, fault: false, holder: 0, shadow: false, sleepy: false, plain: symmetry.classes.length ? plain : undefined });
      this.seen.set(hi, lo, gid);
      this.states++;
      round.keep[0].push(-(r + 1), gid);
      if (this.b.depth > 0) round.next.push({ gid });
      this.watch.state?.(world, { acts: {}, faults: 0, memory });
    }
    return round;
  }

  /** Owners keep what the last round found new, wake steps, and hand nodes over; returns what each owner is handed. */
  private async prepare(round: Round): Promise<Moved[][]> {
    this.join(round);
    const moves = this.balance(round);
    const wake = this.owners.map((): { gid: number; names: number[] }[] => []);
    for (const [gid, names] of round.wake) wake[this.holder[gid]].push({ gid, names: [...names] });
    const broken = this.newlyBroken;
    this.newlyBroken = [];
    const prepared = await all(this.owners, (owner, w) => owner.prepare({ keep: Int32Array.from(round.keep[w] ?? []), wake: wake[w], broken, exports: moves.exports[w] }));
    prepared.forEach((p, w) => this.kept(round.keep[w] ?? [], p));
    const imports = this.owners.map((): Moved[] => []);
    prepared.forEach((p) => {
      for (const moved of p.exported) {
        const to = moves.to.get(moved.gid)!;
        imports[to].push(moved);
        this.holder[moved.gid] = to;
      }
    });
    return imports;
  }

  /** What owners found of the nodes they kept: whether each is stuck, and the predicates that hold there. */
  private kept(keep: number[], prepared: Prepared): void {
    for (let i = 0; i < keep.length / 2; i++) {
      const gid = keep[i * 2 + 1];
      this.truths.forEach((truths, p) => (truths[gid] = prepared.truths[i * this.predicates.length + p]));
      // Fewest faults first, then shortest: the first found, as ids go breadth first.
      const best = this.stuckAt;
      if (prepared.stuck[i] && (best === undefined || this.faults[gid] < this.faults[best] || (this.faults[gid] === this.faults[best] && gid < best))) this.stuckAt = gid;
    }
  }

  private async expand(round: Round, imports: Moved[][]): Promise<Expansion[]> {
    this.frontier = round.next;
    const entries = this.owners.map((): Entry[] => []);
    round.next.forEach((item, slot) => {
      if ("revisit" in item) throw new Error("a revisit was left unresolved in the frontier");
      entries[this.holder[item.gid]].push({ slot, gid: item.gid, ...(item.only ? { only: item.only } : {}) });
    });
    const deadline = this.started + this.b.timeLimit;
    return all(this.owners, (owner, w) => owner.expand({ imports: imports[w], entries: entries[w], deadline }));
  }

  /** The successors of a round, in frontier order: which are new, which break something first, which land on known states. */
  private merge(expansions: Expansion[]): Round {
    const frontier = this.frontier;
    const round = emptyRound(this.owners.length);
    const entries: { owner: number; index: number; offset: number; slot: number }[] = [];
    expansions.forEach((e, owner) => {
      let offset = 0;
      e.slots.forEach((slot, index) => {
        entries.push({ owner, index, offset, slot });
        offset += e.counts[index];
      });
      if (e.cut) this.stoppedBy = "timeLimit";
    });
    entries.sort((a, b) => a.slot - b.slot);
    const notes = expansions.map((e) => new Map(e.notes.map((n) => [n.k, n])));
    merging: for (const { owner, index, offset, slot } of entries) {
      const item = frontier[slot] as { gid: number; only?: number[] };
      const e = expansions[owner];
      if (!item.only) this.expanded[item.gid] = true;
      if (this.keepsEdges) {
        this.edges[item.gid] = [];
        this.enabled[item.gid] = new Map(e.enabled[index]);
      }
      for (let j = 0; j < e.counts[index]; j++) {
        if (!this.land(item.gid, owner, offset + j, e, notes[owner].get(offset + j), round)) break merging;
      }
    }
    if (!this.stoppedBy && Date.now() - this.started > this.b.timeLimit) this.stoppedBy = "timeLimit";
    return round;
  }

  /**
   * Where a successor lands. A step that lands on a known state still ran (the owner counts it
   * as reached). A step that fails for a reason not met before, or breaks a step property, is
   * judged all the same: its counterexample ends with the step itself, so it gets a node of its
   * own that stands for nothing else (a shadow). False when the search must stop.
   */
  private land(parent: number, owner: number, k: number, e: Expansion, note: Note | undefined, round: Round): boolean {
    const [hi, lo] = [e.prints[k * 2], e.prints[k * 2 + 1]];
    const flags = e.flags[k];
    const failed = (flags & FAILED) !== 0;
    const option = e.options[k];
    const breaks = (note?.breaks ?? []).filter((id) => !this.broken.has(id));
    const error = failed && note?.error !== undefined && !this.errors.has(note.error) ? note.error : undefined;
    const news = breaks.length > 0 || error !== undefined;
    const existing = this.seen.get(hi, lo);
    // A failed step goes nowhere: no edge for liveness.
    const edgeTo = (to: number) => {
      if (this.keepsEdges && !failed) this.edges[parent].push({ to, option, fault: (flags & FAULT) !== 0, ...(Number.isNaN(e.fair[k]) ? {} : { fair: e.fair[k] }) });
    };
    if (existing !== undefined) {
      edgeTo(existing);
      if (!news) {
        this.arrivedAgain(existing, this.root[parent], { owner, k }, [e.plains[k * 2], e.plains[k * 2 + 1]], round);
        return true;
      }
    }
    if (failed && !news) return true;
    const shadow = failed || existing !== undefined;
    if (!shadow && this.states >= this.b.maxStates) {
      this.stoppedBy = "maxStates";
      return false;
    }
    const root = this.root[parent];
    const gid = this.node({ parent, root, option, fault: (flags & FAULT) !== 0, holder: owner, shadow, sleepy: (flags & SLEEPY) !== 0, plain: this.roots[root].symmetry.classes.length ? [e.plains[k * 2], e.plains[k * 2 + 1]] : undefined });
    if (!shadow) {
      this.seen.set(hi, lo, gid);
      this.states++;
      edgeTo(gid);
      round.keep[owner].push(k, gid);
      round.fresh.set(gid, { owner, k });
      if (this.depth[gid] < this.b.depth) round.next.push({ gid });
      if (this.watch.state) {
        const c = (this.owners[0] as InlineDriver).owner.candidate(k);
        this.watch.state(c.world, { acts: c.acts, faults: c.faults, memory: c.memory });
      }
    }
    const findings = (note?.findings ?? []).filter((id) => !this.broken.has(id));
    for (const id of [...findings, ...breaks.filter((id) => !findings.includes(id))]) {
      this.broken.add(id);
      this.newlyBroken.push(id);
      this.failures.set(id, gid);
    }
    if (error) this.errors.set(error, gid);
    return true;
  }

  /** A successor that landed on a known state: test the symmetry claim on it, and wake what it skipped that this path did not. */
  private arrivedAgain(existing: number, root: number, from: { owner: number; k: number }, plain: [number, number], round: Round): void {
    const twin = this.roots[root].symmetry.classes.length > 0 && !samePrint(plain, this.plains[existing]);
    if (twin && this.twinChecks < this.b.symmetryChecks) {
      this.twinChecks++;
      round.twins.push({ existing, from });
    }
    if (this.b.reduce && this.sleepy[existing]) {
      round.revisits.push({ existing, from, plain });
      round.next.push({ revisit: round.revisits.length - 1 });
    }
  }

  /**
   * What revisits and twin tests need, asked of the owners holding it. A revisit wakes the
   * steps the known state skipped that the arriving path did not (all of them for a renamed
   * twin, whose step names do not match); a state expanded before then tries those again.
   */
  private async query(round: Round): Promise<void> {
    const queries = this.owners.map((): Query => ({ sleeps: [], twins: [] }));
    const where = (gid: number): [number, Ref] => {
      const fresh = round.fresh.get(gid);
      return fresh ? [fresh.owner, { k: fresh.k }] : [this.holder[gid], { gid }];
    };
    const ask = (kind: keyof Query, [owner, ref]: [number, Ref]) => [owner, queries[owner][kind].push(ref) - 1] as const;
    const asked = new Map<number, readonly [number, number]>();
    const revisits = round.revisits.map((r) => {
      if (!asked.has(r.existing)) asked.set(r.existing, ask("sleeps", where(r.existing)));
      return { existing: asked.get(r.existing)!, from: ask("sleeps", [r.from.owner, { k: r.from.k }]) };
    });
    const twins = round.twins.map((t) => ({ existing: ask("twins", where(t.existing)), from: ask("twins", [t.from.owner, { k: t.from.k }]) }));
    const answers: Answer[] = await all(this.owners, (owner, w) => (queries[w].sleeps.length || queries[w].twins.length ? owner.query(queries[w]) : Promise.resolve({ sleeps: [], twins: new Uint32Array() })));

    const twinPrint = ([owner, i]: readonly [number, number]) => [answers[owner].twins[i * 2], answers[owner].twins[i * 2 + 1]] as [number, number];
    if (twins.some((t) => !samePrint(twinPrint(t.existing), twinPrint(t.from)))) {
      this.refuted = true;
      return;
    }

    const current = new Map<number, Set<number>>();
    const items = round.revisits.map((r, i): Item | undefined => {
      const sleep = current.get(r.existing) ?? new Set(answers[asked.get(r.existing)![0]].sleeps[asked.get(r.existing)![1]]);
      current.set(r.existing, sleep);
      const same = !this.roots[this.root[r.existing]].symmetry.classes.length || samePrint(r.plain, this.plains[r.existing]);
      const arriving = new Set(answers[revisits[i].from[0]].sleeps[revisits[i].from[1]]);
      const woken = [...sleep].filter((name) => !same || !arriving.has(name));
      if (!woken.length) return undefined;
      for (const name of woken) sleep.delete(name);
      round.wake.set(r.existing, new Set([...(round.wake.get(r.existing) ?? []), ...woken]));
      return this.expanded[r.existing] ? { gid: r.existing, only: woken } : undefined;
    });
    for (const [gid, sleep] of current) this.sleepy[gid] = sleep.size > 0;
    round.next = round.next.flatMap((item) => ("revisit" in item ? (items[item.revisit] ?? []) : [item]));
  }

  /** Worlds at the depth bound, for liveness: their edges, if each step lands on a known state; else they stay open. */
  private async close(): Promise<void> {
    const byOwner = this.owners.map((): number[] => []);
    for (let gid = 0; gid < this.parent.length; gid++) if (!this.expanded[gid] && !this.shadow[gid]) byOwner[this.holder[gid]].push(gid);
    const closed = await all(this.owners, (owner, w) => (byOwner[w].length ? owner.close(byOwner[w]) : Promise.resolve([])));
    for (const c of closed.flat()) {
      const out: Edge[] = [];
      let open = false;
      for (let i = 0; i < c.options.length && !open; i++) {
        const to = this.seen.get(c.prints[i * 2], c.prints[i * 2 + 1]);
        if (to === undefined) open = true;
        else out.push({ to, option: c.options[i], fault: c.faults[i] === 1, ...(Number.isNaN(c.fair[i]) ? {} : { fair: c.fair[i] }) });
      }
      if (open) continue;
      this.edges[c.gid] = out;
      this.enabled[c.gid] = new Map(c.enabled);
      this.expanded[c.gid] = true;
    }
  }

  /** Start worker owners once the frontier is big enough, and let them join when ready. */
  private join(round: Round): void {
    const workers = this.workers;
    // A worker that cannot start is a bug: the search fails with its error.
    if (workers.state === "failed") throw workers.error;
    if (workers.state === "ready") {
      this.owners.push(...workers.drivers);
      this.workers = { state: "joined" };
    }
    if (this.spawn && workers.state === "idle" && round.next.length >= SPAWN_AT) {
      this.workers = { state: "starting" };
      this.spawn().then(
        (drivers) => (this.workers = { state: "ready", drivers }),
        (error) => (this.workers = { state: "failed", error }),
      );
    }
  }

  /** Even out the frontier: nodes made this round move from owners with more than their share to owners with less. */
  private balance(round: Round): { exports: number[][]; to: Map<number, number> } {
    const n = this.owners.length;
    const exports = this.owners.map((): number[] => []);
    const to = new Map<number, number>();
    if (n === 1) return { exports, to };
    const counts = new Array<number>(n).fill(0);
    for (const item of round.next) if ("gid" in item) counts[this.holder[item.gid]]++;
    const share = Math.ceil(round.next.length / n);
    if (Math.max(...counts) <= share + Math.max(8, share / 10)) return { exports, to };
    for (const item of round.next) {
      if (!("gid" in item) || item.only || !round.fresh.has(item.gid)) continue;
      const from = this.holder[item.gid];
      if (counts[from] <= share) continue;
      const dest = counts.indexOf(Math.min(...counts));
      if (counts[dest] >= share) break;
      exports[from].push(item.gid);
      to.set(item.gid, dest);
      counts[from]--;
      counts[dest]++;
    }
    return { exports, to };
  }

  private node(n: { parent: number; root: number; option: number; fault: boolean; holder: number; shadow: boolean; sleepy: boolean; plain: [number, number] | undefined }): number {
    const gid = this.parent.length;
    const up = n.parent;
    this.parent.push(up);
    this.root.push(n.root);
    this.depth.push(up < 0 ? 0 : this.depth[up] + 1);
    this.faults.push(up < 0 ? 0 : this.faults[up] + (n.fault ? 1 : 0));
    this.option.push(n.option);
    this.faultIn.push(n.fault);
    this.holder.push(n.holder);
    this.shadow.push(n.shadow);
    this.expanded.push(false);
    this.sleepy.push(n.sleepy);
    if (n.plain) this.plains[gid] = n.plain;
    this.depthReached = Math.max(this.depthReached, this.depth[gid]);
    return gid;
  }
}

function emptyRound(owners: number): Round {
  return { keep: Array.from({ length: owners }, () => []), fresh: new Map(), next: [], revisits: [], twins: [], wake: new Map() };
}

function samePrint(a: [number, number], b: [number, number] | undefined): boolean {
  return !!b && a[0] === b[0] && a[1] === b[1];
}

function stepKey(s: LassoStep): string {
  return `${s.from}:${s.option}`;
}

/**
 * Call every owner at once. Worker owners are called first: the main thread's owner works
 * synchronously when called, and the workers should not wait for it to start.
 */
function all<T>(owners: Driver[], call: (owner: Driver, index: number) => Promise<T>): Promise<T[]> {
  const out: Promise<T>[] = new Array(owners.length);
  for (let w = owners.length - 1; w >= 0; w--) out[w] = call(owners[w], w);
  return Promise.all(out);
}

function mergeStats(stats: Stats[]): Stats {
  return { reached: [...new Set(stats.flatMap((s) => s.reached))], orders: stats.reduce((n, s) => n + s.orders, 0), inputs: stats.reduce((n, s) => n + s.inputs, 0) };
}
