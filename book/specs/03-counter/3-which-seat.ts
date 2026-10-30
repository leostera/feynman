// Chapter 3, step 3: the clerk sells a particular seat.
//
// Expected: four states (nothing sold, A1, A2, both), and stuck once sold out. Selling a
// seat that is sold already changes nothing, and the checker tries it anyway.
import { defineActor, defineSpec, defineZone, oneOf } from "@leostera/feynman";

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
  actions: {
    sell: {
      label: "Sell a seat",
      description: "The clerk sells a seat that is still free.",
      inputs: { seat: oneOf(...SEATS) },
      when: (s) => freeSeats(s).length > 0,
      run(state, { seat }) {
        state.sold.add(seat);
      },
    },
  },
});

export default defineSpec({ name: "Box office", actors: [BoxOffice] });
