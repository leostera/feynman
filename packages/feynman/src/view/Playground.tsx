// The playground: the spec's world as a living diagram on one canvas, with its controls
// floating over it. Time runs (Play) or steps (Step); messages travel between nodes, slowed
// while in flight so you can see them. Click a node to act on it, carry what a node holds to
// another to use it there, click a message to deliver it now or take it by another step on it, a fault say. Routine steps such
// as heartbeats run quietly: no bubbles, no tips, and Step goes past them. The timeline is
// the event log: hover to peek, click to travel back, step through it with ← and →; acting
// in the past continues from there.
import { Button, DropdownMenu, Select, Tabs } from "@cloudflare/kumo";
import { ArrowLeftIcon, ArrowRightIcon, ArrowsDownUpIcon, ArrowsLeftRightIcon, CheckIcon, CopyIcon, HandPointingIcon, PauseIcon, PlayIcon, PlusIcon, SkipBackIcon, SkipForwardIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { choices, dropsFor, labelled, leftAloneStep as fairStepOn, pendingInOrder, stepsTaking, type Drop, type Event, type GroupInfo, type Pending, type Spec, type Token, type World } from "../spec/index.ts";
import { groupsOf, iconFor, TONES, toneColor } from "../play/index.ts";
import { isFault, labelOf, messageName, ordinal } from "./format";
import { ActionBar, actionsOf, InputsDialog, STACK_FROM, startAction, words, type Asking, type Choosing } from "./playground/Actions";
import { bubbleText, fitOf, type Free, routineDelivery, sizesOf, Stage, TokenChip, useLayout, useView, type Bubble, type Dragging, type Flight, type Picking } from "./playground/Stage";
import { nodeDisplay, sceneOf, type Scene } from "./scene";
import { apply, current, nextHint, nextLabel, rollback, scenarioDump, type Op, type Session } from "./session";
import { Timeline, type TimelineTab } from "./Timeline";
import { EntityDetails, useExplorer } from "./ui";
import { useSettings } from "./preferences";
import type { Layout, Layouts, Orientation } from "./layout";
import { DEFAULT_ZOOM, FIT_SCALE_UNITS, type LayoutChoice, POSITION_UNITS_PER_PIXEL, ZOOM_FACTOR_UNITS, ZOOM_UNITS_PER_PERCENT, scaleZoom, zoomScale, type CameraState } from "./url";

/** A choice in the top-left pill: where a session starts from, or which spec. */
export interface Choice {
  items: { value: string; label: string }[];
  onPick: (value: string) => void;
}

/**
 * Room the side pane takes, in pixels, with its margins. The top bar and the playback bar need no
 * room here: the layout keeps space above and below for them (RESERVE in layout.ts).
 */
const PANE_REM = 22;
const PANE_MARGIN = 24;
/** Below this much width left beside the pane, the pane is treated as covering the canvas anyway. */
const MIN_FREE_WIDTH = 320;

/** The canvas left uncovered by the side pane, which the Code tab widens to half the window. */
function freeArea(view: { w: number; h: number }, wide: boolean): Free {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const pane = Math.max(PANE_REM * rem, wide ? innerWidth / 2 : 0) + PANE_MARGIN;
  const right = view.w - pane >= MIN_FREE_WIDTH ? pane : 0;
  return { x: 0, y: 0, w: view.w - right, h: view.h };
}

function sameCamera(a: CameraState, b: CameraState): boolean {
  return a.zoom === b.zoom && a.x === b.x && a.y === b.y && a.fitScale === b.fitScale && a.manual === b.manual;
}

const SPEEDS = [0.25, 1, 5, 25];
/** Real milliseconds a delivered message takes to land on screen, at 1×. */
const FLIGHT_MS = 900;
/** Real milliseconds per event with nothing flying, at 1×. */
const REPLAY_MS = 500;
/** Real milliseconds per routine event, at 1×: housekeeping goes by quickly. */
const ROUTINE_MS = 120;
/** Step runs routine events on its way to the next one worth seeing, up to this many. */
const STEP_LIMIT = 40;

/** The world after `index` steps were taken; -1 is the start. */
function worldAt(session: Session, index: number): World {
  return index < 0 ? session.initial : session.steps[index].world;
}

export function Playground({ session, setSession, scenarios, specs, initialSpeed, initialCamera, initialLayout, onViewStateChange }: { session: Session; setSession: (s: Session) => void; scenarios: Choice; specs: (Choice & { value: string }) | null; initialSpeed: number; initialCamera: CameraState; initialLayout: LayoutChoice; onViewStateChange: (state: { speed: number; camera: CameraState; layout: LayoutChoice }) => void }) {
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
  const [dropChoice, setDropChoice] = useState<{ target: string; drops: Drop[] } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const [paneTab, setPaneTab] = useState<TimelineTab>("timeline");
  const [selectPortal, setSelectPortal] = useState<HTMLDivElement | null>(null);
  const last = session.steps.length - 1;
  const travelled = cursor !== null && cursor < last ? cursor : null;
  // Starting from a scenario opens it at its start, its events ready to step or play through.
  useEffect(() => setCursor(-1), [session.origin, session.initial]);
  const live = current(session);
  const sceneRef = useRef<{ groups: GroupInfo[]; toggled: Set<string> }>({ groups, toggled });
  sceneRef.current = { groups, toggled };
  // A message inside a closed group is not drawn travelling, so there is nothing to slow down for.
  const drawnFlying = (world: World, p: Extract<Pending, { kind: "deliver" }>) => {
    const scene = sceneOf(spec, world, sceneRef.current.groups, sceneRef.current.toggled);
    return scene.of.get(p.from) !== scene.of.get(p.to);
  };
  const settings = useSettings();
  const [playing, setPlaying] = useState(settings.autoPlay);
  const [speed, setSpeed] = useState(initialSpeed);
  const [camera, setCamera] = useState<CameraState>(initialCamera);
  const [layoutChoice, setLayoutChoice] = useState<LayoutChoice>(initialLayout);
  const incomingViewKey = `${initialSpeed}:${JSON.stringify(initialCamera)}:${initialLayout}`;
  const appliedViewKey = useRef(incomingViewKey);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  useEffect(() => {
    if (appliedViewKey.current === incomingViewKey) return;
    appliedViewKey.current = incomingViewKey;
    setSpeed((current) => current === initialSpeed ? current : initialSpeed);
    setCamera((current) => sameCamera(current, initialCamera) ? current : initialCamera);
    setLayoutChoice(initialLayout);
  }, [incomingViewKey, initialCamera, initialSpeed, initialLayout]);
  useEffect(() => onViewStateChangeRef.current({ speed, camera, layout: layoutChoice }), [speed, camera, layoutChoice]);
  const panStart = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const play: Play = { playing, speed, setPlaying, setSpeed };
  const replay = useReplay(spec, session, cursor, setCursor, speed, settings.reduceMotion, drawnFlying);
  usePlay(spec, session, setSession, setCursor, replay, travelled === null && hover === null, [playing, setPlaying]);
  const base = travelled === null ? live : worldAt(session, travelled);
  const viewing = hover ?? travelled;
  const world = viewing === null ? live : worldAt(session, viewing);
  /** The message landing on screen, while an event is played in and nobody is peeking. */
  const flight = hover === null ? replay.flight : null;
  const { ref, view } = useView();
  const scene = sceneOf(spec, world, groups, toggled);
  const baseScene = sceneOf(spec, base, groups, toggled);
  // Laid out into the room the pane leaves, so a diagram that fits there is drawn at full size.
  const free = freeArea(view, paneTab === "code");
  const layouts = useLayout(spec, world, scene, { w: free.w, h: free.h }, sizesOf(playground, scene));
  const graph = layouts && pickLayout(layouts, layoutChoice, free);
  const fit = fitOf(graph, free);
  // A pan or zoom was made on the other orientation; on this one it points nowhere useful.
  const drawnOrientation = useRef<Orientation | null>(null);
  useEffect(() => {
    if (!graph) return;
    if (drawnOrientation.current && drawnOrientation.current !== graph.orientation) setCamera({ zoom: DEFAULT_ZOOM, x: 0, y: 0, fitScale: null, manual: false });
    drawnOrientation.current = graph.orientation;
  }, [graph?.orientation]);
  // Zooming and the camera's offset are about the middle of the free area, not of the canvas.
  const cx = free.x + free.w / 2;
  const cy = free.y + free.h / 2;
  const focusIndex = viewing ?? last;
  // Auto-fit untouched views; once navigated, keep the original scale across scene changes.
  const baseScale = camera.manual ? camera.fitScale === null ? fit.scale : camera.fitScale / FIT_SCALE_UNITS : fit.scale;
  const zoom = zoomScale(camera.zoom);
  const cameraZoom = (baseScale * zoom) / fit.scale;
  const stageFit = {
    scale: baseScale * zoom,
    x: cx + camera.x / POSITION_UNITS_PER_PIXEL + (fit.x - cx) * cameraZoom,
    y: cy + camera.y / POSITION_UNITS_PER_PIXEL + (fit.y - cy) * cameraZoom,
  };
  const zoomBy = (factor: number, x = cx, y = cy) => {
    const next = scaleZoom(camera.zoom, factor);
    const ratio = next / camera.zoom;
    const cameraX = camera.x / POSITION_UNITS_PER_PIXEL;
    const cameraY = camera.y / POSITION_UNITS_PER_PIXEL;
    setCamera({ zoom: next, fitScale: camera.fitScale ?? Math.round(fit.scale * FIT_SCALE_UNITS), manual: true, x: Math.round((x - cx - (x - cx - cameraX) * ratio) * POSITION_UNITS_PER_PIXEL), y: Math.round((y - cy - (y - cy - cameraY) * ratio) * POSITION_UNITS_PER_PIXEL) });
  };
  const onPanStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, [role=menu], [role=dialog], [data-node], [data-overlay]")) return;
    panStart.current = { x: e.clientX, y: e.clientY, cameraX: camera.x / POSITION_UNITS_PER_PIXEL, cameraY: camera.y / POSITION_UNITS_PER_PIXEL };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (!start) return;
    // Read the drag now: React runs the updater later, when the pointer may be up and panStart gone.
    const x = Math.round((start.cameraX + e.clientX - start.x) * POSITION_UNITS_PER_PIXEL);
    const y = Math.round((start.cameraY + e.clientY - start.y) * POSITION_UNITS_PER_PIXEL);
    const fitScale = Math.round(fit.scale * FIT_SCALE_UNITS);
    setCamera((c) => ({ ...c, manual: true, fitScale: c.fitScale ?? fitScale, x, y }));
  };
  const onPanEnd = () => { panStart.current = null; };
  wheelHandler.current = (event) => {
    const canvas = ref.current;
    if (!canvas) return;
    if (event.cancelable) event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const factor = Math.round(Math.exp(-event.deltaY * 0.0015) * ZOOM_FACTOR_UNITS);
    zoomBy(factor, event.clientX - bounds.left, event.clientY - bounds.top);
  };
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => wheelHandler.current(event);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [ref]);
  const focus = focusIndex >= 0 && session.steps[focusIndex].event ? { event: session.steps[focusIndex].event!, index: focusIndex } : null;
  const copyScenario = async () => {
    if (!session.ops) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(scenarioDump(spec, session), null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };
  useEffect(() => setCopyStatus(null), [session.origin, session.steps.length]);
  const run = (op: Op) => {
    const from = travelled === null ? session : rollback(session, travelled + 1);
    replay.stop();
    setCursor(null);
    setHover(null);
    setPacket(null);
    setDropChoice(null);
    setChoosing(null);
    setSelected(null);
    setSession(apply(spec, from, op));
  };
  /** Several operations at once, such as adding a Mac's app and daemon. */
  const runAll = (ops: Op[]) => {
    let next = travelled === null ? session : rollback(session, travelled + 1);
    for (const op of ops) next = apply(spec, next, op);
    replay.stop();
    setCursor(null);
    setSelected(null);
    setSession(next);
  };
  const back = () => {
    play.setPlaying(false);
    replay.stop();
    setCursor(Math.max(-1, (travelled ?? last) - 1));
  };
  /** Back to the start, before the first event; the events stay to step through again. */
  const toStart = () => {
    play.setPlaying(false);
    replay.stop();
    setCursor(-1);
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
    if (!play.playing || travelled === null || hover !== null || replay.running) return;
    replay.to(travelled + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play.playing, travelled, hover, replay.running]);
  const drag = useCarry(spec, base, baseScene, (target, drops) => {
    if (drops.length === 1 && drops[0].complete) run({ op: "act", instance: target, key: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length === 1) setAsking({ instance: target, action: drops[0].action.key, inputs: drops[0].inputs });
    else if (drops.length > 1) setDropChoice({ target, drops });
  });
  useKeys({
    ArrowLeft: back,
    Home: toStart,
    ArrowRight: forward,
    " ": () => play.setPlaying(!play.playing),
    Escape: () => (drag.cancel(), setPacket(null), setDropChoice(null), setChoosing(null), setSelected(null)),
  });
  const bubble = bubbleFor(spec, session, focusIndex, viewing === null && play.playing);
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
    : travelled !== null && !replay.running ? pastTip(session, travelled)
    : tipFor(spec, base, baseScene, spentTokens(spec, session, travelled ?? last));
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-kumo-canvas">
      <div ref={ref} aria-label="Playground canvas. Drag to pan; use the wheel or zoom controls to zoom." className="absolute inset-0 select-none overflow-hidden touch-none" onPointerDown={onPanStart} onPointerMove={onPanMove} onPointerUp={onPanEnd} onPointerCancel={onPanEnd} onClick={() => (setPacket(null), setDropChoice(null), setSelected(null), setChoosing(null))} style={{ cursor: panStart.current ? "grabbing" : "grab" }}>
        {graph && (
          <Stage
            world={world}
            scene={scene}
            graph={graph}
            fit={stageFit}
            flight={flight}
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
            barStacked={!!selectedNode && !choosing && actionsOf(spec, selectedNode, base).length >= STACK_FROM}
          />
        )}
        <div data-overlay className="pointer-events-none absolute inset-x-3 top-3 grid grid-cols-[1fr_auto_1fr] items-start gap-3">
          <div className="pointer-events-auto relative z-40 flex items-center gap-1 justify-self-start rounded-full bg-kumo-elevated p-1 shadow ring ring-kumo-line">
            {specs && specs.items.length > 1 && (
              <Select container={selectPortal ?? undefined} size="sm" aria-label="Spec" className="w-48 rounded-full" value={specs.value} onValueChange={(v) => v && specs.onPick(String(v))} items={specs.items} />
            )}
            <Select container={selectPortal ?? undefined} size="sm" aria-label="Start from" className="w-52 rounded-full" value={session.origin} onValueChange={(v) => v && scenarios.onPick(String(v))} items={scenarios.items} />
            <AddMenu world={base} groups={groups} onRun={runAll} />

          </div>
          <div ref={setSelectPortal} className="feynman-select-portal pointer-events-none absolute inset-0 z-50" />
          <Tip text={tip} action={travelled !== null && hover === null && !replay.running ? { label: "Back to now", onClick: () => setCursor(null) } : null} />
        </div>
        <div data-overlay className="pointer-events-none absolute bottom-[3.5rem] left-3">
          <Legend />
        </div>
        <div data-overlay className="pointer-events-auto absolute bottom-3 left-3 z-30">
          <ZoomControls
            zoom={camera.zoom}
            layout={layoutChoice}
            shown={graph?.orientation ?? "horizontal"}
            onLayout={(next) => (setLayoutChoice(next), setCamera({ zoom: DEFAULT_ZOOM, x: 0, y: 0, fitScale: null, manual: false }))}
            onZoomFactor={(factor) => zoomBy(factor)}
            onReset={() => setCamera({ zoom: DEFAULT_ZOOM, x: 0, y: 0, fitScale: null, manual: false })}
          />
        </div>
        {packet && canAct && <PacketMenu pending={packet} world={base} onClose={() => setPacket(null)} onRun={run} />}
        {dropChoice && <DropChoice choice={dropChoice} world={base} onRun={run} onAsk={(drop) => (setDropChoice(null), setAsking({ instance: dropChoice.target, action: drop.action.key, inputs: drop.inputs }))} />}
      </div>
      <div data-overlay className={`absolute bottom-3 right-3 top-3 z-30 max-w-[calc(100%-1.5rem)] transition-[width] duration-200 ${paneTab === "code" ? "w-[max(22rem,50vw)]" : "w-[22rem]"}`}>
      <Timeline
        session={session}
        tab={paneTab}
        onTab={setPaneTab}
        actions={(() => {
          const label = copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy timeline";
          return <Button size="xs" variant="ghost" shape="square" aria-label={label} title={label} icon={copyStatus === "copied" ? <CheckIcon size={12} /> : <CopyIcon size={12} />} disabled={!session.ops} onClick={copyScenario} />;
        })()}
        preview={hover}
        cursor={travelled}
        onPreview={setHover}
        onPick={(n) => (replay.stop(), setHover(null), setCursor(n >= last ? null : n))}
        details={<EntityDetails ids={baseScene.nodes.find((node) => node.id === selected)?.members.map((member) => member.id) ?? []} world={base} />}
        foldOf={(event, w) => {
          if (event.routine) return "routine";
          // A message from one member of a closed group to another happened inside it.
          if (event.kind !== "deliver" || !event.from) return null;
          const scene = sceneOf(spec, w, groups, toggled);
          const node = scene.of.get(event.instance);
          return node && node === scene.of.get(event.from) && scene.groups.has(node) ? `inside:${scene.groups.get(node)!.label}` : null;
        }}
      />
      </div>
      {/* Centred under the diagram, in the room the pane leaves. */}
      <div data-overlay className="pointer-events-none absolute bottom-3 z-40 -translate-x-1/2" style={{ left: free.x + free.w / 2 }}>
        <Transport
          play={play}
          shown={focusIndex + 1}
          canBack={(travelled ?? last) >= 0}
          canStep={canStep}
          canEnd={travelled !== null || hover !== null}
          onFirst={toStart}
          onBack={back}
          onStep={forward}
          onEnd={() => (play.setPlaying(false), replay.stop(), setHover(null), setCursor(null))}
        />
      </div>
      {drag.dragging && drag.at && !drag.dragging.carried && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 scale-110" style={{ left: drag.at.x, top: drag.at.y }}>
          <TokenChip token={drag.dragging.token} />
        </div>
      )}
      <InputsDialog target={asking} world={base} onClose={() => setAsking(null)} onRun={run} />
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

// Playing ------------------------------------------------------------------------------------------------

interface Play {
  playing: boolean;
  speed: number;
  setPlaying: (on: boolean) => void;
  setSpeed: (speed: number) => void;
}

/**
 * Play lets the system run: at now, the next event it would take left alone is run and
 * animated in, then the next. With nothing to run it stays on and waits, so whatever a
 * person does next plays out by itself. It pauses on a spec error or a broken property.
 * There is no clock (RFD0004): play is a pace, events per animation, never time passing.
 */
function usePlay(spec: Spec, session: Session, setSession: (s: Session) => void, setCursor: (n: number | null) => void, replay: Replay, active: boolean, [playing, setPlaying]: [boolean, (on: boolean) => void]) {
  useEffect(() => {
    if (!playing || !active || replay.running) return;
    const next = leftAloneStep(spec, session);
    const event = next?.steps.at(-1)?.event;
    if (!next || !event) return; // waiting for someone to act
    if (event.error || event.violations.length) setPlaying(false);
    setSession(next);
    setCursor(session.steps.length - 1);
    replay.to(next.steps.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active, replay.running, session]);
}

/** The session after the one event the system takes next left alone; null when nothing is pending. */
function leftAloneStep(spec: Spec, session: Session): Session | null {
  const hint = nextHint(spec, current(session));
  if (hint.kind === "guard") return apply(spec, session, { op: "guard", instance: hint.instance, key: hint.key });
  if (hint.kind === "pending") return apply(spec, session, { op: "fire", pending: hint.pending.id });
  return null;
}

type Replay = ReturnType<typeof useReplay>;

/**
 * Plays recorded events in, one at a time: a delivered message flies the rest of its way,
 * then the cursor moves onto its event. Reaching the last event returns to now. With motion
 * reduced each event takes just as long, but nothing moves: the message waits, then lands.
 */
function useReplay(
  spec: Spec,
  session: Session,
  cursor: number | null,
  setCursor: (n: number | null) => void,
  speed: number,
  still: boolean,
  shown: (world: World, p: Extract<Pending, { kind: "deliver" }>) => boolean,
) {
  const [goal, setGoal] = useState<number | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const visible = useRef(shown);
  visible.current = shown;
  const last = session.steps.length - 1;
  const at = cursor === null ? last : cursor;
  const land = (n: number) => setCursor(n >= last ? null : n);
  useEffect(() => setGoal(null), [session.origin, session.initial]);
  useEffect(() => {
    if (goal === null) return setFlight(null);
    if (at >= goal || at >= last) {
      setGoal(null);
      if (at >= last) setCursor(null);
      return;
    }
    const before = worldAt(session, at);
    const step = session.steps[at + 1];
    const delivered = step.event ? deliveredBy(before, step.world, step.event) : undefined;
    const flying = delivered && !routineDelivery(spec, before, delivered) && visible.current(before, delivered) ? delivered : undefined;
    const duration = (flying ? FLIGHT_MS : step.event?.routine ? ROUTINE_MS : REPLAY_MS) / Math.max(1, speed);
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const done = Math.min(1, (t - start) / duration);
      setFlight(flying ? { pending: flying.id, progress: still ? 0 : done } : null);
      if (done < 1) frame = requestAnimationFrame(tick);
      else land(at + 1);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, at, speed, still, session]);
  return {
    flight: goal === null ? null : flight,
    running: goal !== null,
    to: (n: number) => setGoal(n),
    stop: () => setGoal(null),
    /** Skip the rest of the animation: land on the goal now. */
    finish: () => (goal !== null && land(goal), setGoal(null)),
  };
}

/** The message an event delivered: in flight before it, gone after, addressed to who took it. */
function deliveredBy(before: World, after: World, event: Event): Extract<Pending, { kind: "deliver" }> | undefined {
  if (event.kind !== "deliver") return undefined;
  const still = new Set(after.pending.map((p) => p.id));
  return before.pending.find((p): p is Extract<Pending, { kind: "deliver" }> => p.kind === "deliver" && !still.has(p.id) && p.to === event.instance && p.message === event.message);
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
  if (event.error || event.violations.length || isFault(event)) return "bad";
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
    for (const { token } of nodeDisplay(spec, world, node).held) {
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
  if (timer) return `${nodeLabel(timer.to)} is waiting${timer.kind === "timer" ? ` for ${timer.timer}` : ""}. Press Play, or Step.`;
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

function Transport({ play, shown, canBack, canStep, canEnd, onFirst, onBack, onStep, onEnd }: { play: Play; shown: number; canBack: boolean; canStep: boolean; canEnd: boolean; onFirst: () => void; onBack: () => void; onStep: () => void; onEnd: () => void }) {
  return (
    <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-kumo-elevated p-1.5 pl-3 shadow-lg ring-1 ring-kumo-line">
      <span className="min-w-10 text-right font-mono text-[13px] tabular-nums">{ordinal(shown)}</span>
      <div className="flex items-center gap-1 rounded-lg bg-kumo-recessed p-0.5 ring-1 ring-kumo-line">
        <Button size="sm" variant="secondary" shape="square" aria-label="Back to the start (Home)" title="Back to the start (Home)" icon={<SkipBackIcon size={16} />} disabled={!canBack} onClick={onFirst} />
        <Button size="sm" variant="secondary" shape="square" aria-label="Back one event (←)" title="Back one event (←)" icon={<ArrowLeftIcon size={16} />} disabled={!canBack} onClick={onBack} />
        <Button size="sm" variant="primary" shape="square" aria-label={play.playing ? "Pause" : "Play"} title={play.playing ? "Pause" : "Play"} icon={play.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />} onClick={() => play.setPlaying(!play.playing)} />
        <Button size="sm" variant="secondary" shape="square" aria-label="Step forward (→)" title="Step forward (→)" icon={<ArrowRightIcon size={16} />} disabled={!canStep} onClick={onStep} />
        <Button size="sm" variant="secondary" shape="square" aria-label="Go to the end" title="Go to the end" icon={<SkipForwardIcon size={16} />} disabled={!canEnd} onClick={onEnd} />
      </div>
      <Tabs value={String(play.speed)} onValueChange={(v) => play.setSpeed(Number(v))} tabs={SPEEDS.map((s) => ({ value: String(s), label: `${s === 0.25 ? "¼" : s}×` }))} />
    </div>
  );
}

/** Auto, then always across, then always down: what the layout button does next. */
const NEXT_LAYOUT: Record<LayoutChoice, LayoutChoice> = { auto: "horizontal", horizontal: "vertical", vertical: "auto" };

/**
 * The orientation to draw: the one asked for, or on auto whichever fits the free room larger.
 * Across wins ties, and keeps winning unless down is clearly bigger, so the diagram does not
 * flip back and forth as the room changes a little.
 */
function pickLayout(layouts: Layouts, choice: LayoutChoice, free: Free): Layout {
  if (choice !== "auto") return layouts[choice];
  const across = fitOf(layouts.horizontal, free).scale;
  const down = fitOf(layouts.vertical, free).scale;
  return down > across * 1.15 ? layouts.vertical : layouts.horizontal;
}

function ZoomControls({ zoom, layout, shown, onLayout, onZoomFactor, onReset }: { zoom: number; layout: LayoutChoice; shown: Orientation; onLayout: (next: LayoutChoice) => void; onZoomFactor: (factor: number) => void; onReset: () => void }) {
  const label = layout === "auto" ? `Layout: auto (${shown === "vertical" ? "top to bottom" : "left to right"})` : layout === "vertical" ? "Layout: top to bottom" : "Layout: left to right";
  const Icon = shown === "vertical" ? ArrowsDownUpIcon : ArrowsLeftRightIcon;
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-kumo-elevated p-1 shadow ring-1 ring-kumo-line">
      <Button size="xs" variant={layout === "auto" ? "ghost" : "secondary"} shape="square" aria-label={`${label}. Click to change.`} title={`${label}. Click to change.`} icon={<Icon size={12} />} onClick={() => onLayout(NEXT_LAYOUT[layout])} />
      <span className="mx-0.5 h-4 w-px bg-kumo-line" />
      <Button size="xs" variant="ghost" shape="square" aria-label="Zoom out" title="Zoom out" onClick={() => onZoomFactor(800)}>−</Button>
      <span className="min-w-9 text-center font-mono text-[10px] tabular-nums">{Math.round(zoom / ZOOM_UNITS_PER_PERCENT)}%</span>
      <Button size="xs" variant="ghost" shape="square" aria-label="Zoom in" title="Zoom in" onClick={() => onZoomFactor(1250)}>+</Button>
      <Button size="xs" variant="ghost" shape="square" aria-label="Reset zoom" title="Reset zoom" onClick={onReset}>↺</Button>
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
    onRun([{ op: "spawn", actor: name, label: actor.display.names?.find((n) => !taken.has(n)) ?? nextLabel(world, name) }]);
  };
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" shape="circle" aria-label="Add" title="Add someone or something" icon={<PlusIcon size={14} />} />} />
      <DropdownMenu.Content>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Add</DropdownMenu.Label>
          {keyed.map((group) => {
            const Icon = iconFor(group.icon ?? spec.actors.find((a) => a.name === group.members[0].actor)?.display.icon ?? null);
            return (
              <DropdownMenu.Item key={group.name} icon={<Icon />} onClick={() => addGroup(group)}>
                {group.name}
              </DropdownMenu.Item>
            );
          })}
          {kinds.map((actor) => {
            const Icon = iconFor(actor.display.icon ?? null);
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
  const receiver = spec.actors.find((a) => a.name === world.instances.find((i) => i.id === pending.to)?.actor);
  const leftAlone = receiver && fairStepOn(receiver, pending.message);
  return (
    <div className="absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-kumo-elevated py-1 pl-4 pr-1 shadow-xl ring ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      <span className="text-[13px]">
        <span className="font-medium">{capitalize(messageName(spec, pending.message))}</span>
        <span className="text-kumo-subtle">
          {" "}
          from {labelOf(world, pending.from)} to {labelOf(world, pending.to)}
        </span>
      </span>
      {/* Every step that can take it now (RFD0012): the one left alone delivers it, faults and others by name. */}
      {stepsTaking(spec, world, pending).map((step) =>
        step === leftAlone ? (
          <Button key={step} size="xs" variant="primary" icon={<PlayIcon size={12} />} onClick={() => onRun({ op: "fire", pending: pending.id })}>
            Deliver now
          </Button>
        ) : (
          <Button key={step} size="xs" variant={receiver?.transitions[step]?.tags.includes("fault") ? "secondary-destructive" : "secondary"} onClick={() => onRun({ op: "fire", pending: pending.id, step })}>
            {words(step)}
          </Button>
        ),
      )}
      <Button size="xs" variant="ghost" shape="square" aria-label="Close" icon={<XIcon size={12} />} onClick={onClose} />
    </div>
  );
}
