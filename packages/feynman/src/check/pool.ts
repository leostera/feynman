// Owners behind one interface: the one on the main thread, called directly, and one per worker
// thread, called by message. A pool keeps worker threads for one search after another (checks
// at fewer faults, spec after spec), so they start once and stay warm.
import type { Spec } from "../spec/index.ts";
import type { Answer, Closed, Expansion, ExpandOrder, Owner, OwnerJob, Prepare, Prepared, Query, Resolved, StepRef, Stats } from "./owner.ts";

/** An owner, wherever it runs. */
export interface Driver {
  prepare(order: Prepare): Promise<Prepared>;
  expand(order: ExpandOrder): Promise<Expansion>;
  query(query: Query): Promise<Answer>;
  close(gids: number[]): Promise<Closed[]>;
  resolve(steps: StepRef[], worlds: boolean): Promise<Resolved[]>;
  stats(): Promise<Stats>;
}

/** The owner on the main thread. */
export class InlineDriver implements Driver {
  constructor(readonly owner: Owner) {}
  async prepare(order: Prepare) {
    return this.owner.prepare(order);
  }
  async expand(order: ExpandOrder) {
    return this.owner.expand(order);
  }
  async query(query: Query) {
    return this.owner.query(query);
  }
  async close(gids: number[]) {
    return this.owner.close(gids);
  }
  async resolve(steps: StepRef[], worlds: boolean) {
    return this.owner.resolve(steps, worlds);
  }
  async stats() {
    return this.owner.stats();
  }
}

/**
 * Where a worker finds the spec: a module, the export that is the spec (`default` unless
 * named), and, when checking only some properties, which.
 */
export interface SpecSource {
  module: string;
  export?: string;
  properties?: string[];
  /** The rules turned off: the variant of the design without them (RFD0010). */
  without?: string[];
  /** Model variables started at other values (`--set`, RFD0012). */
  set?: Record<string, unknown>;
}

/** The spec a source names, loaded as a worker does. */
export async function loadSource(source: SpecSource): Promise<Spec> {
  const module = (await import(source.module)) as Record<string, unknown>;
  const spec = module[source.export ?? "default"] as Spec | undefined;
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.actors)) throw new Error(`${source.module} does not export a spec as ${source.export ?? "default"}`);
  const set = source.set && Object.keys(source.set).length ? spec.setting(source.set) : spec;
  const variant = source.without?.length ? set.withoutRules(source.without) : set;
  return source.properties ? { ...variant, properties: variant.properties.filter((p) => source.properties!.includes(p.id)) } : variant;
}

/** Worker threads, started when first needed and kept until closed. One search uses a pool at a time. */
export class Pool {
  private readonly threads: Thread[] = [];

  constructor(readonly size: number) {}

  /** Owners for one search, one per thread, each loading the spec. */
  async owners(source: SpecSource, job: OwnerJob): Promise<Driver[]> {
    while (this.threads.length < this.size) this.threads.push(new Thread());
    await Promise.all(this.threads.map((t) => t.call("init", [source, job])));
    return this.threads.map((t) => t.driver());
  }

  close(): void {
    for (const t of this.threads.splice(0)) t.terminate();
  }
}

/** A worker thread, called one message at a time, in order. */
class Thread {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  private readonly waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private next = 0;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const call = this.waiting.get(e.data.id)!;
      this.waiting.delete(e.data.id);
      if (e.data.error !== undefined) call.reject(new Error(`a checker worker failed: ${e.data.error}`));
      else call.resolve(e.data.result);
    };
    this.worker.onerror = (e) => {
      for (const call of this.waiting.values()) call.reject(new Error(`a checker worker crashed: ${e.message}`));
      this.waiting.clear();
    };
  }

  call<T>(method: string, args: unknown[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  driver(): Driver {
    return {
      prepare: (order) => this.call("prepare", [order]),
      expand: (order) => this.call("expand", [order]),
      query: (query) => this.call("query", [query]),
      close: (gids) => this.call("close", [gids]),
      resolve: (steps, worlds) => this.call("resolve", [steps, worlds]),
      stats: () => this.call("stats", []),
    };
  }

  terminate(): void {
    this.worker.terminate();
  }
}
