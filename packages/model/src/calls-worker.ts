// Run by measure in a Node process (tree-sitter is a Node addon): reads
// { entries, paths, maxDepth } on stdin, prints { trees, errors } on stdout.
// The calldiff CLI keeps only the last of repeated --entry flags, so the library is
// called directly: one index for every entry, or one run per entry when an entry is
// not found (which fails the whole batch).
import { readFileSync } from "node:fs";
import { runTree } from "calldiff";

interface Request {
  entries: string[];
  paths: string[];
  maxDepth: number;
}

const request: Request = JSON.parse(readFileSync(0, "utf8"));
const run = (entries: string[]) => runTree({ cwd: process.cwd(), entries, paths: request.paths, maxDepth: request.maxDepth, locs: true, color: false }).trees;

const trees: { entry: string; tree: unknown }[] = [];
const errors: Record<string, string> = {};
try {
  trees.push(...run(request.entries));
} catch {
  for (const entry of request.entries) {
    try {
      trees.push(...run([entry]));
    } catch (error) {
      errors[entry] = (error as Error).message;
    }
  }
}
process.stdout.write(JSON.stringify({ trees, errors }));
