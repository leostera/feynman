// Chapter 3, a mistake: a step that returns a new state instead of changing its own.
//
// Expected: a spec error on the first sale.
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
      // A mistake: a step changes its state in place, it does not return a new one.
      run: (state) => ({ left: state.left - 1 }),
    },
  },
});

export default defineSpec({ name: "Box office", actors: [BoxOffice] });
