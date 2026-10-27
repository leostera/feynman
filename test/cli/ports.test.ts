import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { portFree } from "../../src/cli/serve.ts";

test("a port held on one loopback address is not free: localhost is both", async () => {
  const held = createServer();
  await new Promise<void>((done) => held.listen(0, "127.0.0.1", done));
  const port = (held.address() as { port: number }).port;
  try {
    expect(await portFree(port)).toBe(false);
  } finally {
    held.close();
  }
  expect(await portFree(port)).toBe(true);
});
