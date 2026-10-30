// Chapter 19, step 3: a grow-only counter (G-counter). Each replica counts its own likes, sends
// what it knows of everyone's, and merges by keeping the bigger number for each replica.
//
// Expected: `neverOvercounts` holds, even when a message arrives twice; `everyLikeCounts`
// still breaks with one lost message.
import { atMost, budget, recordOf, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, duplicate, lose, type Setup, type WorldView } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

// What a replica knows: how many likes each replica has counted, by replica id.
const Counts = defineMessage("Counts", { counts: recordOf(Number) }, { name: "counts" });

const regions = defineZone({ name: "Regions", description: "one replica in each", place: { arrange: "row" } });

/** What a replica shows: the likes every replica has counted, as far as it knows. */
function shown(state: { counts: Record<string, number> }): number {
  return Object.values(state.counts).reduce((n, c) => n + c, 0);
}

const Replica = defineActor({
  name: "Replica",
  description: "A copy of the like counter, in one region.",
  zone: regions,
  // `counts` holds, for every replica, the most likes this one knows it has counted. What it
  // shows is their sum. `liked` counts the likes made here: the truth the properties compare
  // against, not something the code keeps.
  initialState: () => ({ counts: {} as Record<string, number>, liked: 0 }),
  display: { icon: "database", names: ["Europe", "America"], status: (s) => `shows ${shown(s)}` },
  actions: {
    like: {
      with: [atMost(1)],
      label: "Like",
      description: "Someone in this region likes the post.",
      sends: [Counts],
      run(state, _inputs, ctx) {
        state.liked += 1;
        state.counts[ctx.id] = (state.counts[ctx.id] ?? 0) + 1;
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Counts, { counts: { ...state.counts } });
      },
    },
  },
  transitions: {
    counts: {
      on: Counts,
      description: "Merges the other's counts: for each replica, keeps the bigger number.",
      run(state, msg) {
        for (const [id, n] of Object.entries(msg.counts)) state.counts[id] = Math.max(state.counts[id] ?? 0, n);
      },
    },
    countsLost: lose(Counts, { spend: faults }),
    countsTwice: duplicate(Counts, { spend: faults }),
  },
});

/** Every like made anywhere. */
const totalLikes = (w: WorldView) => w.all(Replica).reduce((n, r) => n + r.state.liked, 0);

const neverOvercounts = defineProperty("neverOvercounts", {
  description: "No replica shows more likes than were made.",
  always: (w) => w.all(Replica).every((r) => shown(r.state) <= totalLikes(w)),
});

const everyLikeCounts = defineProperty("everyLikeCounts", {
  description: "Every replica eventually shows every like.",
  leadsTo: {
    whenever: (w) => w.all(Replica).some((r) => shown(r.state) < totalLikes(w)),
    then: (w) => w.all(Replica).every((r) => shown(r.state) === totalLikes(w)),
  },
});

/** One replica in each region. */
const setup = (w: Setup) => {
  w.spawn(Replica, "Europe");
  w.spawn(Replica, "America");
};

const oneLike = defineScenario("A like in Europe", {
  description: "Someone in Europe likes the post, and America catches up.",
  setup,
  run(s) {
    s.act(s.all(Replica).find((r) => r.label === "Europe")!, "like");
    s.settle();
  },
});

export default defineSpec({
  name: "Like counter",
  description: "A counter replicated across two regions.",
  actors: [Replica],
  properties: [neverOvercounts, everyLikeCounts],
  finalState: { description: "Nothing is in flight.", when: (w) => w.quiet },
  scenarios: [oneLike],
});
