// The timeline: the event log of a playground session. Hovering an event shows the world
// as it was then; clicking rolls the session back to it. The focused event's detail sits
// at the bottom, with its code.
import { Badge, cn, Select } from "@cloudflare/kumo";
import { useEffect, useRef } from "react";
import type { Event } from "@feynman/spec";
import { kindLabel, labelOf, stepTitle, time } from "./format";
import type { ReactNodeMenu } from "./Playground";
import type { Session } from "./session";
import { EventDetail, useExplorer } from "./ui";

export function Timeline({
  session,
  preview,
  onPreview,
  onRollback,
  scenarios,
}: {
  session: Session;
  preview: number | null;
  onPreview: (index: number | null) => void;
  onRollback: (count: number) => void;
  scenarios: ReactNodeMenu;
}) {
  const { spec } = useExplorer();
  const list = useRef<HTMLDivElement>(null);
  const steps = session.steps.map((s, index) => ({ ...s, index })).filter((s): s is { event: Event; world: typeof s.world; index: number } => s.event !== null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [session.steps.length]);
  const focusIndex = preview ?? session.steps.length - 1;
  const focused = focusIndex >= 0 ? session.steps[focusIndex] : null;
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-kumo-hairline bg-kumo-base">
      <div className="flex items-center gap-2 border-b border-kumo-hairline px-3 py-2">
        <Select size="sm" aria-label="Start from" className="min-w-0 flex-1" value={session.origin} onValueChange={(v) => scenarios.onPick(String(v))} items={scenarios.items} />
        <span className="shrink-0 text-xs text-kumo-subtle">{steps.length} events</span>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1" onMouseLeave={() => onPreview(null)}>
        <Row
          active={focusIndex === -1}
          previewed={preview === -1}
          onEnter={() => onPreview(-1)}
          onClick={() => onRollback(0)}
          time="0ms"
          title="The start"
          subtitle={session.initial.instances.map((i) => i.label).join(", ") || "Nobody yet"}
        />
        {steps.map(({ event, world, index }) => (
          <Row
            key={index}
            active={focusIndex === index}
            previewed={preview === index}
            onEnter={() => onPreview(index)}
            onClick={() => onRollback(index + 1)}
            time={time(event.at)}
            title={`${labelOf(world, event.instance)} · ${stepTitle(spec, event)}`}
            subtitle={event.description}
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
}: {
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
      title="Go back to this moment"
      className={cn("flex w-full items-start gap-2 border-l-2 border-transparent px-3 py-1.5 text-left hover:bg-kumo-tint", active && "border-kumo-brand bg-kumo-tint", previewed && "bg-kumo-tint")}
    >
      <span className="w-12 shrink-0 pt-px text-right font-mono text-[10.5px] text-kumo-subtle">{time}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-xs font-medium", bad && "text-kumo-danger")}>{title}</span>
        <span className="block truncate text-[11px] text-kumo-subtle">{subtitle}</span>
      </span>
      {kind && (fault || bad) && <Badge variant={bad ? "error" : "warning"}>{bad ? "broken" : kind}</Badge>}
    </button>
  );
}
