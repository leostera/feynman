import { expect, test } from "bun:test";
import type { Element, Model } from "@feynman/model";
import { actorGaps, depthGaps, isTestFile, nextGroup, owns } from "../src/phases.ts";

/** A model whose first-party actors each run one component, named after the actor, covering `paths`. */
const model = (parts: Partial<Model> & { actors: (Element & { paths?: string[] })[] }): Model => {
  const components = parts.actors.filter((a) => a.paths).map((a) => ({ id: a.id, actors: [a.id], footprint: { paths: a.paths } }));
  const actors = parts.actors.map(({ paths: _, ...a }) => a);
  return { meta: { summary: "x" }, flows: [], protocols: [], state: [], stateMachines: [], invariants: [], claims: [], limits: [], components, ...parts, actors } as Model;
};
const actor = (id: string, paths: string[] | null, talksTo: string[] = []): Element & { paths?: string[] } =>
  paths ? { id, kind: "program", provenance: "first-party", paths, talksTo } : { id, kind: "person", provenance: "third-party", talksTo };

test("footprints own files under directories, files, and the root", () => {
  expect(owns(["src/"], "src/a.ts")).toBe(true);
  expect(owns(["src"], "src/a.ts")).toBe(true);
  expect(owns(["src"], "srcx/a.ts")).toBe(false);
  expect(owns(["src/a.ts"], "src/a.ts")).toBe(true);
  expect(owns(["."], "anything")).toBe(true);
});

test("the actor map needs a summary, connected actors, a user, and components in first-party actors", () => {
  expect(actorGaps(model({ meta: {}, actors: [actor("app", ["src/"])] }))).toEqual([
    "meta.json has no summary of what the system is and does",
    "a system interacts with something: add the people, services, and programs it talks to as actors",
    "no actor uses the system: who or what starts its behaviours (a person, another program, a client)?",
  ]);
  expect(actorGaps(model({ actors: [actor("app", null, ["user"]), actor("user", null)].map((a, i) => (i ? a : { ...a, provenance: "first-party" })) }))).toEqual([
    "actors/app is first-party, but no component runs in it; add components with footprints",
  ]);
  expect(actorGaps(model({ actors: [actor("app", ["src/"], ["user"]), actor("user", null)] }))).toEqual([]);
});

test("groups gather connected actors within the budget, split large actors, and end with unowned files", () => {
  const m = model({ actors: [actor("api", ["api/"], ["db", "web"]), actor("db", ["db/"]), actor("web", ["web/"]), actor("user", null, ["web"])] });
  const sizes = new Map([["api/a.ts", 50], ["api/b.ts", 50], ["db/q.ts", 40], ["web/ui.ts", 80], ["README.md", 5]]);
  const unread = [...sizes.keys()];

  // api is the first actor; db fits beside it, web does not.
  expect(nextGroup(m, unread, sizes, 150)).toEqual({ actors: ["api", "db"], components: ["api", "db"], neighbours: ["web"], files: ["api/a.ts", "api/b.ts", "db/q.ts"], bytes: 140, remaining: 2 });
  // An actor larger than the budget is read in parts.
  expect(nextGroup(m, unread, sizes, 60)?.files).toEqual(["api/a.ts"]);
  // web comes next, with the people who use it as context.
  expect(nextGroup(m, ["web/ui.ts", "README.md"], sizes, 150)).toMatchObject({ actors: ["web"], neighbours: ["api", "user"], files: ["web/ui.ts"] });
  expect(nextGroup(m, ["README.md"], sizes, 150)).toMatchObject({ actors: [], files: ["README.md"] });
  expect(nextGroup(m, [], sizes)).toBeNull();
});

test("depth gaps: one-actor flows, unexplained connections, actors in no flow, shallow call paths", () => {
  const m = model({
    actors: [actor("api", ["api/"], ["db", "user"]), actor("db", ["db/"]), actor("user", null)],
    flows: [
      { id: "query", steps: [{ actor: "api", action: "queries", target: "db" }] },
      { id: "think", steps: [{ actor: "api", action: "thinks" }] },
    ],
    protocols: [{ id: "sql", server: "db", clients: ["api"], messages: [{ name: "select" }] }],
    invariants: [{ id: "limit", enforcement: "runtime", enforcedAt: { trigger: "a request", frames: [{ symbol: "check" }] } }],
  });
  expect(depthGaps(m)).toEqual([
    "flows/think involves only api; name each step's target",
    "api ↔ user talk, but no flow step or protocol shows how",
    "invariants/limit: trace the call path from a request to the check (enforcedAt.frames)",
  ]);
});

test("tests are recognised by the usual conventions", () => {
  for (const file of ["test/a.ts", "src/__tests__/a.tsx", "pkg/tests/x.rs", "a.test.ts", "a.spec.js", "pkg/thing_test.go", "tests/test_api.py"]) expect(isTestFile(file)).toBe(true);
  for (const file of ["src/testing.ts", "src/contest.ts", "latest/a.ts"]) expect(isTestFile(file)).toBe(false);
});

test("the model is thin while no invariant, claim, or limit cites the tests", () => {
  const m = model({ actors: [actor("api", ["api/"], ["user"]), actor("user", null)], flows: [{ id: "call", steps: [{ actor: "user", action: "calls", target: "api" }] }] });
  expect(depthGaps(m, ["api/a.ts", "api/a.test.ts"])).toEqual([
    "1 test files check behaviour, but no invariant, claim, or limit cites one: record what they check (invariant tests, claim evidence)",
  ]);
  const cited = { ...m, invariants: [{ id: "bounded", enforcement: ["test-time"], enforcedAt: [], tests: ["api/a.test.ts"] }] } as Model;
  expect(depthGaps(cited, ["api/a.ts", "api/a.test.ts"])).toEqual([]);
});
