import { expect, test } from "bun:test";
import { crash, defineActor, defineSpec, defineZone, emptyWorld, spawn } from "../../src/spec/index.ts";
import { nextHint } from "../../src/view/session";

test("left alone, the playground waits for a fault to be asked for", () => {
  const zone = defineZone({ name: "z" });
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ up: true }),
    transitions: { crash: crash() },
  });
  const spec = defineSpec({ name: "Crashes", actors: [Server] });
  const world = spawn(spec, emptyWorld(), "Server", "Server").world;
  expect(nextHint(spec, world)).toEqual({ kind: "done" });
});
