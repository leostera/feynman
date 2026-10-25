// The playground: the spec's world as a living diagram. Time runs (Play) or steps (Step);
// messages travel the wires and are slowed down while in flight so you can see them; click
// a node to act on it, click a message to deliver it now or lose it. A tip says what to try
// next, presets start from a scenario, and the timeline on the right is the event log.
import { Button, cn, DropdownMenu, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowUUpLeftIcon, LightbulbIcon, PauseIcon, PlayIcon, PlusIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Pending, Spec, World } from "@feynman/spec";
import { clock as clockAt, labelOf, messageName, time } from "./format";
import { iconFor } from "./playground/look";
import { InputsDialog, InspectDialog, NodeMenu } from "./playground/NodeMenu";
import { bubbleText, Stage, useFit, useLayout, type Bubble } from "./playground/Stage";
import { apply, current, nextHint, nextLabel, type Hint, type Op, type Session } from "./session";
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

export function Playground({ session, setSession, scenarios }: { session: Session; setSession: (s: Session) => void; scenarios: ReactNodeMenu }) {
  const { spec } = useExplorer();
  const [preview, setPreview] = useState<number | null>(null);
  const [packet, setPacket] = useState<Extract<Pending, { kind: "deliver" }> | null>(null);
  const [asking, setAsking] = useState<{ instance: string; action: string } | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const live = current(session);
  const clock = useClock(spec, session, setSession, preview === null);
  const world = preview === null ? live : preview < 0 ? session.initial : session.steps[preview].world;
  const graph = useLayout(spec, world);
  const { ref, fit } = useFit(graph?.width ?? 0, graph?.height ?? 0);
  const focus = preview === null ? (session.steps.at(-1)?.event ?? null) : preview >= 0 ? session.steps[preview].event : null;
  const hint = nextHint(spec, live);
  const run = (op: Op) => {
    setPreview(null);
    setPacket(null);
    setSession(apply(spec, session, { ...op, at: clock.now }));
  };
  const bubbles = recentBubbles(spec, session, preview);
  const pulse = hint.kind === "act" ? hint.instance : null;
  const handlers = { onRun: run, onInputs: (instance: string, action: string) => setAsking({ instance, action }), onInspect: setInspecting };
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <NavBar
          scenarios={scenarios}
          origin={session.origin}
          world={live}
          clock={clock}
          hint={hint}
          previewing={preview !== null}
          canStep={hint.kind === "pending" || hint.kind === "guard"}
          canUndo={session.steps.length > 0}
          onRun={run}
          onUndo={() => setSession({ ...session, steps: session.steps.slice(0, -1), ops: session.ops?.slice(0, -1) ?? null })}
          onReset={() => scenarios.onPick(session.origin)}
          onStep={() => setSession(stepOnce(spec, session))}
        />
        <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden bg-kumo-canvas" onClick={() => setPacket(null)}>
          {graph && (
            <Stage
              world={world}
              graph={graph}
              fit={fit}
              clock={preview === null ? clock.now : world.clock}
              live={preview === null}
              focus={focus}
              bubbles={bubbles}
              next={hint.kind === "pending" ? hint.pending.id : null}
              pulse={pulse}
              menu={(id, trigger, children) =>
                preview === null ? (
                  <NodeMenu id={id} world={live} trigger={trigger} handlers={handlers}>
                    {children}
                  </NodeMenu>
                ) : (
                  <div className="flex w-[136px] flex-col items-center gap-1">{children}</div>
                )
              }
              onPacket={(p) => setPacket(p)}
            />
          )}
          {packet && preview === null && <PacketMenu pending={packet} world={live} onClose={() => setPacket(null)} onRun={run} />}
        </div>
      </div>
      <Timeline
        session={session}
        preview={preview}
        onPreview={setPreview}
        onRollback={(n) => (setPreview(null), setSession({ ...session, steps: session.steps.slice(0, n), ops: session.ops?.slice(0, n) ?? null }))}
      />
      <InputsDialog target={asking} world={live} onClose={() => setAsking(null)} onRun={run} />
      <InspectDialog id={inspecting} world={live} onClose={() => setInspecting(null)} />
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
  hint,
  previewing,
  canStep,
  canUndo,
  onRun,
  onUndo,
  onReset,
  onStep,
}: {
  scenarios: ReactNodeMenu;
  origin: string;
  world: World;
  clock: Clock;
  hint: Hint;
  previewing: boolean;
  canStep: boolean;
  canUndo: boolean;
  onRun: (op: Op) => void;
  onUndo: () => void;
  onReset: () => void;
  onStep: () => void;
}) {
  const { spec } = useExplorer();
  const tip = previewing ? "Looking back in time. Click the event to go back to it, or move away to return." : tipFor(spec, hint, world);
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-3">
      <Select size="sm" aria-label="Start from" className="w-56" value={origin} onValueChange={(v) => v && scenarios.onPick(String(v))} items={scenarios.items} />
      <AddMenu world={world} onRun={onRun} />
      <span className="mx-1 h-5 w-px bg-kumo-hairline" />
      <span className="w-[4.5rem] text-right font-mono text-[12px] tabular-nums">{clockAt(clock.now)}</span>
      <Button variant={clock.playing ? "secondary" : "primary"} size="sm" icon={clock.playing ? <PauseIcon /> : <PlayIcon />} onClick={() => clock.setPlaying(!clock.playing)}>
        {clock.playing ? "Pause" : "Play"}
      </Button>
      <Button variant="ghost" size="sm" icon={<SkipForwardIcon />} disabled={!canStep} onClick={onStep}>
        Step
      </Button>
      <div className="flex rounded-lg bg-kumo-recessed p-0.5">
        {SPEEDS.map((s) => (
          <button key={s} type="button" onClick={() => clock.setSpeed(s)} className={cn("rounded-md px-2 py-0.5 font-mono text-[11px] text-kumo-subtle", clock.speed === s && "bg-kumo-base text-kumo-default shadow-sm")}>
            {s === 0.25 ? "¼" : s}×
          </button>
        ))}
      </div>
      <Button variant="ghost" size="sm" shape="square" aria-label="Undo the last step" disabled={!canUndo} onClick={onUndo} icon={<ArrowUUpLeftIcon />} />
      <Button variant="ghost" size="sm" shape="square" aria-label="Start over" onClick={onReset} icon={<ArrowCounterClockwiseIcon />} />
      <span className="mx-1 h-5 w-px bg-kumo-hairline" />
      <LightbulbIcon size={16} weight="duotone" className="shrink-0 text-kumo-warning" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-subtle" title={tip}>
        {tip}
      </span>
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
      <DropdownMenu.Trigger render={<Button variant="secondary" size="sm" shape="square" aria-label="Add" icon={<PlusIcon />} />} />
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

function tipFor(spec: Spec, hint: Hint, world: World): string {
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

