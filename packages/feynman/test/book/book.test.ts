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

test("chapter 15's log is not a run of the agent's draft, and is one of the fix", async () => {
  const { conform, parseLog } = await import("../../src/check/conform.ts");
  const { loadSpec } = await import("../../src/cli/load.ts");
  const log = await Bun.file(join(ROOT, "book/specs/15-triage/two-holds.jsonl")).text();
  const read = async (step: string) => {
    const spec = await loadSpec(join(ROOT, `book/specs/15-triage/${step}.ts`));
    const r = conform(spec, parseLog(log, spec));
    return r.conforms ? { conforms: true, broken: r.broken.length } : { conforms: false, line: r.stop.kind === "mismatch" ? r.stop.line.line : null };
  };
  expect(await read("1-the-agents-draft")).toEqual({ conforms: false, line: 7 });
  expect(await read("2-one-statement")).toEqual({ conforms: true, broken: 0 });
  // And as an OpenTelemetry trace, the box office's clock behind the phones'.
  const { readSpans, traceLog } = await import("../../src/check/trace.ts");
  const trace = await Bun.file(join(ROOT, "book/specs/15-triage/two-holds.otlp.json")).text();
  const traced = async (step: string) => {
    const spec = await loadSpec(join(ROOT, `book/specs/15-triage/${step}.ts`));
    const r = conform(spec, traceLog(readSpans(trace), spec));
    return r.conforms ? { conforms: true, broken: r.broken.length } : { conforms: false, span: r.stop.kind === "mismatch" ? r.stop.line.at : null };
  };
  expect(await traced("1-the-agents-draft")).toEqual({ conforms: false, span: 'span "show held" (Alice, 47582cd9312f09c8)' });
  expect(await traced("2-one-statement")).toEqual({ conforms: true, broken: 0 });
});

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
