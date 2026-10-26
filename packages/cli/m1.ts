import { loadSpec } from "./src/load.ts";
import { branches, apply, initialWorld, canonical, DEFAULT_BOUNDS } from "@feynman/check";
const spec = await loadSpec(process.argv[2]);
// plain BFS with stats, depth 9, no faults; count generated edges, new states, and states modulo time
let frontier = [initialWorld(spec, DEFAULT_BOUNDS)];
const seen = new Set([canonical(frontier[0])]);
const untimed = new Set<string>();
const strip = (w: any) => canonical({ ...w, pending: w.pending.map((p: any) => ({ ...p, at: 0 })), clock: 0 });
let edges = 0, kinds: Record<string, number> = {};
for (let d = 0; d < 9; d++) {
  const next = [];
  for (const w of frontier) for (const c of branches(spec, w, false)) {
    edges++; kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    const s = apply(spec, w, c, { explain: false });
    if (s.event.error) continue;
    const k = canonical(s.world); if (seen.has(k)) continue; seen.add(k); untimed.add(strip(s.world)); next.push(s.world);
  }
  frontier = next;
  console.log("depth", d + 1, "states", seen.size, "untimed", untimed.size, "edges", edges, JSON.stringify(kinds));
}
