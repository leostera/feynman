// Chapter 6, step 2: the race, after the fix; and the last seat, set up rather than replayed.
//
// Expected: every property holds, and every scenario runs as described.
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];
const seat = oneOf(...SEATS);

// Between people and the website.
const Buy = defineMessage("Buy", { seat }, { over: "https" });
const Ticket = defineMessage("Ticket", { seat }, { tone: "reply" });
const SoldOut = defineMessage("SoldOut", { seat }, { name: "sold out", tone: "refused" });
// Between the website and the database. The website keeps nothing between requests: each
// message carries the buyer it is about, as a request handler's local variables would.
const IsFree = defineMessage("IsFree", { seat, buyer: String }, { name: "is it free?", over: "sql" });
const Answer = defineMessage("Answer", { seat, buyer: String, free: Boolean }, { tone: "reply" });
const Reserve = defineMessage("Reserve", { seat, buyer: String }, { over: "sql" });
const Reserved = defineMessage("Reserved", { seat, buyer: String }, { tone: "reply" });
const Taken = defineMessage("Taken", { seat, buyer: String }, { tone: "refused" });

const people = defineZone({ name: "People", description: "buying on their phones" });
const theatre = defineZone({ name: "Theatre", description: "the box office's website and its database" });

interface Books {
  /** Who bought each seat, by instance id. A seat not in it is free. */
  sold: Map<Seat, string>;
}

const Seats = defineActor({
  name: "Seats",
  description: "The database table of tonight's seats and who bought them.",
  zone: theatre,
  singleton: true,
  initialState: (): Books => ({ sold: new Map() }),
  display: {
    icon: "database",
    rows: (s) => SEATS.map((seat) => ({ label: seat, detail: s.sold.has(seat) ? "sold" : "free", mood: s.sold.has(seat) ? "off" : "ok", owner: s.sold.get(seat) })),
  },
  transitions: {
    isFree: {
      on: IsFree,
      description: "Says whether the seat is free.",
      sends: [Answer],
      run: (state, msg, ctx) => ctx.reply(Answer, { ...msg, free: !state.sold.has(msg.seat) }),
    },
    reserve: {
      on: Reserve,
      description: "Writes the buyer against the seat, unless someone has it already.",
      sends: [Reserved, Taken],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return ctx.reply(Taken, msg);
        state.sold.set(msg.seat, msg.buyer);
        ctx.reply(Reserved, msg);
      },
    },
  },
});

const Website = defineActor({
  name: "Website",
  description: "The box office's web server: it takes orders and asks the database.",
  zone: theatre,
  singleton: true,
  initialState: () => ({}),
  display: { icon: "server" },
  transitions: {
    buy: {
      on: Buy,
      description: "Asks the database whether the seat is free.",
      sends: [IsFree],
      run: (_state, msg, ctx) => ctx.send(ctx.the(Seats), IsFree, { seat: msg.seat, buyer: ctx.from.id }),
    },
    answer: {
      on: Answer,
      description: "Reserves the seat if it was free; otherwise tells the buyer it is sold out.",
      sends: [Reserve, SoldOut],
      run(_state, msg, ctx) {
        if (!msg.free) return ctx.send({ id: msg.buyer }, SoldOut, { seat: msg.seat });
        ctx.reply(Reserve, { seat: msg.seat, buyer: msg.buyer });
      },
    },
    taken: {
      on: Taken,
      description: "Someone got there first: tells the buyer it is sold out.",
      sends: [SoldOut],
      run: (_state, msg, ctx) => ctx.send({ id: msg.buyer }, SoldOut, { seat: msg.seat }),
    },
    reserved: {
      on: Reserved,
      description: "Sends the buyer their ticket.",
      sends: [Ticket],
      run: (_state, msg, ctx) => ctx.send({ id: msg.buyer }, Ticket, { seat: msg.seat }),
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
        ctx.send(ctx.the(Website), Buy, { seat });
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

/** Every ticket people hold, as seat and holder. */
const ticketsHeld = (w: { all: (actor: typeof Person) => { id: string; state: { tickets: ReadonlySet<Seat> } }[] }) =>
  w.all(Person).flatMap((p) => [...p.state.tickets].map((seat) => ({ seat, holder: p.id })));

const oneOwnerPerSeat = defineProperty("oneOwnerPerSeat", {
  description: "No two people hold a ticket for the same seat.",
  always: (w) => {
    const seats = ticketsHeld(w).map((t) => t.seat);
    return new Set(seats).size === seats.length;
  },
});

const ticketsMatchTheBooks = defineProperty("ticketsMatchTheBooks", {
  description: "Whoever holds a ticket is who the books say bought that seat.",
  always: (w) => ticketsHeld(w).every((t) => w.the(Seats).state.sold.get(t.seat) === t.holder),
});

const soldSeatsStaySold = defineProperty("soldSeatsStaySold", {
  description: "Once a seat is sold, it stays sold to the same person.",
  everyStep: (before, after) =>
    [...before.the(Seats).state.sold].every(([seat, buyer]) => after.the(Seats).state.sold.get(seat) === buyer),
});

const bothWantA1 = defineScenario("Both want A1", {
  description: "Alice and Bob ask for A1 at once; Alice's request goes all the way through first, so she gets it and Bob hears it is sold out.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    const bob = s.spawn(Person, "Bob");
    s.act(alice, "buy", { seat: "A1" });
    s.settle();
    s.act(bob, "buy", { seat: "A1" });
    s.settle();
  },
});

const bothWantA2 = defineScenario("Both want A2 at once", {
  description: "Both check A2 before either writes: both hear it is free, the database takes Alice's reservation and refuses Bob's, and Bob hears it is sold out.",
  // The world where "Both want A1" ends: Alice has A1, and Bob has nothing.
  setup(w) {
    w.set(Seats, { sold: new Map([["A1", "person-alice"]]) });
    w.spawn(Person, "Alice", { tickets: new Set(["A1"]) });
    w.spawn(Person, "Bob");
  },
  run(s) {
    const website = s.the(Website);
    const seats = s.the(Seats);
    const [alice, bob] = ["Alice", "Bob"].map((label) => s.all(Person).find((p) => p.label === label)!);
    s.act(alice!, "buy", { seat: "A2" });
    s.act(bob!, "buy", { seat: "A2" });
    s.deliver(website, Buy); // Alice's
    s.deliver(website, Buy); // Bob's
    s.deliver(seats, IsFree); // about Alice
    s.deliver(seats, IsFree); // about Bob: A2 is still free
    s.settle();
  },
});

const theLastSeat = defineScenario("The last seat", {
  description: "Carol bought A1 earlier. Alice and Bob both try for A2; Alice's write lands first, and Bob hears it is sold out.",
  setup(w) {
    w.set(Seats, { sold: new Map([["A1", "person-carol"]]) });
    w.spawn(Person, "Carol", { tickets: new Set(["A1"]) });
    w.spawn(Person, "Alice");
    w.spawn(Person, "Bob");
  },
  run(s) {
    const [alice, bob] = ["Alice", "Bob"].map((label) => s.all(Person).find((p) => p.label === label)!);
    s.act(alice!, "buy", { seat: "A2" });
    s.act(bob!, "buy", { seat: "A2" });
    // Left alone until the database has given A2 to someone, then the rest.
    s.settle({ until: (w) => w.the(Seats).state.sold.has("A2") });
    s.settle();
  },
});

export default defineSpec({
  name: "Box office",
  description: "Selling seats for one show, online, from a database.",
  actors: [Person, Website, Seats],
  properties: [oneOwnerPerSeat, ticketsMatchTheBooks, soldSeatsStaySold],
  finalState: { description: "Everyone who asked has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => !p.state.waiting) },
  scenarios: [bothWantA1, bothWantA2, theLastSeat],
});
