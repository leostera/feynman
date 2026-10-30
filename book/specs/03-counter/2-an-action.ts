// Chapter 3, step 2: the clerk sells a seat, any seat.
//
// Expected: three states (2, 1 and 0 left), and stuck once sold out.
import { defineActor, defineSpec, defineZone } from "@leostera/feynman";

const theatre = defineZone({ name: "Theatre", description: "the box office at the door" });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The counter at the door, where a clerk sells seats for tonight's show.",
  zone: theatre,
  singleton: true,
  initialState: () => ({ left: 2 }),
  actions: {
    sell: {
      label: "Sell a seat",
      description: "The clerk sells a seat, while there is one left.",
      when: (s) => s.left > 0,
      run(state) {
        state.left -= 1;
      },
    },
  },
});

export default defineSpec({ name: "Box office", actors: [BoxOffice] });
