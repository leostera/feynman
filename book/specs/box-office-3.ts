// Chapter 3: the box office, as one actor with its state and the actions a clerk takes.
//
// Expected: no properties yet. Check type-checks the spec, runs the scenario, and explores
// every order of sales: nothing sold, A1, A2, both. A sold-out show is final.
import { defineActor, defineScenario, defineSpec, defineZone, input, oneOf } from "@leostera/feynman";

const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];

interface Office {
  sold: Set<Seat>;
}

const freeSeats = (office: Readonly<Office>): Seat[] => SEATS.filter((seat) => !office.sold.has(seat));

const theatre = defineZone({ name: "Theatre", description: "the box office at the door" });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The counter at the door, where a clerk sells seats for tonight's show.",
  zone: theatre,
  singleton: true,
  initialState: (): Office => ({ sold: new Set() }),
  display: {
    icon: "card",
    status: (s) => `${freeSeats(s).length} seat(s) left`,
    mood: (s) => (freeSeats(s).length ? "ok" : "off"),
  },
  actions: {
    sell: {
      label: "Sell a seat",
      description: "The clerk sells a seat that is still free.",
      // The clerk is offered only free seats; a scenario that names a sold one is refused.
      inputs: { seat: input(oneOf(...SEATS), { examples: (w): Seat[] => freeSeats(w.the(BoxOffice).state) }) },
      when: (s) => freeSeats(s).length > 0,
      run(state, { seat }, ctx) {
        if (state.sold.has(seat)) return ctx.note(`${seat} is sold already; the clerk refuses.`);
        state.sold.add(seat);
      },
    },
  },
});

const sellOut = defineScenario("Sell out", {
  description: "The clerk sells A1, then A2: the show is sold out.",
  run(s) {
    const office = s.the(BoxOffice);
    for (const seat of SEATS) s.act(office, "sell", { seat });
  },
});

export default defineSpec({
  name: "Box office",
  description: "Selling seats for one show.",
  actors: [BoxOffice],
  finalState: { description: "The show is sold out.", when: (w) => freeSeats(w.the(BoxOffice).state).length === 0 },
  scenarios: [sellOut],
});
