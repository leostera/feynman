// The search's memory guard. A search that outgrows the machine is killed by the system
// (SIGKILL, exit 137) and reports nothing; stopping at a limit keeps every verdict found so far.
import { totalmem } from "node:os";

/** The default memory limit, in megabytes: 50% of the machine's memory. */
export function defaultMemoryLimit(): number {
  return Math.floor((totalmem() / 2 ** 20) * 0.5);
}

/** How often, in new states, the search looks at its memory: reading it costs a system call. */
export const MEMORY_EVERY = 4096;

/** Whether this process (all its threads) holds more than `limit` megabytes. */
export function overMemory(limit: number): boolean {
  return process.memoryUsage.rss() > limit * 2 ** 20;
}
