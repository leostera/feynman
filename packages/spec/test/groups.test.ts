import { expect, test } from "bun:test";
import { defineSpec, message, type Actor } from "../src/index.ts";

const spec = defineSpec("Groups", { messages: { Ping: message<{}>({ name: "ping" }) } }, (spec) => {
  const cloud = spec.defineZone({ name: "Cloud" });
  const macs = spec.defineZone({ name: "Macs" });
  const Worker = spec.defineActor({ name: "Worker", zone: cloud, singleton: true, initialState: () => ({}) });
  const Store = spec.defineActor({ name: "Store", zone: cloud, singleton: true, initialState: () => ({ n: 0 }) });
  const App = spec.defineActor({ name: "App", zone: macs, initialState: () => ({ linked: false }) });
  const Daemon = spec.defineActor({ name: "Daemon", zone: macs, initialState: () => ({ online: false }) });
  spec.defineGroup({ name: "Relay", actors: [Worker, Store], icon: "cloud" });
  spec.defineGroup({ name: "Mac", actors: { app: App, daemon: Daemon }, collapsed: true, names: ["Studio", "iMac"] });
  return { Worker, Store, App, Daemon };
});

test("a body that returns its actors gives typed handles", () => {
  const store: Actor<{ n: number }, {}> = spec.handles.Store;
  expect(store.name).toBe("Store");
  // @ts-expect-error: no such actor
  void spec.handles.Nope;
});

test("groups are data: singletons as a list, others by label suffix", () => {
  expect(spec.groups.map((g) => g.name)).toEqual(["Relay", "Mac"]);
  expect(spec.groups[0].members).toEqual([
    { actor: "Worker", suffix: null },
    { actor: "Store", suffix: null },
  ]);
  expect(spec.groups[1].members.map((m) => m.suffix)).toEqual(["app", "daemon"]);
  expect(spec.groups[1].collapsed).toBe(true);
});

test("a body that returns nothing still makes a spec", () => {
  const bare = defineSpec("Bare", { messages: {} }, (spec) => void spec.defineZone({ name: "z" }));
  expect(bare.handles).toEqual({});
  expect(bare.groups).toEqual([]);
});
