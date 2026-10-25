// The playground: the spec's world as a living diagram. Time runs (Play) or steps (Step);
// messages travel the wires, slowed while in flight so you can see them. Click a node to act
// on it, drag what a node holds onto another to use it there, click a message to deliver it
// now or lose it. The timeline is the event log: hover to peek, click to travel back, then
// step through it with ← and →; acting in the past continues from there.
import { Button, DropdownMenu, Select, Tabs } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, PauseIcon, PlayIcon, PlusIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { appearance, dropsFor, type Drop, type Pending, type Spec, type Token, type World } from "@feynman/spec";
import { clock as clockAt, labelOf, messageName, time } from "./format";
import { iconFor, instanceColors, TONES, toneColor } from "./playground/look";
import { InputsDialog, InspectDialog, NodeMenu, type Asking } from "./playground/NodeMenu";
import { bubbleText, Stage, TokenChip, useFit, useLayout, type Bubble, type Dragging } from "./playground/Stage";
import { apply, current, nextHint, nextLabel, rollback, type Hint, type Op, type Session } from "./session";
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

/** The world after `index` steps were taken; -1 is the start. */
function worldAt(session: Session, index: number): World {
  return index < 0 ? session.initial : session.steps[index].world;
}

export function Playground({ session, setSession, scenarios }: { session: Session; setSession: (s: Session) => void; scenarios: ReactNodeMenu }) {
  const { spec } = useExplorer();
  /** Hovering a timeline event peeks at it; leaving returns. */
  const [hover, setHover] = useState<number | null>(null);
  /** The moment travelled back to, null for now. Acting there continues from it. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [packet, setPacket] = useState<Extract<Pending, { kind: "deliver" }> | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ target: string; drops: Drop[]; at: { x: number; y: number } } | null>(null);
  const last = session.steps.length - 1;
  const travelled = cursor !== null && cursor < last ? cursor : null;
  useEffect(() => setCursor(null), [session.origin, session.initial]);
  const live = current(session);
  const clock = useClock(spec, session, setSession, travelled === null && hover === null);
  const base = travelled === null ? live : worldAt(session, travelled);
  const viewing = hover ?? travelled;
  const world = viewing === null ? live : worldAt(session, viewing);
  const graph = useLayout(spec, world);
  const { ref, fit } = useFit(graph?.width ?? 0, graph?.height ?? 0);
  const focus = viewing === null ? (session.steps.at(-1)?.event ?? null) : viewing >= 0 ? session.steps[viewing].event : null;
  const hint = nextHint(spec, base);
  const run = (op: Op) => {
    const from = travelled === null ? session : rollback(session, travelled + 1);
    setCursor(null);
    setHover(null);
    setPacket(null);
    setChoosing(null);
    setSession(apply(spec, from, travelled === null ? { ...op, at: clock.now } : op));
  };
  const back = () => {
    clock.setPlaying(false);
    setCursor(Math.max(-1, (travelled ?? last) - 1));
  };
  const forward = () => {
    if (travelled !== null) setCursor(travelled + 1 >= last ? null : travelled + 1);
    else setSession(stepOnce(spec, session));
  };
  // Playing in the past plays the recorded events back, then carries on live.
  useEffect(() => {
    if (!clock.playing || travelled === null || hover !== null) return;
    const timer = setTimeout(() => setCursor(travelled + 1 >= last ? null : travelled + 1), REPLAY_MS / Math.max(1, clock.speed));
    return () => clearTimeout(timer);
  }, [clock.playing, clock.speed, travelled, hover, last]);
  useKeys({ ArrowLeft: back, ArrowRight: forward, " ": () => clock.setPlaying(!clock.playing) });
  const drag = useTokenDrag(spec, base, (target, drops, at) => {
    if (drops.length === 1 && drops[0].complete) run({ op: "act", instance: target, key: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length === 1) setAsking({ instance: target, action: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length > 1) setChoosing({ target, drops, at });
  });
  const bubbles = recentBubbles(spec, session, viewing);
  const pulse = hint.kind === "act" ? hint.instance : null;
  const handlers = { onRun: run, onInputs: (instance: string, action: string) => setAsking({ instance, action }), onInspect: setInspecting };
  const canAct = hover === null;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <NavBar
          scenarios={scenarios}
          origin={session.origin}
          world={base}
          clock={clock}
          shown={viewing === null ? clock.now : world.clock}
          canBack={(travelled ?? last) >= 0}
          canStep={travelled !== null || hint.kind === "pending" || hint.kind === "guard"}
          onRun={run}
          onBack={back}
          onReset={() => scenarios.onPick(session.origin)}
          onStep={forward}
        />
        <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden bg-kumo-canvas" onClick={() => (setPacket(null), setChoosing(null))}>
          {graph && (
            <Stage
              world={world}
              graph={graph}
              fit={fit}
              clock={viewing === null ? clock.now : world.clock}
              live={canAct}
              focus={focus}
              bubbles={bubbles}
              next={hint.kind === "pending" ? hint.pending.id : null}
              pulse={pulse}
              dragging={drag.dragging}
              onToken={drag.start}
              menu={(id, trigger, children) =>
                canAct ? (
                  <NodeMenu id={id} world={base} trigger={trigger} handlers={handlers}>
                    {children}
                  </NodeMenu>
                ) : (
                  <div className="flex w-[136px] flex-col items-center gap-1">{children}</div>
                )
              }
              onPacket={(p) => setPacket(p)}
            />
          )}
          <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center">
            <Tip
              text={hover !== null ? "Peeking at this moment. Click it to travel back here." : travelled !== null ? pastTip(session, travelled) : tipFor(spec, hint, base)}
              action={travelled !== null && hover === null ? { label: "Back to now", onClick: () => setCursor(null) } : null}
            />
          </div>
          <Legend />
          {packet && canAct && <PacketMenu pending={packet} world={base} onClose={() => setPacket(null)} onRun={run} />}
          {choosing && <DropChoice choice={choosing} world={base} onRun={run} onAsk={(drop) => (setChoosing(null), setAsking({ instance: choosing.target, action: drop.action.key, inputs: drop.inputs }))} />}
        </div>
      </div>
      <Timeline session={session} preview={hover} cursor={travelled} onPreview={setHover} onPick={(n) => (setHover(null), setCursor(n >= last ? null : n))} />
      {drag.dragging && drag.at && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 scale-110" style={{ left: drag.at.x, top: drag.at.y }}>
          <TokenChip token={drag.dragging.token} color={instanceColors(spec, base).get(drag.dragging.from)} />
        </div>
      )}
      <InputsDialog target={asking} world={base} onClose={() => setAsking(null)} onRun={run} />
      <InspectDialog id={inspecting} world={base} onClose={() => setInspecting(null)} />
    </div>
  );
}

function pastTip(session: Session, index: number): string {
  const events = session.steps.filter((s) => s.event).length;
  const at = session.steps.slice(0, index + 1).filter((s) => s.event).length;
  return `Back at event ${at} of ${events}. Step through with ← and →, press Play to watch it again, or act here to try something else from this moment.`;
}

function useKeys(keys: Record<string, () => void>) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [role=dialog], [role=menu], [role=listbox]")) return;
      const f = ref.current[e.key];
      if (!f) return;
      e.preventDefault();
      f();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// Drag and drop: pick up a token a node holds, drop it on a node with an action that accepts it -------------

function useTokenDrag(spec: Spec, world: World, onDrop: (target: string, drops: Drop[], at: { x: number; y: number }) => void) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ world, onDrop });
  latest.current = { world, onDrop };
  const start = (from: string, token: Token, e: ReactPointerEvent) => {
    const targets = new Set(world.instances.filter((i) => i.id !== from && dropsFor(spec, world, i.id, token).length).map((i) => i.id));
    setDragging({ from, token, targets });
    setAt({ x: e.clientX, y: e.clientY });
    const move = (ev: PointerEvent) => setAt({ x: ev.clientX, y: ev.clientY });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      setAt(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-instance]");
      const target = el?.dataset.instance;
      if (!target || !targets.has(target)) return;
      const { world, onDrop } = latest.current;
      onDrop(target, dropsFor(spec, world, target, token), { x: ev.clientX, y: ev.clientY });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { dragging, at, start };
}

function DropChoice({ choice, world, onRun, onAsk }: { choice: { target: string; drops: Drop[]; at: { x: number; y: number } }; world: World; onRun: (op: Op) => void; onAsk: (drop: Drop) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rect = box.current?.offsetParent?.getBoundingClientRect();
  return (
    <div
      ref={box}
      className="absolute z-30 flex items-center gap-1 rounded-full bg-kumo-elevated p-1 pl-3 shadow-xl ring ring-kumo-brand"
      style={{ left: choice.at.x - (rect?.left ?? 0), top: choice.at.y - (rect?.top ?? 0) }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs text-kumo-subtle">{labelOf(world, choice.target)}:</span>
      {choice.drops.map((drop) => (
        <Button key={drop.action.key} size="xs" variant="secondary" onClick={() => (drop.complete ? onRun({ op: "act", instance: choice.target, key: drop.action.key, inputs: drop.inputs }) : onAsk(drop))}>
          {drop.action.label}
        </Button>
      ))}
    </div>
  );
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
 * down while a message is in flight so it can be seen travelling; whatever falls due runs.
 */
function useClock(spec: Spec, session: Session, setSession: (s: Session) => void, active: boolean): Clock {
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
      const flying = world.pending.filter((p): p is Extract<Pending, { kind: "deliver" }> => p.kind === "deliver" && p.at > now);
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

/** Run the next thing that is due, jumping the clock to it. */
function stepOnce(spec: Spec, session: Session): Session {
  const hint = nextHint(spec, current(session));
  if (hint.kind === "guard") return apply(spec, session, { op: "guard", instance: hint.instance, key: hint.key });
  if (hint.kind === "pending") return apply(spec, session, { op: "fire", pending: hint.pending.id });
  return session;
}

// Speech bubbles: the last few things that happened, by whoever did them --------------------------------

function recentBubbles(spec: Spec, session: Session, preview: number | null): Bubble[] {
  const end = preview === null ? session.steps.length : preview + 1;
  const out: Bubble[] = [];
  for (let i = end - 1; i >= 0 && out.length < 3; i--) {
    const { event, world } = session.steps[i];
    if (!event || event.kind === "spawn") continue;
    const text = bubbleText(spec, event, world);
    if (out.some((b) => b.instance === event.instance && b.text === text)) continue;
    out.push({
      key: `${i}`,
      instance: event.instance,
      text,
      tone: event.error || event.violations.length || event.kind === "lose" ? "bad" : event.kind === "action" ? "action" : event.kind === "timer" ? "quiet" : "message",
      age: out.length,
    });
  }
  return out;
}

// Overlays ----------------------------------------------------------------------------------------------

function NavBar({
  scenarios,
  origin,
  world,
  clock,
  shown,
  canBack,
  canStep,
  onRun,
  onBack,
  onReset,
  onStep,
}: {
  scenarios: ReactNodeMenu;
  origin: string;
  world: World;
  clock: Clock;
  shown: number;
  canBack: boolean;
  canStep: boolean;
  onRun: (op: Op) => void;
  onBack: () => void;
  onReset: () => void;
  onStep: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-3">
      <Select size="sm" aria-label="Start from" className="w-56" value={origin} onValueChange={(v) => v && scenarios.onPick(String(v))} items={scenarios.items} />
      <AddMenu world={world} onRun={onRun} />
      <div className="mx-auto flex items-center gap-1 rounded-full bg-kumo-elevated p-1 ring ring-kumo-line">
        <span className="w-[4.25rem] px-2 text-right font-mono text-xs tabular-nums">{clockAt(shown)}</span>
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
      <span className="w-[calc(14rem+2rem)]" />
    </div>
  );
}

/** What to try next, as a pill over the canvas. */
function Tip({ text, action }: { text: string; action: { label: string; onClick: () => void } | null }) {
  return (
    <div key={text} className="feynman-tip pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-kumo-tint px-3 py-1.5 text-sm shadow-sm ring ring-kumo-hairline">
      <span aria-hidden>👉</span>
      <span className="min-w-0 truncate" title={text}>
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
    <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 text-[11px] text-kumo-subtle">
      {TONES.map((t) => (
        <span key={t.tone} className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: toneColor(t.tone) }} />
          {t.label}
        </span>
      ))}
    </div>
  );
}

/** "+": add an instance of any actor that is not a singleton. */
function AddMenu({ world, onRun }: { world: World; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  const kinds = spec.actors.filter((a) => !a.singleton);
  if (!kinds.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="secondary" size="xs" shape="square" aria-label="Add" title="Add someone or something" icon={<PlusIcon size={12} />} />} />
      <DropdownMenu.Content>
        <DropdownMenu.Group>
        <DropdownMenu.Label>Add</DropdownMenu.Label>
        {kinds.map((actor) => {
          const Icon = iconFor(actor.look.icon ?? null);
          return (
            <DropdownMenu.Item key={actor.name} icon={<Icon />} onClick={() => onRun({ op: "spawn", actor: actor.name, label: nextLabel(world, actor.name) })}>
              {actor.name}
            </DropdownMenu.Item>
          );
        })}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The first token some node holds that another node would accept. */
function firstDrag(spec: Spec, world: World): { from: string; token: Token; to: string } | null {
  for (const instance of world.instances) {
    for (const token of appearance(spec, world, instance.id).tokens) {
      const to = world.instances.find((i) => i.id !== instance.id && dropsFor(spec, world, i.id, token).length);
      if (to) return { from: instance.id, token, to: to.id };
    }
  }
  return null;
}

function tipFor(spec: Spec, hint: Hint, world: World): string {
  const drag = hint.kind === "act" || hint.kind === "done" ? firstDrag(spec, world) : null;
  if (drag) return `Drag ${drag.token.label ?? String(drag.token.value)} from ${labelOf(world, drag.from)} onto ${labelOf(world, drag.to)}, or click a node to see what else it can do.`;
  switch (hint.kind) {
    case "spawn":
      return `Add a ${hint.actor} with + to begin.`;
    case "act": {
      const instance = world.instances.find((i) => i.id === hint.instance)!;
      const action = spec.actors.find((a) => a.name === instance.actor)!.actions[hint.key];
      const others = world.instances.filter((i) => Object.keys(spec.actors.find((a) => a.name === i.actor)!.actions).length).length;
      return `Click ${instance.label} to ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}${others > 1 ? ", or click another node" : ""}. Click a message on a wire to lose it.`;
    }
    case "pending": {
      const p = hint.pending;
      return p.kind === "deliver"
        ? `${capitalize(messageName(spec, p.message))} is on its way to ${labelOf(world, p.to)}. Press Play, or Step through it.`
        : `${labelOf(world, p.to)} is waiting: ${p.timer} in ${time(Math.max(0, p.at - world.clock))}. Press Play, or Step to skip ahead.`;
    }
    case "guard":
      return `${labelOf(world, hint.instance)} is about to ${hint.key}. Press Step.`;
    default:
      return "Nothing is happening and nobody can act.";
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function PacketMenu({ pending, world, onClose, onRun }: { pending: Extract<Pending, { kind: "deliver" }>; world: World; onClose: () => void; onRun: (op: Op) => void }) {
  const { spec } = useExplorer();
  return (
    <div className="absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-kumo-elevated px-3 py-2 shadow-xl ring-1 ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      <span className="text-[13px]">
        <span className="font-medium">{capitalize(messageName(spec, pending.message))}</span>
        <span className="text-kumo-subtle">
          {" "}
          from {labelOf(world, pending.from)} to {labelOf(world, pending.to)}
        </span>
      </span>
      <Button size="xs" variant="primary" icon={<PlayIcon />} onClick={() => onRun({ op: "fire", pending: pending.id })}>
        Deliver now
      </Button>
      <Button size="xs" variant="secondary-destructive" icon={<XIcon />} onClick={() => onRun({ op: "lose", pending: pending.id })}>
        Lose it
      </Button>
      <Button size="xs" variant="ghost" shape="square" aria-label="Close" icon={<XIcon />} onClick={onClose} />
    </div>
  );
}

