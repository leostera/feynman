// Call trees under steps, measured with calldiff (tree-sitter, many languages).
//
// A step's first symbol source is its entry point; the tree of calls below it is
// mechanical, so drilling from an event down to the code costs nothing and is the same
// every time. Calls into the indexed code keep their own calls; calls that do not
// resolve (libraries, the runtime) are `external` leaves, once per parent. Each tree is
// cut at MAX_DEPTH and MAX_NODES.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSource } from "./sources.ts";

const MAX_DEPTH = 6;
const MAX_NODES = 200;
const WORKER = join(import.meta.dirname, "calls-worker.ts");
const MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "Package.swift", "pyproject.toml", "build.gradle", "pom.xml", "mix.exs", "Gemfile"];

export interface CallNode {
  label: string;
  file?: string;
  line?: number;
  external?: boolean;
  children: CallNode[];
}

interface RawNode {
  label: string;
  kind?: "call" | "branch";
  file?: string;
  line?: number;
  children?: RawNode[];
}

/** Call trees for every `path#symbol` source, keyed by source; problems for those calldiff could not find. */
export function callTrees(root: string, sources: string[]): { trees: Record<string, CallNode>; problems: Record<string, string> } {
  const trees: Record<string, CallNode> = {};
  const problems: Record<string, string> = {};
  const byScope = new Map<string, { source: string; path: string; symbol: string }[]>();
  for (const source of new Set(sources)) {
    const parsed = parseSource(source);
    if (!parsed?.symbol) continue;
    const scope = packageOf(root, parsed.path);
    byScope.set(scope, [...(byScope.get(scope) ?? []), { source, path: parsed.path, symbol: parsed.symbol.replace(/::/g, ".") }]);
  }
  for (const [scope, entries] of byScope) {
    const raw = runTree(root, [...new Set(entries.map((e) => e.symbol))], [scope]);
    for (const entry of entries) {
      const candidates = raw.trees.get(entry.symbol) ?? [];
      const tree = candidates.find((t) => t.file === entry.path) ?? candidates[0];
      if (tree) trees[entry.source] = prune(tree);
      else problems[entry.source] = raw.errors.get(entry.symbol) ?? "calldiff found no such function";
    }
  }
  return { trees, problems };
}

/** The directory of the nearest manifest above a file, as a repository path ending in `/`. */
function packageOf(root: string, path: string): string {
  for (let dir = dirname(path); dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) {
    if (MANIFESTS.some((m) => existsSync(join(root, dir, m)))) return `${dir}/`;
  }
  return `${dirname(path) === "." ? "" : `${dirname(path)}/`}` || "./";
}

function runTree(root: string, symbols: string[], scope: string[]): { trees: Map<string, RawNode[]>; errors: Map<string, string> } {
  const request = JSON.stringify({ entries: symbols, paths: scope, maxDepth: MAX_DEPTH });
  const run = spawnSync("node", [WORKER], { cwd: root, input: request, encoding: "utf8", maxBuffer: 1 << 28, timeout: 180_000 });
  let out: { trees: { entry: string; tree: RawNode }[]; errors: Record<string, string> };
  try {
    out = JSON.parse(run.stdout);
  } catch {
    const reason = (run.stderr || run.stdout).trim().split("\n")[0] || `exited ${run.status}`;
    return { trees: new Map(), errors: new Map(symbols.map((symbol) => [symbol, `calldiff failed: ${reason}`])) };
  }
  const trees = new Map<string, RawNode[]>();
  for (const { entry, tree } of out.trees) trees.set(entry, [...(trees.get(entry) ?? []), tree]);
  return { trees, errors: new Map(Object.entries(out.errors)) };
}

/** Keep calls into the indexed code with their subtrees, the rest as external leaves once per parent; lift calls out of branches. */
function prune(root: RawNode): CallNode {
  let budget = MAX_NODES;
  const convert = (node: RawNode): CallNode => {
    budget -= 1;
    const seen = new Set<string>();
    const children: CallNode[] = [];
    for (const child of calls(node.children ?? [])) {
      const external = !resolved(child);
      const key = `${external}:${child.label}`;
      if (seen.has(key) || budget <= 0) continue;
      seen.add(key);
      children.push(external ? leaf(child) : convert(child));
    }
    return { label: node.label, ...location(node), children };
  };
  const leaf = (node: RawNode): CallNode => {
    budget -= 1;
    return { label: node.label, ...location(node), external: true, children: [] };
  };
  return convert(root);
}

function calls(nodes: RawNode[]): RawNode[] {
  return nodes.flatMap((node) => (node.kind === "branch" ? calls(node.children ?? []) : [node]));
}

/** calldiff prints a resolved callee with its parameters and expands it; an unresolved one as `name()`. */
function resolved(node: RawNode): boolean {
  return (node.children?.length ?? 0) > 0 || !/\(\)$/.test(node.label);
}

function location(node: RawNode): Pick<CallNode, "file" | "line"> {
  return { ...(node.file ? { file: node.file } : {}), ...(node.line ? { line: node.line } : {}) };
}
