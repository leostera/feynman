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
