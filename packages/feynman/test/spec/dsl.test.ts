// The DSL is a boundary: specs are code, but not always type-checked code (plain JavaScript,
// casts, generated specs). Mistakes it can see are reported where they are made, not taken
// for something else.
import { expect, test } from "bun:test";
import { act, defineActor, defineCall, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineZone, failed, spawn, startWorld } from "../../src/spec/index.ts";

const zone = defineZone({ name: "Z" });
const lone = () => defineActor({ name: "A", zone, singleton: true, initialState: () => ({ on: false }), transitions: { flip: { description: "Flips.", when: () => true, run: (s) => void (s.on = !s.on) } } });

test("a property declares exactly one kind, with a function", () => {
  expect(() => defineProperty("p", { description: "Two at once.", always: () => true, eventually: () => true } as never)).toThrow('Property "p": say what it checks with one of always, everyStep, never, eventually, leadsTo, infinitelyOften, eventuallyAlways, not always and eventually');
  expect(() => defineProperty("p", { description: "None." } as never)).toThrow('Property "p": say what it checks with one of');
  expect(() => defineProperty("p", { description: "Half.", leadsTo: { whenever: () => true } } as never)).toThrow('Property "p": leadsTo.then is a function');
  expect(() => defineProperty("p", { description: "Not a function.", always: true } as never)).toThrow('Property "p": always is a function');
});

test("names are unique within a spec", () => {
  const A = lone();
  const p = defineProperty("p", { description: "One.", always: () => true });
  const q = defineProperty("p", { description: "Again.", always: () => true });
  expect(() => defineSpec({ name: "T", actors: [A], properties: [p, q] })).toThrow('Two properties are named "p"');
  expect(() => defineSpec({ name: "T", actors: [A, lone()] })).toThrow('Two actors are named "A"');
  const s = defineScenario("s", { run: () => {} });
  expect(() => defineSpec({ name: "T", actors: [A], scenarios: [s, s] })).toThrow('Two scenarios are named "s"');
});

test("fairness is weak, strong or false, and only for transitions", () => {
  const withFair = (fair: unknown, on: "actions" | "transitions") => () =>
    defineSpec({ name: "T", actors: [defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), [on]: { go: { label: "Go", description: "Goes.", when: () => true, fair, run: () => {} } } } as never)] });
  expect(withFair("strong", "transitions")).not.toThrow();
  expect(withFair(false, "transitions")).not.toThrow();
  expect(withFair("weekly", "transitions")).toThrow('A.go: fair is "weak", "strong" or false, not "weekly"');
  expect(withFair("weak", "actions")).toThrow("A.go: actions are never fair");
});

test("the final state is a predicate", () => {
  expect(() => defineSpec({ name: "T", actors: [lone()], finalState: { description: "Done.", when: true as never } })).toThrow("finalState: `when` is a predicate");
});

test("a message has a word for an id and an object of fields for a payload", () => {
  expect(() => defineMessage("two words")).toThrow('defineMessage\'s first argument is its id, a word like "Charge"');
  expect(() => defineMessage("Charge", [String] as never)).toThrow("its payload is an object of field schemas");
  expect(() => defineMessage("Charge", { payment: "string" } as never)).toThrow("its payload is an object of field schemas");
  expect(defineMessage("SyncReply").name).toBe("sync reply");
  expect(defineMessage("Charge", {}, { name: "charge the card" }).name).toBe("charge the card");
  expect(() => failed(defineMessage("Charged") as never)).toThrow("failed(Charged): charged is a message, not a call");
});

/** A sender and a receiver; `on` and `sends` say what the receiver handles and the sender sends. */
function talk(options: { receives?: unknown; sends: unknown[]; failure?: boolean }) {
  const Receiver = defineActor({ name: "Receiver", zone, singleton: true, initialState: () => ({}), transitions: options.receives ? { got: { on: options.receives, description: "Gets it.", run: () => {} } } : {} } as never);
  const Sender = defineActor({
    name: "Sender",
    zone,
    singleton: true,
    initialState: () => ({}),
    actions: { go: { label: "Go", description: "Sends.", sends: options.sends, run: () => {} } },
    transitions: options.failure ? { gaveUp: { on: failed(options.sends[0] as never), description: "Gives up.", run: () => {} } } : {},
  } as never);
  return () => defineSpec({ name: "Talk", actors: [Receiver, Sender] });
}

test("who talks to whom is checked when the spec is assembled", () => {
  const Ping = defineMessage("Ping");
  const Ask = defineCall("Ask");
  expect(talk({ receives: Ping, sends: [Ping] })).not.toThrow();
  expect(talk({ sends: [Ping] })).toThrow("Sender.go: sends ping, but no actor of Talk has a step on Ping");
  // A call that nothing makes fail needs no step on its failure: a fault that sends one does (lose).
  expect(talk({ receives: Ask, sends: [Ask] })).not.toThrow();
  expect(talk({ receives: Ask, sends: [Ask], failure: true })).not.toThrow();
  expect(talk({ receives: Ping, sends: ["Ping"] })).toThrow('Sender.go: "Ping" is not a message from defineMessage or defineCall');
  expect(talk({ receives: Ping, sends: [defineMessage("Ping")] })).toThrow('Talk: two different messages have the id "Ping"');
});

test("several steps may be on one message, of which at most one is fair; an action and a step have different names", () => {
  const Ping = defineMessage("Ping");
  const actor = (transitions: object, actions: object = {}) => () =>
    defineSpec({ name: "T", actors: [defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), transitions, actions } as never)] });
  expect(actor({ a: { on: Ping, description: "", run: () => {} }, b: { on: Ping, description: "", run: () => {} } })).toThrow(
    "A: a and b are both fair steps on Ping; one message has at most one fair step, and the others say fair: false",
  );
  expect(actor({ a: { on: Ping, description: "", run: () => {} }, b: { on: Ping, fair: false, description: "", run: () => {} } })()).toMatchObject({ actors: [{ stepsOn: { "message:Ping": ["a", "b"] } }] });
  expect(actor({ ping: { on: Ping, description: "", run: () => {} } }, { ping: { label: "Ping", description: "", run: () => {} } })).toThrow("A: an action and a step are both named ping; give them different names");
  expect(actor({ a: { on: "Ping", description: "", run: () => {} } })).toThrow('A.a: on is a message from defineMessage, not "Ping"');
});

test("a payload is checked against its message's schema when it is sent", () => {
  const Pay = defineMessage("Pay", { amount: Number });
  const Shop = defineActor({ name: "Shop", zone, singleton: true, initialState: () => ({ paid: 0 }), transitions: { pay: { on: Pay, description: "Is paid.", run: (s, m) => void (s.paid += m.amount) } } });
  const Buyer = defineActor({
    name: "Buyer",
    zone,
    initialState: () => ({}),
    actions: {
      pay: { label: "Pay", description: "Pays.", sends: [Pay], run: (_s, _i, ctx) => ctx.send(ctx.the(Shop), Pay, { amount: "ten" as never }) },
      raw: { label: "Raw", description: "Sends a string.", sends: [Pay], run: (_s, _i, ctx) => ctx.send(ctx.the(Shop), "Pay" as never, { amount: 1 } as never) },
    },
  });
  const spec = defineSpec({ name: "Shop", actors: [Shop, Buyer] });
  const world = spawn(spec, startWorld(spec).at(-1)!.world, "Buyer", "b").world;
  expect(act(spec, world, "buyer-b", "pay").event.error).toBe('Buyer.pay: sends pay with amount: "ten", but its schema says number');
  expect(act(spec, world, "buyer-b", "raw").event.error).toContain('send and reply take a message from defineMessage');
});

test("a rule is read where the design being checked is known", () => {
  const r = defineRule("r", { description: "" });
  expect(() => r.on).toThrow("rule r: read rule.on in a step, a guard, a property or a display function");
  expect(() => defineRule("two words", { description: "" })).toThrow("A rule's name is a word");
  const p = defineProperty("p", { description: "", always: () => true, needs: [r] });
  const q = defineProperty("q", { description: "", always: () => true, needs: [defineRule("r", { description: "" })] });
  expect(() => defineSpec({ name: "T", actors: [lone()], properties: [p, q] })).toThrow('T: two different rules are named "r"');
  expect(() => defineSpec({ name: "T", actors: [lone()], properties: [p] }).withoutRules(["nope"])).toThrow('T has no rule named "nope"; its rules: r');
});
