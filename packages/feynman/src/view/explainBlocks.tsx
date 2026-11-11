// The explain kit's block diagrams: boxes, groups of boxes, and arrows between them, laid out by
// ELK as the playground's topology is. The agent says what is connected to what; the layout
// is not its to draw, so diagrams stay legible however many boxes there are.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import { cn } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { fill, stroke, type Tone } from "./explainCharts";
import { pathOf } from "./layout";
import { useView } from "./playground/Stage";

export interface Block {
  id: string;
  title: string;
  sub?: string;
  tone?: Tone;
  dashed?: boolean;
  /** Lines of code or steps inside the box, in monospace: routes, tables, a numbered list. */
  lines?: string[];
  /** A step number, drawn as ①. */
  step?: number;
  /** The diagram's centre of attention: a bigger title. */
  big?: boolean;
  /** A group: these boxes inside it, laid out on their own. */
  children?: Block[];
  /** Small capitals under the box: "PER REPOSITORY". */
  note?: string;
}

export type Edge = [string, string] | { from: string; to: string; dashed?: boolean; label?: string };

const elk = new ELK();
const CIRCLED = "⓪①②③④⑤⑥⑦⑧⑨⑩";
const NOTE_H = 20;
const GROUP_TITLE_H = 34;

let ruler: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler) return text.length * 7;
  ruler.font = font;
  return ruler.measureText(text).width;
}

const FONT = getComputedStyle(document.documentElement).fontFamily || "system-ui";
function titleOf(b: Block): string {
  return b.step !== undefined ? `${CIRCLED[b.step] ?? b.step} ${b.title}` : b.title;
}
function boxSize(b: Block): { w: number; h: number } {
  const title = textWidth(titleOf(b), `600 ${b.big ? 17 : 13.5}px ${FONT}`);
  const sub = b.sub ? textWidth(b.sub, `11px ${FONT}`) : 0;
  const lines = Math.max(0, ...(b.lines ?? []).map((l) => textWidth(l, `11px ui-monospace, monospace`)));
  const w = Math.max(110, title, sub, lines) + 28;
  const h = (b.big ? 30 : 24) + (b.sub ? 15 : 0) + (b.lines?.length ?? 0) * 16 + 14;
  return { w: Math.ceil(w), h: Math.ceil(h) };
}

/**
 * A group whose boxes are a chain (each one leading to the next) flows as the diagram does.
 * Any other group is a set of parts: packed in rows, in the order given, as one box to ELK.
 */
function flows(b: Block, internal: Map<string, number>): boolean {
  return (b.children?.length ?? 0) > 1 && (internal.get(b.id) ?? 0) >= b.children!.length - 1;
}

const PAD = 18;
const GAP = 14;

/** The parts of a packed group, placed in rows, relative to the group's corner. */
function pack(b: Block): { w: number; h: number; at: Map<string, { x: number; y: number; w: number; h: number }> } {
  const kids = b.children!;
  const columns = Math.min(kids.length, kids.length === 4 ? 2 : 3);
  const sizes = kids.map((c) => {
    const { w, h } = boxSize(c);
    return { w, h: h + (c.note ? NOTE_H : 0) };
  });
  const cell = Math.max(...sizes.map((z) => z.w));
  const at = new Map<string, { x: number; y: number; w: number; h: number }>();
  let y = GROUP_TITLE_H + 6;
  for (let row = 0; row * columns < kids.length; row++) {
    const cells = kids.slice(row * columns, (row + 1) * columns);
    const height = Math.max(...cells.map((_, i) => sizes[row * columns + i]!.h));
    // A short last row is spread across the width, as the rows above it are.
    const width = (columns * cell + (columns - 1) * GAP - (cells.length - 1) * GAP) / cells.length;
    cells.forEach((c, i) => at.set(c.id, { x: PAD + i * (width + GAP), y, w: width, h: height }));
    y += height + GAP;
  }
  return { w: PAD * 2 + columns * cell + (columns - 1) * GAP, h: y - GAP + PAD, at };
}

function elkNode(b: Block, direction: "RIGHT" | "DOWN", internal: Map<string, number>): ElkNode {
  if (b.children?.length && flows(b, internal)) {
    return {
      id: b.id,
      layoutOptions: {
        "elk.padding": `[top=${GROUP_TITLE_H + 6},left=${PAD},bottom=${PAD},right=${PAD}]`,
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.spacing.nodeNode": "16",
        "elk.layered.spacing.nodeNodeBetweenLayers": "28",
      },
      children: b.children.map((c) => elkNode(c, direction, internal)),
    };
  }
  if (b.children?.length) {
    const { w, h } = pack(b);
    return { id: b.id, width: w, height: h };
  }
  const { w, h } = boxSize(b);
  return { id: b.id, width: w, height: h + (b.note ? NOTE_H : 0) };
}

interface Placed {
  block: Block;
  x: number;
  y: number;
  w: number;
  h: number;
  group: boolean;
}
interface Laid {
  width: number;
  height: number;
  boxes: Placed[];
  edges: { path: string; dashed: boolean; label?: { text: string; x: number; y: number } }[];
}

/** Laid out as asked, unless that would have to shrink a lot to fit: then wrapped into rows. */
async function layout(blocks: Block[], edges: Edge[], direction: "RIGHT" | "DOWN", width: number): Promise<Laid> {
  const straight = await layoutOnce(blocks, edges, direction, false, true).catch(() => layoutOnce(blocks, edges, direction, false, false));
  if (!width || straight.width <= width / 0.8) return straight;
  const wrapped = await layoutOnce(blocks, edges, direction, true, true).catch(() => straight);
  return Math.min(1, width / wrapped.width) > Math.min(1, width / straight.width) ? wrapped : straight;
}

async function layoutOnce(blocks: Block[], edges: Edge[], direction: "RIGHT" | "DOWN", wrap: boolean, ordered: boolean): Promise<Laid> {
  const all = new Map<string, Block>();
  const walk = (b: Block) => (all.set(b.id, b), b.children?.forEach(walk));
  blocks.forEach(walk);
  const normal = edges.map((e, i) => (Array.isArray(e) ? { from: e[0], to: e[1], id: `e${i}` } : { ...e, id: `e${i}` }));
  for (const e of normal) for (const end of [e.from, e.to]) if (!all.has(end)) throw new Error(`An arrow names "${end}", which is no box of this diagram`);
  // Which group each box is directly in, and how many arrows stay inside each group.
  const parent = new Map<string, string>();
  const note = (b: Block) => b.children?.forEach((c) => (parent.set(c.id, b.id), note(c)));
  blocks.forEach(note);
  const internal = new Map<string, number>();
  for (const e of normal) {
    const p = parent.get(e.from);
    if (p && p === parent.get(e.to)) internal.set(p, (internal.get(p) ?? 0) + 1);
  }
  // Arrows to a part of a packed group are, to ELK, arrows to the group; arrows inside one are drawn here.
  const packedIn = (id: string): string | null => {
    const p = parent.get(id);
    if (!p) return null;
    return flows(all.get(p)!, internal) ? packedIn(p) : (packedIn(p) ?? p);
  };
  const elkEnd = (id: string) => packedIn(id) ?? id;
  const inside = normal.filter((e) => packedIn(e.from) !== null && packedIn(e.from) === packedIn(e.to));
  const across = normal.filter((e) => !inside.includes(e));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "22",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeRouting": "POLYLINE",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.padding": "[top=8,left=8,bottom=8,right=8]",
      // The order boxes are given in is the order they are read in.
      ...(ordered ? { "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.layered.crossingMinimization.forceNodeModelOrder": "true" } : {}),
      ...(wrap ? { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": "1.3", "elk.layered.wrapping.additionalEdgeSpacing": "16" } : {}),
    },
    children: blocks.map((b) => elkNode(b, direction, internal)),
    edges: across.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [elkEnd(e.from)],
        targets: [elkEnd(e.to)],
        labels: "label" in e && e.label ? [{ text: e.label, width: textWidth(e.label, `11px ${FONT}`) + 8, height: 16 }] : [],
      }),
    ),
  };
  const out = await elk.layout(graph);
  const boxes: Placed[] = [];
  const placePacked = (block: Block, x: number, y: number) => {
    for (const [id, cell] of pack(block).at) {
      const child = all.get(id)!;
      boxes.push({ block: child, x: x + cell.x, y: y + cell.y, w: cell.w, h: cell.h, group: false });
    }
  };
  const collect = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      const block = all.get(c.id)!;
      boxes.push({ block, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0, group: Boolean(block.children?.length) });
      if (block.children?.length && !c.children?.length) placePacked(block, c.x ?? 0, c.y ?? 0);
      collect(c);
    }
  };
  collect(out);
  // Arrows inside a packed group: straight, from box edge to box edge.
  const placed = new Map(boxes.map((b) => [b.block.id, b]));
  const rim = (b: Placed, towards: { x: number; y: number }) => {
    const c = { x: b.x + b.w / 2, y: b.y + (b.h - (b.block.note ? NOTE_H : 0)) / 2 };
    const dx = towards.x - c.x;
    const dy = towards.y - c.y;
    const h = (b.h - (b.block.note ? NOTE_H : 0)) / 2;
    const t = Math.min(Math.abs(dx) ? b.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) ? h / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  };
  const straightEdges = inside.map((e) => {
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    const p = rim(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const q = rim(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
    return { path: `M${p.x},${p.y} L${q.x},${q.y}`, dashed: "dashed" in e && Boolean(e.dashed), label: undefined };
  });
  const laidEdges = (out.edges ?? []).flatMap((e) => {
    const source = normal.find((n) => n.id === e.id)!;
    return (e.sections ?? []).map((s) => {
      const label = e.labels?.[0];
      return {
        path: pathOf([s.startPoint, ...(s.bendPoints ?? []), s.endPoint]),
        dashed: "dashed" in source && Boolean(source.dashed),
        label: label?.text ? { text: label.text, x: (label.x ?? 0) + (label.width ?? 0) / 2, y: (label.y ?? 0) + (label.height ?? 0) / 2 } : undefined,
      };
    });
  });
  return { width: out.width ?? 0, height: out.height ?? 0, boxes, edges: [...laidEdges, ...straightEdges] };
}

/**
 * Boxes in the rows the author gives, each row spread across the width, and arrows between
 * them: straight within a row, an elbow between rows. A group in a row is drawn around its
 * parts, side by side when they are a chain, packed in rows otherwise.
 */
function rowsLayout(blocks: Block[], edges: Edge[], rows: string[][]): Laid {
  const all = new Map<string, Block>();
  const walk = (b: Block) => (all.set(b.id, b), b.children?.forEach(walk));
  blocks.forEach(walk);
  const normal = edges.map((e) => (Array.isArray(e) ? { from: e[0], to: e[1] } : e));
  const missing = rows.flat().find((id) => !blocks.some((b) => b.id === id));
  if (missing) throw new Error(`rows names "${missing}", which is no top-level box of this diagram`);
  const ROW_GAP = 46;
  const COL_GAP = 40;
  // The size of each top-level box, and where a group's parts sit inside it.
  const sized = new Map<string, { w: number; h: number; parts?: Map<string, { x: number; y: number; w: number; h: number }> }>();
  for (const id of rows.flat()) {
    const b = all.get(id)!;
    if (!b.children?.length) {
      const { w, h } = boxSize(b);
      sized.set(id, { w, h: h + (b.note ? NOTE_H : 0) });
      continue;
    }
    const chain = normal.filter((e) => b.children!.some((c) => c.id === e.from) && b.children!.some((c) => c.id === e.to)).length >= b.children.length - 1;
    if (!chain) {
      const packed = pack(b);
      sized.set(id, { w: packed.w, h: packed.h, parts: packed.at });
      continue;
    }
    const parts = new Map<string, { x: number; y: number; w: number; h: number }>();
    let x = PAD;
    const height = Math.max(...b.children.map((c) => boxSize(c).h));
    for (const c of b.children) {
      const { w } = boxSize(c);
      parts.set(c.id, { x, y: GROUP_TITLE_H + 6, w, h: height });
      x += w + 28;
    }
    sized.set(id, { w: x - 28 + PAD, h: GROUP_TITLE_H + 6 + height + PAD, parts });
  }
  const rowWidth = (row: string[]) => row.reduce((sum, id) => sum + sized.get(id)!.w, 0) + (row.length - 1) * COL_GAP;
  const width = Math.max(...rows.map(rowWidth)) + 16;
  const boxes: Placed[] = [];
  let y = 8;
  for (const row of rows) {
    const height = Math.max(...row.map((id) => sized.get(id)!.h));
    // Spread across the width: the first box at the left edge, the last at the right.
    const free = width - 16 - rowWidth(row);
    const gap = row.length > 1 ? COL_GAP + free / (row.length - 1) : 0;
    let x = row.length > 1 ? 8 : (width - sized.get(row[0]!)!.w) / 2;
    for (const id of row) {
      const size = sized.get(id)!;
      const block = all.get(id)!;
      boxes.push({ block, x, y: y + (height - size.h) / 2, w: size.w, h: size.h, group: Boolean(block.children?.length) });
      for (const [child, part] of size.parts ?? []) boxes.push({ block: all.get(child)!, x: x + part.x, y: y + (height - size.h) / 2 + part.y, w: part.w, h: part.h, group: false });
      x += size.w + gap;
    }
    y += height + ROW_GAP;
  }
  const placed = new Map(boxes.map((b) => [b.block.id, b]));
  const body = (b: Placed) => ({ x: b.x, y: b.y, w: b.w, h: b.h - (b.block.note ? NOTE_H : 0) });
  const laidEdges = normal.map((e) => {
    const a = body(placed.get(e.from)!);
    const b = body(placed.get(e.to)!);
    const dashed = "dashed" in e && Boolean(e.dashed);
    const label = "label" in e && e.label ? e.label : undefined;
    // Side by side: straight across, at the middle of where they overlap.
    if (b.y < a.y + a.h && a.y < b.y + b.h) {
      const top = Math.max(a.y, b.y);
      const mid = (top + Math.min(a.y + a.h, b.y + b.h)) / 2;
      const [from, to] = a.x < b.x ? [a.x + a.w, b.x] : [a.x, b.x + b.w];
      return { path: `M${from},${mid} L${to},${mid}`, dashed, label: label ? { text: label, x: (from + to) / 2, y: mid - 10 } : undefined };
    }
    // From one row to another: down from under the first, then across, then down to the second.
    const down = b.y > a.y;
    const sx = Math.min(Math.max(b.x + b.w / 2, a.x + 24), a.x + a.w - 24);
    const tx = Math.min(Math.max(sx, b.x + 24), b.x + b.w - 24);
    const sy = down ? a.y + a.h : a.y;
    const ty = down ? b.y : b.y + b.h;
    const my = (sy + ty) / 2;
    const path = sx === tx ? `M${sx},${sy} L${tx},${ty}` : `M${sx},${sy} L${sx},${my} L${tx},${my} L${tx},${ty}`;
    return { path, dashed, label: label ? { text: label, x: (sx + tx) / 2, y: my } : undefined };
  });
  return { width, height: y - ROW_GAP + 8, boxes, edges: laidEdges };
}

/** Boxes and arrows, laid out left to right (or top down) by ELK, or in the rows given; fitted to the column. */
export function Blocks({ blocks, edges = [], direction = "right", rows }: { blocks: Block[]; edges?: Edge[]; direction?: "right" | "down"; rows?: string[][] }) {
  const [laid, setLaid] = useState<Laid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ref, view } = useView();
  // Whole widths, rounded: a resize of a few pixels does not lay the diagram out again.
  const width = Math.round(view.w / 40) * 40;
  const key = JSON.stringify([blocks, edges, direction, rows, width]);
  useEffect(() => {
    if (!width) return;
    let live = true;
    (rows ? Promise.resolve().then(() => rowsLayout(blocks, edges, rows)) : layout(blocks, edges, direction === "down" ? "DOWN" : "RIGHT", width)).then((l) => live && setLaid(l), (e) => live && setError(String(e)));
    return () => void (live = false);
    // `key` is the diagram's content and room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (error) return <p className="text-sm text-kumo-danger">{error}</p>;
  const scale = laid && view.w ? Math.min(1, view.w / laid.width) : 1;
  return (
    <div ref={ref} className="w-full">
      {laid && (
        <div className="relative mx-auto" style={{ width: laid.width * scale, height: laid.height * scale }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ width: laid.width, height: laid.height, transform: `scale(${scale})` }}>
            {laid.boxes.filter((b) => b.group).map((b) => <BlockBox key={b.block.id} placed={b} />)}
            <svg width={laid.width} height={laid.height} className="absolute inset-0 overflow-visible" aria-hidden>
              <defs>
                <marker id="blocks-head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--explain-arrow)" />
                </marker>
              </defs>
              {laid.edges.map((e, i) => (
                <path key={i} d={e.path} fill="none" stroke="var(--explain-arrow)" strokeWidth={1.5} strokeDasharray={e.dashed ? "5 4" : undefined} markerEnd="url(#blocks-head)" />
              ))}
            </svg>
            {laid.boxes.filter((b) => !b.group).map((b) => <BlockBox key={b.block.id} placed={b} />)}
            {laid.edges.map((e, i) =>
              e.label ? (
                <span key={i} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-kumo-base px-1 text-[11px] text-kumo-subtle" style={{ left: e.label.x, top: e.label.y }}>
                  {e.label.text}
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BlockBox({ placed }: { placed: Placed }) {
  const { block: b, x, y, w, h, group } = placed;
  const tone = b.tone ?? "grey";
  const border = `1.5px ${b.dashed ? "dashed" : "solid"} ${stroke(tone)}`;
  if (group) {
    return (
      <div className="absolute rounded-2xl" style={{ left: x, top: y, width: w, height: h, border, background: fill(tone, 7) }}>
        <div className="px-4 pt-2.5 text-[15px] font-semibold">{titleOf(b)}{b.sub && <span className="ml-2 text-xs font-normal text-kumo-subtle">{b.sub}</span>}</div>
      </div>
    );
  }
  const boxH = h - (b.note ? NOTE_H : 0);
  return (
    <div className="absolute" style={{ left: x, top: y, width: w }}>
      <div className={cn("flex flex-col items-center justify-center rounded-xl px-3 text-center")} style={{ height: boxH, border, background: b.dashed ? "var(--color-kumo-base)" : fill(tone) }}>
        <div className={cn("font-semibold leading-tight", b.big ? "text-[17px]" : "text-[13.5px]")}>{titleOf(b)}</div>
        {b.sub && <div className="mt-0.5 text-[11px] leading-tight text-kumo-subtle">{b.sub}</div>}
        {b.lines && (
          <div className="mt-1 flex flex-col font-mono text-[11px] leading-4">
            {b.lines.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        )}
      </div>
      {b.note && <div className="pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-kumo-subtle">{b.note}</div>}
    </div>
  );
}
