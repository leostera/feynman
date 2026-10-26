import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, loadPlayground } from "../../src/cli/load.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "feynman-play-"));
  mkdirSync(join(dir, "specs"));
  writeFileSync(
    join(dir, "specs", "tiny.ts"),
    `import { defineSpec } from "@leostera/feynman";
export default defineSpec("Tiny", { messages: {} }, (spec) => {
  const zone = spec.defineZone({ name: "z" });
  const Lamp = spec.defineActor({ name: "Lamp", zone, initialState: () => ({ on: false }), actions: { flip: { label: "Flip", description: "Flips it.", run: (s) => void (s.on = !s.on) } } });
  return { Lamp };
});`,
  );
  writeFileSync(
    join(dir, "specs", "tiny.play.tsx"),
    `import { definePlayground, Node } from "@leostera/feynman/play";
import { useState } from "react";
import spec from "./tiny.ts";
export default definePlayground(spec, (play) => {
  play.actor(spec.handles.Lamp, { node: ({ state }) => <Node shape="circle" icon="bell" label={state.on ? "on" : "off"} /> });
});
export const unused = useState;`,
  );
  return join(dir, "specs", "tiny.play.tsx");
}

test("a playground bundle for the browser uses the page's React, Kumo and kit", async () => {
  const code = await bundle(fixture(), "browser");
  expect(code).toContain("globalThis.__feynman.modules");
  expect(code).not.toContain("react.production");
  expect(code).toContain('"Lamp"');
});

test("loading a playground checks it names the spec's actors", async () => {
  const play = (await loadPlayground(fixture())) as { kind: string; actor: Record<string, unknown> };
  expect(play.kind).toBe("feynman.playground");
  expect(Object.keys(play.actor)).toEqual(["Lamp"]);
});
