// The timeline: the event log of a playground session. Hovering an event peeks at the world
// as it was then; clicking travels back to it, without forgetting what came after until
// something else is done there. The focused event's detail sits at the bottom, with its code.
import { Badge, cn } from "@cloudflare/kumo";
import { useEffect, useRef } from "react";
import type { Event } from "@feynman/spec";
import { clock, kindLabel, labelOf, stepTitle } from "./format";
import { bubbleText } from "./playground/Stage";
import type { Session } from "./session";
import { EventDetail, useExplorer } from "./ui";

export function Timeline({
  session,
  preview,
  cursor,
  onPreview,
  onPick,
}: {
  session: Session;
  preview: number | null;
  /** The moment travelled back to; later events are greyed out. */
  cursor: number | null;
  onPreview: (index: number | null) => void;
  onPick: (index: number) => void;
}) {
  const { spec } = useExplorer();
  const list = useRef<HTMLDivElement>(null);
  const steps = session.steps.map((s, index) => ({ ...s, index })).filter((s): s is { event: Event; world: typeof s.world; index: number } => s.event !== null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [session.steps.length]);
  useEffect(() => {
    if (cursor !== null) list.current?.querySelector(`[data-step="${cursor}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);
  const focusIndex = preview ?? cursor ?? session.steps.length - 1;
  const focused = focusIndex >= 0 ? session.steps[focusIndex] : null;
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-kumo-hairline bg-kumo-base">
      <div className="flex items-baseline gap-2 px-4 pb-2 pt-3">
        <span className="text-sm font-semibold">Timeline</span>
        <span className="ml-auto text-xs text-kumo-subtle">{steps.length} events</span>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1" onMouseLeave={() => onPreview(null)}>
        <Row
          active={focusIndex === -1}
          previewed={preview === -1}
          onEnter={() => onPreview(-1)}
          onClick={() => onPick(-1)}
          step={-1}
          time="0.00s"
          title={session.origin === "Fresh start" ? "The start" : `Start of “${session.origin}”`}
          subtitle={session.initial.instances.map((i) => i.label).join(", ") || "Nobody yet"}
        />
        {steps.map(({ event, world, index }) => (
          <Row
            key={index}
            active={focusIndex === index}
            previewed={preview === index}
            onEnter={() => onPreview(index)}
            onClick={() => onPick(index)}
            step={index}
            later={cursor !== null && index > cursor}
            time={clock(event.at)}
            title={bubbleText(spec, event, world)}
            subtitle={`${labelOf(world, event.instance)} · ${stepTitle(spec, event)}`}
            kind={kindLabel(event)}
            bad={Boolean(event.error || event.violations.length)}
            fault={event.kind === "lose" || event.kind === "restart"}
          />
        ))}
      </div>
      {focused?.event && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-t border-kumo-hairline px-3 py-3">
          <EventDetail event={focused.event} world={focused.world} />
        </div>
      )}
    </aside>
  );
}

function Row({
  active,
  previewed,
  onEnter,
  onClick,
  time,
  title,
  subtitle,
  kind,
  bad,
  fault,
  step,
  later,
}: {
  step: number;
  later?: boolean;
  active: boolean;
  previewed: boolean;
  onEnter: () => void;
  onClick: () => void;
  time: string;
  title: string;
  subtitle: string;
  kind?: string;
  bad?: boolean;
  fault?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onEnter}
      onFocus={onEnter}
      onClick={onClick}
      data-step={step}
      title="Travel back to this moment"
      className={cn(later && "opacity-45", "mx-2 flex w-[calc(100%-1rem)] items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-kumo-tint", active && "bg-kumo-tint ring-1 ring-kumo-line", previewed && "bg-kumo-tint")}
    >
      <span className="w-11 shrink-0 pt-px text-right font-mono text-[10.5px] font-semibold text-kumo-subtle">{time}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[12.5px] font-medium leading-snug", bad && "text-kumo-danger")}>{title}</span>
        <span className="block truncate text-[11px] text-kumo-subtle">{subtitle}</span>
      </span>
      {kind && (fault || bad) && <Badge variant={bad ? "error" : "warning"}>{bad ? "broken" : kind}</Badge>}
    </button>
  );
}
