// Chapter 12: a symmetry claim that is false.
//
// The box office runs a ballot for the last seat: everyone who enters before the draw goes
// in, and the draw picks the entrant whose id sorts first. That orders ids, so people are not
// interchangeable, and `symmetric: true` is a false claim.
//
// Expected: the checker refutes the claim; `firstEntrantWins` breaks in 5 events.
import { atMost, defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

const Enter = defineMessage("Enter", {}, { over: "https" });
const Won = defineMessage("Won", {}, { tone: "reply" });

const people = defineZone({ name: "People" });
const theatre = defineZone({ name: "Theatre" });

const BoxOffice = defineActor({
  name: "Box office",
  zone: theatre,
  singleton: true,
  initialState: () => ({ entrants: [] as string[], first: null as string | null, winner: null as string | null }),
  transitions: {
    enter: {
      on: Enter,
      description: "Adds the person to the ballot, and remembers who entered first.",
      run(state, _msg, ctx) {
        if (state.winner || state.entrants.includes(ctx.from.id)) return;
        state.entrants.push(ctx.from.id);
        state.first ??= ctx.from.id;
      },
    },
    draw: {
      description: "Draws the winner: the entrant whose id sorts first.",
      when: (s) => s.entrants.length >= 2 && s.winner === null,
      sends: [Won],
      run(state, _, ctx) {
        const winner = [...state.entrants].sort()[0]!;
        state.winner = winner;
        ctx.send({ id: winner }, Won, {});
      },
    },
  },
});

const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true, // false: the draw sorts ids
  initialState: () => ({ won: false }),
  actions: {
    enter: {
      with: [atMost(1)],
      label: "Enter the ballot",
      description: "Enters the ballot for the last seat.",
      sends: [Enter],
      run: (_state, _inputs, ctx) => ctx.send(ctx.the(BoxOffice), Enter, {}),
    },
  },
  transitions: {
    won: { on: Won, description: "Wins the seat.", run: (s) => void (s.won = true) },
  },
});

const firstEntrantWins = defineProperty("firstEntrantWins", {
  description: "Whoever entered first wins.",
  always: (w) => w.the(BoxOffice).state.winner === null || w.the(BoxOffice).state.winner === w.the(BoxOffice).state.first,
});

export default defineSpec({
  name: "Ballot",
  actors: [BoxOffice, Person],
  properties: [firstEntrantWins],
  finalState: { description: "Anything: people need not enter.", when: () => true },
});
