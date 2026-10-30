// Chapter 7, step 1: holding the seat, then paying.
//
// Expected: both properties hold. A hold never ends unless its holder pays.
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

// The last seat: one seat, and what the box office knows about it.
type Seat = { kind: "free" } | { kind: "held"; by: string } | { kind: "sold"; to: string };

const Hold = defineMessage("Hold", {}, { name: "hold the seat", over: "https" });
const Held = defineMessage("Held", {}, { tone: "reply" });
const Unavailable = defineMessage("Unavailable", {}, { tone: "refused" });
const Pay = defineMessage("Pay", {}, { over: "https" });
const Ticket = defineMessage("Ticket", {}, { tone: "reply" });
const Expired = defineMessage("Expired", {}, { name: "hold expired", tone: "refused" });

const people = defineZone({ name: "People", description: "buying on their phones" });
const theatre = defineZone({ name: "Theatre", description: "the box office" });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website and its database, deciding each request in one statement.",
  zone: theatre,
  singleton: true,
  initialState: () => ({ seat: { kind: "free" } as Seat }),
  display: {
    icon: "server",
    status: (s) => (s.seat.kind === "free" ? "the last seat is free" : s.seat.kind === "held" ? "the last seat is held" : "sold out"),
    rows: (s) => [{ label: "A1", detail: s.seat.kind, owner: s.seat.kind === "held" ? s.seat.by : s.seat.kind === "sold" ? s.seat.to : undefined }],
  },
  transitions: {
    hold: {
      on: Hold,
      description: "Holds the seat, if it is free.",
      sends: [Held, Unavailable],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id };
        ctx.reply(Held, {});
      },
    },
    pay: {
      on: Pay,
      description: "Sells the seat to whoever pays, unless it is sold already.",
      sends: [Ticket, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind === "sold") return ctx.reply(Expired, {});
        state.seat = { kind: "sold", to: ctx.from.id };
        ctx.reply(Ticket, {});
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
    expired: { on: Expired, description: "Hears the seat went to someone else.", run: (s) => void (s.phone = "browsing") },
  },
});

const holdsAreRespected = defineProperty("holdsAreRespected", {
  description: "A seat held for one person is never sold to another.",
  everyStep: (before, after) => {
    const was = before.the(BoxOffice).state.seat;
    const now = after.the(BoxOffice).state.seat;
    return !(was.kind === "held" && now.kind === "sold" && now.to !== was.by);
  },
});

const oneTicket = defineProperty("oneTicket", {
  description: "At most one person has a ticket for the last seat.",
  always: (w) => w.all(Person).filter((p) => p.state.ticket).length <= 1,
});

const aliceBuys = defineScenario("Alice buys the last seat", {
  description: "Alice holds the seat, pays in time, and gets the ticket.",
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
  description: "Holding the last seat, then paying for it.",
  actors: [BoxOffice, Person],
  properties: [holdsAreRespected, oneTicket],
  finalState: { description: "The seat is sold, and everyone has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => p.state.phone === "browsing" || p.state.phone === "done") },
  scenarios: [aliceBuys],
});
