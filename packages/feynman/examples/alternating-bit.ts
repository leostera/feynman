// The alternating bit protocol, over a network that reorders, and over one that keeps order.
//
// A sender sends two items, one at a time, and resends the current one until it is
// acknowledged. Each message carries a bit that alternates from one item to the next; the
// receiver keeps an item only if its bit is the one it expects, and acknowledges with the bit
// it got; the sender moves on on an acknowledgement of its current bit. The protocol is
// correct on a link that keeps messages in order, which is what it was designed for. Here
// the network may reorder: a retry's stale copy of "x" can land after "y", when the expected
// bit has come round to 0 again, and is kept as a third item. The fix: sequence numbers,
// which do not come round.
//
// Over a link that keeps order (`alternatingBit("buggy", "ordered")`: both messages ordered,
// as over TCP, losses allowed), the stale "x" cannot overtake "y", and one bit is enough.
//
// Expected: buggy breaks `inOrder` in 6 steps without faults (send "x", it lands, the retry
// sends it again, the acknowledgement moves the sender to "y", "y" lands, the stale "x"
// lands and is kept); fixed holds, with a message lost too; buggy on an ordered link holds,
// with a message lost too.
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const ITEMS = ["x", "y"];

export function alternatingBit(variant: "buggy" | "fixed", link: "reorders" | "ordered" = "reorders") {
  const ordered = link === "ordered";
  const Data = defineMessage("Data", { tag: Number, value: String }, { ordered });
  const Ack = defineMessage("Ack", { tag: Number }, { tone: "reply", ordered });
  const zone = defineZone({ name: "Link", description: ordered ? "a network that loses, and keeps order" : "a network that loses and reorders", place: { arrange: "row" } });

  // What tells items apart: one alternating bit, or the item's position, which never repeats.
  const tagOf = (position: number) => (variant === "buggy" ? position % 2 : position);

  const Receiver = defineActor({
    name: "Receiver",
    zone,
    singleton: true,
    initialState: () => ({ delivered: [] as string[] }),
    place: { order: 1 },
    display: {
      icon: "desktop",
      status: (s) => (s.delivered.length ? `has ${s.delivered.join(", ")}` : "nothing yet"),
      mood: (s) => (s.delivered.every((v, i) => v === ITEMS[i]) ? "ok" : "bad"),
    },
    transitions: {
      data: {
        on: Data,
        description: "Keeps the item if its tag is the one it expects next, and acknowledges the tag either way.",
        sends: [Ack],
        run(state, msg, ctx) {
          if (msg.tag === tagOf(state.delivered.length)) state.delivered.push(msg.value);
          ctx.reply(Ack, { tag: msg.tag });
        },
      },
      dataLost: lose(Data, { spend: faults }),
    },
  });

  const Sender = defineActor({
    name: "Sender",
    zone,
    singleton: true,
    initialState: () => ({ next: 0, started: false }),
    place: { order: 0 },
    display: {
      icon: "laptop",
      status: (s) => (!s.started ? "ready" : s.next >= ITEMS.length ? "sent everything" : `sending ${ITEMS[s.next]}`),
      mood: (s) => (!s.started ? "off" : s.next >= ITEMS.length ? "ok" : "busy"),
    },
    actions: {
      send: {
        with: [atMost(2)],
        label: "Send",
        description: "Starts sending the items.",
        when: (state) => !state.started,
        sends: [Data],
        starts: ["retry"],
        run(state, _inputs, ctx) {
          state.started = true;
          ctx.send(ctx.the(Receiver), Data, { tag: tagOf(state.next), value: ITEMS[state.next] });
          ctx.start("retry");
        },
      },
    },
    transitions: {
      ack: {
        on: Ack,
        description: "Moves on to the next item, if the acknowledgement carries the current item's tag.",
        sends: [Data],
        starts: ["retry"],
        run(state, msg, ctx) {
          if (state.next >= ITEMS.length || msg.tag !== tagOf(state.next)) return;
          state.next += 1;
          if (state.next === ITEMS.length) return void ctx.cancel("retry");
          ctx.send(ctx.the(Receiver), Data, { tag: tagOf(state.next), value: ITEMS[state.next] });
          ctx.start("retry");
        },
      },
      retry: {
        description: "No acknowledgement yet: sends the current item again.",
        after: "1 second",
        sends: [Data],
        starts: ["retry"],
        run(state, _, ctx) {
          if (state.next >= ITEMS.length) return;
          ctx.send(ctx.the(Receiver), Data, { tag: tagOf(state.next), value: ITEMS[state.next] });
          ctx.start("retry");
        },
      },
      ackLost: lose(Ack, { spend: faults }),
    },
  });

  const inStep = defineProperty("inStep", {
    description: "The sender is never past an item the receiver does not have.",
    always: (w) => w.the(Sender).state.next <= w.the(Receiver).state.delivered.length,
  });

  const inOrder = defineProperty("inOrder", {
    description: "The receiver has the items in order, each once.",
    always: (w) => w.the(Receiver).state.delivered.every((v, i) => v === ITEMS[i]),
  });

  const sendingXAndY = defineScenario("Sending x and y", {
    description: "Each item arrives and is acknowledged before the next goes out.",
    run(s) {
      s.act(s.the(Sender), "send");
      s.settle();
    },
  });

  const aLostItemIsSentAgain = defineScenario("A lost item is sent again", {
    description: "x is lost on the way; the sender hears nothing, and its retry sends x again.",
    run(s) {
      const sender = s.the(Sender);
      s.act(sender, "send");
      s.step(s.the(Receiver), "dataLost");
      s.fire(sender, "retry");
      s.settle();
    },
  });

  const aStaleCopyArrivesLate = defineScenario("A stale copy arrives late", {
    description:
      variant === "buggy"
        ? "A resent copy of x arrives after y, carrying tag 0, the tag the receiver expects next: it keeps x twice."
        : "A resent copy of x arrives after y, carrying its position, 0: the receiver expects 2, and ignores it.",
    run(s) {
      const receiver = s.the(Receiver);
      const sender = s.the(Sender);
      s.act(sender, "send");
      s.deliver(receiver, Data);
      s.fire(sender, "retry");
      s.deliver(sender, Ack);
      s.deliver(receiver, Data, { tag: 1, value: "y" });
      s.deliver(receiver, Data);
      s.settle();
    },
  });

  return defineSpec({
    name: `Alternating bit (${variant}${ordered ? ", on an ordered link" : ""})`,
    actors: [Receiver, Sender],
    properties: [inStep, inOrder],
    finalState: {
      description: "The sender has had every item acknowledged.",
      when: (w) => w.the(Sender).state.next === ITEMS.length,
    },
    // On an ordered link, the stale copy cannot arrive after y: there is no such story.
    scenarios: ordered ? [sendingXAndY, aLostItemIsSentAgain] : [sendingXAndY, aLostItemIsSentAgain, aStaleCopyArrivesLate],
  });
}

/** `feynman check alternating-bit` checks the buggy variant, so you see the checker find the bug. */
export default alternatingBit("buggy");
export const fixed = alternatingBit("fixed");
export const ordered = alternatingBit("buggy", "ordered");
