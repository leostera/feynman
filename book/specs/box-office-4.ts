// Chapter 4: people buy seats online, with messages.
//
// Expected: no properties yet. Two people, one of each by default, more from the scenario.
import { atMost, defineActor, defineMessage, defineScenario, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];
const seat = oneOf(...SEATS);

const Buy = defineMessage("Buy", { seat }, { over: "https" });
const Ticket = defineMessage("Ticket", { seat }, { tone: "reply" });
const SoldOut = defineMessage("SoldOut", { seat }, { name: "sold out", tone: "refused" });

const people = defineZone({ name: "People", description: "buying on their phones" });
const theatre = defineZone({ name: "Theatre", description: "the box office's website" });

interface Office {
  /** Who bought each seat, by instance id. A seat not in it is free. */
  sold: Map<Seat, string>;
}

const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website, which sells seats for tonight's show.",
  zone: theatre,
  singleton: true,
  initialState: (): Office => ({ sold: new Map() }),
  display: {
    icon: "server",
    status: (s) => `${SEATS.length - s.sold.size} seat(s) left`,
    rows: (s) => SEATS.map((seat) => ({ label: seat, detail: s.sold.has(seat) ? "sold" : "free", mood: s.sold.has(seat) ? "off" : "ok", owner: s.sold.get(seat) })),
  },
  transitions: {
    buy: {
      on: Buy,
      description: "Sells the seat if it is free; otherwise says it is sold out.",
      sends: [Ticket, SoldOut],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return ctx.reply(SoldOut, { seat: msg.seat });
        state.sold.set(msg.seat, ctx.from.id);
        ctx.reply(Ticket, { seat: msg.seat });
      },
    },
  },
});

const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true,
  initialState: () => ({ tickets: new Set<Seat>(), waiting: false }),
  display: {
    icon: "phone",
    names: ["Alice", "Bob"],
    status: (s) => (s.waiting ? "buying" : s.tickets.size ? `has ${[...s.tickets].join(", ")}` : "no ticket"),
    mood: (s) => (s.waiting ? "busy" : s.tickets.size ? "ok" : "off"),
  },
  actions: {
    buy: {
      with: [atMost(1)],
      label: "Buy a seat",
      description: "Asks the box office for a seat.",
      inputs: { seat },
      when: (s) => !s.waiting,
      sends: [Buy],
      run(state, { seat }, ctx) {
        state.waiting = true;
        ctx.send(ctx.the(BoxOffice), Buy, { seat });
      },
    },
  },
  transitions: {
    ticket: {
      on: Ticket,
      description: "Gets the ticket.",
      run(state, msg) {
        state.tickets.add(msg.seat);
        state.waiting = false;
      },
    },
    soldOut: {
      on: SoldOut,
      description: "Hears the seat is gone.",
      run: (state) => void (state.waiting = false),
    },
  },
});

const bothWantA1 = defineScenario("Both want A1", {
  description: "Alice and Bob ask for A1 at once; Bob's request arrives first, so he gets it and Alice hears it is sold out.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    const bob = s.spawn(Person, "Bob");
    s.act(alice, "buy", { seat: "A1" });
    s.act(bob, "buy", { seat: "A1" });
    s.deliver(s.the(BoxOffice), Buy, { seat: "A1" }); // the oldest Buy in flight: Alice's
    s.settle();
  },
});

export default defineSpec({
  name: "Box office",
  description: "Selling seats for one show, online.",
  actors: [BoxOffice, Person],
  finalState: { description: "Everyone who asked has an answer.", when: (w) => w.quiet },
  scenarios: [bothWantA1],
});
