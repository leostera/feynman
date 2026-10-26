// The kit: what the playground draws with, and what playground files compose. Small and
// quiet on purpose: thin rings, 12px names, 10px detail, colour only where it says
// something. Kumo tokens only, so light and dark both work.
import { cn } from "@cloudflare/kumo";
import { TicketIcon, XIcon } from "@phosphor-icons/react";
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { Icon as IconName, Mood, Row, Shape } from "../spec/index.ts";
import { iconFor, labelInside, moodColor, telling } from "./look.tsx";

// Context ------------------------------------------------------------------------------------------

/** What the playground tells the kit: whose colour an instance wears. */
export interface PlayContextValue {
  /** The identity colour of an instance, by id or label. */
  colorOf: (ref: string | null | undefined) => string | undefined;
}

const PlayContext = createContext<PlayContextValue>({ colorOf: () => undefined });
export const PlayProvider = PlayContext.Provider;
export const usePlay = () => useContext(PlayContext);

// Formatting ---------------------------------------------------------------------------------------

/** Time left as a person reads it: "9:58", "42s", "expired". */
export function countdown(left: number): string {
  if (left <= 0) return "expired";
  const s = Math.ceil(left / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Icons --------------------------------------------------------------------------------------------

export function Icon({ name, size = 16, className, style }: { name: IconName | null | undefined; size?: number; className?: string; style?: CSSProperties }) {
  const Glyph = iconFor(name ?? null);
  return <Glyph size={size} weight="duotone" className={className} style={style} />;
}

// Nodes --------------------------------------------------------------------------------------------

export interface NodeBadge {
  /** One or two characters: an initial. */
  text: string;
  color: string;
  title?: string;
}

export interface NodeVisualProps {
  shape: Shape;
  icon?: IconName | null;
  label: string;
  status?: string | null;
  /** Colours the ring when it says something (ok, busy, warn, bad); otherwise the ring is neutral. */
  mood?: Mood | null;
  /** A ring colour that wins over the mood's. */
  ring?: string;
  /** Services in a region wear the region's accent on their ring and icon. */
  accent?: string;
  /** Whose it is: a small initial in their colour. */
  badge?: NodeBadge | null;
  /** The name inside the shape; by default for services and gates. */
  inside?: boolean;
  className?: string;
  /** Classes for the shape itself, such as an animation that should follow its outline. */
  shapeClassName?: string;
}

const SHAPE_SIZE: Record<Shape, string> = {
  circle: "size-[60px] rounded-full",
  device: "size-[54px] rounded-[16px]",
  gate: "h-[84px] w-[60px] rounded-[14px]",
  card: "h-[48px] w-[132px] rounded-xl",
};

/** A node as the playground draws it: a shape with an icon, its name, and a few words. */
export function Node({ shape, icon, label, status, mood, ring, accent, badge, inside, className, shapeClassName }: NodeVisualProps) {
  const within = inside ?? labelInside(shape, icon, label);
  const edge = ring ?? (telling(mood) ? moodColor(mood) : (accent ?? "var(--color-kumo-line)"));
  const body = (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center bg-kumo-elevated transition-[box-shadow,scale] duration-200 ease-out group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-kumo-focus",
        SHAPE_SIZE[shape],
        shape === "circle" && within && "size-[72px]",
        shape === "gate" && !within && "h-[68px]",
        (shape === "gate" || shape === "card" || within) && "flex-col gap-0.5",
        shape === "card" && "flex-row justify-start gap-2 px-2.5",
        mood === "busy" && "feynman-busy",
        shapeClassName,
      )}
      style={{ boxShadow: `0 0 0 2px ${edge}` }}
    >
      <Icon name={icon} size={within && shape !== "card" ? 24 : 26} style={accent ? { color: accent } : undefined} />
      {within && (
        <span className={cn("flex min-w-0 flex-col", shape === "card" ? "items-start" : "items-center px-1 text-center")}>
          <span className="max-w-[64px] truncate text-[11px] font-semibold leading-tight" title={label}>
            {label}
          </span>
          {shape !== "circle" && status && <span className="max-w-[64px] truncate text-[11px] leading-tight text-kumo-subtle">{status}</span>}
        </span>
      )}
      {badge && (
        <span
          className="absolute -right-1 -top-1 flex size-[18px] items-center justify-center rounded-full text-[10px] font-bold text-kumo-inverse ring-2 ring-kumo-canvas"
          style={{ background: badge.color }}
          title={badge.title}
        >
          {badge.text}
        </span>
      )}
    </span>
  );
  const below = within ? (shape === "circle" ? status : null) : null;
  return (
    <span className={cn("flex flex-col items-center gap-1", className)}>
      {body}
      {!within && (
        <span className="flex max-w-[124px] flex-col items-center">
          <span className="max-w-full truncate text-[12px] font-semibold leading-tight" title={label}>
            {label}
          </span>
          {status && <span className="max-w-full truncate text-[11px] leading-tight text-kumo-subtle">{status}</span>}
        </span>
      )}
      {below && <span className="max-w-[240px] truncate text-[11px] leading-tight text-kumo-subtle">{below}</span>}
    </span>
  );
}

// Rows ---------------------------------------------------------------------------------------------

/**
 * State as structure: rows boxed by group. A group belonging to someone wears their colour.
 * `anchor` marks each row so live links can end at it.
 */
export function Rows({ rows, anchor, compact, limit, className }: { rows: Row[]; anchor?: string; compact?: boolean; limit?: number; className?: string }) {
  const { colorOf } = usePlay();
  const max = limit ?? (compact ? 3 : 6);
  const dot = (row: Row) => (row.mood ? moodColor(row.mood) : (colorOf(row.owner) ?? moodColor(null)));
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.group ?? "", [...(groups.get(row.group ?? "") ?? []), row]);
  if (!rows.length) return null;
  return (
    <div className={cn("flex min-h-0 flex-col gap-2 overflow-hidden", className)}>
      {[...groups].map(([group, items]) => {
        const owner = colorOf(items.find((r) => r.owner)?.owner);
        return (
          // A border, not an outer ring: the list clips what is outside its boxes, which cut a ring's edges.
          <div key={group} className="shrink-0 overflow-hidden rounded-lg border-solid bg-kumo-base" style={{ borderWidth: owner ? 1.5 : 1, borderColor: owner ?? "var(--color-kumo-line)" }}>
            {group && (
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5">
                <span className="size-2 rounded-full" style={{ background: owner ?? "var(--color-kumo-line)" }} />
                <span className="truncate text-[12px] font-semibold">{group}</span>
              </div>
            )}
            <div className={cn("flex flex-col divide-y divide-kumo-hairline", compact ? "py-0.5" : "pb-0.5")}>
              {items.slice(0, max).map((row, i) => (
                <div key={i} data-row={anchor ? `${anchor}::${row.label}` : undefined} className={cn("flex min-w-0 items-center gap-1.5 px-2.5", compact ? "py-0.5" : "py-1")}>
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot(row) }} />
                  <span className="min-w-0 truncate text-[11.5px]">{row.label}</span>
                  {row.detail && <span className="ml-auto truncate pl-2 font-mono text-[11px] text-kumo-subtle">{row.detail}</span>}
                </div>
              ))}
              {items.length > max && <div className="px-2.5 py-1 text-[11px] text-kumo-subtle">+{items.length - max} more</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A small titled box: a host_link record, a Settings pane. */
export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-md bg-kumo-base px-2 py-1 ring-1 ring-kumo-line", className)}>
      {title && <div className="text-[11px] text-kumo-subtle">{title}</div>}
      <div className="text-[11px] leading-snug">{children}</div>
    </div>
  );
}

export function Badge({ children, mood }: { children: ReactNode; mood?: Mood }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-kumo-base px-1.5 py-px text-[11px] ring-1 ring-kumo-line">
      <span className="size-1.5 rounded-full" style={{ background: moodColor(mood) }} />
      {children}
    </span>
  );
}

// Tokens -------------------------------------------------------------------------------------------

/** Something to hand over: a code on a ticket, with the time it has left. */
export function Ticket({ code, left, label }: { code: string; left?: number | null; label?: string }) {
  const expired = left !== undefined && left !== null && left <= 0;
  return (
    <span
      className={cn("flex items-center gap-1 whitespace-nowrap rounded-md border-2 border-dashed bg-kumo-warning-tint px-1.5 py-0.5 font-mono text-[11.5px] font-bold", expired && "opacity-50 line-through")}
      style={{ borderColor: "var(--color-kumo-warning)" }}
      title={label}
    >
      <TicketIcon size={13} weight="duotone" className="text-kumo-warning" />
      {code}
      {left !== undefined && left !== null && <span className="font-sans text-[11px] font-normal text-kumo-subtle">{countdown(left)}</span>}
    </span>
  );
}

// Panels -------------------------------------------------------------------------------------------

/** A terminal beside a node: what came back, and commands to click. */
export function Terminal({
  title,
  lines,
  commands = [],
  onRun,
  onClose,
  busy,
}: {
  title: string;
  lines: string[];
  commands?: string[];
  onRun?: (command: string) => void;
  onClose?: () => void;
  /** Waiting for an answer. */
  busy?: boolean;
}) {
  return (
    // A terminal is dark in either mode: Kumo's dark tokens, scoped to it.
    <div data-mode="dark" style={{ colorScheme: "dark" }} className="w-56 rounded-lg bg-kumo-recessed p-2 text-kumo-default shadow-xl ring-1 ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center justify-between text-[11px] text-kumo-subtle">
        <span className="truncate">{title}</span>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close the terminal" className="rounded p-0.5 hover:bg-kumo-tint">
            <XIcon size={10} />
          </button>
        )}
      </div>
      <pre className="m-0 min-h-12 overflow-hidden whitespace-pre-wrap font-mono text-[11px] leading-4 text-kumo-success">
        {lines.slice(-4).join("\n") || " "}
        {busy && <span className="animate-pulse">▍</span>}
      </pre>
      {commands.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {commands.map((command) => (
            <button
              key={command}
              type="button"
              disabled={!onRun}
              onClick={() => onRun?.(command)}
              className="rounded bg-kumo-fill px-1.5 py-0.5 font-mono text-[11px] hover:bg-kumo-fill-hover disabled:opacity-40"
            >
              {command}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A plain panel beside a node, for anything else. */
export function Panel({ title, children, onClose }: { title?: ReactNode; children: ReactNode; onClose?: () => void }) {
  return (
    <div className="w-56 rounded-lg bg-kumo-elevated p-2 shadow-xl ring-1 ring-kumo-line" onClick={(e) => e.stopPropagation()}>
      {(title || onClose) && (
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold">
          <span className="truncate">{title}</span>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-tint">
              <XIcon size={10} />
            </button>
          )}
        </div>
      )}
      <div className="text-[11px]">{children}</div>
    </div>
  );
}
