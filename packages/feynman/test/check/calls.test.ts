// Calls (RFD0009): losing a call, or its reply, gives the caller the call's failure instead of
// silence. The caller cannot tell which was lost, so a retry after a lost reply applies the
// call twice, unless the callee recognises it.
import { expect, test } from "bun:test";
import { check, type Bounds, type Report } from "../../src/check/index.ts";
import { act, call, defineSpec, fire, lose, message, pendingInOrder, restart, spawn, startWorld, type SpecBuilder, type World } from "../../src/spec/index.ts";
import { explore } from "./reference.ts";

/** A client that writes and, when the call throws, writes again; the store applies each write, once per id if `idempotent`. */
function retries(idempotent: boolean) {
  return defineSpec(
    `Retried writes (${idempotent ? "with" : "without"} an idempotency key)`,
    { messages: { Write: call<{ id: number }>({ name: "write", over: "rpc" }), Ok: message<{ id: number }>({ name: "ok", tone: "reply" }) } },
    (spec) => {
      const { Write, Ok } = spec.messages;
      const zone = spec.defineZone({ name: "z" });
      const Store = spec.defineActor({
        name: "Store",
        zone,
        singleton: true,
        initialState: () => ({ applied: 0, seen: [] as number[] }),
        transitions: {
          [Write]: {
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
      const Client = spec.defineActor({
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
          [Ok]: { description: "The write is done.", run: (s) => void (s.waiting = null) },
          [spec.failed(Write)]: {
            description: "The call threw: writes again.",
            sends: [Write],
            run(_state, failure, ctx) {
              ctx.send(failure.to, Write, failure.payload);
            },
          },
        },
      });
      spec.defineProperties({
        appliedOnce: { description: "The store applies no more writes than the client made.", always: (w) => w.the(Store).state.applied <= w.the(Client).state.written },
        answered: { description: "A write in progress ends.", leadsTo: { whenever: (w) => w.the(Client).state.waiting !== null, then: (w) => w.the(Client).state.waiting === null } },
      });
      return { Store, Client };
    },
  );
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
  const spec = defineSpec("Restarts", { messages: { Ask: call<{}>({ name: "ask" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const Server = s.defineActor({ name: "Server", zone, singleton: true, initialState: () => ({}), transitions: { [s.messages.Ask]: { description: "Takes it.", run: () => {} } } });
    s.defineActor({
      name: "Asker",
      zone,
      initialState: () => ({ failed: 0 }),
      actions: { ask: { label: "Ask", description: "Asks.", sends: [s.messages.Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), s.messages.Ask, {}) } },
      transitions: { [s.failed(s.messages.Ask)]: { description: "Gives up.", run: (state) => void state.failed++ } },
    });
  });
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
  const MESSAGES = { Ask: call<{}>({ name: "ask" }), Tell: message<{}>({ name: "tell" }) };
  const define = (body: (s: SpecBuilder<typeof MESSAGES>) => void) => () => defineSpec("Calls", { messages: MESSAGES }, body);
  expect(
    define((s) => {
      const zone = s.defineZone({ name: "z" });
      s.defineActor({ name: "Asker", zone, singleton: true, initialState: () => ({}), actions: { ask: { label: "Ask", description: "Asks.", sends: [s.messages.Ask], run: () => {} } } });
    }),
  ).toThrow("Asker: sends ask, a call: handle its failure with a transition keyed by spec.failed(Ask)");
  expect(define((s) => void s.failed(s.messages.Tell))).toThrow("spec.failed(message:Tell): tell is a message, not a call; declare it with call(…) for its failure to reach the caller");
  expect(
    define((s) => {
      const zone = s.defineZone({ name: "z" });
      s.defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), transitions: { ["failed:message:Tell" as never]: { description: "No.", run: () => {} } } });
    }),
  ).toThrow("A: failed:message:Tell is not the failure of one of this spec's calls");
  // Replying twice to a call, or with a call, is a spec error at the step.
  const twice = defineSpec("Twice", { messages: { Ask: call<{}>({ name: "ask" }), Ok: message<{}>({ name: "ok", tone: "reply" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const Server = s.defineActor({
      name: "Server",
      zone,
      singleton: true,
      initialState: () => ({}),
      transitions: { [s.messages.Ask]: { description: "Answers twice.", sends: [s.messages.Ok], run: (_s, _m, ctx) => (ctx.reply(s.messages.Ok, {}), ctx.reply(s.messages.Ok, {})) } },
    });
    s.defineActor({
      name: "Asker",
      zone,
      singleton: true,
      initialState: () => ({}),
      actions: { ask: { label: "Ask", description: "Asks.", sends: [s.messages.Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), s.messages.Ask, {}) } },
      transitions: { [s.messages.Ok]: { description: "Done.", run: () => {} }, [s.failed(s.messages.Ask)]: { description: "Gives up.", run: () => {} } },
    });
  });
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
  expect(scenarioCode(spec, broken)).toContain('s.deliver(client, "failed:Charge"); // from bank');
});
