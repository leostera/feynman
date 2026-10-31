// A webhook receiver that must credit each event once.
//
// A payment provider notifies a shop of two payments, in order, as webhook events. Delivery is
// at least once: the network may hand the shop the same event twice. The shop credits the
// customer for each event and skips the ones it has seen, but it remembers only the last
// event's id, which is enough only while events arrive in order. A copy of the first event
// that arrives after the second is not the last one seen, and is credited again. The fix:
// remember every event id credited.
//
// This covers messages the network duplicates (RFD0012's `duplicate`), and deduplication that
// silently assumes order.
//
// Expected: buggy holds without faults, and breaks `creditedOnce` in 6 steps with one (the
// first event is sent and duplicated, one copy arrives, the second event is sent and arrives,
// the other copy of the first arrives and is credited again); fixed holds, with faults too.
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, duplicate, lose } from "@leostera/feynman";

/** Faults on one path: duplicated and lost events. `--set faults=2` raises it. */
const faults = budget("faults", 1);

const EVENTS = ["evt-1", "evt-2"];
const AMOUNT = 10;

const Event = defineMessage("Event", { id: String });

export function webhooks(variant: "buggy" | "fixed") {
  const provider = defineZone({ name: "Provider", description: "takes payments and notifies the shop", place: { column: 0 } });
  const shop = defineZone({ name: "Shop", description: "credits customers for their payments", place: { column: 1, region: true } });

  const Receiver = defineActor({
    name: "Receiver",
    zone: shop,
    singleton: true,
    // Credits and what it remembers are in the shop's database.
    initialState: () => ({ balance: 0, last: null as string | null, seen: [] as string[] }),
    display: {
      icon: "server",
      status: (s) => `credited ${s.balance}`,
      mood: (s) => (s.balance > AMOUNT * EVENTS.length ? "bad" : s.balance ? "ok" : "off"),
      rows: (s) => (variant === "buggy" ? [{ label: "last event", detail: s.last ?? "none" }] : s.seen.map((id) => ({ label: id, detail: "credited" }))),
    },
    transitions: {
      event: {
        on: Event,
        description: variant === "buggy" ? "Credits the payment, unless it is the last event seen." : "Credits the payment, unless its event was credited before.",
        say: (s, msg) => ((variant === "buggy" ? s.last === msg.id : s.seen.includes(msg.id)) ? `Skips ${msg.id}, seen` : `Credits ${msg.id}`),
        run(state, msg) {
          if (variant === "buggy") {
            if (state.last === msg.id) return;
            state.last = msg.id;
          } else {
            if (state.seen.includes(msg.id)) return;
            state.seen.push(msg.id);
          }
          state.balance += AMOUNT;
        },
      },
      eventTwice: duplicate(Event, { spend: faults }),
      eventLost: lose(Event, { spend: faults }),
    },
  });

  const Provider = defineActor({
    name: "Provider",
    zone: provider,
    singleton: true,
    initialState: () => ({ sent: 0 }),
    display: { icon: "card", status: (s) => `${s.sent} of ${EVENTS.length} event(s) sent`, mood: (s) => (s.sent ? "ok" : "off") },
    actions: {
      notify: {
        with: [atMost(2)],
        label: "Notify",
        description: "Sends the shop the next payment's event.",
        when: (s) => s.sent < EVENTS.length,
        sends: [Event],
        run(state, _inputs, ctx) {
          ctx.send(ctx.the(Receiver), Event, { id: EVENTS[state.sent] });
          state.sent += 1;
        },
      },
    },
  });

  const creditedOnce = defineProperty("creditedOnce", {
    description: "The shop never credits more than the payments it was notified of.",
    always: (w) => w.the(Receiver).state.balance <= AMOUNT * w.the(Provider).state.sent,
  });

  const twoEvents = defineScenario("Two events", {
    description: "The provider sends both events; the shop credits each once.",
    run(s) {
      s.act(s.the(Provider), "notify");
      s.act(s.the(Provider), "notify");
      s.settle();
    },
  });

  const aCopyArrivesLate = defineScenario("A copy arrives late", {
    description:
      variant === "buggy"
        ? "The first event arrives twice, the second in between: the late copy is not the last event seen, and is credited again."
        : "The first event arrives twice, the second in between: the shop has seen the late copy's id, and skips it.",
    run(s) {
      const receiver = s.the(Receiver);
      s.act(s.the(Provider), "notify");
      s.step(receiver, "eventTwice");
      s.deliver(receiver, Event, { id: "evt-1" });
      s.act(s.the(Provider), "notify");
      s.deliver(receiver, Event, { id: "evt-2" });
      s.deliver(receiver, Event, { id: "evt-1" });
    },
  });

  return defineSpec({
    name: `Webhooks (${variant})`,
    actors: [Provider, Receiver],
    properties: [creditedOnce],
    finalState: { description: "Both events are sent and nothing is in flight.", when: (w) => w.quiet && w.the(Provider).state.sent === EVENTS.length },
    scenarios: [twoEvents, aCopyArrivesLate],
  });
}

/** `feynman check webhooks` checks the buggy variant, so you see the checker find the bug. */
export default webhooks("buggy");
export const fixed = webhooks("fixed");
