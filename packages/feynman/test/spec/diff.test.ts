import { expect, test } from "bun:test";
import { defineActor, defineMessage, defineScenario, defineSpec, defineZone, diffRuns, runScenario } from "../../src/spec/index.ts";

const version = (refuseEmpty: boolean) =>
  (() => {
  const Say = defineMessage("Say", { text: String });
  const Heard = defineMessage("Heard", { text: String }, { tone: "reply" });
  const zone = defineZone({ name: "z" });
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ heard: [] as string[] }),
    transitions: {
      say: {
        on: Say,
        description: "Repeats what it hears.",
        sources: ["server.ts#say"],
        sends: [Heard],
        run(state, msg, ctx) {
          if (refuseEmpty && !msg.text) return;
          state.heard.push(msg.text);
          ctx.reply(Heard, { text: msg.text });
        },
      },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    initialState: () => ({ got: [] as string[] }),
    actions: {
      say: {
        label: "Say",
        description: "Says something.",
        inputs: { text: String },
        sources: ["client.ts#say"],
        sends: [Say],
        run: (_s, { text }, ctx) => ctx.send(ctx.the(Server), Say, { text }),
      },
    },
    transitions: { heard: { on: Heard, description: "Hears it back.", sources: ["client.ts#heard"], run: (s, msg) => void s.got.push(msg.text) } },
  });

  const sayNothing = defineScenario("Say nothing", {
    run(s) {
      const c = s.spawn(Client, "c");
      s.act(c, "say", { text: "" });
      s.settle();
    },
  });
  return defineSpec({
    name: "Echo",
    actors: [Server, Client],
    scenarios: [sayNothing],
  });
})();

test("the same scenario at two versions: changed steps, and steps that no longer happen", () => {
  const before = version(false);
  const after = version(true);
  const diff = diffRuns(runScenario(before, before.scenarios[0]), runScenario(after, after.scenarios[0]));
  expect(diff.status).toBe("changed");
  expect(diff.steps.map((s) => `${s.status} ${(s.head ?? s.base)!.actor}.${(s.head ?? s.base)!.key}`)).toEqual([
    "same Client.spawn",
    "same Client.say",
    "changed Server.say",
    "removed Client.heard",
  ]);
  expect(diffRuns(runScenario(after, after.scenarios[0]), runScenario(after, after.scenarios[0])).status).toBe("same");
});
