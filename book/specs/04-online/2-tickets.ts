// Chapter 4, step 2: the box office answers only when it sells.
//
// Expected: stuck in 4 events: the person buys A1, then asks for A1 again and hears nothing.
import { atMost, defineActor, defineMessage, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];
const seat = oneOf(...SEATS);

const Buy = defineMessage("Buy", { seat }, { over: "https" });
const Ticket = defineMessage("Ticket", { seat }, { tone: "reply" });

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
      description: "Sells the seat if it is free.",
      sends: [Ticket],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return;
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
      with: [atMost(2)],
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
  },
});

export default defineSpec({
  name: "Box office",
  description: "Selling seats for one show, online.",
  actors: [BoxOffice, Person],
  finalState: { description: "Everyone who asked has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => !p.state.waiting) },
});
