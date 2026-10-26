// The playground: the spec's world as a living diagram on one canvas, with its controls
// floating over it. Time runs (Play) or steps (Step); messages travel between nodes, slowed
// while in flight so you can see them. Click a node to act on it, carry what a node holds to
// another to use it there, click a message to deliver it now or lose it. Routine steps such
// as heartbeats run quietly: no bubbles, no tips, and Step goes past them. The timeline is
// the event log: hover to peek, click to travel back, step through it with ← and →; acting
// in the past continues from there.
import { Button, DropdownMenu, Select, Tabs } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, HandPointingIcon, PauseIcon, PlayIcon, PlusIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { choices, dropsFor, labelled, pendingInOrder, type Drop, type Event, type GroupInfo, type Pending, type Spec, type Token, type World } from "@feynman/spec";
import { groupsOf, iconFor, TONES, toneColor } from "@feynman/play";
import { clock as clockAt, labelOf, messageName, time } from "./format";
import { ActionBar, actionsOf, InputsDialog, InspectDialog, STACK_FROM, startAction, type Asking, type Choosing } from "./playground/Actions";
import { bubbleText, fitOf, routineDelivery, sizesOf, Stage, TokenChip, useLayout, useView, type Bubble, type Dragging, type Picking } from "./playground/Stage";
import { nodeLook, sceneOf, type Scene } from "./scene";
import { apply, current, nextHint, nextLabel, rollback, type Op, type Session } from "./session";
import { Timeline } from "./Timeline";
import { useExplorer } from "./ui";

/** Where a session can start from: "Fresh start" and every scenario. */
export interface ReactNodeMenu {
  items: { value: string; label: string }[];
  onPick: (value: string) => void;
}

const SPEEDS = [0.25, 1, 5, 25];
/** Real milliseconds a message takes on screen, at most: flights are slowed to this. */
const FLIGHT_MS = 900;
/** Real milliseconds per event when playing back through the past. */
const REPLAY_MS = 700;
/** Step runs routine events on its way to the next one worth seeing, up to this many. */
const STEP_LIMIT = 40;

/** The world after `index` steps were taken; -1 is the start. */
function worldAt(session: Session, index: number): World {
  return index < 0 ? session.initial : session.steps[index].world;
}

export function Playground({ session, setSession, scenarios }: { session: Session; setSession: (s: Session) => void; scenarios: ReactNodeMenu }) {
  const { spec, playground } = useExplorer();
  const groups = groupsOf(spec, playground);
  /** Groups opened (or, for those that start open, closed) by node id. */
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  /** Hovering a timeline event peeks at it; leaving returns. */
  const [hover, setHover] = useState<number | null>(null);
  /** The moment travelled back to, null for now. Acting there continues from it. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [packet, setPacket] = useState<Extract<Pending, { kind: "deliver" }> | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [inspecting, setInspecting] = useState<string[] | null>(null);
  const [dropChoice, setDropChoice] = useState<{ target: string; drops: Drop[] } | null>(null);
  const last = session.steps.length - 1;
  const travelled = cursor !== null && cursor < last ? cursor : null;
  useEffect(() => setCursor(null), [session.origin, session.initial]);
  const live = current(session);
  const sceneRef = useRef<{ groups: GroupInfo[]; toggled: Set<string> }>({ groups, toggled });
  sceneRef.current = { groups, toggled };
  // A message inside a closed group is not drawn travelling, so there is nothing to slow down for.
  const drawnFlying = (world: World, p: Extract<Pending, { kind: "deliver" }>) => {
    const scene = sceneOf(spec, world, sceneRef.current.groups, sceneRef.current.toggled);
    return scene.of.get(p.from) !== scene.of.get(p.to);
  };
  const clock = useClock(spec, session, setSession, travelled === null && hover === null, drawnFlying);
  const replay = useReplay(spec, session, cursor, setCursor, clock.speed, drawnFlying);
  const base = travelled === null ? live : worldAt(session, travelled);
  const viewing = hover ?? travelled;
  const world = viewing === null ? live : worldAt(session, viewing);
  /** The clock on screen: live time, the replay running between two recorded events, or the moment looked at. */
  const shownClock = viewing === null ? clock.now : hover === null && replay.clock !== null ? replay.clock : world.clock;
  const { ref, view } = useView();
  const scene = sceneOf(spec, world, groups, toggled);
  const baseScene = sceneOf(spec, base, groups, toggled);
  const graph = useLayout(spec, world, scene, view, sizesOf(playground, scene));
  const fit = fitOf(graph, view);
  const focusIndex = viewing ?? last;
  const focus = focusIndex >= 0 && session.steps[focusIndex].event ? { event: session.steps[focusIndex].event!, index: focusIndex } : null;
  const run = (op: Op) => {
    const from = travelled === null ? session : rollback(session, travelled + 1);
    replay.stop();
    setCursor(null);
    setHover(null);
    setPacket(null);
    setDropChoice(null);
    setChoosing(null);
    setSelected(null);
    setSession(apply(spec, from, travelled === null ? { ...op, at: clock.now } : op));
  };
  /** Several operations at once, such as adding a Mac's app and daemon. */
  const runAll = (ops: Op[]) => {
    let next = travelled === null ? session : rollback(session, travelled + 1);
    for (const op of ops) next = apply(spec, next, travelled === null ? { ...op, at: clock.now } : op);
    replay.stop();
    setCursor(null);
    setSelected(null);
    setSession(next);
  };
  const back = () => {
    clock.setPlaying(false);
    replay.stop();
    setCursor(Math.max(-1, (travelled ?? last) - 1));
  };
  /** One step on, animated: in the past, to the next recorded event; at now, run the next events and play them in. */
  const forward = () => {
    if (replay.running) return replay.finish();
    if (travelled !== null) return replay.to(travelled + 1);
    const next = stepPastRoutine(spec, session);
    if (next.steps.length === session.steps.length) return;
    setSession(next);
    setCursor(last);
    replay.to(next.steps.length - 1);
  };
  // Playing in the past plays the recorded events back, animated, then carries on live.
  useEffect(() => {
    if (!clock.playing || travelled === null || hover !== null || replay.running) return;
    replay.to(travelled + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.playing, travelled, hover, replay.running]);
  const drag = useCarry(spec, base, baseScene, (target, drops) => {
    if (drops.length === 1 && drops[0].complete) run({ op: "act", instance: target, key: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length === 1) setAsking({ instance: target, action: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length > 1) setDropChoice({ target, drops });
  });
  useKeys({
    ArrowLeft: back,
    ArrowRight: forward,
    " ": () => clock.setPlaying(!clock.playing),
    Escape: () => (drag.cancel(), setPacket(null), setDropChoice(null), setChoosing(null), setSelected(null)),
  });
  const bubble = bubbleFor(spec, session, focusIndex, viewing === null && clock.playing);
  const act = firstAction(spec, base);
  const canAct = hover === null;
  const picking = pickingOf(base, baseScene, choosing);
  const spent = spentTokens(spec, session, focusIndex);
  const selectedNode = canAct && selected ? baseScene.nodes.find((n) => n.id === selected) : undefined;
  const openGroup = selectedNode && (baseScene.groups.has(selectedNode.id) ? { id: selectedNode.id, open: false } : (() => {
    const g = baseScene.open.find((o) => o.nodes.includes(selectedNode.id));
    return g ? { id: g.id, open: true } : null;
  })());
  const bar = selectedNode && (
    <ActionBar
      node={selectedNode}
      world={base}
      choosing={choosing}
      group={openGroup ? { label: baseScene.groups.get(openGroup.id)?.label ?? "", open: openGroup.open } : null}
      onStart={(instance, action) => {
        const next = startAction(spec, base, instance, action);
        if ("run" in next) run(next.run);
        else if ("choose" in next) setChoosing(next.choose);
        else setAsking(next.ask);
      }}
      onRun={run}
      onAsk={(a) => (setChoosing(null), setAsking(a))}
      onBack={() => setChoosing(null)}
      onInspect={setInspecting}
      onToggleGroup={() => {
        if (!openGroup) return;
        setToggled((t) => (t.has(openGroup.id) ? new Set([...t].filter((x) => x !== openGroup.id)) : new Set([...t, openGroup.id])));
        setSelected(openGroup.open ? openGroup.id : null);
      }}
      onClose={() => (setSelected(null), setChoosing(null))}
      nameOf={(value) => {
        const node = typeof value === "string" ? baseScene.nodes.find((n) => n.id === baseScene.of.get(value)) : undefined;
        return node?.label ?? labelled(base, String(value));
      }}
    />
  );
  const canStep = travelled !== null || pendingInOrder(base).length > 0 || choices(spec, base).guards.length > 0;
  const tip =
    drag.dragging?.carried ? `Carrying ${tokenName(drag.dragging.token)}. Click a highlighted node to hand it over, or press Esc.`
    : choosing && picking ? `Click ${[...picking.targets.keys()].map((id) => baseScene.nodes.find((n) => n.id === id)?.label).join(" or ")}, or choose in the bar.`
    : hover !== null ? "Peeking at this moment. Click it to travel back here."
    : travelled !== null ? pastTip(session, travelled)
    : tipFor(spec, base, baseScene, spentTokens(spec, session, travelled ?? last));
  return (
    <div className="flex h-full min-h-0 gap-3 bg-kumo-recessed p-3">
      <div ref={ref} className="relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-kumo-canvas ring-1 ring-kumo-line" onClick={() => (setPacket(null), setDropChoice(null), setSelected(null), setChoosing(null))}>
        {graph && (
          <Stage
            world={world}
            scene={scene}
            graph={graph}
            fit={fit}
            clock={shownClock}
            live={canAct}
            focus={focus}
            bubble={bubble}
            next={nextFlight(spec, base)}
            pulse={act ? (baseScene.of.get(act.instance) ?? null) : null}
            selected={selectedNode?.id ?? null}
            picking={picking}
            dragging={drag.dragging}
            spent={spent}
            onSelect={(id) => (setSelected(id), setChoosing(null))}
            onPick={(id) => {
              const value = picking?.targets.get(id);
              if (choosing && value !== undefined) run({ op: "act", instance: choosing.instance, key: choosing.action, inputs: { ...choosing.inputs, [choosing.input]: value } });
            }}
            onToken={drag.start}
            onDrop={drag.drop}
            onAct={(instance, key, inputs) => run({ op: "act", instance, key, inputs })}
            onPacket={(p) => setPacket(p)}
            bar={bar}
            barStacked={!!selectedNode && !choosing && actionsOf(spec, selectedNode).length >= STACK_FROM}
          />
        )}
        <div className="pointer-events-none absolute inset-x-3 top-3 grid grid-cols-[1fr_auto_1fr] items-start gap-3">
          <div className="pointer-events-auto flex items-center gap-1 justify-self-start rounded-full bg-kumo-elevated p-1 shadow ring ring-kumo-line">
            <Select size="sm" aria-label="Start from" className="w-52 rounded-full" value={session.origin} onValueChange={(v) => v && scenarios.onPick(String(v))} items={scenarios.items} />
            <AddMenu world={base} groups={groups} onRun={runAll} />
          </div>
          <Tip text={tip} action={travelled !== null && hover === null ? { label: "Back to now", onClick: () => setCursor(null) } : null} />
        </div>
        <div className="pointer-events-none absolute inset-x-3 bottom-3 grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <Legend />
          <Transport clock={clock} shown={shownClock} canBack={(travelled ?? last) >= 0} canStep={canStep} onBack={back} onStep={forward} onReset={() => scenarios.onPick(session.origin)} />
        </div>
        {packet && canAct && <PacketMenu pending={packet} world={base} onClose={() => setPacket(null)} onRun={run} />}
        {dropChoice && <DropChoice choice={dropChoice} world={base} onRun={run} onAsk={(drop) => (setDropChoice(null), setAsking({ instance: dropChoice.target, action: drop.action.key, inputs: drop.inputs }))} />}
      </div>
      <Timeline
        session={session}
        preview={hover}
        cursor={travelled}
        onPreview={setHover}
        onPick={(n) => (replay.stop(), setHover(null), setCursor(n >= last ? null : n))}
        foldOf={(event, w) => {
          if (event.routine) return "routine";
          // A message from one member of a closed group to another happened inside it.
          if (event.kind !== "deliver" || !event.from) return null;
          const scene = sceneOf(spec, w, groups, toggled);
          const node = scene.of.get(event.instance);
          return node && node === scene.of.get(event.from) && scene.groups.has(node) ? `inside:${scene.groups.get(node)!.label}` : null;
        }}
      />
      {drag.dragging && drag.at && !drag.dragging.carried && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 scale-110" style={{ left: drag.at.x, top: drag.at.y }}>
          <TokenChip token={drag.dragging.token} clock={clock.now} />
        </div>
      )}
      <InputsDialog target={asking} world={base} onClose={() => setAsking(null)} onRun={run} />
      <InspectDialog ids={inspecting} world={base} onClose={() => setInspecting(null)} />
    </div>
  );
}

const tokenName = (token: Token) => token.label ?? String(token.value);

function pastTip(session: Session, index: number): string {
  const events = session.steps.filter((s) => s.event).length;
  const at = session.steps.slice(0, index + 1).filter((s) => s.event).length;
  return `Back at event ${at} of ${events}. Step with ← and →, Play to watch it again, or act to try something else from here.`;
}

function useKeys(keys: Record<string, () => void>) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, button, [role=dialog], [role=menu], [role=listbox]") && e.key !== "Escape") return;
      const f = ref.current[e.key];
      if (!f) return;
      e.preventDefault();
      f();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// Time ------------------------------------------------------------------------------------------------

interface Clock {
  now: number;
  playing: boolean;
  speed: number;
  setPlaying: (on: boolean) => void;
  setSpeed: (speed: number) => void;
}

/**
 * The displayed clock. While playing it advances in real time at the chosen speed, slowed
 * down while a message worth watching is in flight; whatever falls due runs.
 */
function useClock(spec: Spec, session: Session, setSession: (s: Session) => void, active: boolean, shown: (world: World, p: Extract<Pending, { kind: "deliver" }>) => boolean): Clock {
  const visible = useRef(shown);
  visible.current = shown;
  const [now, setNow] = useState(current(session).clock);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const state = useRef({ now, session, setSession });
  state.current = { now, session, setSession };
  // A rollback or a new start moves the clock to that world; events never run behind it.
  const worldClock = current(session).clock;
  useEffect(() => {
    if (worldClock > now || session.steps.length === 0) setNow(worldClock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldClock, session.steps.length, session.origin]);
  useEffect(() => {
    if (!playing || !active) return;
    let last = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const elapsed = Math.min(100, t - last);
      last = t;
      let { now, session } = state.current;
      const world = current(session);
      const flying = world.pending.filter((p): p is Extract<Pending, { kind: "deliver" }> => p.kind === "deliver" && p.at > now && !routineDelivery(spec, world, p) && visible.current(world, p));
      const slowest = Math.min(...flying.map((p) => spec.messages[p.message]?.latency ?? spec.latency));
      const rate = flying.length ? Math.min(speed, slowest / FLIGHT_MS) : speed;
      now += elapsed * rate;
      // Run what fell due, at most a few per frame so a burst stays visible.
      for (let n = 0; n < 4; n++) {
        const hint = nextHint(spec, current(session));
        if (hint.kind === "guard") session = apply(spec, session, { op: "guard", instance: hint.instance, key: hint.key, at: now });
        else if (hint.kind === "pending" && hint.pending.at <= now) session = apply(spec, session, { op: "fire", pending: hint.pending.id });
        else break;
        if (session.steps.at(-1)?.event?.error) {
          setPlaying(false);
          break;
        }
      }
      if (session !== state.current.session) state.current.setSession(session);
      setNow(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, active, speed, spec]);
  return { now, playing, speed, setPlaying, setSpeed };
}

/**
 * Plays recorded events in, one at a time: within the world before each event the clock runs up to
 * the moment it happened, so its message flies as it did live; then the cursor moves onto it. Reaching
 * the last event returns to now.
 */
function useReplay(
  spec: Spec,
  session: Session,
  cursor: number | null,
  setCursor: (n: number | null) => void,
  speed: number,
  shown: (world: World, p: Extract<Pending, { kind: "deliver" }>) => boolean,
) {
  const [goal, setGoal] = useState<number | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const visible = useRef(shown);
  visible.current = shown;
  const last = session.steps.length - 1;
  const at = cursor === null ? last : cursor;
  const land = (n: number) => setCursor(n >= last ? null : n);
  useEffect(() => setGoal(null), [session.origin, session.initial]);
  useEffect(() => {
    if (goal === null) return setClock(null);
    if (at >= goal || at >= last) {
      setGoal(null);
      if (at >= last) setCursor(null);
      return;
    }
    const plan = flightOf(spec, worldAt(session, at), session.steps[at + 1].world.clock, visible.current);
    const duration = (plan.flying ? FLIGHT_MS : REPLAY_MS) / Math.max(1, speed);
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const done = Math.min(1, (t - start) / duration);
      setClock(plan.from + (plan.to - plan.from) * done);
      if (done < 1) frame = requestAnimationFrame(tick);
      else land(at + 1);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, at, speed, session]);
  return {
    clock: goal === null ? null : clock,
    running: goal !== null,
    to: (n: number) => setGoal(n),
    stop: () => setGoal(null),
    /** Skip the rest of the animation: land on the goal now. */
    finish: () => (goal !== null && land(goal), setGoal(null)),
  };
}

/** The stretch of time to animate before the next event: from when its visible messages left (or now), to when it happened. */
function flightOf(spec: Spec, world: World, until: number, shown: (world: World, p: Extract<Pending, { kind: "deliver" }>) => boolean) {
  const landing = world.pending.filter((p): p is Extract<Pending, { kind: "deliver" }> => p.kind === "deliver" && p.at <= until && shown(world, p));
  if (!landing.length) return { from: until, to: until, flying: false };
  const left = Math.min(...landing.map((p) => p.at - (spec.messages[p.message]?.latency ?? spec.latency)));
  return { from: Math.max(world.clock, left), to: until, flying: true };
}

/** Run what is due, past routine events, until something worth seeing has happened. */
function stepPastRoutine(spec: Spec, session: Session): Session {
  let s = session;
  for (let n = 0; n < STEP_LIMIT; n++) {
    const hint = nextHint(spec, current(s));
    if (hint.kind === "guard") s = apply(spec, s, { op: "guard", instance: hint.instance, key: hint.key });
    else if (hint.kind === "pending") s = apply(spec, s, { op: "fire", pending: hint.pending.id });
    else break;
    const event = s.steps.at(-1)?.event;
    if (!event?.routine || event.error) break;
  }
  return s;
}

// What to show and suggest --------------------------------------------------------------------------------

/** The bubble for the focused event, unless it is routine. While time runs it fades. */
function bubbleFor(spec: Spec, session: Session, index: number, fading: boolean): (Bubble & { fading: boolean }) | null {
  for (let i = index; i >= 0 && i > index - 6; i--) {
    const { event, world } = session.steps[i];
    if (!event || event.kind === "spawn" || event.routine) continue;
    return { key: `${i}`, instance: event.instance, text: bubbleText(spec, event, world), tone: toneOf(event), fading };
  }
  return null;
}

function toneOf(event: Event): Bubble["tone"] {
  if (event.error || event.violations.length || event.kind === "lose") return "bad";
  return event.kind === "action" ? "action" : event.kind === "timer" ? "quiet" : "message";
}

/** The next message in flight worth pointing at. */
function nextFlight(spec: Spec, world: World): number | null {
  return pendingInOrder(world).find((p) => p.kind === "deliver" && !routineDelivery(spec, world, p))?.id ?? null;
}

/** The first thing a person can do: an action someone can take now. */
function firstAction(spec: Spec, world: World): { instance: string; key: string } | null {
  return choices(spec, world).actions[0] ?? null;
}

/** The first token some node holds that another node would accept. */
function firstDrag(spec: Spec, world: World, scene: Scene, spent: Set<string>): { from: string; token: Token; to: string } | null {
  for (const node of scene.nodes) {
    for (const { token } of nodeLook(spec, world, node).held) {
      if (spent.has(`${token.kind}\u0000${String(token.value)}`)) continue;
      const to = scene.nodes.find((n) => n.id !== node.id && n.members.some((m) => dropsFor(spec, world, m.id, token).length));
      if (to) return { from: node.label, token, to: to.label };
    }
  }
  return null;
}

/** What to try next, as a goal: what is on its way, what to carry, who to add, what to click. */
function tipFor(spec: Spec, world: World, scene: Scene, spent: Set<string>): string {
  const nodeLabel = (instance: string) => scene.nodes.find((n) => n.id === scene.of.get(instance))?.label ?? labelOf(world, instance);
  const flight = pendingInOrder(world).find(
    (p): p is Extract<Pending, { kind: "deliver" }> => p.kind === "deliver" && !routineDelivery(spec, world, p) && scene.of.get(p.from) !== scene.of.get(p.to),
  );
  if (flight) return `${capitalize(messageName(spec, flight.message))} is on its way to ${nodeLabel(flight.to)}. Press Play to watch it arrive.`;
  const drag = firstDrag(spec, world, scene, spent);
  if (drag) return `Drag ${tokenName(drag.token)} from ${drag.from} onto ${drag.to}.`;
  const missing = spec.actors.find((a) => !a.singleton && Object.keys(a.actions).length && !world.instances.some((i) => i.actor === a.name));
  if (missing) return `Add ${article(missing.name)} with +.`;
  const act = firstAction(spec, world);
  if (act) {
    const instance = world.instances.find((i) => i.id === act.instance)!;
    const action = spec.actors.find((a) => a.name === instance.actor)!.actions[act.key];
    return `Click ${nodeLabel(instance.id)}, then “${action.label}”. Every node has more to try.`;
  }
  const timer = pendingInOrder(world).find((p) => !routineDelivery(spec, world, p));
  if (timer) return `${nodeLabel(timer.to)} is waiting${timer.kind === "timer" ? ` (${timer.timer}, ${time(Math.max(0, timer.at - world.clock))})` : ""}. Press Play.`;
  return "All quiet. Add someone with +, or start from a scenario.";
}

const article = (name: string) => (/^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`);

/** While choosing an input whose values are instances, the nodes they are drawn in, each with its value. */
function pickingOf(world: World, scene: Scene, choosing: Choosing | null): Picking | null {
  if (!choosing) return null;
  const targets = new Map<string, unknown>();
  for (const value of choosing.values) {
    const node = typeof value === "string" && world.instances.some((i) => i.id === value) ? scene.of.get(value) : undefined;
    if (node && !targets.has(node)) targets.set(node, value);
  }
  return targets.size ? { targets } : null;
}

/**
 * Tokens already handed over by the moment `index`: every value an action took as an input,
 * by the kind that input accepts. A pairing code typed into a Mac is gone from the phone.
 */
function spentTokens(spec: Spec, session: Session, index: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= index && i < session.steps.length; i++) {
    const event = session.steps[i].event;
    if (!event || event.kind !== "action" || !event.inputs) continue;
    const action = spec.actors.find((a) => a.name === event.actor)?.actions[event.key];
    if (!action) continue;
    for (const [name, value] of Object.entries(event.inputs)) {
      const input = action.inputs[name];
      if (!input) continue;
      out.add(`${event.actor}.${event.key}.${name}\u0000${String(value)}`);
      if (input.accepts) out.add(`${input.accepts}\u0000${String(value)}`);
    }
  }
  return out;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Carrying tokens: drag one, or click it to pick it up, then drop it on a node that takes it ---------------

function useCarry(spec: Spec, world: World, scene: Scene, onDrop: (target: string, drops: Drop[]) => void) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ world, scene, onDrop, dragging });
  latest.current = { world, scene, onDrop, dragging };
  const cleanup = useRef<() => void>(() => {});
  const cancel = () => {
    cleanup.current();
    setDragging(null);
    setAt(null);
  };
  /** Drop on a node: the first of its members with an action that takes the token. */
  const drop = (target: string) => {
    const carrying = latest.current.dragging;
    cancel();
    if (!carrying || !carrying.targets.has(target)) return;
    const { world, scene, onDrop } = latest.current;
    const node = scene.nodes.find((n) => n.id === target);
    for (const member of node?.members ?? []) {
      const drops = dropsFor(spec, world, member.id, carrying.token);
      if (drops.length) return onDrop(member.id, drops);
    }
  };
  const start = (from: string, fromNode: string, token: Token, e: ReactPointerEvent | null) => {
    cancel();
    const targets = new Set(scene.nodes.filter((n) => n.id !== fromNode && n.members.some((m) => dropsFor(spec, world, m.id, token).length)).map((n) => n.id));
    if (!e) {
      setDragging({ from, fromNode, token, targets, carried: true });
      return;
    }
    const origin = { x: e.clientX, y: e.clientY };
    let moved = false;
    setDragging({ from, fromNode, token, targets, carried: false });
    const move = (ev: PointerEvent) => {
      moved ||= Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > 4;
      setAt({ x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      cleanup.current();
      // A click without moving picks the token up instead.
      if (!moved) {
        setAt(null);
        setDragging({ from, fromNode, token, targets, carried: true });
        return;
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-node]");
      drop(el?.dataset.node ?? "");
    };
    const abort = () => cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", abort);
      cleanup.current = () => {};
    };
  };
  return { dragging, at, start, drop, cancel };
}

function DropChoice({ choice, world, onRun, onAsk }: { choice: { target: string; drops: Drop[] }; world: World; onRun: (op: Op) => void; onAsk: (drop: Drop) => void }) {
  return (
    <div className="absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-kumo-elevated p-1 pl-3 shadow-xl ring ring-kumo-brand" onClick={(e) => e.stopPropagation()}>
      <span className="text-xs text-kumo-subtle">{labelOf(world, choice.target)}:</span>
      {choice.drops.map((drop) => (
        <Button key={drop.action.key} size="xs" variant="secondary" onClick={() => (drop.complete ? onRun({ op: "act", instance: choice.target, key: drop.action.key, inputs: drop.inputs }) : onAsk(drop))}>
          {drop.action.label}
        </Button>
      ))}
    </div>
  );
}

// Overlays ----------------------------------------------------------------------------------------------

function Transport({ clock, shown, canBack, canStep, onBack, onStep, onReset }: { clock: Clock; shown: number; canBack: boolean; canStep: boolean; onBack: () => void; onStep: () => void; onReset: () => void }) {
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-kumo-elevated p-1 shadow-lg ring ring-kumo-line">
      <span className="w-[4.5rem] px-2 text-right font-mono text-xs tabular-nums">{clockAt(shown)}</span>
      <Button size="xs" variant="ghost" shape="square" aria-label="Back one event (←)" title="Back one event (←)" icon={<ArrowLeftIcon size={12} />} disabled={!canBack} onClick={onBack} />
      <Button size="xs" variant={clock.playing ? "secondary" : "primary"} icon={clock.playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />} onClick={() => clock.setPlaying(!clock.playing)}>
        {clock.playing ? "Pause" : "Play"}
      </Button>
      <Button size="xs" variant="ghost" icon={<SkipForwardIcon size={12} />} title="Next event (→)" disabled={!canStep} onClick={onStep}>
        Step
      </Button>
      <Tabs size="sm" value={String(clock.speed)} onValueChange={(v) => clock.setSpeed(Number(v))} tabs={SPEEDS.map((s) => ({ value: String(s), label: `${s === 0.25 ? "¼" : s}×` }))} />
      <Button size="xs" variant="ghost" shape="square" aria-label="Start over" title="Start over" icon={<ArrowCounterClockwiseIcon size={12} />} onClick={onReset} />
    </div>
  );
}

/** What to try next, as a pill over the canvas. */
function Tip({ text, action }: { text: string; action: { label: string; onClick: () => void } | null }) {
  return (
    <div key={text} role="status" className="feynman-tip pointer-events-auto flex min-w-0 max-w-[44rem] items-center gap-2 rounded-full bg-kumo-elevated py-1 pl-3 pr-1 text-[13px] shadow ring ring-kumo-line">
      <HandPointingIcon size={16} weight="duotone" className="shrink-0 rotate-90 text-kumo-warning" />
      <span className="min-w-0 truncate py-0.5 pr-2" title={text}>
        {text}
      </span>
      {action && (
        <Button size="xs" variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 justify-self-start pb-2 pl-2 text-[11px] text-kumo-subtle">
      {TONES.map((t) => (
        <span key={t.tone} className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: toneColor(t.tone) }} />
          {t.label}
        </span>
      ))}
    </div>
  );
}

/**
 * "+": add someone or something. A group of actors drawn as one (a Mac: its app and its
 * daemon) is added whole, each member labelled "<name> <suffix>"; other actors one at a time.
 */
function AddMenu({ world, groups, onRun }: { world: World; groups: GroupInfo[]; onRun: (ops: Op[]) => void }) {
  const { spec } = useExplorer();
  const keyed = groups.filter((g) => g.members.some((m) => m.suffix !== null));
  const inGroup = new Set(keyed.flatMap((g) => g.members.map((m) => m.actor)));
  const kinds = spec.actors.filter((a) => !a.singleton && !inGroup.has(a.name));
  if (!kinds.length && !keyed.length) return null;
  const taken = new Set(world.instances.map((i) => i.label));
  const addGroup = (group: GroupInfo) => {
    const free = (name: string) => group.members.every((m) => !taken.has(m.suffix ? `${name} ${m.suffix}` : name));
    const name = group.names?.find(free) ?? Array.from({ length: 99 }, (_, n) => (n ? `${group.name} ${n + 1}` : group.name)).find(free)!;
    onRun(group.members.map((m) => ({ op: "spawn", actor: m.actor, label: m.suffix ? `${name} ${m.suffix}` : name })));
  };
  const addActor = (name: string) => {
    const actor = spec.actors.find((a) => a.name === name)!;
    onRun([{ op: "spawn", actor: name, label: actor.look.names?.find((n) => !taken.has(n)) ?? nextLabel(world, name) }]);
  };
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" shape="circle" aria-label="Add" title="Add someone or something" icon={<PlusIcon size={14} />} />} />
      <DropdownMenu.Content>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Add</DropdownMenu.Label>
          {keyed.map((group) => {
            const Icon = iconFor(group.icon ?? spec.actors.find((a) => a.name === group.members[0].actor)?.look.icon ?? null);
            return (
              <DropdownMenu.Item key={group.name} icon={<Icon />} onClick={() => addGroup(group)}>
                {group.name}
              </DropdownMenu.Item>
            );
          })}
          {kinds.map((actor) => {
            const Icon = iconFor(actor.look.icon ?? null);
            return (
              <DropdownMenu.Item key={actor.name} icon={<Icon />} onClick={() => addActor(actor.name)}>
                {actor.name}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function PacketMenu({ pending, world, onClose, onRun }: { pending: Extract<Pending, { kind: "deliver" }>; world: World; onClose: () => void; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  return (
    <div className="absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-kumo-elevated py-1 pl-4 pr-1 shadow-xl ring ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      <span className="text-[13px]">
        <span className="font-medium">{capitalize(messageName(spec, pending.message))}</span>
        <span className="text-kumo-subtle">
          {" "}
          from {labelOf(world, pending.from)} to {labelOf(world, pending.to)}
        </span>
      </span>
      <Button size="xs" variant="primary" icon={<PlayIcon size={12} />} onClick={() => onRun({ op: "fire", pending: pending.id })}>
        Deliver now
      </Button>
      <Button size="xs" variant="secondary-destructive" icon={<XIcon size={12} />} onClick={() => onRun({ op: "lose", pending: pending.id })}>
        Lose it
      </Button>
      <Button size="xs" variant="ghost" shape="square" aria-label="Close" icon={<XIcon size={12} />} onClick={onClose} />
    </div>
  );
}
