// A CPU profile (`bun --cpu-prof`) as a flame graph: an SVG anyone can open in a browser
// (hover a frame for its share), folded stacks for other tools (speedscope, inferno), and the
// heaviest functions by self and total time as text.
import { readFileSync, writeFileSync } from "node:fs";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

/** A frame in the merged call tree: its name, time spent in it and below it, and its callees. */
interface Frame {
  name: string;
  file: string;
  total: number;
  self: number;
  children: Map<string, Frame>;
}

export interface Flame {
  svg: string;
  folded: string;
  summary: string;
}

export function flame(path: string, title: string): Flame {
  const profile = JSON.parse(readFileSync(path, "utf8")) as Profile;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const time = new Map<number, number>();
  profile.samples.forEach((id, i) => time.set(id, (time.get(id) ?? 0) + Math.max(0, profile.timeDeltas[i] ?? 0)));

  const root: Frame = { name: title, file: "", total: 0, self: 0, children: new Map() };
  const folded: string[] = [];
  for (const [id, t] of time) {
    const stack: ProfileNode[] = [];
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) stack.unshift(byId.get(at)!);
    const frames = stack.map((n) => n.callFrame).filter((f) => f.functionName !== "(root)");
    if (!frames.length) continue;
    let at = root;
    at.total += t;
    for (const f of frames) {
      const name = label(f);
      let next = at.children.get(name);
      if (!next) at.children.set(name, (next = { name, file: fileOf(f.url), total: 0, self: 0, children: new Map() }));
      next.total += t;
      at = next;
    }
    at.self += t;
    folded.push(`${frames.map(label).join(";")} ${Math.round(t)}`);
  }
  return { svg: svgOf(root), folded: folded.join("\n") + "\n", summary: summaryOf(root) };
}

function label(f: ProfileNode["callFrame"]): string {
  const file = fileOf(f.url);
  return file ? `${f.functionName || "(anonymous)"} ${file}:${f.lineNumber + 1}` : f.functionName || "(anonymous)";
}

function fileOf(url: string): string {
  return url.split("/").slice(-2).join("/").replace(/^.*?(src|bench|examples|test)\//, "$1/");
}

/** The heaviest functions, by time in them and by time in them and below. */
function summaryOf(root: Frame): string {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const visit = (f: Frame, above: Set<string>) => {
    self.set(f.name, (self.get(f.name) ?? 0) + f.self);
    // Recursion counts once in a frame's total.
    if (!above.has(f.name)) total.set(f.name, (total.get(f.name) ?? 0) + f.total);
    const next = new Set(above).add(f.name);
    for (const c of f.children.values()) visit(c, next);
  };
  for (const c of root.children.values()) visit(c, new Set());
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, t]) => `${((t / root.total) * 100).toFixed(1).padStart(5)}%  ${name}`);
  return [`total ${(root.total / 1000).toFixed(0)} ms sampled`, "", "self:", ...top(self, 20), "", "total:", ...top(total, 30)].join("\n");
}

const WIDTH = 1600;
const ROW = 17;

/** The call tree as an icicle-free flame graph: roots at the bottom, width by total time. */
function svgOf(root: Frame): string {
  const rows: string[] = [];
  let depth = 0;
  const place = (f: Frame, x: number, level: number) => {
    const w = (f.total / root.total) * WIDTH;
    if (w < 0.3) return;
    depth = Math.max(depth, level);
    rows.push(rect(f, x, level, w, root.total));
    let cx = x;
    for (const c of [...f.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      place(c, cx, level + 1);
      cx += (c.total / root.total) * WIDTH;
    }
  };
  place(root, 0, 0);
  const height = (depth + 2) * ROW;
  const flip = (svg: string) => svg.replaceAll(/data-level="(\d+)" y="0"/g, (_, l) => `y="${height - (Number(l) + 1) * ROW}"`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" font-family="ui-monospace,Menlo,monospace" font-size="11">`,
    `<rect width="100%" height="100%" fill="#fafafa"/>`,
    flip(rows.join("\n")),
    `</svg>`,
  ].join("\n");
}

function rect(f: Frame, x: number, level: number, w: number, total: number): string {
  const share = ((f.total / total) * 100).toFixed(2);
  const text = w > 40 ? `<text x="${(x + 3).toFixed(1)}" data-level="${level}" y="0" dy="12">${escape(clip(f.name, w))}</text>` : "";
  return `<g><title>${escape(f.name)} — ${share}% (${(f.total / 1000).toFixed(1)} ms, self ${(f.self / 1000).toFixed(1)} ms)</title><rect x="${x.toFixed(1)}" data-level="${level}" y="0" width="${Math.max(0.3, w - 0.5).toFixed(1)}" height="${ROW - 1}" fill="${colour(f.file)}" rx="2"/>${text}</g>`;
}

function clip(text: string, width: number): string {
  const fits = Math.floor((width - 6) / 6.6);
  return text.length <= fits ? text : `${text.slice(0, Math.max(0, fits - 1))}…`;
}

/** Frames coloured by where they live: the search, the engine, the keys, JSON, the runtime. */
function colour(file: string): string {
  if (file.includes("check/keys") || file.includes("check/prints")) return "#f4a261";
  if (file.includes("check/")) return "#e76f51";
  if (file.includes("spec/json")) return "#e9c46a";
  if (file.includes("spec/")) return "#2a9d8f";
  if (file.includes("examples/")) return "#8ab17d";
  return "#b8c0c8";
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

if (import.meta.main) {
  const [path, out = path.replace(/\.cpuprofile$/, "")] = process.argv.slice(2);
  const f = flame(path, out.split("/").at(-1)!);
  writeFileSync(`${out}.svg`, f.svg);
  writeFileSync(`${out}.folded`, f.folded);
  console.log(f.summary);
}
