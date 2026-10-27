// The alternating bit protocol, over a network that reorders.
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
// Expected: buggy breaks `inOrder` in 6 steps without faults (send "x", it lands, the retry
// sends it again, the acknowledgement moves the sender to "y", "y" lands, the stale "x"
// lands and is kept); fixed holds, with a message lost too.
import { defineSpec, message } from "@leostera/feynman";

const ITEMS = ["x", "y"];

export function alternatingBit(variant: "buggy" | "fixed") {
  return defineSpec(
    `Alternating bit (${variant})`,
    {
      messages: {
        Data: message<{ tag: number; value: string }>({ name: "data" }),
        Ack: message<{ tag: number }>({ name: "ack", tone: "reply" }),
      },
    },
    (spec) => {
      const { Data, Ack } = spec.messages;
      const zone = spec.defineZone({ name: "Link", description: "a network that loses and reorders", place: { arrange: "row" } });

      // What tells items apart: one alternating bit, or the item's position, which never repeats.
      const tagOf = (position: number) => (variant === "buggy" ? position % 2 : position);

      const Receiver = spec.defineActor({
        name: "Receiver",
        zone,
        singleton: true,
        initialState: () => ({ delivered: [] as string[] }),
        place: { order: 1 },
        look: {
          icon: "desktop",
          status: (s) => (s.delivered.length ? `has ${s.delivered.join(", ")}` : "nothing yet"),
          mood: (s) => (s.delivered.every((v, i) => v === ITEMS[i]) ? "ok" : "bad"),
        },
        transitions: {
          [Data]: {
            description: "Keeps the item if its tag is the one it expects next, and acknowledges the tag either way.",
            sends: [Ack],
            run(state, msg, ctx) {
              if (msg.tag === tagOf(state.delivered.length)) state.delivered.push(msg.value);
              ctx.reply(Ack, { tag: msg.tag });
            },
          },
        },
      });

      const Sender = spec.defineActor({
        name: "Sender",
        zone,
        singleton: true,
        initialState: () => ({ next: 0, started: false }),
        place: { order: 0 },
        look: {
          icon: "laptop",
          status: (s) => (!s.started ? "ready" : s.next >= ITEMS.length ? "sent everything" : `sending ${ITEMS[s.next]}`),
          mood: (s) => (!s.started ? "off" : s.next >= ITEMS.length ? "ok" : "busy"),
        },
        actions: {
          send: {
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
          [Ack]: {
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
            run(state, ctx) {
              if (state.next >= ITEMS.length) return;
              ctx.send(ctx.the(Receiver), Data, { tag: tagOf(state.next), value: ITEMS[state.next] });
              ctx.start("retry");
            },
          },
        },
      });

      spec.defineFinalState({
        description: "The sender has had every item acknowledged.",
        when: (w) => w.the(Sender).state.next === ITEMS.length,
      });
      spec.defineProperties({
        inStep: {
          description: "The sender is never past an item the receiver does not have.",
          always: (w) => w.the(Sender).state.next <= w.the(Receiver).state.delivered.length,
        },
        inOrder: {
          description: "The receiver has the items in order, each once.",
          always: (w) => w.the(Receiver).state.delivered.every((v, i) => v === ITEMS[i]),
        },
      });
      spec.defineScenario({
        name: "Sending x and y",
        description: "Each item arrives and is acknowledged before the next goes out.",
        run(s) {
          s.act(s.the(Sender), "send");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "A stale copy arrives late",
        description:
          variant === "buggy"
            ? "A resent copy of x arrives after y, carrying tag 0, the tag the receiver expects next: it keeps x twice."
            : "A resent copy of x arrives after y, carrying its position, 0: the receiver expects 2, and ignores it.",
        run(s) {
          const receiver = s.the(Receiver);
          const sender = s.the(Sender);
          s.act(sender, "send");
          s.deliver(receiver, "Data");
          s.fire(sender, "retry");
          s.deliver(sender, "Ack");
          s.deliver(receiver, "Data", { tag: 1, value: "y" });
          s.deliver(receiver, "Data");
          s.settle();
        },
      });
      return { Sender, Receiver };
    },
  );
}

/** `feynman check alternating-bit` checks the buggy variant, so you see the checker find the bug. */
export default alternatingBit("buggy");
export const fixed = alternatingBit("fixed");
