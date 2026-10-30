// Chapter 15, step 2: the false alarm fixed. Holding the seat is one SQL statement, so one step.
//
// Expected, at `--depth 40`: `holdsAreKept` and `oneTicket` hold; `paymentsEnd` still breaks,
// with one fault: a restart while the bank is charging.
import { atMost, budget, defineActor, defineCall, defineLimit, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, crash, defineZone, duplicate, failed, lose } from "@leostera/feynman";

/**
 * At most two faults on any path: resuming payments after a restart only matters when a
 * charge is lost and the box office restarts before it hears. `--set faults=1` lowers it.
 */
const faults = budget("faults", 2);

// The safeguards, each named. Steps read `rule.on` where it applies; properties say which
// they need, and check makes sure each is.
const payOnlyTheHolder = defineRule("payOnlyTheHolder", { description: "A payment counts only for the hold it pays for." });
const idempotencyKey = defineRule("idempotencyKey", { description: "The bank charges each order once." });
const resumePayments = defineRule("resumePayments", { description: "After a restart, the box office resumes the payments the database says are in progress." });
const rearmHolds = defineRule("rearmHolds", { description: "After a restart, the box office sets the expiry of every hold again." });

/** The last seat, and the order a hold opens: a payment is for one order. */
type Seat = { kind: "free" } | { kind: "held"; by: string; order: string } | { kind: "paying"; by: string; order: string } | { kind: "sold"; to: string };

const Hold = defineMessage("Hold", {}, { name: "hold the seat", over: "https" });
const Held = defineMessage("Held", {}, { tone: "reply" });
const Unavailable = defineMessage("Unavailable", {}, { tone: "refused" });
const Pay = defineMessage("Pay", {}, { over: "https" });
const Ticket = defineMessage("Ticket", {}, { tone: "reply" });
const Expired = defineMessage("Expired", {}, { name: "hold expired", tone: "refused" });
// A call: an HTTPS request whose failure the box office hears about, as a fetch throws.
const Charge = defineCall("Charge", { order: String }, { over: "https" });
const Charged = defineMessage("Charged", { order: String }, { tone: "reply" });

const holdLifetime = defineLimit({ name: "Hold lifetime", value: 10, unit: "minutes", sources: ["book/code/box-office/src/server.ts#HOLD_MINUTES"] });

const people = defineZone({ name: "People", description: "buying on their phones", place: { column: 0 } });
const theatre = defineZone({ name: "Theatre", description: "the box office", place: { column: 1 } });
const bank = defineZone({ name: "Bank", description: "the card processor", place: { column: 2 } });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website and its database, deciding each request in one statement.",
  zone: theatre,
  singleton: true,
  // `calling`: whether this process is waiting on the bank. It lives in memory, so a restart
  // forgets it, and `resume` sees a payment nobody is calling the bank about.
  // `expiring`: whether the hold's timer is set. Timers live in memory too, so a restart
  // forgets it, and `rearm` sets the timer again for a seat the database says is held.
  initialState: () => ({ seat: { kind: "free" } as Seat, calling: false, expiring: false, answering: null as string | null }),
  display: {
    icon: "server",
    status: (s) => (s.seat.kind === "free" ? "the last seat is free" : s.seat.kind === "sold" ? "sold out" : `the last seat is ${s.seat.kind}`),
  },
  transitions: {
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free, and opens an order for it.",
      sources: ["book/code/box-office/src/server.ts#handleHold", "book/code/box-office/src/db.ts:9-10"],
      sends: [Held, Unavailable],
      starts: ["expire"],
      run(state, _msg, ctx) {
        // One conditional UPDATE: looking the seat up and holding it are one step.
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id, order: ctx.fresh("order") };
        state.expiring = true;
        ctx.start("expire");
        ctx.reply(Held, {});
      },
    },
    pay: {
      on: Pay,
      description: "Charges the card of whoever holds the seat; anyone else's hold has expired.",
      sources: ["book/code/box-office/src/server.ts:19-23", "book/code/box-office/src/db.ts:11-12"],
      sends: [Charge, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "held") return ctx.reply(Expired, {});
        if (payOnlyTheHolder.on && state.seat.by !== ctx.from.id) return ctx.reply(Expired, {});
        state.seat = { kind: "paying", by: ctx.from.id, order: state.seat.order };
        state.answering = ctx.from.id;
        state.calling = true;
        state.expiring = false;
        ctx.cancel("expire");
        ctx.send(ctx.the(Bank), Charge, { order: state.seat.order });
      },
    },
    charged: {
      on: Charged,
      description: "The card was charged: sells the seat, and answers the phone's request with the ticket.",
      sources: ["book/code/box-office/src/server.ts:24-24", "book/code/box-office/src/db.ts:13-14"],
      sends: [Ticket],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "paying") return; // a late answer for an order already settled
        state.calling = false;
        state.seat = { kind: "sold", to: state.seat.by };
        // The ticket is the answer to the phone's request, which only this process holds.
        if (state.answering) ctx.send({ id: state.answering }, Ticket, {});
        state.answering = null;
      },
    },
    resume: {
      description: "After a restart, charges again for a payment the database says is in progress.",
      sources: ["book/code/box-office/src/server.ts#onStartup", "book/code/box-office/src/server.ts#resumePayment"],
      when: (s) => resumePayments.on && s.seat.kind === "paying" && !s.calling,
      sends: [Charge],
      run(state, _, ctx) {
        if (state.seat.kind !== "paying") return;
        state.calling = true;
        ctx.send(ctx.the(Bank), Charge, { order: state.seat.order });
      },
    },
    chargeFailed: {
      on: failed(Charge),
      description: "The call to the bank failed: sends the same charge again.",
      sources: ["book/code/box-office/src/server.ts#chargeUntilAnswered"],
      sends: [Charge],
      run: (_state, failure, ctx) => ctx.send(failure.to, Charge, failure.payload),
    },
    // A lost answer fails the call too: the bank did the work, and the box office cannot tell.
    chargedLost: lose(Charged, { fails: Charge, spend: faults }),
    // The process restarts; the database keeps the seat, and memory and timers are gone.
    crash: crash({ keeps: ["seat"], spend: faults }),
    expire: {
      description: "The hold runs out, and the seat is free again.",
      sources: ["book/code/box-office/src/server.ts#onHoldExpired", "book/code/box-office/src/db.ts:15-16"],
      after: "10 minutes",
      run(state) {
        state.expiring = false;
        if (state.seat.kind === "held") state.seat = { kind: "free" };
      },
    },
    rearm: {
      description: "After a restart, sets the expiry timer again for the seat on hold.",
      sources: ["book/code/box-office/src/server.ts#onStartup", "book/code/box-office/src/server.ts#scheduleExpiry"],
      when: (s) => rearmHolds.on && s.seat.kind === "held" && !s.expiring,
      starts: ["expire"],
      run(state, _, ctx) {
        state.expiring = true;
        ctx.start("expire");
      },
    },
  },
});

const Bank = defineActor({
  name: "Bank",
  description: "The card processor the theatre uses.",
  zone: bank,
  singleton: true,
  initialState: () => ({ charges: [] as string[], seen: new Set<string>() }),
  display: { icon: "card", status: (s) => `${s.charges.length} charge(s)` },
  transitions: {
    charge: {
      on: Charge,
      description: "Charges the card for the order, unless it has charged that order already, and answers.",
      sources: ["book/code/box-office/src/bank.ts#charge"],
      sends: [Charged],
      run(state, msg, ctx) {
        if (!idempotencyKey.on || !state.seen.has(msg.order)) {
          state.seen.add(msg.order);
          state.charges.push(msg.order);
        }
        ctx.reply(Charged, msg);
      },
    },
    chargeLost: lose(Charge, { spend: faults }),
    chargeTwice: duplicate(Charge, { spend: faults }),
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
      sources: ["book/code/box-office/src/phone.ts:2-3"],
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
      sources: ["book/code/box-office/src/phone.ts:7-8"],
      when: (s) => s.phone === "holding",
      sends: [Pay],
      run(state, _inputs, ctx) {
        state.phone = "paying";
        ctx.send(ctx.the(BoxOffice), Pay, {});
      },
    },
  },
  transitions: {
    held: { on: Held, sources: ["book/code/box-office/src/phone.ts:4-4"], description: "Sees the seat is held for them.", run: (s) => void (s.phone = "holding") },
    unavailable: { on: Unavailable, sources: ["book/code/box-office/src/phone.ts:4-4"], description: "Sees someone else has the seat.", run: (s) => void (s.phone = "browsing") },
    ticket: {
      on: Ticket,
      description: "Gets the ticket.",
      sources: ["book/code/box-office/src/phone.ts:9-9"],
      run(s) {
        s.ticket = true;
        s.phone = "done";
      },
    },
    expired: { on: Expired, sources: ["book/code/box-office/src/phone.ts:9-9"], description: "Hears the hold ran out before the payment.", run: (s) => void (s.phone = "browsing") },
  },
});

const chargedOnce = defineProperty("chargedOnce", {
  description: "No order is charged twice.",
  needs: [idempotencyKey],
  always: (w) => {
    const charges = w.the(Bank).state.charges;
    return new Set(charges).size === charges.length;
  },
});

const oneTicket = defineProperty("oneTicket", {
  description: "At most one person has a ticket for the last seat.",
  always: (w) => w.all(Person).filter((p) => p.state.ticket).length <= 1,
});

const holdsAreRespected = defineProperty("holdsAreRespected", {
  description: "A seat held for one person is never paid for by another.",
  everyStep: (before, after) => {
    const was = before.the(BoxOffice).state.seat;
    const now = after.the(BoxOffice).state.seat;
    return !(was.kind === "held" && now.kind === "paying" && now.by !== was.by);
  },
  needs: [payOnlyTheHolder],
});

const paymentsEnd = defineProperty("paymentsEnd", {
  description: "Whoever pays eventually hears back: a ticket, or that their hold expired.",
  needs: [resumePayments],
  leadsTo: {
    whenever: (w) => w.all(Person).some((p) => p.state.phone === "paying"),
    then: (w) => w.all(Person).every((p) => p.state.phone !== "paying"),
  },
});

const holdsAreKept = defineProperty("holdsAreKept", {
  description: "A hold is never handed to someone else while it lasts.",
  everyStep: (before, after) => {
    const was = before.the(BoxOffice).state.seat;
    const now = after.the(BoxOffice).state.seat;
    return !(was.kind === "held" && now.kind === "held" && now.by !== was.by);
  },
});

const holdsEnd = defineProperty("holdsEnd", {
  description: "A hold ends: the seat is eventually paid for or free again.",
  needs: [rearmHolds],
  leadsTo: {
    whenever: (w) => w.the(BoxOffice).state.seat.kind === "held",
    then: (w) => w.the(BoxOffice).state.seat.kind !== "held",
  },
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

const answerLost = defineScenario("The bank's answer is lost", {
  description: "The bank charges Alice's card, but its answer is lost. The call fails, the box office charges again, and the bank recognises the order: one charge, and Alice gets her ticket.",
  setup(w) {
    w.spawn(Person, "Alice");
  },
  run(s) {
    const office = s.the(BoxOffice);
    const alice = s.the(Person);
    s.act(alice, "hold");
    s.settle({ until: (w) => w.the(Person).state.phone === "holding" });
    s.act(alice, "pay");
    s.settle({ until: (w) => w.the(Bank).state.charges.length === 1 });
    s.step(office, "chargedLost");
    s.settle();
  },
});

export default defineSpec({
  name: "Box office",
  description: "Holding the last seat, then paying for it by card.",
  actors: [BoxOffice, Bank, Person],
  limits: [holdLifetime],
  properties: [chargedOnce, oneTicket, holdsAreRespected, holdsAreKept, paymentsEnd, holdsEnd],
  finalState: { description: "Everyone has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => p.state.phone === "browsing" || p.state.phone === "done") },
  scenarios: [aliceBuys, answerLost],
});
