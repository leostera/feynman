// The stage: the scene's zones (the service's as a tinted region, the others as captioned
// columns), one node per scene node, the live links they hold, messages travelling between
// them, panels beside nodes, and a speech bubble for what just happened. Colour follows
// people: whose a node is shows as a small initial in their colour, and its links carry it.
// Rings show only how a node is doing: grey until something is connected, busy or broken.
import { cn } from "@cloudflare/kumo";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { declaresLinks, labelled, worldView, type Actor, type Event, type InstanceState, type Pending, type Spec, type Token, type World } from "../../spec/index.ts";
import { identityColors, moodColor, Node, PlayProvider, Rows, telling, Ticket, toneColor, type GroupProps, type NodeProps, type Playground } from "../../play/index.ts";
import { isLoss, labelOf, messageName, messageTone, short } from "../format";
import { layout, layoutKey, nodeLinks, type Anchor, type Box, type Layout, type Layouts, type Sizes, type View, type ZoneBox } from "../layout";
import { nodeDisplay, sceneLinks, shownAs, type NodeDisplay, type Scene, type SceneNode } from "../scene";
import { useExplorer } from "../ui";

export interface Bubble {
  key: string;
  instance: string;
  text: string;
  tone: "action" | "message" | "bad" | "quiet";
}

/** A token being carried, by dragging it or by picking it up: which nodes would take it. */
export interface Dragging {
  /** The instance holding it, and the node it is drawn on. */
  from: string;
  fromNode: string;
  token: Token;
  /** Node ids that would take it. */
  targets: Set<string>;
  /** Picked up with a click or the keyboard, rather than held under the pointer. */
  carried: boolean;
}

export interface Fit {
  scale: number;
  x: number;
  y: number;
}

/** A node being chosen as an action's input: clicking a target runs the action with its value. */
export interface Picking {
  targets: Map<string, unknown>;
}

/** The size of the canvas, which the layout fills. */
export function useView() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setView({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, view };
}

/** Sizes a playground file gives its custom nodes, by node id. */
export function sizesOf(playground: Playground | null, scene: Scene): Sizes {
  const sizes: Sizes = new Map();
  if (!playground) return sizes;
  for (const node of scene.nodes) {
    const size = node.group ? playground.group[node.group.name]?.size : playground.actor[node.members[0].actor]?.size;
    if (size) sizes.set(node.id, size);
  }
  return sizes;
}

/** The scene laid out both ways (`Layouts`), recomputed when its nodes, their sizes or the canvas change. */
export function useLayout(spec: Spec, world: World, scene: Scene, view: View, sizes: Sizes): Layouts | null {
  const key = layoutKey(spec, world, scene, view, sizes);
  const [state, setState] = useState<{ key: string; layout: Layouts } | null>(null);
  const latest = useRef({ world, scene, view, sizes });
  latest.current = { world, scene, view, sizes };
  useEffect(() => {
    if (!latest.current.view.w) return;
    let live = true;
    const { world, scene, view, sizes } = latest.current;
    layout(spec, world, scene, view, sizes).then((l) => live && setState({ key, layout: l }));
    return () => {
      live = false;
    };
  }, [key, spec]);
  return state?.layout ?? null;
}

/** The layout already fills the canvas; scale down only when it could not fit. */
/** The part of the canvas that floating controls leave free: where the diagram is fitted. */
export interface Free {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The diagram scaled down (never up) to fit the free area, and centred in it. */
export function fitOf(graph: Layout | null, free: Free): Fit {
  if (!graph || free.w <= 0 || free.h <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(1, free.w / graph.width, free.h / graph.height);
  return { scale, x: free.x + (free.w - graph.width * scale) / 2, y: free.y + (free.h - graph.height * scale) / 2 };
}

export interface StageProps {
  world: World;
  scene: Scene;
  graph: Layout;
  fit: Fit;
  /** The message landing on screen, if an event is being played in. */
  flight: Flight | null;
  live: boolean;
  focus: { event: Event; index: number } | null;
  bubble: (Bubble & { fading: boolean }) | null;
  next: number | null;
  /** The node to try first, breathing. */
  pulse: string | null;
  selected: string | null;
  picking: Picking | null;
  dragging: Dragging | null;
  /** Tokens already handed over, by `kind\0value`: they are gone from their holder. */
  spent: Set<string>;
  onSelect: (node: string | null) => void;
  onPick: (node: string) => void;
  onToken: (from: string, fromNode: string, token: Token, e: ReactPointerEvent | null) => void;
  onDrop: (target: string) => void;
  onPacket: (pending: Extract<Pending, { kind: "deliver" }>) => void;
  /** Run an action of an instance, from a custom render. */
  onAct: (instance: string, key: string, inputs: Record<string, unknown>) => void;
  /** What the action bar shows over the selected node. */
  bar: ReactNode;
  /** The bar is a menu, one action per row: it opens beside the node rather than above it. */
  barStacked?: boolean;
}

export function Stage(props: StageProps) {
  const { world, scene, graph, fit, flight, live, focus, bubble, next, dragging, selected } = props;
  const { spec, playground } = useExplorer();
  const colors = identityColors(spec, world);
  const colorOf = (ref: string | null | undefined) => {
    const instance = ref ? world.instances.find((i) => i.id === ref || i.label === ref) : undefined;
    return instance ? colors.get(instance.id) : undefined;
  };
  const links = sceneLinks(spec, world, scene);
  const changed = new Set((focus?.event.changes ?? []).map((c) => scene.of.get(c.instance)));
  const humming = new Set(world.pending.filter((p) => p.kind === "deliver" && scene.of.get(p.from) === scene.of.get(p.to) && scene.nodes.find((n) => n.id === scene.of.get(p.to))?.group).map((p) => scene.of.get(p.to)));
  const { ref, rows } = useRowAnchors(fit.scale, `${layoutKey(spec, world, scene, { w: graph.width, h: graph.height }, new Map())}`);
  const selectedBox = selected ? graph.nodes.get(selected) : undefined;
  return (
    <PlayProvider value={{ colorOf }}>
      <div ref={ref} className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`, width: graph.width, height: graph.height }}>
        <svg width={graph.width} height={graph.height} className="absolute inset-0 overflow-visible" aria-hidden>
          {graph.zones.map((z, i) => (
            <Zone key={z.name} zone={z} side={graph.orientation === "vertical" ? "middle" : i === 0 ? "first" : i === graph.zones.length - 1 ? "last" : "middle"} width={graph.width} description={spec.zones.find((x) => x.name === z.name)?.description} />
          ))}
          {graph.groups.map((g) => (
            <g key={g.id}>
              <rect x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx={16} fill="none" stroke="var(--color-kumo-line)" strokeDasharray="3 5" />
              <text x={g.box.x + 12} y={g.box.y + 14} fill="var(--text-color-kumo-subtle)" className="text-[11px] font-medium">
                {g.label}
              </text>
            </g>
          ))}
          {!declaresLinks(spec) && <Wires spec={spec} scene={scene} graph={graph} />}
          {links.map((link, i) => {
            const a = graph.nodes.get(link.fromNode);
            const b = graph.nodes.get(link.toNode);
            if (!a || !b) return null;
            const row = link.row ? rows.get(`${link.toNode}::${shownAs(scene, world, labelled(world, link.row))}`) : undefined;
            const q = row ? rowAnchor(row, center(a)) : rim(b, center(a));
            const p = rim(a, q);
            const style = { ...(link.kind ? playground?.link[link.kind] : undefined) };
            const dotted = (style.style ?? link.style) === "dotted";
            const flowing = style.flowing ?? !dotted;
            const tint = style.color && style.color !== "owner" ? moodColor(style.color) : undefined;
            const stroke = tint ?? (link.mood && link.mood !== "ok" ? moodColor(link.mood) : (colorOf(link.from) ?? "var(--color-kumo-brand)"));
            return (
              <line
                key={i}
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
                stroke={stroke}
                strokeWidth={2}
                strokeOpacity={0.85}
                strokeDasharray={dotted ? "2 6" : (style.style ?? "dashed") === "solid" ? undefined : "6 6"}
                strokeLinecap="round"
                className={flowing ? "feynman-flow" : undefined}
              />
            );
          })}
          {world.pending.map((p) => (p.kind === "deliver" ? <Trail key={p.id} pending={p} scene={scene} graph={graph} /> : null))}
        </svg>
        {scene.nodes.map((node) => {
          const box = graph.nodes.get(node.id);
          return box ? (
            <NodeView
              key={node.id}
              node={node}
              box={box}
              region={graph.zones.some((z) => z.region && z.name === node.zone) && node.singleton}
              flash={live && changed.has(node.id) ? (focus?.index ?? null) : null}
              humming={humming.has(node.id)}
              colorOf={colorOf}
              colors={colors}
              stage={props}
            />
          ) : null;
        })}
        {world.pending.map((p) =>
          p.kind === "deliver" ? <Packet key={p.id} pending={p} scene={scene} graph={graph} world={world} progress={flight?.pending === p.id ? flight.progress : 0} next={next === p.id} live={live} onClick={() => props.onPacket(p)} /> : null,
        )}
        {scene.nodes.map((node) => {
          const box = graph.nodes.get(node.id);
          const panel = box && panelOf(spec, playground, world, node, props);
          return panel ? (
            <div key={`panel:${node.id}`} className="absolute z-20 -translate-x-1/2" style={{ left: Math.min(Math.max(box.x + box.anchor.x, 132), graph.width - 132), top: box.y + box.h + 4 }}>
              {panel}
            </div>
          ) : null;
        })}
        {bubble && <SpeechBubble key={bubble.key} bubble={bubble} scene={scene} graph={graph} />}
        {selectedBox && props.bar && !props.barStacked && (
          <div className="absolute z-30 -translate-x-1/2 -translate-y-full" style={{ left: clampX(selectedBox.x + selectedBox.anchor.x, graph.width), top: selectedBox.y - 10 }} onClick={(e) => e.stopPropagation()}>
            {props.bar}
          </div>
        )}
        {selectedBox && props.bar && props.barStacked && (
          <div className="absolute z-30" style={besideNode(selectedBox, graph)} onClick={(e) => e.stopPropagation()}>
            {props.bar}
          </div>
        )}
        {dragging && <span className="sr-only">Carrying {dragging.token.label ?? String(dragging.token.value)}</span>}
      </div>
    </PlayProvider>
  );
}

const clampX = (x: number, width: number) => Math.min(Math.max(x, 220), width - 220);

/** Where a menu (14rem wide) goes: just right of the node's shape (not its label, which may be wider), or left of it near the right edge; its top level with the shape's, within the canvas. */
const MENU_WIDTH = 224;
const MENU_GAP = 8;
function besideNode(box: { x: number; y: number; anchor: { x: number; y: number; r: number } }, graph: { width: number; height: number }) {
  const centre = box.x + box.anchor.x;
  const right = centre + box.anchor.r + MENU_GAP;
  const left = right + MENU_WIDTH > graph.width - 8 ? Math.max(8, centre - box.anchor.r - MENU_GAP - MENU_WIDTH) : right;
  const top = box.y + box.anchor.y - box.anchor.r;
  return { left, top: Math.min(Math.max(top, 8), Math.max(8, graph.height - 260)) };
}

/** A zone's caption sits over its column; at the canvas's edges it grows inwards so it is never cut off. */
function Zone({ zone, side, width, description }: { zone: ZoneBox; side: "first" | "middle" | "last"; width: number; description?: string }) {
  if (zone.region) {
    return (
      <g>
        <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={40} fill="var(--color-kumo-warning-tint)" fillOpacity={0.6} stroke="var(--color-kumo-warning)" strokeOpacity={0.45} strokeDasharray="6 6" />
        <text x={zone.x + zone.w / 2} y={zone.y + zone.h - 14} textAnchor="middle" fill="var(--text-color-kumo-warning)" className="text-[12px]">
          {zone.name}
        </text>
      </g>
    );
  }
  return (
    <text
      x={side === "first" ? Math.max(16, zone.x) : side === "last" ? Math.min(width - 16, zone.x + zone.w) : zone.x + zone.w / 2}
      y={zone.y - 10}
      textAnchor={side === "first" ? "start" : side === "last" ? "end" : "middle"}
      fill="var(--text-color-kumo-subtle)"
      className="text-[11px]"
    >
      <tspan>{zone.name}</tspan>
      {description && <tspan opacity={0.75}> · {description}</tspan>}
    </text>
  );
}

/** Without declared links, which nodes can talk is drawn faintly. */
function Wires({ spec, scene, graph }: { spec: Spec; scene: Scene; graph: Layout }) {
  return (
    <>
      {nodeLinks(spec, scene).map(([x, y]) => {
        const a = graph.nodes.get(x);
        const b = graph.nodes.get(y);
        if (!a || !b) return null;
        const p = rim(a, center(b));
        const q = rim(b, center(a));
        return <line key={`${x}|${y}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--color-kumo-line)" strokeWidth={1} />;
      })}
    </>
  );
}

// Geometry ----------------------------------------------------------------------------------------

type Point = { x: number; y: number };
type Placed = Box & { anchor: Anchor };

function center(box: Placed): Point {
  return { x: box.x + box.anchor.x, y: box.y + box.anchor.y };
}

/** The point on a node's rim facing `towards`. */
function rim(box: Placed, towards: Point): Point {
  const c = center(box);
  const d = Math.hypot(towards.x - c.x, towards.y - c.y) || 1;
  return { x: c.x + ((towards.x - c.x) / d) * (box.anchor.r + 3), y: c.y + ((towards.y - c.y) / d) * (box.anchor.r + 3) };
}

/** A gentle curve from a to b, bending to one side: requests one way, answers the other. */
function curve(a: Point, b: Point, bend: number) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const c = { x: mx - ((b.y - a.y) / len) * bend, y: my + ((b.x - a.x) / len) * bend };
  return {
    d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`,
    at: (t: number): Point => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y }),
  };
}

function flight(pending: Extract<Pending, { kind: "deliver" }>, scene: Scene, graph: Layout, tone: string | undefined) {
  const from = graph.nodes.get(scene.of.get(pending.from) ?? "");
  const to = graph.nodes.get(scene.of.get(pending.to) ?? "");
  if (!from || !to || from === to) return null;
  const bend = tone === "reply" || tone === "refused" ? -24 : 24;
  return curve(rim(from, center(to)), rim(to, center(from)), bend);
}

/** Where rows sit on the stage, in stage coordinates, so links can end at them. Measured when they move. */
function useRowAnchors(scale: number, key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Map<string, Box>>(new Map());
  const last = useRef("");
  // Measured after every render, but only stored when something moved, so it settles.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const origin = el.getBoundingClientRect();
    const next = new Map<string, Box>();
    for (const row of el.querySelectorAll<HTMLElement>("[data-row]")) {
      const r = row.getBoundingClientRect();
      next.set(row.dataset.row!, { x: Math.round((r.left - origin.left) / scale), y: Math.round((r.top - origin.top) / scale), w: Math.round(r.width / scale), h: Math.round(r.height / scale) });
    }
    const signature = `${key}|${JSON.stringify([...next])}`;
    if (signature === last.current) return;
    last.current = signature;
    setRows(next);
  });
  return { ref, rows };
}

/** The side of a row facing a point: where a link from there meets it. */
function rowAnchor(row: Box, from: Point): Point {
  const left = Math.abs(from.x - row.x) < Math.abs(from.x - (row.x + row.w));
  return { x: left ? row.x : row.x + row.w, y: row.y + row.h / 2 };
}

// Nodes -------------------------------------------------------------------------------------------

/** Props for a playground file's render functions. */
function renderProps(spec: Spec, world: World, node: SceneNode, display: NodeDisplay, stage: StageProps) {
  const view = worldView(spec, world);
  const act = (instance: string, key: string, inputs?: Record<string, unknown>) => stage.live && stage.onAct(instance, key, inputs ?? {});
  if (!node.group) {
    const [m] = node.members;
    return {
      kind: "actor" as const,
      props: { instance: { id: m.id, label: m.label }, state: m.state, display, world: view, live: stage.live, act: ((key: string, inputs?: Record<string, unknown>) => act(m.id, key, inputs)) as NodeProps["act"] } as NodeProps,
    };
  }
  const members = node.members.map((m: InstanceState) => ({ instance: { id: m.id, label: m.label }, actor: m.actor, state: m.state, display: nodeDisplay(spec, world, { ...node, group: null, members: [m], id: m.id }) }));
  const props: GroupProps = {
    label: node.label,
    members,
    display,
    world: view,
    live: stage.live,
    member: <A extends Actor<any, any>>(actor: A) => members.find((m) => m.actor === actor.name) as never,
    act,
  };
  return { kind: "group" as const, props };
}

function panelOf(spec: Spec, playground: Playground | null, world: World, node: SceneNode, stage: StageProps): ReactNode {
  if (!playground) return null;
  const display = nodeDisplay(spec, world, node);
  const made = renderProps(spec, world, node, display, stage);
  try {
    if (made.kind === "group") return playground.group[node.group!.name]?.panel?.(made.props) ?? null;
    return playground.actor[node.members[0].actor]?.panel?.(made.props) ?? null;
  } catch (error) {
    console.warn(`feynman: the panel for ${node.label} failed`, error);
    return null;
  }
}

/** A custom drawing from the playground file, if it has one for this node; null otherwise. */
function customNode(spec: Spec, playground: Playground | null, world: World, node: SceneNode, display: NodeDisplay, stage: StageProps): { content: ReactNode } | { failed: true } | null {
  if (!playground) return null;
  const made = renderProps(spec, world, node, display, stage);
  const render = made.kind === "group" ? playground.group[node.group!.name]?.render : playground.actor[node.members[0].actor]?.node;
  if (!render) return null;
  try {
    return { content: (render as (p: unknown) => ReactNode)(made.props) };
  } catch (error) {
    console.warn(`feynman: the drawing for ${node.label} failed; showing the default`, error);
    return { failed: true };
  }
}

function NodeView({
  node,
  box,
  region,
  flash,
  humming,
  colorOf,
  colors,
  stage,
}: {
  node: SceneNode;
  box: Layout["nodes"] extends Map<string, infer B> ? B : never;
  region: boolean;
  flash: number | null;
  humming: boolean;
  colorOf: (ref: string | null | undefined) => string | undefined;
  colors: Map<string, string>;
  stage: StageProps;
}) {
  const { spec, playground } = useExplorer();
  const { world, dragging, picking, live } = stage;
  const display = presentedDisplay(spec, playground, world, node, stage);
  const identity = node.members.map((m) => colors.get(m.id)).find(Boolean);
  const owner = display.owner ? world.instances.find((i) => i.id === display.owner || i.label === display.owner) : identity ? node.members.find((m) => colors.get(m.id)) : undefined;
  const badge = identity && owner ? { text: owner.label.charAt(0).toUpperCase(), color: identity, title: display.owner ? `${owner.label}'s` : owner.label } : null;
  const drop = dragging ? (dragging.targets.has(node.id) ? "target" : dragging.fromNode === node.id ? "source" : "other") : null;
  const pickable = picking?.targets.has(node.id) ?? false;
  const timers = world.pending.filter((p): p is Extract<Pending, { kind: "timer" }> => p.kind === "timer" && node.members.some((m) => m.id === p.to));
  const waiting = timers.map((t) => t.timer).join(", ");
  const custom = customNode(spec, playground, world, node, display, stage);
  const visual =
    custom && "content" in custom ? (
      custom.content
    ) : (
      <span className="relative">
        <Node
          shape={display.shape}
          icon={display.icon}
          label={node.label}
          status={display.status}
          mood={display.mood}
          accent={region ? "var(--color-kumo-warning)" : undefined}
          badge={badge}
          shapeClassName={cn(stage.pulse === node.id && !dragging && live && "feynman-pulse", flash !== null && "feynman-flash")}
        />
        {custom && "failed" in custom && <span className="absolute -left-1 -top-1 size-3 rounded-full bg-kumo-danger" title="The playground file's drawing failed; see the console" />}
      </span>
    );
  const held = display.held.filter(({ token }) => !stage.spent.has(`${token.kind}\u0000${String(token.value)}`));
  const target = drop === "target" || pickable;
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pickable) stage.onPick(node.id);
    else if (dragging?.carried && drop === "target") stage.onDrop(node.id);
    else if (live) stage.onSelect(stage.selected === node.id ? null : node.id);
  };
  const trigger = (
    <button
      type="button"
      title={waiting ? `Waiting: ${waiting}` : undefined}
      aria-label={pickable ? `Choose ${node.label}` : `${node.label}${display.status ? `, ${display.status}` : ""}`}
      aria-pressed={stage.selected === node.id}
      onClick={click}
      className={cn(
        "group relative flex shrink-0 cursor-pointer flex-col items-center rounded-xl outline-none transition-[scale] duration-200 ease-out hover:scale-[1.04]",
        custom && stage.pulse === node.id && !dragging && live && "feynman-pulse",
        custom && flash !== null && "feynman-flash",
        humming && "feynman-hum",
        target && "scale-110",
        stage.selected === node.id && "scale-[1.04]",
      )}
      style={{ width: kindWidth(box) }}
    >
      <span key={flash ?? "still"} className="contents">
        {visual}
      </span>
      {target && <span className="feynman-target pointer-events-none absolute rounded-full" style={{ left: box.anchor.x - box.anchor.r - 8, top: box.anchor.y - box.anchor.r - 8, width: (box.anchor.r + 8) * 2, height: (box.anchor.r + 8) * 2 }} />}
    </button>
  );
  const tokens = held.length > 0 && (
    <div className={cn("absolute z-10 flex flex-col items-start gap-1", drop === "source" && "opacity-30")} style={{ left: box.anchor.x + box.anchor.r + 6, top: Math.max(0, box.anchor.y - box.anchor.r - 6) }}>
      {held.slice(-2).map(({ token, from }) => (
        <TokenChip key={`${token.kind}:${String(token.value)}`} token={token} holder={world.instances.find((i) => i.id === from)!} onPick={live ? (e) => stage.onToken(from, node.id, token, e) : null} />
      ))}
    </div>
  );
  const frame = cn("absolute transition-opacity duration-200", (drop === "other" || (picking && !pickable)) && "opacity-35");
  const place = { left: box.x, top: box.y, width: box.w, height: box.h };
  const shown = display.rows.map((r) => ({ ...r, label: shownAs(stage.scene, world, r.label) }));
  const rows = <Rows rows={shown} anchor={node.id} compact={box.kind === "side"} className={box.kind === "hub" ? "mt-3 w-full" : "mt-1 w-[150px]"} />;
  return (
    <div data-node={node.id} className={cn(frame, box.kind === "side" ? "flex items-start" : "flex flex-col items-center")} style={place}>
      <div className="relative">
        {trigger}
        {tokens}
      </div>
      {box.kind !== "plain" && rows}
    </div>
  );
}

/** The node's display, with what the playground file says about it: a group's status. */
function presentedDisplay(spec: Spec, playground: Playground | null, world: World, node: SceneNode, stage: StageProps): NodeDisplay {
  const display = nodeDisplay(spec, world, node);
  const status = node.group && playground?.group[node.group.name]?.status;
  if (!status) return display;
  try {
    const made = renderProps(spec, world, node, display, stage);
    return { ...display, status: status(made.props as GroupProps) };
  } catch (error) {
    console.warn(`feynman: the status for ${node.label} failed`, error);
    return display;
  }
}

function kindWidth(box: { kind: string; w: number; anchor: Anchor }): number | undefined {
  return box.kind === "plain" ? box.w : box.kind === "side" ? box.anchor.x * 2 : undefined;
}

/** Something to carry to another node: drag it, or click it (or press Enter) to pick it up. */
export function TokenChip({ token, holder, onPick }: { token: Token; holder?: { id: string; label: string }; onPick?: ((e: ReactPointerEvent | null) => void) | null }) {
  const { playground } = useExplorer();
  const name = token.label ?? String(token.value);
  const custom = playground?.token[token.kind];
  let body: ReactNode = null;
  if (custom) {
    try {
      body = custom({ token, holder: holder ?? { id: "", label: "" } });
    } catch (error) {
      console.warn(`feynman: the drawing for ${token.kind} failed`, error);
    }
  }
  body ??= <Ticket code={String(token.value)} label={token.label} />;
  const tilt = "-rotate-3 drop-shadow-sm";
  if (!onPick) return <span className={cn("block select-none", tilt)}>{body}</span>;
  return (
    <button
      type="button"
      title={`Drag ${name} onto another node, or click to pick it up`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onPick(e);
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(null);
      }}
      className={cn("block cursor-grab touch-none select-none rounded-md transition-transform duration-150 ease-out hover:scale-110 focus-visible:outline-2 focus-visible:outline-kumo-focus active:cursor-grabbing", tilt)}
    >
      {body}
    </button>
  );
}

// Messages in flight ------------------------------------------------------------------------------

/** The faint path a message travels. */
function Trail({ pending, scene, graph }: { pending: Extract<Pending, { kind: "deliver" }>; scene: Scene; graph: Layout }) {
  const { spec } = useExplorer();
  const tone = messageTone(spec, pending.message);
  const c = flight(pending, scene, graph, tone);
  if (!c) return null;
  return <path d={c.d} fill="none" stroke={toneColor(tone)} strokeOpacity={0.3} strokeWidth={1.5} strokeDasharray="2 5" />;
}

/** A message being delivered on screen: which one, and how far through its last stretch (0 to 1). */
export interface Flight {
  pending: number;
  progress: number;
}

/** Where a message in flight waits along its path, as a share of it: on its way, not there yet. */
const IN_FLIGHT = 0.35;

/** A message in flight; `progress` (0 to 1) carries it from where it waits to its destination. */
function Packet({ pending, scene, graph, world, progress, next, live, onClick }: { pending: Extract<Pending, { kind: "deliver" }>; scene: Scene; graph: Layout; world: World; progress: number; next: boolean; live: boolean; onClick: () => void }) {
  const { spec } = useExplorer();
  const tone = messageTone(spec, pending.message);
  const c = flight(pending, scene, graph, tone);
  if (!c) return null;
  const at = c.at(0.04 + (IN_FLIGHT + (1 - IN_FLIGHT) * progress) * 0.92);
  const color = toneColor(tone);
  const name = messageName(spec, pending.message);
  if (routineDelivery(spec, world, pending)) {
    return <span className="pointer-events-none absolute z-10 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60" style={{ left: at.x, top: at.y, background: color }} title={name} />;
  }
  return (
    <button
      type="button"
      disabled={!live}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: at.x, top: at.y }}
      title={`${name} ${short(pending.payload, 80)}. Click to deliver it now, or take it another way.`}
    >
      <span className={cn("block size-3 rounded-full", next && live && "feynman-pulse")} style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
      <span className="absolute bottom-full left-1/2 mb-1 max-w-[200px] -translate-x-1/2 truncate whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold text-kumo-inverse" style={{ background: color }}>
        {name}
      </span>
    </button>
  );
}

/** Whether a message in flight lands on a routine step, like a heartbeat. */
export function routineDelivery(spec: Spec, world: World, pending: Pending): boolean {
  const actor = spec.actors.find((a) => a.name === world.instances.find((i) => i.id === pending.to)?.actor);
  const key = pending.kind === "deliver" ? `message:${pending.message}` : pending.timer;
  return Boolean(actor?.transitions[key]?.routine);
}

// The speech bubble -------------------------------------------------------------------------------

/** What just happened, above whoever did it; while time runs it fades after a moment. */
function SpeechBubble({ bubble, scene, graph }: { bubble: Bubble & { fading: boolean }; scene: Scene; graph: Layout }) {
  const box = graph.nodes.get(scene.of.get(bubble.instance) ?? "");
  if (!box) return null;
  const c = center(box);
  const ring = bubble.tone === "bad" ? "var(--color-kumo-danger)" : bubble.tone === "action" ? "var(--color-kumo-brand)" : "var(--color-kumo-line)";
  return (
    <div
      className={cn("pointer-events-none absolute z-20 w-max max-w-[260px] -translate-x-1/2 -translate-y-full rounded-xl bg-kumo-elevated px-2.5 py-1.5 text-center text-[11px] leading-snug shadow-lg", bubble.fading && "feynman-bubble")}
      style={{ left: Math.min(Math.max(c.x, 140), graph.width - 140), top: c.y - box.anchor.r - 12, boxShadow: `0 0 0 1.5px ${ring}, 0 6px 16px var(--color-kumo-shadow-drop)` }}
    >
      {bubble.text}
    </div>
  );
}

export function bubbleText(spec: Spec, event: Event, world: World | undefined): string {
  void spec;
  const say = (text: string) => (world ? labelled(world, text) : text);
  if (event.text) return say(event.text);
  if (event.notes.length) return say(event.notes[0]);
  if (isLoss(event)) return say(event.description);
  return `${labelOf(world, event.instance)}: ${say(event.description.replace(/\.$/, ""))}`;
}

export { telling };
