import { expect, test } from "bun:test";
import { defineSpec, message, type Actor } from "../../src/spec/index.ts";
import { definePlayground, groupsOf, isPlayground } from "../../src/play/index.ts";

const spec = defineSpec("Relay", { messages: { Ping: message<{}>({ name: "ping" }) } }, (spec) => {
  const cloud = spec.defineZone({ name: "Cloud" });
  const macs = spec.defineZone({ name: "Macs" });
  const Worker = spec.defineActor({ name: "Worker", zone: cloud, singleton: true, initialState: () => ({}) });
  const Store = spec.defineActor({ name: "Store", zone: cloud, singleton: true, initialState: () => ({ codes: 0 }) });
  const App = spec.defineActor({ name: "App", zone: macs, initialState: () => ({ linked: false }) });
  const Daemon = spec.defineActor({ name: "Daemon", zone: macs, initialState: () => ({ online: false }) });
  spec.defineGroup({ name: "Mac", actors: { app: App, daemon: Daemon } });
  return { Worker, Store, App, Daemon };
});

test("a playground records groups, renders, tokens and links by name", () => {
  const { Worker, Store, App } = spec.handles;
  const play = definePlayground(spec, (play) => {
    play.group("Relay", [Worker, Store], { icon: "cloud", status: ({ member }) => `${member(Store)?.state.codes ?? 0} codes` });
    play.group("Mac", { size: { w: 120, h: 90 } });
    play.actor(App, { panel: ({ state }) => (state.linked ? "linked" : null) });
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
  expect(groupsOf(spec, play).map((g) => g.name)).toEqual(["Mac", "Relay"]);
});

test("naming an actor the spec does not have, or styling a group it does not define, fails", () => {
  const stranger = { name: "Stranger", actions: {}, transitions: {} } as unknown as Actor<{}, {}>;
  expect(() => definePlayground(spec, (play) => play.actor(stranger, {}))).toThrow(/not an actor of Relay/);
  expect(() => definePlayground(spec, (play) => play.group("Nope", {}))).toThrow(/does not define/);
});
