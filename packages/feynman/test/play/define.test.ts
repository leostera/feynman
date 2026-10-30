import { expect, test } from "bun:test";
import { defineActor, defineGroup, defineScenario, defineSpec, defineZone, type Actor } from "../../src/spec/index.ts";
import { definePlayground, groupsOf, isPlayground } from "../../src/play/index.ts";

const cloud = defineZone({ name: "Cloud" });
const macs = defineZone({ name: "Macs" });
const Worker = defineActor({ name: "Worker", zone: cloud, singleton: true, initialState: () => ({}) });
const Store = defineActor({ name: "Store", zone: cloud, singleton: true, initialState: () => ({ codes: 0 }) });
const App = defineActor({ name: "App", zone: macs, initialState: () => ({ linked: false }) });
const Daemon = defineActor({ name: "Daemon", zone: macs, initialState: () => ({ online: false }) });

const spec = (() => {
  const connect = defineScenario("Connect", { run: () => {} });
  return defineSpec({
    name: "Relay",
    actors: [Worker, Store, App, Daemon],
    groups: [defineGroup({ name: "Mac", actors: { app: App, daemon: Daemon } })],
    scenarios: [connect],
  });
})();

test("a playground records groups, renders, tokens and links by name", () => {
  const play = definePlayground(spec, (play) => {
    play.group("Relay", [Worker, Store], { icon: "cloud", status: ({ member }) => `${member(Store)?.state.codes ?? 0} codes` });
    play.group("Mac", { size: { w: 120, h: 90 } });
    play.actor(App, { panel: ({ state }) => (state.linked ? "linked" : null) });
    play.flow("Connect", [App, Worker, Store]);
    play.token("pairing code", ({ token }) => String(token.value));
    play.link("websocket", { style: "dashed", flowing: true });
  });
  expect(isPlayground(play)).toBe(true);
  expect(play.groups.map((g) => g.name)).toEqual(["Relay"]);
  expect(play.groups[0].members).toEqual([
    { actor: "Worker", suffix: null },
    { actor: "Store", suffix: null },
  ]);
  expect(Object.keys(play.group)).toEqual(["Relay", "Mac"]);
  expect(play.group.Mac.size).toEqual({ w: 120, h: 90 });
  expect(Object.keys(play.actor)).toEqual(["App"]);
  expect(play.flowOrder.Connect).toEqual(["App", "Worker", "Store"]);
  expect(groupsOf(spec, play).map((g) => g.name)).toEqual(["Mac", "Relay"]);
});

test("naming an actor the spec does not have, or styling a group it does not define, fails", () => {
  const stranger = { name: "Stranger", actions: {}, transitions: {} } as unknown as Actor<{}, {}>;
  expect(() => definePlayground(spec, (play) => play.actor(stranger, {}))).toThrow(/not an actor of Relay/);
  expect(() => definePlayground(spec, (play) => play.group("Nope", {}))).toThrow(/does not define/);
  expect(() => definePlayground(spec, (play) => play.flow("Missing", []))).toThrow(/unknown scenario/);
});
