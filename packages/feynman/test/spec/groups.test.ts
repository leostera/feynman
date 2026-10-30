import { expect, test } from "bun:test";
import { defineActor, defineGroup, defineSpec, defineZone } from "../../src/spec/index.ts";

const spec = (() => {
  const cloud = defineZone({ name: "Cloud" });
  const macs = defineZone({ name: "Macs" });
  const Worker = defineActor({ name: "Worker", zone: cloud, singleton: true, initialState: () => ({}) });
  const Store = defineActor({ name: "Store", zone: cloud, singleton: true, initialState: () => ({ n: 0 }) });
  const App = defineActor({ name: "App", zone: macs, initialState: () => ({ linked: false }) });
  const Daemon = defineActor({ name: "Daemon", zone: macs, initialState: () => ({ online: false }) });
  return defineSpec({
    name: "Groups",
    actors: [Worker, Store, App, Daemon],
    groups: [defineGroup({ name: "Relay", actors: [Worker, Store], icon: "cloud" }), defineGroup({ name: "Mac", actors: { app: App, daemon: Daemon }, collapsed: true, names: ["Studio", "iMac"] })],
  });
})();

test("groups are data: singletons as a list, others by label suffix", () => {
  expect(spec.groups.map((g) => g.name)).toEqual(["Relay", "Mac"]);
  expect(spec.groups[0].members).toEqual([
    { actor: "Worker", suffix: null },
    { actor: "Store", suffix: null },
  ]);
  expect(spec.groups[1].members.map((m) => m.suffix)).toEqual(["app", "daemon"]);
  expect(spec.groups[1].collapsed).toBe(true);
});

test("a spec without groups has none", () => {
  const bare = defineSpec({ name: "Bare", actors: [defineActor({ name: "A", zone: defineZone({ name: "z" }), initialState: () => ({}) })] });
  expect(bare.groups).toEqual([]);
});
