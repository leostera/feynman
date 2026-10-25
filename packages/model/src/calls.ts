// Call trees under flow steps, measured with calldiff (tree-sitter, many languages).
//
// A step anchored to a function (`path#symbol`) gets the tree of calls that function
// makes. The agent says where a step happens; the tree below it is mechanical, so
// drilling from a flow down to the code costs no tokens and is the same every time.
//
// Calls that resolve to code in the indexed paths are kept with their own calls;
// calls that do not (libraries, the runtime, system calls) are kept as `external`
// leaves, once per parent. Each tree is cut at MAX_DEPTH and MAX_NODES.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { resolveAnchor } from "./anchors.ts";
import type { CallNode, Model } from "./types.ts";

const MAX_DEPTH = 6;
const MAX_NODES = 200;

const WORKER = join(import.meta.dirname, "calls-worker.ts");

/** What calldiff prints per node in `--format json`. */
interface RawNode {
  label: string;
  kind?: "call" | "branch";
  file?: string;
  line?: number;
  children?: RawNode[];
}

/** A step to measure: where its entry function is, and which paths to index. */
interface Entry {
  flow: string;
  step: number;
  file: string;
  symbol: string;
  /** Repository paths to index: the code of the step's actor, and the entry file's directory. */
  scope: string[];
}

/** Call trees for every anchored step with a symbol, keyed `<flow>#<step index>`; problems for those that failed. */
export function measureCalls(repository: string, model: Model): { trees: Map<string, CallNode>; problems: string[] } {
  const trees = new Map<string, CallNode>();
  const problems: string[] = [];
  // One calldiff run per scope, with every entry in it.
  const byScope = new Map<string, Entry[]>();
  for (const entry of entries(model)) {
    const key = entry.scope.join("\0");
    byScope.set(key, [...(byScope.get(key) ?? []), entry]);
  }
  for (const group of byScope.values()) {
    const symbols = [...new Set(group.map((entry) => entry.symbol))];
    const raw = runTree(repository, symbols, group[0].scope);
    for (const entry of group) {
      const tree = raw.trees.get(entry.symbol)?.find((root) => root.file === entry.file) ?? raw.trees.get(entry.symbol)?.[0];
      if (tree) trees.set(`${entry.flow}#${entry.step}`, prune(tree));
      else {
        const reason = raw.errors.get(entry.symbol);
        problems.push(`flows/${entry.flow} step ${entry.step + 1}: no call tree for ${entry.file}#${entry.symbol}${reason ? ` (${reason})` : ""}`);
      }
    }
  }
  return { trees, problems };
}

function entries(model: Model): Entry[] {
  // A step runs in its actor: index the code of every component running there, and the entry's own directory.
  const code = (actor: string) => model.components.filter((component) => component.actors?.includes(actor)).flatMap((component) => component.footprint?.paths ?? []);
  return model.flows.flatMap((flow) =>
    flow.steps.flatMap((step, index): Entry[] => {
      if (!step.anchor) return [];
      const { file, symbol } = resolveAnchor(step.anchor);
      if (!symbol) return [];
      return [{ flow: flow.id, step: index, file, symbol, scope: [...new Set([...code(step.actor), `${dirname(file)}/`])].sort() }];
    }),
  );
}

/** Raw trees by entry symbol (one symbol can name several functions), and why entries were not found. */
function runTree(repository: string, symbols: string[], scope: string[]): { trees: Map<string, RawNode[]>; errors: Map<string, string> } {
  const request = JSON.stringify({ entries: symbols, paths: scope, maxDepth: MAX_DEPTH });
  // tree-sitter is a Node addon; run it in Node even when we run in Bun.
  const run = spawnSync("node", [WORKER], { cwd: repository, input: request, encoding: "utf8", maxBuffer: 1 << 28, timeout: 120_000 });
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

/**
 * Keep calls into the indexed code with their subtrees, and the rest as external
 * leaves, once per parent; lift the calls out of branches (`if`, `else`).
 */
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

/** Calls, with branch nodes replaced by the calls inside them. */
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
