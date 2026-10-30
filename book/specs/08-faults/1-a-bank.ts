// Chapter 8, step 1: the box office charges the card through the bank.
//
// Expected: both properties hold. No message is ever lost: the spec declares no faults.
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

/** The last seat, and the order a hold opens: a payment is for one order. */
type Seat = { kind: "free" } | { kind: "held"; by: string; order: string } | { kind: "paying"; by: string; order: string } | { kind: "sold"; to: string };

const Hold = defineMessage("Hold", {}, { name: "hold the seat", over: "https" });
const Held = defineMessage("Held", {}, { tone: "reply" });
const Unavailable = defineMessage("Unavailable", {}, { tone: "refused" });
const Pay = defineMessage("Pay", {}, { over: "https" });
const Ticket = defineMessage("Ticket", {}, { tone: "reply" });
const Expired = defineMessage("Expired", {}, { name: "hold expired", tone: "refused" });
const Charge = defineMessage("Charge", { order: String }, { over: "https" });
const Charged = defineMessage("Charged", { order: String }, { tone: "reply" });

const people = defineZone({ name: "People", description: "buying on their phones", place: { column: 0 } });
const theatre = defineZone({ name: "Theatre", description: "the box office", place: { column: 1 } });
const bank = defineZone({ name: "Bank", description: "the card processor", place: { column: 2 } });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website and its database, deciding each request in one statement.",
  zone: theatre,
  singleton: true,
  initialState: () => ({ seat: { kind: "free" } as Seat }),
  display: {
    icon: "server",
    status: (s) => (s.seat.kind === "free" ? "the last seat is free" : s.seat.kind === "sold" ? "sold out" : `the last seat is ${s.seat.kind}`),
  },
  transitions: {
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free, and opens an order for it.",
      sends: [Held, Unavailable],
      starts: ["expire"],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id, order: ctx.fresh("order") };
        ctx.start("expire");
        ctx.reply(Held, {});
      },
    },
    pay: {
      on: Pay,
      description: "Charges the card of whoever holds the seat; anyone else's hold has expired.",
      sends: [Charge, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "held" || state.seat.by !== ctx.from.id) return ctx.reply(Expired, {});
        state.seat = { ...state.seat, kind: "paying" };
        ctx.cancel("expire");
        ctx.send(ctx.the(Bank), Charge, { order: state.seat.order });
      },
    },
    charged: {
      on: Charged,
      description: "The card was charged: sells the seat and sends the ticket.",
      sends: [Ticket],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "paying") return; // a late answer for an order already settled
        const buyer = state.seat.by;
        state.seat = { kind: "sold", to: buyer };
        ctx.send({ id: buyer }, Ticket, {});
      },
    },
    expire: {
      description: "The hold runs out, and the seat is free again.",
      after: "10 minutes",
      run(state) {
        if (state.seat.kind === "held") state.seat = { kind: "free" };
      },
    },
  },
});

const Bank = defineActor({
  name: "Bank",
  description: "The card processor the theatre uses.",
  zone: bank,
  singleton: true,
  initialState: () => ({ charges: [] as string[] }),
  display: { icon: "card", status: (s) => `${s.charges.length} charge(s)` },
  transitions: {
    charge: {
      on: Charge,
      description: "Charges the card for the order, and answers.",
      sends: [Charged],
      run(state, msg, ctx) {
        state.charges.push(msg.order);
        ctx.reply(Charged, msg);
      },
    },
  },
});

type Phone = "browsing" | "holding" | "asking" | "paying" | "done";

const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true,
  initialState: () => ({ phone: "browsing" as Phone, ticket: false }),
  display: {
    icon: "phone",
    names: ["Alice", "Bob"],
    status: (s) => (s.ticket ? "has a ticket" : s.phone),
    mood: (s) => (s.ticket ? "ok" : s.phone === "done" ? "off" : "busy"),
  },
  actions: {
    hold: {
      with: [atMost(2)],
      label: "Hold the seat",
      description: "Asks the box office to hold the last seat.",
      when: (s) => s.phone === "browsing",
      sends: [Hold],
      run(state, _inputs, ctx) {
        state.phone = "asking";
        ctx.send(ctx.the(BoxOffice), Hold, {});
      },
    },
    pay: {
      label: "Pay",
      description: "Pays for the seat on hold.",
      when: (s) => s.phone === "holding",
      sends: [Pay],
      run(state, _inputs, ctx) {
        state.phone = "paying";
        ctx.send(ctx.the(BoxOffice), Pay, {});
      },
    },
  },
  transitions: {
    held: { on: Held, description: "Sees the seat is held for them.", run: (s) => void (s.phone = "holding") },
    unavailable: { on: Unavailable, description: "Sees someone else has the seat.", run: (s) => void (s.phone = "browsing") },
    ticket: {
      on: Ticket,
      description: "Gets the ticket.",
      run(s) {
        s.ticket = true;
        s.phone = "done";
      },
    },
    expired: { on: Expired, description: "Hears the hold ran out before the payment.", run: (s) => void (s.phone = "browsing") },
  },
});

const chargedOnce = defineProperty("chargedOnce", {
  description: "No order is charged twice.",
  always: (w) => {
    const charges = w.the(Bank).state.charges;
    return new Set(charges).size === charges.length;
  },
});

const oneTicket = defineProperty("oneTicket", {
  description: "At most one person has a ticket for the last seat.",
  always: (w) => w.all(Person).filter((p) => p.state.ticket).length <= 1,
});

const aliceBuys = defineScenario("Alice buys the last seat", {
  description: "Alice holds the seat, pays in time, the bank charges her card, and she gets the ticket.",
  setup(w) {
    w.spawn(Person, "Alice");
    w.spawn(Person, "Bob");
  },
  run(s) {
    const alice = s.all(Person).find((p) => p.label === "Alice")!;
    s.act(alice, "hold");
    s.settle({ until: (w) => w.all(Person).some((p) => p.state.phone === "holding") });
    s.act(alice, "pay");
    s.settle();
  },
});

export default defineSpec({
  name: "Box office",
  description: "Holding the last seat, then paying for it by card.",
  actors: [BoxOffice, Bank, Person],
  properties: [chargedOnce, oneTicket],
  finalState: { description: "Everyone has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => p.state.phone === "browsing" || p.state.phone === "done") },
  scenarios: [aliceBuys],
});
