// The one place that says whether a build may start: one build at a time across the whole
// service, and a daily budget of builds. A single instance (GATE_NAME) holds both, so the
// checks are atomic: a Durable Object runs one request's synchronous code at a time.
import { DurableObject } from "cloudflare:workers";
import type { ShareEnv } from "./env.ts";

export const GATE_NAME = "global";

/** How many builds may run at once. */
export const CONCURRENT_BUILDS = 1;
/** How many builds may start in a UTC day. */
export const DAILY_BUILDS = 200;
/** A lease older than this is a build that never released it (its container died): it lapses. */
const LEASE_MS = 15 * 60 * 1_000;
/** What a refused build is told to wait while another runs. */
const BUSY_RETRY_S = 30;

interface Lease {
  readonly job: string;
  readonly since: number;
}

interface Budget {
  /** UTC day, `2026-10-28`. */
  readonly day: string;
  readonly started: number;
}

export type GateDecision =
  | { ok: true }
  | { ok: false; reason: "busy" | "budget"; retryAfterSeconds: number };

export class ShareGate extends DurableObject<ShareEnv> {
  /** A slot for `job`, or why not. The same job asking again (a retried call) keeps its slot. */
  acquire(job: string): GateDecision {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    const leases = this.#live(now).filter((lease) => lease.job !== job);
    if (leases.length >= CONCURRENT_BUILDS) return { ok: false, reason: "busy", retryAfterSeconds: BUSY_RETRY_S };
    const day = utcDay(now);
    const budget = kv.get<Budget>("budget");
    const started = budget?.day === day ? budget.started : 0;
    if (started >= DAILY_BUILDS) return { ok: false, reason: "budget", retryAfterSeconds: secondsToNextUtcDay(now) };
    kv.put<Budget>("budget", { day, started: started + 1 });
    kv.put<Lease[]>("leases", [...leases, { job, since: now }]);
    return { ok: true };
  }

  release(job: string): void {
    this.ctx.storage.kv.put<Lease[]>("leases", this.#live(Date.now()).filter((lease) => lease.job !== job));
  }

  #live(now: number): Lease[] {
    return (this.ctx.storage.kv.get<Lease[]>("leases") ?? []).filter((lease) => now - lease.since < LEASE_MS);
  }
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsToNextUtcDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.ceil((next.getTime() - now) / 1_000);
}
