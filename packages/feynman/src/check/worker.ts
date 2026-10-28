// A checker worker thread: one owner of worlds (owner.ts), driven by the search's coordinator
// on the main thread. Each search starts with `init`, which loads the spec by its source.
import { Owner } from "./owner.ts";
import { loadSource } from "./pool.ts";

declare const self: Worker;
let owner: Owner | undefined;

type Method = "prepare" | "expand" | "query" | "close" | "resolve" | "stats";

self.onmessage = async (e: MessageEvent<{ id: number; method: "init" | Method; args: any[] }>) => {
  const { id, method, args } = e.data;
  try {
    if (method === "init") {
      owner = new Owner(await loadSource(args[0]), args[1]);
      self.postMessage({ id, result: null });
      return;
    }
    if (!owner) throw new Error(`${method} before init`);
    const result = (owner[method] as (...a: unknown[]) => unknown)(...args);
    self.postMessage({ id, result }, buffersOf(result));
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
};

/** The typed arrays' buffers in a result, moved rather than copied. */
function buffersOf(result: unknown): ArrayBuffer[] {
  if (!result || typeof result !== "object") return [];
  const out = new Set<ArrayBuffer>();
  for (const value of Object.values(result)) if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) out.add(value.buffer);
  return [...out];
}
