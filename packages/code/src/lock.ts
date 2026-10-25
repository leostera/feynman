// feynman.lock: for every source a spec names, the hash of the code it stood for when
// the spec was last checked. A source is stale when that code has changed since.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSource, type ResolvedSource } from "./sources.ts";

export const LOCK_FILE = "feynman.lock";

export interface Lock {
  version: 1;
  sources: Record<string, string>;
}

export type SourceStatus =
  | { source: string; status: "fresh" | "new"; resolved: ResolvedSource }
  | { source: string; status: "stale"; resolved: ResolvedSource; was: string }
  | { source: string; status: "missing"; reason: string };

export function readLock(root: string): Lock {
  const path = join(root, LOCK_FILE);
  if (!existsSync(path)) return { version: 1, sources: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Lock>;
  return { version: 1, sources: parsed.sources ?? {} };
}

/** Each source resolved and compared with the lock. */
export function checkSources(root: string, sources: string[], lock = readLock(root)): SourceStatus[] {
  return [...new Set(sources)].sort().map((source): SourceStatus => {
    const resolution = resolveSource(root, source);
    if (!resolution.ok) return { source, status: "missing", reason: resolution.reason };
    const was = lock.sources[source];
    if (was === undefined) return { source, status: "new", resolved: resolution.resolved };
    return was === resolution.resolved.hash ? { source, status: "fresh", resolved: resolution.resolved } : { source, status: "stale", resolved: resolution.resolved, was };
  });
}

/** Record the current hash of every resolved source; sources no spec names any more are dropped. */
export function writeLock(root: string, statuses: SourceStatus[]): Lock {
  const sources: Record<string, string> = {};
  for (const status of statuses) if (status.status !== "missing") sources[status.source] = status.resolved.hash;
  const lock: Lock = { version: 1, sources };
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
