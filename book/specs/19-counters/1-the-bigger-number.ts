// Chapter 19, step 1: two replicas of a like counter. Each tells the other its count, and
// each keeps the bigger number.
//
// Expected: `neverOvercounts` holds; `everyLikeCounts` breaks with no faults: both replicas
// count a like at once, and each keeps 1 where there were 2.
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, type Setup, type WorldView } from "@leostera/feynman";

const Count = defineMessage("Count", { value: Number }, { name: "count" });

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
      sends: [Count],
      run(state, _inputs, ctx) {
        state.liked += 1;
        state.value += 1;
        for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Count, { value: state.value });
      },
    },
  },
  transitions: {
    count: {
      on: Count,
      description: "Keeps the bigger of its count and the other's.",
      run: (state, msg) => void (state.value = Math.max(state.value, msg.value)),
    },
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
