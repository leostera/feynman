import { expect, test } from "bun:test";
import { appearance, defineSpec, dropsFor, liveLinks, message, runScenario } from "../src/index.ts";

const spec = defineSpec("Look", { messages: { Dial: message<{ n: number }>({ name: "dial" }), Up: message<{ n: number }>({ name: "up", tone: "reply" }) } }, (spec) => {
  const { Dial, Up } = spec.messages;
  const zone = spec.defineZone({ name: "z" });
  const Hub = spec.defineActor({
    name: "Hub",
    zone,
    singleton: true,
    initialState: () => ({ peers: [] as string[] }),
    look: { icon: "cloud", status: (s) => `${s.peers.length} connected`, rows: (s) => s.peers.map((p) => ({ label: p, group: "peers", mood: "ok" as const })), tokens: () => [{ kind: "slot", value: 7 }] },
    transitions: {
      [Dial]: {
        description: "Accepts a peer.",
        sources: ["hub.ts#dial"],
        sends: [Up],
        say: (s, msg) => `Accepted peer ${msg.n}; ${s.peers.length} now`,
        run(state, msg, ctx) {
          state.peers.push(String(msg.n));
          ctx.reply(Up, { n: msg.n });
        },
      },
    },
  });
  const Peer = spec.defineActor({
    name: "Peer",
    zone,
    initialState: () => ({ up: false, pings: 0 }),
    look: { icon: "laptop", mood: (s) => (s.up ? "ok" : "off"), owner: (s) => (s.up ? "Hub" : null) },
    links: (s) => (s.up ? [{ to: "Hub", kind: "socket" }] : []),
    actions: {
      dial: {
        label: "Dial",
        description: "Dials the hub.",
        inputs: { n: spec.defineInput(Number, { examples: [1, 2], accepts: "slot" }) },
        sources: ["peer.ts#dial"],
        sends: [Dial],
        run: (_s, { n }, ctx) => ctx.send(ctx.the(Hub), Dial, { n }),
      },
      ping: { label: "Ping yourself", description: "Counts.", routine: true, sources: ["peer.ts#ping"], run: (s, _i, ctx) => void (s.pings += ctx.self.id ? 1 : 0) },
    },
    transitions: { [Up]: { description: "Is up.", sources: ["peer.ts#up"], run: (s) => void (s.up = true) } },
  });
  spec.defineScenario({
    name: "Dial",
    run(s) {
      const p = s.spawn(Peer, "p");
      s.act(p, "ping", {});
      s.act(p, "dial", { n: 1 });
      s.settle();
      // Scenarios can reach singletons.
      if (s.the(Hub).state.peers.length !== 1) throw new Error("hub did not accept");
    },
  });
});

test("look, links and say: presentation as data, evaluated against the world", () => {
  const run = runScenario(spec, spec.scenarios[0]);
  expect(run.error).toBeUndefined();
  const world = run.worlds.at(-1)!;
  expect(appearance(spec, world, "hub")).toEqual({ icon: "cloud", status: "1 connected", mood: null, rows: [{ label: "1", group: "peers", mood: "ok" }], tokens: [{ kind: "slot", value: 7 }], owner: undefined });
  expect(appearance(spec, world, "peer-p").owner).toBe("Hub");
  expect(run.events.find((e) => e.key === "ping")?.routine).toBe(true);
  expect(run.events.find((e) => e.key === "dial")?.routine).toBeUndefined();
  // Dropping the hub's token on the peer dials with it.
  const drops = dropsFor(spec, world, "peer-p", { kind: "slot", value: 7 });
  expect(drops.map((d) => [d.action.key, d.inputs, d.complete])).toEqual([["dial", { n: 7 }, true]]);
  expect(dropsFor(spec, world, "hub", { kind: "slot", value: 7 })).toEqual([]);
  expect(liveLinks(spec, world)).toEqual([{ to: "Hub", kind: "socket", from: "peer-p", target: "hub" }]);
  expect(run.events.find((e) => e.key === "message:Dial")?.text).toBe("Accepted peer 1; 1 now");
  // Example arrays work like example functions.
  expect(spec.actors[1].actions.dial.inputs.n.examples?.({} as never)).toEqual([1, 2]);
});
