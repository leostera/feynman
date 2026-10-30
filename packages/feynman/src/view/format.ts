// Words and numbers as the explorer shows them.
import { deliveryName } from "../spec/engine.ts";
import type { Event, Spec, World } from "../spec/index.ts";

/** An event's place in a run, counted from 1: specs have no clock (RFD0004), events have an order. */
export function ordinal(position: number): string {
  return `#${position}`;
}

/** Real time in words, such as how long a check took: 50ms, 9.95s, 10min. */
export function time(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(2)}s`;
  if (ms < 3_600_000) return `${+(ms / 60_000).toFixed(1)}min`;
  return `${+(ms / 3_600_000).toFixed(1)}h`;
}

/** For JSON.stringify: sets as arrays and maps as objects, which plain JSON writes as `{}`. */
export function asJson(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

export function short(value: unknown, max = 48): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const text = JSON.stringify(value, asJson);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function messageName(spec: Spec, key: string): string {
  // A call's failure (RFD0009) is named for the call: "charge failed".
  if (key.startsWith("failed:")) return `${messageName(spec, key.slice("failed:".length))} failed`;
  return spec.messages[key]?.name ?? key.replace(/^message:/, "");
}

/** How a message reads on screen; a call's failure reads as refused. */
export function messageTone(spec: Spec, key: string): Spec["messages"][string]["tone"] | undefined {
  return key.startsWith("failed:") ? "refused" : spec.messages[key]?.tone;
}

export function labelOf(world: World | undefined, id: string): string {
  return world?.instances.find((i) => i.id === id)?.label ?? id;
}

/** What an event is called: the action's label, the message's name, the timer's key. */
export function stepTitle(spec: Spec, event: Event): string {
  switch (event.kind) {
    case "spawn":
      return "joins";
    case "restart":
      return "restarts";
    case "lose":
      return `${messageName(spec, event.message ?? event.key)} is lost`;
    case "action":
      return spec.actors.find((a) => a.name === event.actor)?.actions[event.key]?.label ?? event.key;
    case "deliver":
      return deliveryName(spec, event);
    default:
      return event.key;
  }
}

export function kindLabel(event: Event): string {
  return { spawn: "joins", action: "action", deliver: "receives", timer: "timer", guard: "when", lose: "fault", restart: "fault" }[event.kind];
}

/** The repository file link for a source, from the code host's file URL. */
export function sourceUrl(fileUrl: string | null, path: string, start?: number, end?: number): string | null {
  if (!fileUrl) return null;
  const base = fileUrl.replace("{path}", path);
  if (!start) return base;
  return /gitlab/.test(fileUrl) ? `${base}#L${start}-${end ?? start}` : `${base}#L${start}-L${end ?? start}`;
}
