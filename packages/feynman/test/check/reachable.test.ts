// Reachable properties: some world the system can get to is like this. Found is found, with the
// shortest way there; not found is a ✗ only when every world within the bounds was explored.
// The reference explorer (reference.ts), which shares none of the search, says how far each is.
import { expect, test } from "bun:test";
import { check, replay, type Bounds, type Counterexample, type Report } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { verdictOf } from "../../src/check/verdict.ts";
import { scenarioCode } from "../../src/cli/scenario-code.ts";
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, runScenario, worldView, type Property, type Spec, type WorldView } from "../../src/spec/index.ts";
import { compile } from "../cli/compile.ts";
import { explore } from "./reference.ts";

const zone = defineZone({ name: "z" });
/** No random runs, and a time limit the search never meets: the verdicts are the search's own. */
const SEARCH = { walks: 0, timeLimit: 600_000 } satisfies Partial<Bounds>;

const Buy = defineMessage("Buy", {});
const Sold = defineMessage("Sold", {}, { tone: "reply" });
const SoldOut = defineMessage("SoldOut", {}, { tone: "reply" });

/** A shop with two of something, and buyers who each ask once. */
const Shop = defineActor({
  name: "Shop",
  zone,
  singleton: true,
  initialState: () => ({ stock: 2 }),
  transitions: {
    buy: {
      on: Buy,
      description: "Sells one, if there is one left.",
      sends: [Sold, SoldOut],
      run(state, _msg, ctx) {
        if (state.stock === 0) return ctx.reply(SoldOut, {});
        state.stock -= 1;
        ctx.reply(Sold, {});
      },
    },
  },
});
const Buyer = defineActor({
  name: "Buyer",
  zone,
  symmetric: true,
  initialState: () => ({ asked: false, got: false, missed: false }),
  actions: {
    buy: { label: "Buy", description: "Asks for one.", with: [atMost(1)], sends: [Buy], run: (state, _i, ctx) => (void (state.asked = true), ctx.send(ctx.the(Shop), Buy, {})) },
  },
  transitions: {
    sold: { on: Sold, description: "Gets one.", run: (state) => void (state.got = true) },
    soldOut: { on: SoldOut, description: "Is told there are none left.", run: (state) => void (state.missed = true) },
  },
});

const buyers = (w: WorldView) => w.all(Buyer);
const someoneGetsOne = defineProperty("someoneGetsOne", { description: "A buyer gets one.", reachable: (w) => buyers(w).some((b) => b.state.got) });
const someoneMisses = defineProperty("someoneMisses", { description: "A buyer is told there are none left.", reachable: (w) => buyers(w).some((b) => b.state.missed) });
const ANY = { description: "Anything.", when: () => true };
const shop = (properties: Property[], scenarios: ReturnType<typeof defineScenario>[] = []): Spec => defineSpec({ name: "Shop", actors: [Shop, Buyer], properties, scenarios, finalState: ANY });

const read = (report: Report, id: string) => verdictOf(report.properties.find((p) => p.id === id)!, { report, brokenBy: new Map() });
const witnessOf = (report: Report, id: string): Counterexample => {
  const p = report.properties.find((q) => q.id === id)!;
  if (!p.holds || !p.witness) throw new Error(`${id} was not reached`);
  return p.witness;
};
/** The way there replays to the same events and ends in a world the property looks for. */
const getsThere = (spec: Spec, id: string, witness: Counterexample) => {
  const again = replay(spec, witness.initial, witness.choices);
  expect(again.events.map((e) => e.key)).toEqual(witness.events.map((e) => e.key));
  const property = spec.properties.find((p) => p.id === id)!;
  if (property.kind !== "reachable") throw new Error(`${id} is not reachable`);
  expect(property.reachable(worldView(spec, again.worlds.at(-1) ?? again.initial))).toBe(true);
};

test("a world some path gets to: holds, with the shortest way there, which the reference agrees with", async () => {
  const spec = shop([someoneGetsOne, someoneMisses]);
  const bounds = { ...SEARCH, instances: { Buyer: 3 }, symmetry: false };
  const report = await check(spec, bounds);
  const reference = explore(spec, { depth: 100, instances: bounds.instances });
  expect(report.exhaustive && !report.cutAtDepth).toBe(true);
  for (const id of ["someoneGetsOne", "someoneMisses"]) {
    expect(read(report, id)).toBe("holds");
    const witness = witnessOf(report, id);
    expect(witness.events.length).toBe(reference.reachable.get(id)!);
    getsThere(spec, id, witness);
  }
  // A buy, the shop's sale, the buyer hearing it.
  expect(witnessOf(report, "someoneGetsOne").events.map((e) => e.key)).toEqual(["buy", "buy", "sold"]);
});

test("a world no path gets to, in a search that explored every world: broken, and no way there", async () => {
  // Two buyers, two in stock: nobody is ever told there are none left.
  const spec = shop([someoneGetsOne, someoneMisses]);
  const report = await check(spec, { ...SEARCH, instances: { Buyer: 2 } });
  expect(explore(spec, { depth: 100, instances: { Buyer: 2 } }).reachable.has("someoneMisses")).toBe(false);
  const missed = report.properties.find((p) => p.id === "someoneMisses")!;
  expect({ holds: missed.holds, unreached: !missed.holds && missed.unreached, verdict: read(report, "someoneMisses") }).toEqual({ holds: false, unreached: true, verdict: "broken" });
  expect(read(report, "someoneGetsOne")).toBe("holds");
});

test("not reached in a search that stopped early, or that the depth bound cut off: unfinished, not broken", async () => {
  const spec = shop([someoneMisses]);
  // Three buyers miss out at the earliest in 7 events.
  const cut = await check(spec, { ...SEARCH, instances: { Buyer: 3 }, depth: 4 });
  const missed = cut.properties[0]!;
  expect({ cut: cut.cutAtDepth, verdict: read(cut, "someoneMisses"), upTo: !missed.holds && missed.unreached && missed.upTo }).toEqual({ cut: true, verdict: "unfinished", upTo: 4 });
  const stopped = await check(spec, { ...SEARCH, instances: { Buyer: 3 }, maxStates: 5 });
  expect({ stoppedBy: stopped.stoppedBy, verdict: read(stopped, "someoneMisses") }).toEqual({ stoppedBy: "maxStates", verdict: "unfinished" });
});

test("a random run past the search's depth gets there: holds, by a run, with a way there that replays", async () => {
  const spec = shop([someoneMisses]);
  const report = await check(spec, { instances: { Buyer: 3 }, depth: 2, walks: 500, walkDepth: 30, timeLimit: 600_000 });
  const p = report.properties[0]!;
  expect({ holds: p.holds, by: p.holds && p.witnessBy, verdict: read(report, "someoneMisses") }).toEqual({ holds: true, by: "walk", verdict: "holds" });
  getsThere(spec, "someoneMisses", witnessOf(report, "someoneMisses"));
});

test("where a path starts counts: the initial world, and a scenario's setup, say from where", async () => {
  const always = defineProperty("startsWithStock", { description: "There is stock.", reachable: (w) => w.the(Shop).state.stock > 0 });
  const atStart = await check(shop([always]), { ...SEARCH, instances: { Buyer: 1 } });
  expect(witnessOf(atStart, "startsWithStock").events).toEqual([]);
  // A scenario that sets the shop sold out, with a buyer: who then misses out in 3 events, from its setup.
  const empty = defineScenario("Sold out", { setup: (w) => (w.set(Shop, { stock: 0 }), w.spawn(Buyer, "Ann")), run: () => {} });
  const spec = shop([someoneMisses], [empty]);
  const report = await check(spec, { ...SEARCH, instances: { Buyer: 1 } }, scenarioSeeds(spec));
  const witness = witnessOf(report, "someoneMisses");
  expect({ events: witness.events.length, from: witness.from }).toEqual({ events: 3, from: { scenario: "Sold out", at: "start" } });
});

test("symmetry does not hide a world a property finds on one instance but not its twin", async () => {
  // Buyer B gets one: the same world as "Buyer A gets one", renamed. The search must still find it.
  const bGetsOne = defineProperty("bGetsOne", { description: "Buyer B gets one.", reachable: (w) => buyers(w).some((b) => b.label === "Buyer B" && b.state.got) });
  const spec = shop([bGetsOne]);
  const plain = await check(spec, { ...SEARCH, instances: { Buyer: 2 }, symmetry: false });
  const folded = await check(spec, { ...SEARCH, instances: { Buyer: 2 }, symmetry: true });
  expect(witnessOf(folded, "bGetsOne").events.length).toBe(witnessOf(plain, "bGetsOne").events.length);
  getsThere(spec, "bGetsOne", witnessOf(folded, "bGetsOne"));
});

test("a predicate that cannot be read in a world (no such instance there) is not a world it looks for", async () => {
  // the(Buyer) throws with two buyers, so no world is one: never reached, and no crash.
  const oneBuyer = defineProperty("theBuyerGetsOne", { description: "The buyer gets one.", reachable: (w) => w.the(Buyer).state.got });
  const report = await check(shop([oneBuyer]), { ...SEARCH, instances: { Buyer: 2 } });
  expect(read(report, "theBuyerGetsOne")).toBe("broken");
});

test("known: a reachable property not reached yet is the known bug; reached, the mark is stale", async () => {
  const known = (p: Property & { def?: unknown }, why: string) => defineProperty(p.id, { ...(p as unknown as { def: object }).def, known: why } as never);
  const two = await check(shop([known(someoneMisses, "BUG-1")]), { ...SEARCH, instances: { Buyer: 2 } });
  expect(read(two, "someoneMisses")).toBe("known");
  const three = await check(shop([known(someoneMisses, "BUG-1")]), { ...SEARCH, instances: { Buyer: 3 } });
  expect(read(three, "someoneMisses")).toBe("fixed");
});

test("the way there, as scenario code, replays to a world the property looks for", async () => {
  const spec = shop([someoneMisses]);
  const report = await check(spec, { ...SEARCH, instances: { Buyer: 3 }, symmetry: false });
  const witness = witnessOf(report, "someoneMisses");
  const code = scenarioCode(spec, { id: "someoneMisses", description: "A buyer is told there are none left.", counterexample: witness, reached: true });
  expect(code).toContain('defineScenario("someoneMisses is reached"');
  expect(code).toContain("// someoneMisses is reached here:");
  const run = runScenario(spec, compile(spec, "someoneMisses", code));
  expect(run.error).toBeUndefined();
  expect(run.events.filter((e) => e.kind !== "spawn").map((e) => e.key)).toEqual(witness.events.map((e) => e.key));
  expect(buyers(worldView(spec, run.worlds.at(-1)!)).some((b) => b.state.missed)).toBe(true);
});
