import { loadSpec } from "./src/load.ts";
import { branches, apply, initialWorld, canonical, DEFAULT_BOUNDS } from "@feynman/check";
import { pendingInOrder } from "@feynman/spec";
const spec = await loadSpec(process.argv[2]);
const clamp = (w: any) => { let r = 0; const order = pendingInOrder(w); return canonical({ ...w, pending: order.map((p: any) => ({ ...p, at: p.at <= w.clock ? w.clock - 1e6 + (r++) : p.at })) }); };
let frontier = [initialWorld(spec, DEFAULT_BOUNDS)];
const seen = new Set([clamp(frontier[0])]);
for (let d = 0; d < 10; d++) {
  const next = [];
  for (const w of frontier) for (const c of branches(spec, w, false)) {
    const s = apply(spec, w, c, { explain: false });
    if (s.event.error) continue;
    const k = clamp(s.world); if (seen.has(k)) continue; seen.add(k); next.push(s.world);
  }
  frontier = next;
  console.log("depth", d + 1, "states", seen.size);
}
