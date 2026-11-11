import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTrees, checkSources, findSymbol, resolveSource, writeLock } from "../../src/code/index.ts";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "feynman-code-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

const TS = `import { db } from "./db";

export const CODE_TTL = 10 * 60 * 1000;

export class Relay {
  constructor(private readonly store: Map<string, string>) {}

  async redeem(code: string): Promise<boolean> {
    if (!code) {
      return false;
    }
    return this.store.has(code);
  }
}

export function createPairing(account: string) {
  const code = "{" + account;
  return code;
}
`;

const RUST = `pub struct Worker;

impl Worker {
    pub async fn link(&self, code: &str) -> Result<(), Error> {
        let x = "}";
        Ok(())
    }
}

fn retry() {}
`;

const SWIFT = `final class RemoteAccess {
    func link(code: String) {
        print(code)
    }
}
`;

const PY = `def redeem(code):
    if code:
        return True
    return False

def other():
    pass
`;

test("symbols are found by their definitions, with their extent, in several languages", () => {
  const at = (text: string, symbol: string) => findSymbol(text.split("\n"), symbol);
  expect(at(TS, "CODE_TTL")).toEqual([3, 3]);
  expect(at(TS, "Relay")).toEqual([5, 14]);
  expect(at(TS, "Relay.redeem")).toEqual([8, 13]);
  expect(at(TS, "createPairing")).toEqual([16, 19]);
  expect(at(RUST, "Worker.link")).toEqual([4, 7]);
  expect(at(RUST, "Worker::link")).toEqual([4, 7]);
  expect(at(RUST, "retry")).toEqual([10, 10]);
  expect(at(SWIFT, "RemoteAccess.link")).toEqual([2, 4]);
  expect(at(PY, "redeem")).toEqual([1, 4]);
  expect(at(TS, "nowhere")).toBeNull();
});

test("generic functions and methods are found, with type parameters nested in theirs", () => {
  const GENERIC = [
    "export class Client<T extends Record<string, unknown>> {",
    "  async call<M extends KeyMethods<T>>(keys: readonly string[], method: M): Promise<Result<T[M]>[]> {",
    "    return this.route<M>(keys, method);",
    "  }",
    "  private async route<M extends Keys<Map<string, T>>, R = Out<M>>(keys: readonly string[], method: M): Promise<R[]> {",
    "    return [];",
    "  }",
    "}",
    "export function pick<K extends keyof Shape<T>, T>(value: T, key: K) {",
    "  return value;",
    "}",
    "export const wrap = <T extends Box<T>>(value: T) => {",
    "  return value;",
    "};",
    "const handlers = { send: async <M,>(m: M) => m };",
  ].join("\n");
  const at = (symbol: string) => findSymbol(GENERIC.split("\n"), symbol);
  expect(at("Client")).toEqual([1, 8]);
  expect(at("Client.call")).toEqual([2, 4]);
  expect(at("Client.route")).toEqual([5, 7]);
  expect(at("pick")).toEqual([9, 11]);
  expect(at("wrap")).toEqual([12, 14]);
});

test("sources resolve to their text and hash; bad ones say why", () => {
  const root = repo({ "src/relay.ts": TS });
  const ok = resolveSource(root, "src/relay.ts#Relay.redeem");
  expect(ok.ok && ok.resolved.text.split("\n")[0].trim()).toBe("async redeem(code: string): Promise<boolean> {");
  const range = resolveSource(root, "src/relay.ts:16-19");
  expect(range.ok && range.resolved.start).toBe(16);
  expect(resolveSource(root, "src/relay.ts")).toEqual({ ok: false, source: "src/relay.ts", reason: "is neither path#symbol nor path:start-end" });
  expect(resolveSource(root, "src/gone.ts#x")).toEqual({ ok: false, source: "src/gone.ts#x", reason: "src/gone.ts does not exist" });
  expect(resolveSource(root, "src/relay.ts:18-90")).toMatchObject({ ok: false, reason: "lines 18-90 are outside src/relay.ts (20 lines)" });
  // A symbol a few letters off names the ones the file does define.
  expect(resolveSource(root, "src/relay.ts#Relay.redeemCode")).toMatchObject({ ok: false, reason: "Relay.redeemCode is not defined in src/relay.ts; did you mean src/relay.ts#Relay.redeem?" });
  expect(resolveSource(root, "src/relay.ts#createpairing")).toMatchObject({ reason: "createpairing is not defined in src/relay.ts; did you mean src/relay.ts#createPairing?" });
  expect(resolveSource(root, "src/relay.ts#zzz")).toMatchObject({ reason: "zzz is not defined in src/relay.ts" });
});

test("the lock flags a source as stale only when its own code changes", () => {
  const root = repo({ "src/relay.ts": TS });
  const sources = ["src/relay.ts#Relay.redeem", "src/relay.ts#createPairing"];
  expect(checkSources(root, sources).map((s) => s.status)).toEqual(["new", "new"]);
  writeLock(root, checkSources(root, sources));
  // Changing createPairing leaves Relay.redeem fresh.
  writeFileSync(join(root, "src/relay.ts"), TS.replace('"{" + account', '"code-" + account'));
  const statuses = Object.fromEntries(checkSources(root, sources).map((s) => [s.source, s.status]));
  expect(statuses).toEqual({ "src/relay.ts#Relay.redeem": "fresh", "src/relay.ts#createPairing": "stale" });
});

test("call trees come from calldiff, keyed by source", () => {
  const root = repo({
    "app/package.json": "{}",
    "app/src/main.ts": `import { helper } from "./helper";\nexport function handle(x: number) {\n  return helper(x) + Math.max(x, 1);\n}\n`,
    "app/src/helper.ts": `export function helper(x: number) {\n  return inner(x);\n}\nfunction inner(x: number) {\n  return x * 2;\n}\n`,
  });
  const { trees, problems } = callTrees(root, ["app/src/main.ts#handle", "app/src/main.ts#missing"]);
  expect(Object.keys(problems)).toEqual(["app/src/main.ts#missing"]);
  const tree = trees["app/src/main.ts#handle"];
  const labels = (node: { label: string; children: { label: string; children: never[] }[] }): string[] => [node.label.split("(")[0], ...node.children.flatMap((c) => labels(c as never))];
  expect(labels(tree as never)).toEqual(expect.arrayContaining(["handle", "helper", "inner"]));
}, 60_000);

// Each a way a definition's extent once stopped short, or was not found: the lock hashes the
// extent, so a definition resolved to its signature alone never goes stale when its body changes.
const EXTENTS: [name: string, path: string, symbol: string, text: string, lines: [number, number]][] = [
  ["ts: wrapped params with an object type", "x.ts", "f", `export function f(
  opts: { a: string },
  n: number,
) {
  return opts.a + n;
}`, [1, 6]],
  ["ts: wrapped params with a default object", "x.ts", "f", `export function f(
  opts = {},
) {
  return opts;
}`, [1, 5]],
  ["ts: method with wrapped params and object type", "x.ts", "A.m", `class A {
  m(
    opts: { a: string },
  ): void {
    this.x = opts.a;
  }
}`, [2, 6]],
  ["ts: arrow const with wrapped object param", "x.ts", "f", `export const f = async (
  { a, b }: Args,
): Promise<void> => {
  await a(b);
};`, [1, 5]],
  ["ts: return type object literal", "x.ts", "f", `function f(): { a: number } {
  return { a: 1 };
}`, [1, 3]],
  ["ts: wrapped return type object", "x.ts", "f", `function f(x: number): {
  a: number;
} {
  return { a: x };
}`, [1, 5]],
  ["ts: template string with a brace", "x.ts", "f", "function f() {\n  const s = `${a} }`;\n  return s;\n}", [1, 4]],
  ["ts: regex with a brace", "x.ts", "f", `function f(s: string) {
  const m = /\\{/.test(s);
  return m;
}`, [1, 4]],
  ["ts: string with a quote char and brace", "x.ts", "f", `function f() {
  const q = "'";
  const b = "{";
  return q + b;
}`, [1, 5]],
  ["ts: block comment with a brace", "x.ts", "f", `function f() {
  /* } */
  return 1;
}`, [1, 4]],
  ["rust: long signature", "x.rs", "long", `pub fn long(
    a: A,
    b: B,
    c: C,
    d: D,
    e: E,
    f: F,
) -> R {
    body()
}`, [1, 10]],
  ["rust: where clause", "x.rs", "f", `pub fn f<T>(x: T) -> R
where
    T: Clone,
{
    x.clone()
}`, [1, 6]],
  ["rust: char literal brace", "x.rs", "f", `fn f() -> char {
    let c = '}';
    c
}`, [1, 4]],
  ["go: method with receiver", "x.go", "Handle", `func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
	s.n++
}`, [1, 3]],
  ["go: function", "x.go", "Run", `func Run(ctx context.Context) error {
	return nil
}`, [1, 3]],
  ["python: decorator", "x.py", "f", `@app.route("/")
def f():
    return 1
`, [2, 3]],
  ["python: dict literal early", "x.py", "f", `def f():
    d = {"a": 1}
    return d
`, [1, 3]],
  ["python: multi-line string dedent", "x.py", "f", `def f():
    s = """
text
"""
    return s
`, [1, 5]],
  ["swift: func with wrapped params", "x.swift", "link", `func link(
    code: String,
    to mac: Mac
) async throws -> Account {
    try await relay.redeem(code)
}`, [1, 6]],
  ["ruby: def end", "x.rb", "pay", `def pay(order)
  charge(order)
end`, [1, 3]],
  ["ts: overloads then implementation", "x.ts", "f", `function f(a: string): string;
function f(a: number): number;
function f(a: any): any {
  return a;
}`, [3, 5]],
  ["ts: symbol name in a call before the definition", "x.ts", "run", `it("x", () => {
  run(1, 2
  );
});
function run(a: number, b: number) {
  return a + b;
}`, [5, 7]],
  ["ts: object method shorthand in export default", "x.ts", "fetch", `export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("ok");
  },
};`, [2, 4]],
  ["ts: interface member picked instead of implementation", "x.ts", "A.m", `interface A {
  m(x: number): void;
}
class A {
  m(x: number): void {
    work(x);
  }
}`, [5, 7]],
  ["ts: a signature with an inline object type and semicolons", "x.ts", "A.resolve", `export class A {
  async resolve(keys: readonly string[], payloads: readonly { route: string; token: number }[]): Promise<void> {
    await this.send(keys, payloads);
  }
}`, [2, 4]],
  ["python: a class with a wrapped header", "x.py", "A", `class A(
    Base,
):
    def m(self):
        pass

class B:
    pass`, [1, 5]],
  ["python: a method of a class with a wrapped header", "x.py", "A.m", `class A(
    Base,
):
    def m(self):
        pass
`, [4, 5]],
  ["python: a def with a wrapped header", "x.py", "B.m", `class B:
    def m(
        self,
    ):
        pass

x = 1`, [2, 5]],
  ["python: wrapped type parameters", "x.py", "A", `class A[
    T,
](Base):
    x = 1
`, [1, 4]],
  ["go: a method named by its type", "x.go", "Server.Handle", `type Server struct {
	n int
}

func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
	s.n++
}`, [5, 7]],
  ["swift: a protocol requirement has no body", "x.swift", "Store.load", `protocol Store {
    func load() -> Data
    func save(_ data: Data)
}`, [2, 2]],
  ["ts: a constant without a semicolon", "x.ts", "LIMIT", `const LIMIT = 10
const OTHER = {
  a: 1,
}`, [1, 1]],
  ["ts: a multi-line constant", "x.ts", "SOURCE", "export const SOURCE = `\nline {\n`;\nconst after = 1;", [1, 3]],
];

test.each(EXTENTS)("a definition's extent: %s", (_name, path, symbol, text, lines) => {
  expect(findSymbol(text.split("\n"), symbol, path)).toEqual(lines);
});
