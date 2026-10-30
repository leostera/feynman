// Chapter 19, step 2: each replica sends the like itself, and the other adds one.
//
// Expected: with no faults every property holds; with one, `everyLikeCounts` breaks (a like
// is lost) and `neverOvercounts` breaks (a like arrives twice).
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, duplicate, lose, type Setup, type WorldView } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

const Liked = defineMessage("Liked", {}, { name: "one more like" });

const regions = defineZone({ name: "Regions", description: "one replica in each", place: { arrange: "row" } });

const Replica = defineActor({
  name: "Replica",
  description: "A copy of the like counter, in one region.",
  zone: regions,
  // `value` is what this replica shows. `liked` counts the likes made here: the truth the
  // properties compare against, not something the code keeps.
  initialState: () => ({ value: 0, liked: 0 }),
  display: { icon: "database", names: ["Europe", "America"], status: (s) => `shows ${s.value}` },
  actions: {
    like: {
      with: [atMost(1)],
      label: "Like",
      description: "Someone in this region likes the post.",
      sends: [Liked],
      run(state, _inputs, ctx) {
        state.liked += 1;
        state.value += 1;
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Liked, {});
      },
    },
  },
  transitions: {
    liked: {
      on: Liked,
      description: "Adds the other region's like.",
      run: (state) => void (state.value += 1),
    },
    likedLost: lose(Liked, { spend: faults }),
    likedTwice: duplicate(Liked, { spend: faults }),
  },
});

/** Every like made anywhere. */
const totalLikes = (w: WorldView) => w.all(Replica).reduce((n, r) => n + r.state.liked, 0);

const neverOvercounts = defineProperty("neverOvercounts", {
  description: "No replica shows more likes than were made.",
  always: (w) => w.all(Replica).every((r) => r.state.value <= totalLikes(w)),
});

const everyLikeCounts = defineProperty("everyLikeCounts", {
  description: "Every replica eventually shows every like.",
  leadsTo: {
    whenever: (w) => w.all(Replica).some((r) => r.state.value < totalLikes(w)),
    then: (w) => w.all(Replica).every((r) => r.state.value === totalLikes(w)),
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
