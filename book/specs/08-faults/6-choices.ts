// Chapter 8, step 6: a person changes their mind, and the network reorders.
//
// Expected: `lastChoiceWins` breaks in 4 events without faults (choose A1, choose A2, A2
// arrives, A1 arrives).
import { atMost, budget, defineActor, defineMessage, defineProperty, defineSpec, defineZone, lose, oneOf } from "@leostera/feynman";

/** No faults unless asked for: `--set faults=1` allows one. */
const faults = budget("faults", 0);

const SEATS = ["A1", "A2"] as const;
const seat = oneOf(...SEATS);

// Each choice is its own HTTPS request: two of them can arrive in either order.
const Choose = defineMessage("Choose", { seat }, { name: "choose a seat", over: "https" });

const people = defineZone({ name: "People", description: "choosing on their phones" });
const theatre = defineZone({ name: "Theatre", description: "the box office's website" });

const BoxOffice = defineActor({
  name: "Box office",
  zone: theatre,
  singleton: true,
  initialState: () => ({ chosen: {} as Record<string, string> }),
  display: { icon: "server", rows: (s) => Object.entries(s.chosen).map(([who, seat]) => ({ label: seat, detail: "chosen", mood: "ok", owner: who })) },
  transitions: {
    choose: { on: Choose, description: "Keeps the seat the person chose.", run: (state, msg, ctx) => void (state.chosen[ctx.from!.id] = msg.seat) },
    chooseLost: lose(Choose, { spend: faults }),
  },
});

const Person = defineActor({
  name: "Person",
  zone: people,
  initialState: () => ({ choice: null as string | null }),
  display: { icon: "phone", status: (s) => (s.choice ? `chose ${s.choice}` : "choosing") },
  actions: {
    choose: {
      with: [atMost(2)],
      label: "Choose a seat",
      description: "Picks a seat, or changes their mind.",
      inputs: { seat },
      sends: [Choose],
      run(state, { seat }, ctx) {
        state.choice = seat;
        ctx.send(ctx.the(BoxOffice), Choose, { seat });
      },
    },
  },
});

const lastChoiceWins = defineProperty("lastChoiceWins", {
  description: "Once nothing is in flight, the box office has each person's last choice.",
  always: (w) => !w.quiet || w.all(Person).every((p) => w.the(BoxOffice).state.chosen[p.id] === (p.state.choice ?? undefined)),
});

export default defineSpec({ name: "Box office", actors: [Person, BoxOffice], properties: [lastChoiceWins] });
