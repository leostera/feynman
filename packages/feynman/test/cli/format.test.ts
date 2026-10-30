import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { formatReport } from "../../src/cli/format.ts";
import { defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "../../src/spec/index.ts";

// A client that writes once and waits for the answer, with nothing that retries.
const writes = (() => {
  const Write = defineMessage("Write");
  const Ok = defineMessage("Ok", {}, { tone: "reply" });
  const zone = defineZone({ name: "z" });
  const Store = defineActor({
    name: "Store",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    transitions: { write: { on: Write, description: "Writes.", sends: [Ok], run: (s, _m, ctx) => (s.n++, ctx.reply(Ok, {})) } },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ waiting: false }),
    actions: { write: { label: "Write", description: "Writes.", when: (s) => !s.waiting, sends: [Write], run: (s, _i, ctx) => ((s.waiting = true), ctx.send(ctx.the(Store), Write, {})) } },
    transitions: { ok: { on: Ok, description: "Done.", run: (s) => void (s.waiting = false) } },
  });

  const answered = defineProperty("answered", { description: "A write is answered.", leadsTo: { whenever: (w) => w.the(Client).state.waiting, then: (w) => !w.the(Client).state.waiting } });
  return defineSpec({
    name: "Writes",
    actors: [Store, Client],
    properties: [answered],
  });
})();

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("a path that ends waiting on a lost message says who waits, and what to model instead", async () => {
  const text = plain(formatReport(writes, await check(writes, { depth: 10, faults: 1, walks: 0 })));
  // Losing the write leaves its sender waiting; losing the reply, the one it was for. The shortest path loses the write.
  expect(text).toContain("then nothing fair can happen: it stays there forever, and never holds\n    The lost write to Store is never sent again, so Client waits for an answer that cannot come.");
  expect(text).toContain("✗ stuck");
  expect(text.match(/Model what the code does when none comes: if the code is told \(an RPC or fetch that throws\), define Write with defineCall and handle its failure with a step on failed\(Write\); otherwise a timer that retries/g)).toHaveLength(2);
  // Without faults, nothing is lost, and nothing is said about it.
  expect(plain(formatReport(writes, await check(writes, { depth: 10, faults: 0, walks: 0 })))).not.toContain("lost");
});
