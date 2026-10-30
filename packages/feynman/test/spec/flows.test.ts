import { expect, test } from "bun:test";
import { defineActor, defineMessage, defineScenario, defineSpec, defineZone, flowsOf, runScenario } from "../../src/spec/index.ts";

// Two clients each ping a server, at once: their flows interleave in the trace, but each keeps
// its own ping and pong.
const pings = (() => {
  const Ping = defineMessage("Ping");
  const Pong = defineMessage("Pong", {}, { tone: "reply" });
  const zone = defineZone({ name: "z" });
  const Server = defineActor({ name: "Server", zone, singleton: true, initialState: () => ({}), transitions: { ping: { on: Ping, description: "Answers.", sends: [Pong], run: (_s, _m, ctx) => ctx.reply(Pong, {}) } } });
  const Client = defineActor({
    name: "Client",
    zone,
    initialState: () => ({ got: 0 }),
    actions: { ping: { label: "Ping", description: "Pings.", sends: [Ping], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ping, {}) } },
    transitions: { pong: { on: Pong, description: "Counts.", run: (s) => void (s.got += 1) } },
  });

  const bothPing = defineScenario("Both ping", {
    run(s) {
      const a = s.spawn(Client, "A");
      const b = s.spawn(Client, "B");
      s.act(a, "ping");
      s.act(b, "ping");
      s.settle();
    },
  });
  return defineSpec({
    name: "Pings",
    actors: [Server, Client],
    scenarios: [bothPing],
  });
})();

test("each action's flow holds what it set off, even where flows interleave", () => {
  const run = runScenario(pings, pings.scenarios[0]);
  const flows = flowsOf(run);
  const describe = (indices: number[]) => indices.map((i) => `${run.events[i].instance}.${run.events[i].key}`);
  expect(flows.map((f) => f.kind)).toEqual(["spawn", "action", "action"]);
  expect(describe(flows[1].events)).toEqual(["client-a.ping", "server.ping", "client-a.pong"]);
  expect(describe(flows[2].events)).toEqual(["client-b.ping", "server.ping", "client-b.pong"]);
  // Every event is in exactly one flow.
  expect(flows.flatMap((f) => f.events).sort((a, b) => a - b)).toEqual(run.events.map((_, i) => i));
});
