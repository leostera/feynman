// The timeline: the event log of a playground session, one line per event. Runs of routine
// events (heartbeats and other housekeeping) fold into one line that opens on click, and so
// do runs of events inside a closed group (the relay's Worker asking its Durable Object).
// Hovering an event peeks at the world as it was then; clicking travels back to it, without
// forgetting what came after until something else is done there. The focused event sits at
// the bottom in words, with its changes, messages and code one click away.
import { Badge, cn, Tabs } from "@cloudflare/kumo";
import { CaretRightIcon, CornersInIcon, HeartbeatIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Event, Spec, World } from "../spec/index.ts";
import { CodeTrace } from "./CodeTrace";
import { kindLabel, labelOf, ordinal, stepTitle } from "./format";
import { bubbleText } from "./playground/Stage";
import type { Session } from "./session";
import { EventDetail, useExplorer } from "./ui";

export type TimelineTab = "timeline" | "code" | "details";

type Item = { event: Event; world: World; index: number; fold: string | null };
type Entry = ({ kind: "event" } & Item) | { kind: "fold"; fold: string; events: Item[] };

/** Which run an event folds into: "routine", "inside:<group>", or none. */
export type FoldOf = (event: Event, world: World) => string | null;

/** Events in order, with each run of two or more events that fold alike folded into one entry. */
function entriesOf(session: Session, foldOf: FoldOf): Entry[] {
  const out: Entry[] = [];
  session.steps.forEach(({ event, world }, index) => {
    if (!event) return;
    const item = { event, world, index, fold: foldOf(event, world) };
    const prev = out.at(-1);
    if (!item.fold) out.push({ kind: "event", ...item });
    else if (prev?.kind === "fold" && prev.fold === item.fold) prev.events.push(item);
    else if (prev?.kind === "event" && prev.fold === item.fold) out[out.length - 1] = { kind: "fold", fold: item.fold, events: [prev, item] };
    else out.push({ kind: "event", ...item });
  });
  return out;
}

export function Timeline({
  session,
  preview,
  cursor,
  onPreview,
  onPick,
  actions,
  details,
  foldOf,
  tab,
  onTab,
}: {
  tab: TimelineTab;
  onTab: (tab: TimelineTab) => void;
  /** What folds together; routine events by default. */
  foldOf: FoldOf;
  session: Session;
  preview: number | null;
  /** The moment travelled back to; later events are greyed out. */
  cursor: number | null;
  onPreview: (index: number | null) => void;
  onPick: (index: number) => void;
  actions?: ReactNode;
  details: ReactNode;
}) {
  const { spec } = useExplorer();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const entries = entriesOf(session, foldOf);
  const count = session.steps.filter((s) => s.event).length;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [session.steps.length]);
  useEffect(() => {
    if (cursor !== null) list.current?.querySelector(`[data-step="${cursor}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);
  const focusIndex = preview ?? cursor ?? session.steps.length - 1;
  const focused = focusIndex >= 0 ? session.steps[focusIndex] : null;
  const row = ({ event, world, index }: { event: Event; world: World; index: number }, nested = false) => (
    <Row
      key={index}
      step={index}
      active={focusIndex === index}
      later={cursor !== null && index > cursor}
      nested={nested}
      onEnter={() => onPreview(index)}
      onClick={() => onPick(index)}
      time={ordinal(index + 1)}
      title={timelineText(spec, event, world)}
      who={`${labelOf(world, event.instance)} · ${stepTitle(spec, event)}`}
      flag={event.error || event.violations.length ? "broken" : event.kind === "lose" || event.kind === "restart" ? kindLabel(event) : null}
    />
  );
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-kumo-elevated/95 shadow-xl backdrop-blur-sm ring-1 ring-kumo-line">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Tabs
          size="sm"
          value={tab}
          onValueChange={(value) => value && onTab(value as TimelineTab)}
          tabs={[{ value: "timeline", label: "Timeline" }, { value: "code", label: "Code" }, { value: "details", label: "Details" }]}
        />
        {tab !== "details" && <span className="ml-auto text-xs tabular-nums text-kumo-subtle">{count} events</span>}
        {tab === "timeline" && actions}
      </div>
      {tab === "timeline" ? <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onMouseLeave={() => onPreview(null)}>
        <Row
          step={-1}
          active={focusIndex === -1}
          onEnter={() => onPreview(-1)}
          onClick={() => onPick(-1)}
          time={ordinal(0)}
          title={session.origin === "New scenario" ? "The start" : `Start of “${session.origin}”`}
          who={session.initial.instances.map((i) => i.label).join(", ") || "Nobody yet"}
        />
        {entries.map((entry) => {
          if (entry.kind === "event") return row(entry);
          const first = entry.events[0];
          const expanded = open.has(first.index);
          const lastIndex = entry.events.at(-1)!.index;
          const inside = entry.fold.startsWith("inside:") ? entry.fold.slice(7) : null;
          const names = inside ? [`inside ${inside}`] : [...new Set(entry.events.map((e) => stepTitle(spec, e.event)))];
          return (
            <div key={`fold-${first.index}`}>
              <button
                type="button"
                aria-expanded={expanded}
                onMouseEnter={() => onPreview(lastIndex)}
                onClick={() => setOpen((s) => new Set(s.has(first.index) ? [...s].filter((x) => x !== first.index) : [...s, first.index]))}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-kumo-subtle hover:bg-kumo-tint",
                  cursor !== null && first.index > cursor && "opacity-45",
                  !expanded && focusIndex >= first.index && focusIndex <= lastIndex && "bg-kumo-tint",
                )}
              >
                <span className="w-11 shrink-0 text-right font-mono text-[11px] tabular-nums">{ordinal(first.index + 1)}</span>
                {inside ? <CornersInIcon size={14} className="shrink-0" /> : <HeartbeatIcon size={14} className="shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  {names.join(", ")} <span className="tabular-nums">{inside ? `· ${entry.events.length} steps` : `×${entry.events.length}`}</span>
                </span>
                <CaretRightIcon size={12} className={cn("shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
              </button>
              {expanded && entry.events.map((e) => row(e, true))}
            </div>
          );
        })}
      </div> : tab === "code" ? <div className="min-h-0 flex-1 overflow-y-auto">
        <CodeTrace session={session} focus={focusIndex} cursor={cursor} onPreview={onPreview} onPick={onPick} />
      </div> : <div className="min-h-0 flex-1 overflow-y-auto">{details}</div>}
      {tab === "timeline" && focused?.event && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-kumo-line px-4 py-3">
          <EventDetail event={focused.event} world={focused.world} folded />
        </div>
      )}
    </aside>
  );
}

/** The bubble's sentence, said by whom: a `say` line needs its speaker away from the node. */
function timelineText(spec: Spec, event: Event, world: World): string {
  const text = bubbleText(spec, event, world);
  const label = labelOf(world, event.instance);
  return event.kind === "lose" || text.startsWith(`${label}:`) ? text : `${label}: ${text}`;
}

function Row({
  step,
  active,
  later,
  nested,
  onEnter,
  onClick,
  time,
  title,
  who,
  flag,
}: {
  step: number;
  active: boolean;
  later?: boolean;
  nested?: boolean;
  onEnter: () => void;
  onClick: () => void;
  time: string;
  title: string;
  /** Who did what, for the tooltip. */
  who: string;
  flag?: string | null;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onEnter}
      onFocus={onEnter}
      onClick={onClick}
      data-step={step}
      title={`${who}. Click to travel back to this moment.`}
      className={cn("flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-kumo-tint", active && "bg-kumo-tint ring-1 ring-kumo-line", later && "opacity-45", nested && "pl-6")}
    >
      <span className="w-11 shrink-0 text-right font-mono text-[11px] tabular-nums text-kumo-subtle">{time}</span>
      <span className={cn("min-w-0 flex-1 text-[12.5px] font-medium leading-snug line-clamp-2", flag === "broken" && "text-kumo-danger")}>{title}</span>
      {flag && <Badge variant={flag === "broken" ? "error" : "warning"}>{flag}</Badge>}
    </button>
  );
}
