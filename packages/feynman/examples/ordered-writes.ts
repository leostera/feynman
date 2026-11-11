// Writes over one connection.
//
// A client sets a value, up to three times; each write goes to a store, which applies it
// as it arrives. Once nothing is in flight, the store should hold the client's last write.
// Over a network that reorders, the first write can arrive last and win. Over one connection
// (TCP, a websocket), writes arrive in the order they were sent: `ordered: true`. That is
// enough without faults; a lost write still leaves the store behind, as no ordering helps
// with.
//
// Expected: buggy breaks `lastWriteWins` in 4 steps without faults (set a, set b, b lands,
// a lands); fixed holds without faults, and breaks in 2 with one (set a, a is lost).
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose, oneOf } from "@leostera/feynman";

/** Faults on one path: lost messages (RFD0012). `--set faults=1` allows one. */
const faults = budget("faults", 0);

export function orderedWrites(variant: "buggy" | "fixed") {
  const Put = defineMessage("Put", { value: String }, { ordered: variant === "fixed" });
  const zone = defineZone({ name: "App", description: variant === "fixed" ? "one connection, which keeps order" : "a network that reorders", place: { arrange: "row" } });

  const Store = defineActor({
    name: "Store",
    zone,
    singleton: true,
    place: { order: 1 },
    initialState: () => ({ value: null as string | null }),
    display: { icon: "database", status: (s) => s.value ?? "empty", mood: (s) => (s.value ? "ok" : "off") },
    transitions: {
      put: { on: Put, description: "Applies the write.", run: (state, msg) => void (state.value = msg.value) },
      putLost: lose(Put, { spend: faults }),
    },
  });

  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    place: { order: 0 },
    initialState: () => ({ last: null as string | null }),
    display: { icon: "laptop", status: (s) => (s.last ? `wrote ${s.last}` : "nothing written"), mood: (s) => (s.last ? "busy" : "off") },
    actions: {
      set: {
        with: [atMost(3)],
        label: "Set",
        description: "Writes a value.",
        inputs: { value: oneOf("a", "b") },
        sends: [Put],
        run(state, { value }, ctx) {
          state.last = value;
          ctx.send(ctx.the(Store), Put, { value });
        },
      },
    },
  });

  const lastWriteWins = defineProperty("lastWriteWins", {
    description: "Once nothing is in flight, the store holds the client's last write.",
    always: (w) => !w.quiet || w.the(Store).state.value === w.the(Client).state.last,
  });

  const twoWrites = defineScenario("Two writes", {
    description: "The client sets a, then b, and each arrives in turn.",
    run(s) {
      s.act(s.the(Client), "set", { value: "a" });
      s.act(s.the(Client), "set", { value: "b" });
      s.settle();
    },
  });

  const aWriteOvertaken = defineScenario("A write overtaken", {
    description:
      variant === "buggy"
        ? "The client sets a, then b; b lands first, then a, which the store keeps: the first write wins."
        : "The client sets a, then b; over one connection b cannot land first: a does, then b, which wins.",
    run(s) {
      const store = s.the(Store);
      s.act(s.the(Client), "set", { value: "a" });
      s.act(s.the(Client), "set", { value: "b" });
      if (variant === "buggy") s.deliver(store, Put, { value: "b" });
      s.settle();
    },
  });

  return defineSpec({
    name: `Ordered writes (${variant})`,
    actors: [Client, Store],
    properties: [lastWriteWins],
    finalState: { description: "Nothing is in flight.", when: (w) => w.quiet },
    scenarios: [twoWrites, aWriteOvertaken],
  });
}

/** `feynman check ordered-writes` checks the buggy variant, so you see the checker find the bug. */
export default orderedWrites("buggy");
export const fixed = orderedWrites("fixed");
