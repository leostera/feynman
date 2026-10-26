// Words and numbers as the explorer shows them.
import type { Event, Spec, World } from "../spec/index.ts";

/** A moment on the clock, like a stopwatch: 0.65s, 4.20s, 1:48.4, 2:03:10. */
export function clock(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** A duration in words: 50ms, 9.95s, 10min. */
export function time(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(2)}s`;
  if (ms < 3_600_000) return `${+(ms / 60_000).toFixed(1)}min`;
  return `${+(ms / 3_600_000).toFixed(1)}h`;
}

export function short(value: unknown, max = 48): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function messageName(spec: Spec, key: string): string {
  return spec.messages[key]?.name ?? key.replace(/^message:/, "");
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
      return messageName(spec, event.key);
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
