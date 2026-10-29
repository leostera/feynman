import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { formatReport } from "../../src/cli/format.ts";
import { defineSpec, message } from "../../src/spec/index.ts";

// A client that writes once and waits for the answer, with nothing that retries.
const writes = defineSpec("Writes", { messages: { Write: message<{}>({ name: "write" }), Ok: message<{}>({ name: "ok", tone: "reply" }) } }, (spec) => {
  const { Write, Ok } = spec.messages;
  const zone = spec.defineZone({ name: "z" });
  const Store = spec.defineActor({
    name: "Store",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    transitions: { [Write]: { description: "Writes.", sends: [Ok], run: (s, _m, ctx) => (s.n++, ctx.reply(Ok, {})) } },
  });
  const Client = spec.defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ waiting: false }),
    actions: { write: { label: "Write", description: "Writes.", when: (s) => !s.waiting, sends: [Write], run: (s, _i, ctx) => ((s.waiting = true), ctx.send(ctx.the(Store), Write, {})) } },
    transitions: { [Ok]: { description: "Done.", run: (s) => void (s.waiting = false) } },
  });
  spec.defineProperties({ answered: { description: "A write is answered.", leadsTo: { whenever: (w) => w.the(Client).state.waiting, then: (w) => !w.the(Client).state.waiting } } });
  return { Store, Client };
});

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("a path that ends waiting on a lost message says who waits, and what to model instead", async () => {
  const text = plain(formatReport(writes, await check(writes, { depth: 10, faults: 1, walks: 0 })));
  // Losing the write leaves its sender waiting; losing the reply, the one it was for. The shortest path loses the write.
  expect(text).toContain("then nothing fair can happen: it stays there forever, and never holds\n    The lost write to Store is never sent again, so Client waits for an answer that cannot come.");
  expect(text).toContain("✗ stuck");
  expect(text.match(/Model what the code does when none comes: a timer that retries, or the error the call raises/g)).toHaveLength(2);
  // Without faults, nothing is lost, and nothing is said about it.
  expect(plain(formatReport(writes, await check(writes, { depth: 10, faults: 0, walks: 0 })))).not.toContain("lost");
});
