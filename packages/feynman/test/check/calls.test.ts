// Calls (RFD0009): losing a call, or its reply, gives the caller the call's failure instead of
// silence. The caller cannot tell which was lost, so a retry after a lost reply applies the
// call twice, unless the callee recognises it.
import { expect, test } from "bun:test";
import { check, type Bounds, type Report } from "../../src/check/index.ts";
import { act, defineActor, defineCall, defineMessage, defineProperty, defineSpec, defineZone, failed, fire, lose, pendingInOrder, restart, spawn, startWorld, type World } from "../../src/spec/index.ts";
import { explore } from "./reference.ts";

const Write = defineCall("Write", { id: Number }, { over: "rpc" });
const Ok = defineMessage("Ok", { id: Number }, { tone: "reply" });

/** A client that writes and, when the call throws, writes again; the store applies each write, once per id if `idempotent`. */
function retries(idempotent: boolean) {
  const zone = defineZone({ name: "z" });
  const Store = defineActor({
    name: "Store",
    zone,
    singleton: true,
    initialState: () => ({ applied: 0, seen: [] as number[] }),
    transitions: {
      write: {
        on: Write,
        description: "Applies the write and answers.",
        sends: [Ok],
        run(state, msg, ctx) {
          if (!idempotent || !state.seen.includes(msg.id)) state.applied++;
          if (idempotent && !state.seen.includes(msg.id)) state.seen.push(msg.id);
          ctx.reply(Ok, { id: msg.id });
        },
      },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ written: 0, waiting: null as number | null }),
    actions: {
      write: {
        label: "Write",
        description: "Writes once more.",
        when: (s) => s.waiting === null,
        sends: [Write],
        run(state, _inputs, ctx) {
          state.written++;
          state.waiting = state.written;
          ctx.send(ctx.the(Store), Write, { id: state.written });
        },
      },
    },
    transitions: {
      ok: { on: Ok, description: "The write is done.", run: (s) => void (s.waiting = null) },
      writeFailed: {
        on: failed(Write),
        description: "The call threw: writes again.",
        sends: [Write],
        run(_state, failure, ctx) {
          ctx.send(failure.to, Write, failure.payload);
        },
      },
    },
  });

  const appliedOnce = defineProperty("appliedOnce", { description: "The store applies no more writes than the client made.", always: (w) => w.the(Store).state.applied <= w.the(Client).state.written });

  const answered = defineProperty("answered", { description: "A write in progress ends.", leadsTo: { whenever: (w) => w.the(Client).state.waiting !== null, then: (w) => w.the(Client).state.waiting === null } });

  return defineSpec({
    name: `Retried writes (${idempotent ? "with" : "without"} an idempotency key)`,
    actors: [Store, Client],
    properties: [appliedOnce, answered],
  });
}

const PLAIN = { depth: 12, repeats: 1, walks: 0, reduce: false, symmetry: false, workers: 0 } as const;
const comparable = (r: Report) => ({ ...r, durationMs: 0 });

async function report(idempotent: boolean, bounds: Partial<Bounds>): Promise<Report> {
  const spec = retries(idempotent);
  const integer = await check(spec, { ...PLAIN, ...bounds }, [], { engine: "integer" });
  const classic = await check(spec, { ...PLAIN, ...bounds }, [], { engine: "classic" });
  expect(comparable(integer)).toEqual(comparable(classic));
  return integer;
}

test("a call and its failure: a lost write and a lost reply both reach the caller, as the same failure", () => {
  const spec = retries(false);
  const start = startWorld(spec).at(-1)!.world;
  const written = act(spec, start, "client", "write").world;
  const [request] = pendingInOrder(written);
  // The request lost: the store never applied it, and the client hears its call failed.
  const lostRequest = lose(spec, written, request.id);
  expect(lostRequest.event.description).toBe("write to Store is lost on the way: Client's call fails.");
  expect(lostRequest.world.pending).toMatchObject([{ kind: "deliver", to: "client", from: "store", message: "failed:message:Write", payload: { id: 1 } }]);
  expect(lostRequest.event.sent).toMatchObject([{ to: "client", message: "failed:message:Write" }]);
  // The reply lost: the store did apply it, and the client hears the same failure.
  const applied = fire(spec, written, request.id).world;
  expect(applied.pending).toMatchObject([{ message: "message:Ok", answers: { message: "message:Write", payload: { id: 1 } } }]);
  const lostReply = lose(spec, applied, pendingInOrder(applied)[0].id);
  expect(lostReply.event.description).toBe("ok to Client is lost on the way: Client's write fails.");
  const failure = (w: World) => w.pending.map(({ id: _, ...p }) => p);
  expect(failure(lostReply.world)).toEqual(failure(lostRequest.world));
  // The failure carries the call and whom it was to; the client retries it.
  const retried = fire(spec, lostReply.world, pendingInOrder(lostReply.world)[0].id);
  expect(retried.event).toMatchObject({ kind: "deliver", key: "failed:message:Write", from: "store", description: "The call threw: writes again." });
  expect(retried.world.pending).toMatchObject([{ to: "store", message: "message:Write", payload: { id: 1 } }]);
});

test("a failure cannot be lost, and a restart of the caller drops the failures on their way to it", () => {
  const spec = (() => {
    const Ask = defineCall("Ask");
    const zone = defineZone({ name: "z" });
    const Server = defineActor({ name: "Server", zone, singleton: true, initialState: () => ({}), transitions: { ask: { on: Ask, description: "Takes it.", run: () => {} } } });
    const AskerActor = defineActor({
      name: "Asker",
      zone,
      initialState: () => ({ failed: 0 }),
      actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, {}) } },
      transitions: { askFailed: { on: failed(Ask), description: "Gives up.", run: (state) => void state.failed++ } },
    });
    return defineSpec({
      name: "Restarts",
      actors: [Server, AskerActor],
    });
  })();
  let world = startWorld(spec).at(-1)!.world;
  world = spawn(spec, world, "Asker", "A").world;
  world = act(spec, world, "asker-a", "ask").world;
  world = lose(spec, world, pendingInOrder(world)[0].id).world;
  const [failure] = pendingInOrder(world);
  expect(failure.kind === "deliver" && failure.message).toBe("failed:message:Ask");
  expect(() => lose(spec, world, failure.id)).toThrow("ask failed happens in asker-a's own process: it cannot be lost");
  expect(restart(spec, world, "asker-a").world.pending).toEqual([]);
});

test("a call is declared and handled as one: its failure is handled, its reply is one, and only calls fail", () => {
  const Ask = defineCall("Ask");
  const Tell = defineMessage("Tell");
  const z = defineZone({ name: "z" });
  const Answerer = defineActor({ name: "Answerer", zone: z, singleton: true, initialState: () => ({}), transitions: { ask: { on: Ask, description: "Hears it.", run: () => {} } } });
  const asker = defineActor({ name: "Asker", zone: z, singleton: true, initialState: () => ({}), actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: () => {} } } });
  expect(() => defineSpec({ name: "Calls", actors: [Answerer, asker] })).toThrow("Asker: sends ask, a call: handle its failure with a step on failed(Ask)");
  expect(() => failed(Tell as never)).toThrow("failed(Tell): tell is a message, not a call; define it with defineCall for its failure to reach the caller");
  // Replying twice to a call, or with a call, is a spec error at the step.
  const twice = (() => {
    const Ask = defineCall("Ask");
    const Ok = defineMessage("Ok", {}, { tone: "reply" });
    const zone = defineZone({ name: "z" });
    const Server = defineActor({
      name: "Server",
      zone,
      singleton: true,
      initialState: () => ({}),
      transitions: { ask: { on: Ask, description: "Answers twice.", sends: [Ok], run: (_s, _m, ctx) => (ctx.reply(Ok, {}), ctx.reply(Ok, {})) } },
    });
    const AskerActor = defineActor({
      name: "Asker",
      zone,
      singleton: true,
      initialState: () => ({}),
      actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, {}) } },
      transitions: { ok: { on: Ok, description: "Done.", run: () => {} }, askFailed: { on: failed(Ask), description: "Gives up.", run: () => {} } },
    });
    return defineSpec({
      name: "Twice",
      actors: [Server, AskerActor],
    });
  })();
  const asked = act(twice, startWorld(twice).at(-1)!.world, "asker", "ask").world;
  expect(fire(twice, asked, pendingInOrder(asked)[0].id).event.error).toBe("Server.message:Ask: replies twice to ask, a call: a call has one reply");
});

test("without faults, a call is a message: the same states, and nothing fails", async () => {
  const r = await report(false, { faults: 0 });
  expect(r.exhaustive).toBe(true);
  expect(r.properties.every((p) => p.holds)).toBe(true);
  expect(r.coverage.missed).toEqual(["Client.failed:message:Write"]);
});

test("a retry after a lost reply applies the write twice; an idempotency key stops it; both engines and the reference agree", async () => {
  const buggy = await report(false, { faults: 1 });
  const broken = buggy.properties.find((p) => p.id === "appliedOnce")!;
  expect(broken.holds).toBe(false);
  if (broken.holds) return;
  // The shortest way: write, the store applies it, its reply is lost, the client writes it again.
  expect(broken.counterexample.events.map((e) => `${e.actor}.${e.kind === "lose" ? "lose" : e.key}`)).toEqual(["Client.write", "Store.message:Write", "Client.lose", "Client.failed:message:Write", "Store.message:Write"]);
  const fixed = await report(true, { faults: 1 });
  expect(fixed.properties.map((p) => [p.id, p.holds])).toEqual([["appliedOnce", true], ["answered", true]]);
  // The retry is fair, so every write in progress ends, even with a fault; the reference explorer counts the same states.
  for (const idempotent of [false, true]) {
    const spec = retries(idempotent);
    const theirs = explore(spec, { depth: PLAIN.depth, faults: 1, repeats: 1, instances: {} });
    const ours = idempotent ? fixed : buggy;
    expect(ours.states).toBe(theirs.worlds.size);
    expect(Object.fromEntries(theirs.liveness)).toEqual({ answered: "holds" });
  }
});

test("reductions and symmetry keep the verdicts on calls", async () => {
  for (const idempotent of [false, true]) {
    const spec = retries(idempotent);
    const plain = await check(spec, { ...PLAIN, faults: 2 }, [], { engine: "classic" });
    const reduced = await check(spec, { ...PLAIN, faults: 2, reduce: true }, [], { engine: "classic" });
    expect(reduced.properties.map((p) => [p.id, p.holds])).toEqual(plain.properties.map((p) => [p.id, p.holds]));
  }
});

test("a scenario delivers a call's failure by the call's name, and --as-scenario writes it so", async () => {
  const { retriedCall } = await import("../../examples/retried-call.ts");
  const { runScenario } = await import("../../src/spec/index.ts");
  const { scenarioCode } = await import("../../src/cli/scenario-code.ts");
  const spec = retriedCall("buggy");
  const lost = spec.scenarios.find((s) => s.name === "The answer is lost")!;
  const run = runScenario(spec, lost);
  expect(run.error).toBeUndefined();
  expect(run.events.map((e) => e.key)).toEqual(["pay", "message:Charge", "message:Charged", "failed:message:Charge", "message:Charge", "message:Charged"]);
  const report = await check(spec, { ...PLAIN, faults: 1 }, [], { engine: "integer" });
  const broken = report.properties.find((p) => p.id === "chargedOnce")!;
  if (broken.holds) throw new Error("chargedOnce should break");
  expect(scenarioCode(spec, broken)).toContain("s.deliver(client, failed(Charge)); // from bank");
});

test("symmetric callers: a reply to a call is renamed like any message (0.12.0 crashed here)", async () => {
  const spec = (() => {
    const Ask = defineCall("Ask", { from: String });
    const Told = defineMessage("Told", { to: String }, { tone: "reply" });
    const zone = defineZone({ name: "z" });
    const Server = defineActor({
      name: "Server",
      zone,
      singleton: true,
      initialState: () => ({ asked: 0 }),
      transitions: { ask: { on: Ask, description: "Answers.", sends: [Told], run: (s, m, ctx) => void (s.asked++, ctx.reply(Told, { to: m.from })) } },
    });
    const AgentActor = defineActor({
      name: "Agent",
      zone,
      symmetric: true,
      initialState: () => ({ told: false }),
      actions: { ask: { label: "Ask", description: "Asks the server.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, { from: ctx.self.id }) } },
      transitions: {
        told: { on: Told, description: "Told.", run: (s) => void (s.told = true) },
        askFailed: { on: failed(Ask), description: "Gives up.", run: () => {} },
      },
    });
    return defineSpec({
      name: "Symmetric callers",
      actors: [Server, AgentActor],
    });
  })();
  for (const engine of ["integer", "classic"] as const) {
    const symmetric = await check(spec, { ...PLAIN, faults: 1, instances: { Agent: 2 }, symmetry: true }, [], { engine });
    const plain = await check(spec, { ...PLAIN, faults: 1, instances: { Agent: 2 } }, [], { engine });
    expect(symmetric.errors).toEqual([]);
    expect(symmetric.exhaustive).toBe(true);
    expect(symmetric.states).toBeLessThan(plain.states);
  }
});
