// Calls, from the faults library (RFD0009, RFD0012): losing a call, or its reply, gives the
// caller the call's failure instead of silence. The caller cannot tell which was lost, so a
// retry after a lost reply applies the call twice, unless the callee recognises it.
import { expect, test } from "bun:test";
import { check, type Report } from "../../src/check/index.ts";
import { act, budget, crash, defineActor, defineCall, defineMessage, defineProperty, defineSpec, defineZone, failed, fire, guard, lose, pendingInOrder, spawn, startWorld, stepsTaking, type World } from "../../src/spec/index.ts";
import { agreesWithReference } from "./agree.ts";
import { explore } from "./reference.ts";

const Write = defineCall("Write", { id: Number }, { over: "rpc" });
const Ok = defineMessage("Ok", { id: Number }, { tone: "reply" });

/** A client that writes and, when the call throws, writes again; the store applies each write, once per id if `idempotent`. */
function retries(idempotent: boolean) {
  const zone = defineZone({ name: "z" });
  const faults = budget("faults", 1);
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
      writeLost: lose(Write, { spend: faults }),
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
        when: (s) => s.waiting === null && s.written === 0,
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
      okLost: lose(Ok, { fails: Write, spend: faults }),
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

const PLAIN = { depth: 12, walks: 0, symmetry: false } as const;

/** The check, which must find what the reference explorer does. */
async function report(idempotent: boolean, faults: number): Promise<Report> {
  return agreesWithReference(retries(idempotent).setting({ faults }), { depth: PLAIN.depth, instances: {} });
}

const withoutIds = (w: World) => w.pending.map(({ id: _, ...p }) => p);

test("a call and its failure: a lost write and a lost reply both reach the caller, as the same failure", () => {
  const spec = retries(false);
  const start = startWorld(spec).at(-1)!.world;
  const written = act(spec, start, "client", "write").world;
  const [request] = pendingInOrder(written);
  // The request lost: the store never applied it, and the client hears its call failed, from the store.
  expect(stepsTaking(spec, written, request)).toEqual(["write", "writeLost"]);
  const lostRequest = fire(spec, written, request.id, "writeLost");
  expect(lostRequest.event).toMatchObject({ kind: "deliver", key: "writeLost", tags: ["fault"], description: "Write is lost on the way." });
  expect(withoutIds(lostRequest.world)).toEqual([{ kind: "deliver", to: "client", from: "store", message: "message:Write.failed", payload: { payload: { id: 1 }, to: { id: "store" } } }]);
  // The reply lost: the store did apply it, and the client hears the same failure.
  const applied = fire(spec, written, request.id).world;
  expect(applied.pending).toMatchObject([{ message: "message:Ok", answers: { message: "message:Write", payload: { id: 1 } } }]);
  const lostReply = fire(spec, applied, pendingInOrder(applied)[0].id, "okLost");
  expect(withoutIds(lostReply.world)).toEqual(withoutIds(lostRequest.world));
  // The failure carries the call and whom it was to; the client retries it.
  const retried = fire(spec, lostReply.world, pendingInOrder(lostReply.world)[0].id);
  expect(retried.event).toMatchObject({ kind: "deliver", key: "writeFailed", message: "message:Write.failed", from: "store", description: "The call threw: writes again." });
  expect(retried.world.pending).toMatchObject([{ to: "store", message: "message:Write", payload: { id: 1 } }]);
});

test("a failure has no lose step, so it cannot be lost, and a crash of the caller drops the failures on their way to it", () => {
  const spec = (() => {
    const Ask = defineCall("Ask");
    const zone = defineZone({ name: "z" });
    const Server = defineActor({ name: "Server", zone, singleton: true, initialState: () => ({}), transitions: { ask: { on: Ask, description: "Takes it.", run: () => {} }, askLost: lose(Ask) } });
    const Asker = defineActor({
      name: "Asker",
      zone,
      initialState: () => ({ failed: 0 }),
      actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, {}) } },
      transitions: { askFailed: { on: failed(Ask), description: "Gives up.", run: (state) => void state.failed++ }, crash: crash() },
    });
    return defineSpec({ name: "Crashes", actors: [Server, Asker] });
  })();
  let world = startWorld(spec).at(-1)!.world;
  world = spawn(spec, world, "Asker", "A").world;
  world = act(spec, world, "asker-a", "ask").world;
  world = fire(spec, world, pendingInOrder(world)[0].id, "askLost").world;
  const [failure] = pendingInOrder(world);
  expect(failure.kind === "deliver" && failure.message).toBe("message:Ask.failed");
  expect(stepsTaking(spec, world, failure)).toEqual(["askFailed"]);
  expect(guard(spec, world, "asker-a", "crash").world.pending).toEqual([]);
});

test("every call that can fail has its failure handled, a call that cannot needs no handler, and a reply answers once", () => {
  const z = defineZone({ name: "z" });
  const Ask = defineCall("Ask");
  const losing = defineActor({ name: "Answerer", zone: z, singleton: true, initialState: () => ({}), transitions: { ask: { on: Ask, description: "Hears it.", run: () => {} }, askLost: lose(Ask) } });
  const keeping = defineActor({ name: "Answerer", zone: z, singleton: true, initialState: () => ({}), transitions: { ask: { on: Ask, description: "Hears it.", run: () => {} } } });
  const asker = defineActor({ name: "Asker", zone: z, singleton: true, initialState: () => ({}), actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: () => {} } } });
  expect(() => defineSpec({ name: "Calls", actors: [losing, asker] })).toThrow("Answerer.askLost: sends ask failed, but no actor of Calls has a step on Ask.failed");
  expect(() => defineSpec({ name: "Calls", actors: [keeping, asker] })).not.toThrow();
  expect(() => failed(defineMessage("Tell") as never)).toThrow("failed(Tell): tell is a message, not a call; define it with defineCall from the faults library");
  // Replying twice to a call is a spec error at the step.
  const Ok = defineMessage("Ok", {}, { tone: "reply" });
  const Server = defineActor({
    name: "Server",
    zone: z,
    singleton: true,
    initialState: () => ({}),
    transitions: { ask: { on: Ask, description: "Answers twice.", sends: [Ok], run: (_s, _m, ctx) => (ctx.reply(Ok, {}), ctx.reply(Ok, {})) } },
  });
  const Asker = defineActor({
    name: "Asker",
    zone: z,
    singleton: true,
    initialState: () => ({}),
    actions: { ask: { label: "Ask", description: "Asks.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, {}) } },
    transitions: { ok: { on: Ok, description: "Done.", run: () => {} } },
  });
  const twice = defineSpec({ name: "Twice", actors: [Server, Asker] });
  const asked = act(twice, startWorld(twice).at(-1)!.world, "asker", "ask").world;
  expect(fire(twice, asked, pendingInOrder(asked)[0].id).event.error).toBe("Server.ask: replies twice to ask: a reply answers one request once");
});

test("with no faults left, a call is a message: nothing fails", async () => {
  const r = await report(false, 0);
  expect(r.exhaustive).toBe(true);
  expect(r.properties.every((p) => p.holds)).toBe(true);
  expect(r.coverage.missed.sort()).toEqual(["Client.okLost", "Client.writeFailed", "Store.writeLost"]);
});

test("a retry after a lost reply applies the write twice; an idempotency key stops it; the reference agrees", async () => {
  const buggy = await report(false, 1);
  const broken = buggy.properties.find((p) => p.id === "appliedOnce")!;
  if (broken.holds) throw new Error("appliedOnce should break");
  // The shortest way: write, the store applies it, its reply is lost, the client writes it again.
  expect(broken.counterexample.events.map((e) => `${e.actor}.${e.key}`)).toEqual(["Client.write", "Store.write", "Client.okLost", "Client.writeFailed", "Store.write"]);
  const fixed = await report(true, 1);
  expect(fixed.properties.map((p) => [p.id, p.holds])).toEqual([["appliedOnce", true], ["answered", true]]);
  // The retry is fair, so every write in progress ends, even with a fault; the reference explorer counts the same states.
  for (const idempotent of [false, true]) {
    const theirs = explore(retries(idempotent), { depth: PLAIN.depth, instances: {} });
    expect((idempotent ? fixed : buggy).states).toBe(theirs.worlds.size);
    expect(Object.fromEntries(theirs.liveness)).toEqual({ answered: "holds" });
  }
});

test("a scenario takes a lost reply by its step, and --as-scenario delivers the failure by the call's name", async () => {
  const { retriedCall } = await import("../../examples/retried-call.ts");
  const { runScenario } = await import("../../src/spec/index.ts");
  const { scenarioCode } = await import("../../src/cli/scenario-code.ts");
  const spec = retriedCall("buggy");
  const lost = spec.scenarios.find((s) => s.name === "The answer is lost")!;
  const run = runScenario(spec, lost);
  expect(run.error).toBeUndefined();
  expect(run.events.map((e) => e.key)).toEqual(["pay", "charge", "chargedLost", "chargeFailed", "charge", "charged"]);
  const report = await check(spec, PLAIN);
  const broken = report.properties.find((p) => p.id === "chargedOnce")!;
  if (broken.holds) throw new Error("chargedOnce should break");
  const code = scenarioCode(spec, broken);
  expect(code).toContain('s.step(client, "chargedLost"); // from bank');
  expect(code).toContain("s.deliver(client, failed(Charge)); // from bank");
});

test("symmetric callers: a reply to a call is renamed like any message", async () => {
  const spec = (() => {
    const Ask = defineCall("Ask", { from: String });
    const Told = defineMessage("Told", { to: String }, { tone: "reply" });
    const zone = defineZone({ name: "z" });
    const faults = budget("faults", 1);
    const Server = defineActor({
      name: "Server",
      zone,
      singleton: true,
      initialState: () => ({ asked: 0 }),
      transitions: { ask: { on: Ask, description: "Answers.", sends: [Told], run: (s, m, ctx) => void (s.asked++, ctx.reply(Told, { to: m.from })) }, askLost: lose(Ask, { spend: faults }) },
    });
    const Agent = defineActor({
      name: "Agent",
      zone,
      symmetric: true,
      initialState: () => ({ told: false }),
      actions: { ask: { label: "Ask", description: "Asks the server.", when: (s) => !s.told, sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, { from: ctx.self.id }) } },
      transitions: {
        told: { on: Told, description: "Told.", run: (s) => void (s.told = true) },
        toldLost: lose(Told, { fails: Ask, spend: faults }),
        askFailed: { on: failed(Ask), description: "Gives up.", run: () => {} },
      },
    });
    return defineSpec({ name: "Symmetric callers", actors: [Server, Agent] });
  })();
  const symmetric = await check(spec, { ...PLAIN, depth: 8, instances: { Agent: 2 }, symmetry: true });
  const plain = await check(spec, { ...PLAIN, depth: 8, instances: { Agent: 2 } });
  expect(symmetric.errors).toEqual([]);
  expect(symmetric.exhaustive).toBe(true);
  expect(symmetric.states).toBeLessThan(plain.states);
});
