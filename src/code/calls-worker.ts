// Run in a Node process (tree-sitter is a Node addon): reads { entries, paths, maxDepth }
// on stdin, prints { trees, errors } on stdout. The calldiff CLI keeps only the last of
// repeated --entry flags, so the library is called directly: one index for every entry,
// or one run per entry when an entry is not found (which fails the whole batch).
//
// calldiff places a call where it is made (the line in its caller); to show a callee's own code,
// each call is also given where its function is defined (`def`), from an index of every function
// in the same paths, built the way calldiff builds its own.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, extractFunctions, runTree, type FunctionInfo } from "calldiff";

interface Request {
  entries: string[];
  paths: string[];
  maxDepth: number;
}

interface Node {
  key?: string;
  label: string;
  file?: string;
  line?: number;
  children?: Node[];
  def?: { file: string; line: number; endLine: number };
}

const request: Request = JSON.parse(readFileSync(0, "utf8"));
const cwd = process.cwd();
const run = (entries: string[]) => runTree({ cwd, entries, paths: request.paths, maxDepth: request.maxDepth, locs: true, color: false }).trees;

const trees: { entry: string; tree: Node }[] = [];
const errors: Record<string, string> = {};
try {
  trees.push(...(run(request.entries) as { entry: string; tree: Node }[]));
} catch {
  for (const entry of request.entries) {
    try {
      trees.push(...(run([entry]) as { entry: string; tree: Node }[]));
    } catch (error) {
      errors[entry] = (error as Error).message;
    }
  }
}

/** Every function defined in the requested paths, by calldiff's key ("foo", "Class.method"). */
function definitions(): Map<string, FunctionInfo> {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...request.paths.map((p) => (p === "./" ? "." : p))], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const functions: FunctionInfo[] = [];
  for (const path of listed.split("\n").filter(Boolean)) {
    try {
      if (!statSync(join(cwd, path)).isFile()) continue;
      functions.push(...extractFunctions(path, readFileSync(join(cwd, path), "utf8")));
    } catch {
      // A file that does not parse defines nothing we can show.
    }
  }
  return buildIndex(functions);
}

if (trees.length) {
  const index = definitions();
  const annotate = (node: Node) => {
    const fn = node.key ? index.get(node.key) : undefined;
    if (fn?.line && fn.endLine) node.def = { file: fn.file, line: fn.line, endLine: fn.endLine };
    node.children?.forEach(annotate);
  };
  for (const { tree } of trees) tree.children?.forEach(annotate);
}

process.stdout.write(JSON.stringify({ trees, errors }));
