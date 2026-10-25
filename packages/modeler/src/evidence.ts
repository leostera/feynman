// Which repository files the agent has read in full in this session.
//
// Only reading counts: a file is read when the agent's reads together cover every
// line of it (continuing past truncation with offsets as needed). Naming a file in
// a search or listing does not count. The agent is free to move between files in
// any order; files are recorded as read once they are covered.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "./paths.ts";

/** One read: 1-based `offset`, at most `limit` lines, and how many came back if truncated. */
export interface Read {
  offset?: number;
  limit?: number;
  /** Lines actually returned, when the runtime truncated the output. */
  returnedLines?: number;
}

export class Evidence {
  /** Covered line ranges per file, merged, inclusive. */
  private ranges = new Map<string, [number, number][]>();
  private lengths = new Map<string, number>();

  constructor(private readonly repository: string) {}

  /** Whether every line of `path` has been read. */
  has(path: string): boolean {
    const total = this.length(path);
    if (total === 0) return this.ranges.has(path);
    const covered = this.ranges.get(path) ?? [];
    return covered.length > 0 && covered[0][0] <= 1 && covered[0][1] >= total;
  }

  /** How much of `path` has been read, for messages: "120 of 480 lines". */
  progress(path: string): string {
    const covered = (this.ranges.get(path) ?? []).reduce((n, [a, b]) => n + b - a + 1, 0);
    return `${Math.min(covered, this.length(path))} of ${this.length(path)} lines`;
  }

  /** Files read in full so far. */
  files(): string[] {
    return [...this.ranges.keys()].filter((file) => this.has(file));
  }

  /** A read of `path` (relative to `cwd`); returns the repository path once the file is read in full. */
  read(cwd: string, path: string, read: Read = {}): string | null {
    const file = this.toRepository(cwd, path);
    if (!file) return null;
    const total = this.length(file);
    const start = Math.max(1, read.offset ?? 1);
    const span = Math.min(read.limit ?? Infinity, read.returnedLines ?? Infinity);
    const end = Math.min(total, span === Infinity ? total : start + span - 1);
    this.add(file, start, Math.max(start, end));
    return this.has(file) ? file : null;
  }

  private add(file: string, start: number, end: number) {
    const ranges = [...(this.ranges.get(file) ?? []), [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of ranges) {
      const last = merged.at(-1);
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    this.ranges.set(file, merged);
  }

  /** Lines in the file, ignoring a final newline; 0 for empty or unreadable files. */
  private length(file: string): number {
    let total = this.lengths.get(file);
    if (total === undefined) {
      try {
        const text = readFileSync(join(this.repository, file), "utf8");
        total = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
      } catch {
        total = 0;
      }
      this.lengths.set(file, total);
    }
    return total;
  }

  private toRepository(cwd: string, path: string): string | null {
    return within(this.repository, cwd, path);
  }
}
