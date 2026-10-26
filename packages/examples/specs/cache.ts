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
// invalidation is lost the cache is still empty, which is fine; `eventually` breaks only in a
// world where the property is false and stays so, which takes the stale fill.
import { defineSpec, message, SEC } from "@feynman/spec";

export function cache(variant: "buggy" | "fixed") {
  return defineSpec(
    `Cache (${variant})`,
    {
      messages: {
        Get: message<{}>({ name: "get" }),
        Load: message<{}>({ name: "load" }),
        Loaded: message<{ value: string; version: number }>({ name: "loaded", tone: "reply" }),
        Update: message<{ value: string }>({ name: "update" }),
        Invalidate: message<{ version: number }>({ name: "invalidate" }),
      },
    },
    (spec) => {
      const { Get, Load, Loaded, Update, Invalidate } = spec.messages;
      const zone = spec.defineZone({ name: "Service" });

      const Database = spec.defineActor({
        name: "Database",
        zone,
        singleton: true,
        initialState: () => ({ value: "a", version: 0 }),
        transitions: {
          [Load]: { description: "Answers with the current value.", sends: [Loaded], run: (state, _msg, ctx) => ctx.reply(Loaded, { value: state.value, version: state.version }) },
          [Update]: {
            description: "Stores a new value and invalidates the cache.",
            sends: [Invalidate],
            run(state, msg, ctx) {
              state.value = msg.value;
              state.version += 1;
              ctx.send(ctx.the(Cache), Invalidate, { version: state.version });
            },
          },
        },
      });

      const Cache = spec.defineActor({
        name: "Cache",
        zone,
        singleton: true,
        initialState: () => ({ entry: null as { value: string; version: number } | null, invalidated: 0, loading: false }),
        transitions: {
          [Get]: {
            description: "Serves the entry, or loads it on a miss.",
            sends: [Load],
            run(state, _msg, ctx) {
              if (state.entry || state.loading) return;
              state.loading = true;
              ctx.send(ctx.the(Database), Load, {});
            },
          },
          [Loaded]: {
            description: "Fills the entry; with versions, only if no newer write has invalidated it.",
            run(state, msg) {
              state.loading = false;
              if (variant === "fixed" && msg.version < state.invalidated) return;
              state.entry = { value: msg.value, version: msg.version };
            },
          },
          [Invalidate]: {
            description: "Drops the entry.",
            run(state, msg) {
              state.entry = null;
              state.invalidated = Math.max(state.invalidated, msg.version);
            },
          },
        },
      });

      const App = spec.defineActor({
        name: "App",
        zone,
        singleton: true,
        initialState: () => ({}),
        actions: {
          read: { label: "Read", description: "Reads through the cache.", sends: [Get], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Cache), Get, {}) },
          write: {
            label: "Write",
            description: "Writes a new value.",
            inputs: { value: { type: ["b", "c"] as const } },
            sends: [Update],
            run: (_state, { value }, ctx) => ctx.send(ctx.the(Database), Update, { value }),
          },
        },
      });

      spec.defineInvariants({
        consistentOnceQuiet: {
          description: "Once nothing is in flight, the cache is empty or agrees with the database.",
          always: (w) => {
            const entry = w.the(Cache).state.entry;
            return !w.quiet || entry === null || entry.value === w.the(Database).state.value;
          },
        },
        converges: {
          description: "Left alone, the cache ends up empty or agreeing with the database.",
          eventually: (w) => {
            const entry = w.the(Cache).state.entry;
            return entry === null || entry.value === w.the(Database).state.value;
          },
          within: 10 * SEC,
        },
      });
      return { Database, Cache, App };
    },
  );
}
