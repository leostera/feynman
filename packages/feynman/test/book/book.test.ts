// The book's specs (book/specs at the repository root) must keep saying what the book says
// they say. Each is checked as its header comment asks ("Expected, at `--depth N`"), and its
// verdicts are compared with the snapshot. When a change to Feynman moves one on purpose,
// update the chapter that quotes it, then the snapshot (`bun test test/book --update-snapshots`).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { main } from "../../src/cli/main.ts";

const ROOT = join(import.meta.dir, "../../../..");
const SPECS = [...new Glob("book/specs/**/*.ts").scanSync(ROOT)].sort();

/** The depth a step's header asks for, if any. */
function depthOf(path: string): string | undefined {
  return /at `--depth (\d+)`/.exec(readFileSync(join(ROOT, path), "utf8"))?.[1];
}

/** `feynman check --json`, in process, as parsed JSON. */
async function checkJson(path: string, depth: string | undefined): Promise<CheckJson> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await main(["check", path, "--json", ...(depth ? ["--depth", depth] : [])], ROOT);
  } finally {
    console.log = log;
  }
  return JSON.parse(lines.join("\n")) as CheckJson;
}

interface CheckJson {
  typeErrors: unknown[];
  specs: {
    properties: { id: string; verdict: string }[];
    rules: { name: string; neededBy: { property: string; verdict: string }[] }[];
    stuck?: unknown;
    errors: unknown[];
  }[];
}

/** What a chapter can quote: each property's verdict, each rule's, and whether it gets stuck. */
function verdicts(json: CheckJson) {
  const [spec] = json.specs;
  return {
    typeErrors: json.typeErrors.length,
    errors: spec!.errors.length,
    stuck: spec!.stuck !== undefined && spec!.stuck !== null,
    properties: Object.fromEntries(spec!.properties.map((p) => [p.id, p.verdict])),
    rules: Object.fromEntries(spec!.rules.map((r) => [r.name, r.neededBy.map((n) => `${n.property}: ${n.verdict}`)])),
  };
}

test("the book has specs", () => {
  expect(SPECS.length).toBeGreaterThan(50);
});

for (const path of SPECS) {
  test(relative("book/specs", path), async () => {
    // A step may fail to load on purpose: its chapter shows the error.
    const result = await checkJson(path, depthOf(path)).then(verdicts, (error: Error) => ({ loadError: error.message.replaceAll(ROOT + "/", "") }));
    expect(result).toMatchSnapshot();
  }, 60_000);
}
