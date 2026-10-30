// A cache filled on a miss and invalidated on a write.
//
// A read that misses asks the database; a write updates the database, which tells the cache
// to drop its entry. If the answer to the read was made before the write but arrives after
// the invalidation, the cache fills with the old value and keeps it forever. The fix:
// versions; the cache ignores a fill older than the newest invalidation it has seen. A lost
// invalidation still leaves the cache stale; versions cannot help with that.
//
// Expected: buggy breaks `converges` in 7 steps without faults (read, miss, load, write,
// update, invalidate, stale fill); fixed holds without faults and breaks with one, also in 7
// (read, miss, load, write, update, the invalidation lost, stale fill). Not 6: just after the
// invalidation is lost the cache is still empty, which is fine; `converges` breaks only where
// the cache can stay wrong forever, which takes the stale fill.
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose, oneOf } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const Get = defineMessage("Get");
const Load = defineMessage("Load");
const Loaded = defineMessage("Loaded", { value: String, version: Number }, { tone: "reply" });
const Update = defineMessage("Update", { value: String });
const Invalidate = defineMessage("Invalidate", { version: Number });

export function cache(variant: "buggy" | "fixed") {
  const apps = defineZone({ name: "App servers", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Service", description: "a read-through cache in front of the database", place: { column: 1, arrange: "row", region: true } });

  const Database = defineActor({
    name: "Database",
    zone,
    singleton: true,
    initialState: () => ({ value: "a", version: 0 }),
    place: { order: 1 },
    display: { icon: "database", status: (s) => `"${s.value}", version ${s.version}`, mood: () => "ok" },
    transitions: {
      load: { on: Load, description: "Answers with the current value.", sends: [Loaded], run: (state, _msg, ctx) => ctx.reply(Loaded, { value: state.value, version: state.version }) },
      update: {
        on: Update,
        description: "Stores a new value and invalidates the cache.",
        sends: [Invalidate],
        run(state, msg, ctx) {
          state.value = msg.value;
          state.version += 1;
          ctx.send(ctx.the(Cache), Invalidate, { version: state.version });
        },
      },
      loadLost: lose(Load, { spend: faults }),
      updateLost: lose(Update, { spend: faults }),
    },
  });

  const Cache = defineActor({
    name: "Cache",
    zone,
    singleton: true,
    initialState: () => ({ entry: null as { value: string; version: number } | null, invalidated: 0, loading: false }),
    place: { order: 0 },
    display: {
      icon: "storage",
      status: (s) => (s.entry ? `holds "${s.entry.value}" (version ${s.entry.version})` : s.loading ? "loading" : "empty"),
      mood: (s) => (s.entry ? "info" : s.loading ? "busy" : "off"),
    },
    transitions: {
      get: {
        on: Get,
        description: "Serves the entry, or loads it on a miss.",
        sends: [Load],
        run(state, _msg, ctx) {
          if (state.entry || state.loading) return;
          state.loading = true;
          ctx.send(ctx.the(Database), Load, {});
        },
      },
      loaded: {
        on: Loaded,
        description: "Fills the entry; with versions, only if no newer write has invalidated it.",
        say: (s, msg) => (s.entry?.version === msg.version && s.entry.value === msg.value ? `Fills "${msg.value}" (version ${msg.version})` : `Drops "${msg.value}": version ${msg.version} was invalidated`),
        run(state, msg) {
          state.loading = false;
          if (variant === "fixed" && msg.version < state.invalidated) return;
          state.entry = { value: msg.value, version: msg.version };
        },
      },
      invalidate: {
        on: Invalidate,
        description: "Drops the entry.",
        run(state, msg) {
          state.entry = null;
          state.invalidated = Math.max(state.invalidated, msg.version);
        },
      },
      getLost: lose(Get, { spend: faults }),
      loadedLost: lose(Loaded, { spend: faults }),
      invalidateLost: lose(Invalidate, { spend: faults }),
    },
  });

  const App = defineActor({
    name: "App",
    zone: apps,
    singleton: true,
    initialState: () => ({}),
    display: { icon: "server", status: () => "serving" },
    actions: {
      read: { with: [atMost(2)], label: "Read", description: "Reads through the cache.", sends: [Get], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Cache), Get, {}) },
      write: {
        with: [atMost(2)],
        label: "Write",
        description: "Writes a new value.",
        inputs: { value: oneOf("b", "c") },
        sends: [Update],
        run: (_state, { value }, ctx) => ctx.send(ctx.the(Database), Update, { value }),
      },
    },
  });

  const consistentOnceQuiet = defineProperty("consistentOnceQuiet", {
    description: "Once nothing is in flight, the cache is empty or agrees with the database.",
    always: (w) => {
      const entry = w.the(Cache).state.entry;
      return !w.quiet || entry === null || entry.value === w.the(Database).state.value;
    },
  });

  const converges = defineProperty("converges", {
    description: "The cache ends up empty or agreeing with the database, and stays so.",
    eventuallyAlways: (w) => {
      const entry = w.the(Cache).state.entry;
      return entry === null || entry.value === w.the(Database).state.value;
    },
  });

  const readWriteRead = defineScenario("Read, write, read", {
    description: "The app reads (a miss, filled), writes, and reads again (a miss after the invalidation).",
    run(s) {
      const app = s.the(App);
      s.act(app, "read");
      s.settle();
      s.act(app, "write", { value: "b" });
      s.settle();
      s.act(app, "read");
      s.settle();
    },
  });

  const aStaleFillOvertakesTheInvalidation = defineScenario("A stale fill overtakes the invalidation", {
    description:
      variant === "buggy"
        ? "A miss loads “a”; meanwhile “b” is written and the invalidation arrives first; then “a” fills the cache, stale for good."
        : "A miss loads “a”; meanwhile “b” is written and the invalidation arrives first; the fill carries version 0, older than the invalidation, and is dropped.",
    run(s) {
      const app = s.the(App);
      s.act(app, "read");
      s.deliver(s.the(Cache), Get);
      s.deliver(s.the(Database), Load);
      s.act(app, "write", { value: "b" });
      s.deliver(s.the(Database), Update);
      s.deliver(s.the(Cache), Invalidate);
      s.settle();
    },
  });

  return defineSpec({
    name: `Cache (${variant})`,
    actors: [Database, Cache, App],
    properties: [consistentOnceQuiet, converges],
    scenarios: [readWriteRead, aStaleFillOvertakesTheInvalidation],
  });
}

/** `feynman check cache` checks the buggy variant, so you see the checker find the bug. */
export default cache("buggy");
export const fixed = cache("fixed");
