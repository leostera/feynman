import { expect, test } from "bun:test";
import { act, atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, fire, pendingInOrder, Runner, runScenario, startWorld } from "../../src/spec/index.ts";
import remoteAccess from "./fixtures/remote-access.ts";

test("a scenario runs to its end, recording what each step changed and sent", () => {
  const run = runScenario(remoteAccess, remoteAccess.scenarios[0]);
  expect(run.error).toBeUndefined();
  expect(run.events.map((e) => `${e.actor}.${e.key}`)).toEqual([
    "Person.spawn",
    "Mac.spawn",
    "Person.pairHost",
    "Axo relay.newCode",
    "Person.code",
    "Mac.link",
    "Axo relay.redeem",
    "Mac.redeemed",
  ]);
  const link = run.events.find((e) => e.key === "link")!;
  expect(link.inputs).toEqual({ code: "code-1" });
  expect(link.changes.map((c) => `${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)).toEqual([
    'link.pending: null → "cred-1"',
    'code: null → "code-1"',
    'keychain: [] → ["cred-1"]',
    "@Mac.link: 0 → 1", // one of the times it may link (atMost)
  ]);
  expect(link.sent.map((s) => s.message)).toEqual(["message:Redeem"]);
  expect(link.started.map((s) => s.timer)).toEqual(["redeemTimeout"]);
  const studio = run.worlds.at(-1)!.instances.find((i) => i.id === "mac-studio")!;
  expect(studio.state).toMatchObject({ link: { account: "acct-Alice", pending: null } });
  expect(run.events.every((e) => !e.error && e.violations.length === 0)).toBe(true);
  // Redeemed cancelled the timeout: nothing is left pending.
  expect(run.worlds.at(-1)!.pending).toEqual([]);
});

test("runs are deterministic: the same spec and seed give the same trace", () => {
  const a = runScenario(remoteAccess, remoteAccess.scenarios[0], 7);
  const b = runScenario(remoteAccess, remoteAccess.scenarios[0], 7);
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});

test("a lost reply leaves the Mac retrying, and the relay refuses the used code", () => {
  const runner = new Runner(remoteAccess);
  const alice = runner.spawn("Person", "Alice").instance;
  const studio = runner.spawn("Mac", "Studio").instance;
  runner.act(alice, "pairHost");
  runner.settle();
  const code = (runner.world.instances.find((i) => i.id === alice)!.state as { codes: string[] }).codes[0];
  runner.act(studio, "link", { code });
  runner.next(); // the relay redeems it, and answers
  runner.step(studio, "redeemedLost");
  runner.settle();
  const keys = runner.events.map((e) => `${e.kind} ${e.actor}.${e.key}`);
  expect(keys).toContain("deliver Mac.redeemedLost"); // a lost message is a step on it, a fault
  expect(keys).toContain("timer Mac.redeemTimeout");
  expect(keys.at(-1)).toBe("deliver Mac.refused");
  const mac = runner.world.instances.find((i) => i.id === studio)!.state as { link: { account: string | null } };
  expect(mac.link.account).toBeNull();
});

test("a send the step does not declare is a spec error, and the step has no effects", () => {
  const spec = (() => {
    const Ping = defineMessage("Ping");
    const zone = defineZone({ name: "z" });
    const A = defineActor({
      name: "A",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: {
        go: {
          label: "Go",
          description: "Sends without declaring it.",
          sources: ["a.ts#go"],
          run(state, _inputs, ctx) {
            state.n = 1;
            ctx.send(ctx.the(A), Ping, {});
          },
        },
      },
    });
    return defineSpec({
      name: "Undeclared",
      actors: [A],
    });
  })();
  const [start] = startWorld(spec);
  const step = act(spec, start.world, "a", "go");
  expect(step.event.error).toBe("A.go: sends Ping, which it does not declare in sends");
  expect(step.event.changes).toEqual([]);
  expect(step.world.pending).toEqual([]);
  expect(step.world.instances[0].state).toEqual({ n: 0 });
});

test("invariants that do not hold are reported on the event that broke them", () => {
  const spec = (() => {
    const Ping = defineMessage("Ping");
    const zone = defineZone({ name: "z" });
    const Counter = defineActor({
      name: "Counter",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: {
        bump: { label: "Bump", description: "Adds one.", sources: ["c.ts#bump"], sends: [Ping], run: (state, _i, ctx) => { state.n += 1; ctx.send(ctx.the(Counter), Ping, {}); } },
      },
      transitions: {
        ping: { on: Ping, description: "Adds one more.", sources: ["c.ts#ping"], run: (state) => void (state.n += 1) },
      },
    });

    const atMostTwo = defineProperty("atMostTwo", { description: "n stays at two or below.", always: (w) => w.the(Counter).state.n <= 2 });
    return defineSpec({
      name: "Broken",
      actors: [Counter],
      properties: [atMostTwo],
    });
  })();
  let world = startWorld(spec).at(-1)!.world;
  world = act(spec, world, "counter", "bump").world;
  const delivered = fire(spec, world, pendingInOrder(world)[0].id);
  expect(delivered.event.violations).toEqual([]);
  const again = act(spec, delivered.world, "counter", "bump");
  expect(again.event.violations).toEqual(["atMostTwo"]);
});

test("a crash keeps what it keeps and forgets the rest, and its timers", () => {
  const runner = new Runner(remoteAccess);
  const studio = runner.spawn("Mac", "Studio").instance;
  runner.act(studio, "link", { code: "never-issued" });
  const restarted = runner.step(studio, "crash");
  // It spends one of the faults the model allows, too.
  expect(restarted.changes.map((c) => c.path)).toEqual(["link.pending", "code", "keychain", "@faults"]);
  expect(runner.world.pending.filter((p) => p.kind === "timer")).toEqual([]);
});

const Tick = defineMessage("Tick", { n: Number });

// A counter that ticks itself up to 3, sending a note to a log each time.
function ticker(run: (state: { n: number }) => unknown = (state) => void (state.n += 1)) {
  const zone = defineZone({ name: "z" });
  const Log = defineActor({
    name: "Log",
    zone,
    singleton: true,
    initialState: () => ({ seen: [] as number[] }),
    transitions: { tick: { on: Tick, description: "Writes it down.", run: (state, msg) => void state.seen.push(msg.n) } },
  });
  const Counter = defineActor({
    name: "Counter",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    transitions: {
      tick: {
        description: "Counts one.",
        sends: [Tick],
        when: (state) => state.n < 3,
        run: (state, _, ctx) => {
          const returned = run(state);
          ctx.send(ctx.the(Log), Tick, { n: state.n });
          return returned as void;
        },
      },
    },
  });

  const untilTwoAreLogged = defineScenario("Until two are logged", { run: (sc) => sc.settle({ until: (w) => w.the(Log).state.seen.length === 2 }) });

  const untilTenAreLogged = defineScenario("Until ten are logged", { run: (sc) => sc.settle({ until: (w) => w.the(Log).state.seen.length === 10 }) });

  const untilItHasStarted = defineScenario("Until it has started", { run: (sc) => sc.settle({ until: (w) => w.the(Counter).state.n >= 0 }) });

  return defineSpec({
    name: "Ticker",
    actors: [Log, Counter],
    scenarios: [untilTwoAreLogged, untilTenAreLogged, untilItHasStarted],
  });
}

test("settle({ until }) stops as soon as the world gets there, and fails if it never does", () => {
  const spec = ticker();
  const [two, ten, start] = spec.scenarios.map((scenario) => runScenario(spec, scenario));
  expect(two.error).toBeUndefined();
  expect(two.worlds.at(-1)!.instances.find((i) => i.actor === "Log")!.state).toEqual({ seen: [1, 2] });
  // Stopped at once: the third tick may have happened, but its note is still in flight.
  expect(two.worlds.at(-1)!.pending.length).toBeLessThanOrEqual(1);
  expect(ten.error).toBe("settle: nothing is left to happen, and `until` never held");
  expect(start.events).toEqual([]);
});

test("a step that returns a new state is an error: state changes in place", () => {
  const assigned = ticker((state) => (state.n += 1));
  expect(runScenario(assigned, assigned.scenarios[0]).error).toBeUndefined();
  const returned = ticker((state) => ({ n: state.n + 1 }));
  const run = runScenario(returned, returned.scenarios[0]);
  expect(run.error).toContain("Counter.tick: its run returned an object, which is ignored: a step changes its state in place");
  const async = ticker(async (state) => void (state.n += 1));
  expect(runScenario(async, async.scenarios[0]).error).toContain("Counter.tick: its run is async");
});

test("an actor without a zone says so", () => {
  expect(() =>
    (() => {

    const AActor = defineActor({ name: "A", singleton: true, initialState: () => ({}) } as never);
    return defineSpec({
      name: "Nowhere",
      actors: [AActor],
    });
  })(),
  ).toThrow("A: say where it runs, with zone: a zone from defineZone");
});

test("a timer whose run is (state, ctx) says so when the spec is defined", () => {
  expect(() =>
    (() => {

    const zone = defineZone({ name: "z" });
    const ClientActor = defineActor({
      name: "Client",
      zone,
      singleton: true,
      initialState: () => ({ tries: 0 }),
      transitions: { retry: { description: "Tries again.", run: ((state: { tries: number }, _ctx: unknown) => void state.tries++) as never } },
    });
    return defineSpec({
      name: "Retries",
      actors: [ClientActor],
    });
  })(),
  ).toThrow("Client.retry: a timer or a guard receives nothing, and its run is (state, _, ctx), not (state, ctx)");
});

const Push = defineMessage("Push", { commit: Number });

// A store that keeps pushed commits, and clients that push the next one.
function repository() {
  const zone = defineZone({ name: "z" });
  const Store = defineActor({
    name: "Store",
    zone,
    singleton: true,
    initialState: () => ({ commits: [] as number[], head: 0 }),
    transitions: { push: { on: Push, description: "Keeps it.", run: (state, msg) => void (state.commits.push(msg.commit), (state.head = msg.commit)) } },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    initialState: () => ({ head: 0 }),
    actions: { push: { label: "Push", description: "Pushes the next commit.", sends: [Push], run: (state, _i, ctx) => ctx.send(ctx.the(Store), Push, { commit: ++state.head }) } },
  });

  const secondPush = defineScenario("Second push", {
    setup(w) {
      w.set(Store, { commits: [1], head: 1 });
      w.spawn(Client, "Alice", { head: 1 });
    },
    run(sc) {
      sc.act(sc.the(Client), "push");
      sc.settle();
    },
  });

  const noSuchField = defineScenario("No such field", { setup: (w) => w.set(Store, { tip: 1 } as never), run: () => {} });

  const setAClient = defineScenario("Set a client", { setup: (w) => w.set(Client, { head: 1 }), run: () => {} });

  const spawnTheStore = defineScenario("Spawn the store", { setup: (w) => w.spawn(Store, "Store"), run: () => {} });

  const notPlain = defineScenario("Not plain", { setup: (w) => w.set(Store, { commits: [() => 1] as never }), run: () => {} });

  return defineSpec({
    name: "Repository",
    actors: [Store, Client],
    scenarios: [secondPush, noSuchField, setAClient, spawnTheStore, notPlain],
  });
}

test("setup: a scenario starts in the world it sets, and its flow starts after it", () => {
  const spec = repository();
  const run = runScenario(spec, spec.scenarios[0]);
  expect(run.error).toBeUndefined();
  expect(run.initial.instances.map((i) => [i.label, i.state])).toEqual([
    ["Store", { commits: [1], head: 1 }],
    ["Alice", { head: 1 }],
  ]);
  // No spawn and no setup in the trace: only what the scenario does.
  expect(run.events.map((e) => `${e.actor} ${e.key}`)).toEqual(["Client push", "Store push"]);
  expect(run.worlds.at(-1)!.instances[0].state).toEqual({ commits: [1, 2], head: 2 });
  expect(Object.isFrozen(run.initial.instances[0].state)).toBe(true);
});

test("setup: fields the state does not have, the wrong way to set an instance, and data that is not plain are errors", () => {
  const spec = repository();
  const error = (name: string) => runScenario(spec, spec.scenarios.find((s) => s.name === name)!).error;
  expect(error("No such field")).toBe('setup: Store: its state has no field "tip" (it has commits, head)');
  expect(error("Set a client")).toBe("setup: set(Client): it is not a singleton; spawn(Client, label, state) sets up one of them");
  expect(error("Spawn the store")).toBe("setup: spawn(Store): it is a singleton, there from the start; set(Store, state) sets it up");
  expect(error("Not plain")).toContain("setup: Store: holds state.commits[0]: a function, which is not plain data");
});

test("several steps on one message: each is a way to take it, left alone takes the fair one, and a step's when gates it", async () => {
  const Ping = defineMessage("Ping");
  const zone = defineZone({ name: "z" });
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ answered: 0, ignored: 0, open: true }),
    transitions: {
      answer: { on: Ping, description: "Answers.", run: (s) => void s.answered++ },
      ignore: { on: Ping, fair: false, when: (s) => s.open, description: "Ignores it, while open.", run: (s) => void (s.ignored++, (s.open = false)) },
    },
  });
  const Client = defineActor({ name: "Client", zone, singleton: true, initialState: () => ({}), actions: { ping: { label: "Ping", description: "Pings, twice at most.", with: [atMost(2)], sends: [Ping], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ping, {}) } } });
  const ignored = defineScenario("Ignored", { run: (s) => (s.act(s.the(Client), "ping"), s.step(s.the(Server), "ignore")) });
  const settled = defineScenario("Settled", { run: (s) => (s.act(s.the(Client), "ping"), s.settle()) });
  const spec = defineSpec({ name: "Steps", actors: [Server, Client], scenarios: [ignored, settled] });
  const run = runScenario(spec, spec.scenarios[0]);
  expect(run.error).toBeUndefined();
  expect(run.events.map((e) => `${e.actor}.${e.key}`).slice(-2)).toEqual(["Client.ping", "Server.ignore"]);
  expect(run.worlds.at(-1)!.instances.find((i) => i.actor === "Server")!.state).toEqual({ answered: 0, ignored: 1, open: false });
  expect(runScenario(spec, spec.scenarios[1]).events.at(-1)!.key).toBe("answer");
  // The checker takes the message either way, while the guard allows.
  const { check } = await import("../../src/check/index.ts");
  const report = await check(spec, { depth: 6, walks: 0 });
  expect(report.coverage.missed).toEqual([]);
  // Start; one ping in flight; answered or ignored; two in flight; then those, met by either order.
  expect(report.states).toBe(9);
});
