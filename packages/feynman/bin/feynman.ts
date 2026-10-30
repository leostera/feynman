#!/usr/bin/env bun
import { dirname } from "node:path";
import { main } from "../src/cli/main.ts";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(crashed(error) ? crashReport(error as Error) : error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

/**
 * A crash inside Feynman itself, rather than an error it reports on purpose: JavaScript's own
 * errors (a TypeError, a JSON SyntaxError…) thrown from Feynman's source. Its message alone
 * says nothing useful, so the report adds where it happened and where to send it.
 */
function crashed(error: unknown): boolean {
  const own = [TypeError, RangeError, ReferenceError, SyntaxError];
  if (!(error instanceof Error) || !own.some((type) => error instanceof type)) return false;
  // The first frame in a file: JSON.parse and friends leave native frames above it.
  const first = error.stack?.split("\n").find((line) => line.trim().startsWith("at ") && line.includes("/"));
  return first?.includes(dirname(import.meta.dir)) ?? false;
}

function crashReport(error: Error): string {
  const frames = (error.stack ?? "").split("\n").filter((line) => line.trim().startsWith("at ")).slice(0, 8);
  return [
    `feynman crashed: ${error.name}: ${error.message}`,
    ...frames,
    "This is a bug in Feynman, not in your spec. Please report it with the command you ran and the spec:",
    "https://github.com/leostera/feynman/issues",
  ].join("\n");
}
