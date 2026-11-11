// The explain kit's data figures: numbers, charts, scales and anatomies. Each takes its data
// as props and works its own arithmetic out (ratios, shares, maxima), so a figure never says
// something its numbers don't. Every one can name where its numbers came from.
import { cn } from "@cloudflare/kumo";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The palette figures share: a stroke, and a fill mixed from it, legible in light and dark. */
export type Tone = "blue" | "green" | "orange" | "purple" | "red" | "grey";

const STROKE: Record<Tone, string> = {
  blue: "var(--explain-blue)",
  green: "var(--explain-green)",
  orange: "var(--explain-orange)",
  purple: "var(--explain-purple)",
  red: "var(--explain-red)",
  grey: "var(--explain-grey)",
};

export const stroke = (tone: Tone = "blue") => STROKE[tone];
export const fill = (tone: Tone = "blue", strength = 14) => `color-mix(in oklab, ${STROKE[tone]} ${strength}%, var(--color-kumo-base))`;

/** 17_000_000 → "17M", 902_000 → "902k", 0.8 → "0.8". */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const round = (x: number) => (x >= 100 ? Math.round(x).toString() : x >= 10 ? x.toFixed(1).replace(/\.0$/, "") : x.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e9) return `${round(n / 1e9)}B`;
  if (abs >= 1e6) return `${round(n / 1e6)}M`;
  if (abs >= 1e3) return `${round(n / 1e3)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(abs < 10 ? 1 : 0);
}

/** A chip naming where numbers came from. */
export function Source({ children }: { children: ReactNode }) {
  return <span className="ml-1 inline-flex rounded-full px-1.5 py-px align-middle text-[11px] text-kumo-subtle ring-1 ring-kumo-line">{children}</span>;
}

/** The words under a figure, inside its frame. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className="explain-caption mt-4 text-sm leading-relaxed text-kumo-subtle text-pretty">{children}</p>;
}

// Stats --------------------------------------------------------------------------------------------

export function Stats({ children, columns = 3 }: { children: ReactNode; columns?: number }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

export function Stat({ value, label, tone, source }: { value: number | string; label: ReactNode; tone?: Tone; source?: string }) {
  return (
    <div className="rounded-xl bg-kumo-base px-4 py-3 ring-1 ring-kumo-hairline">
      <div className="text-3xl font-semibold tracking-tight" style={{ color: tone ? stroke(tone) : undefined }}>
        {typeof value === "number" ? compact(value) : value}
      </div>
      <div className="mt-1 text-sm text-kumo-subtle">
        {label}
        {source && <Source>{source}</Source>}
      </div>
    </div>
  );
}

// Columns: small multiples of a series over time -------------------------------------------------

export interface Series {
  title: string;
  values: number[];
  tone?: Tone;
  /** Labels under the first and last column. */
  from?: string;
  to?: string;
  /** What the last column is called in the headline: "last week". */
  last?: string;
}

/** Each series as columns, with its growth (last ÷ first) and last value worked out. */
export function Columns({ series, height = 96 }: { series: Series[]; height?: number }) {
  return (
    <div className="grid gap-x-10 gap-y-6" style={{ gridTemplateColumns: `repeat(${Math.min(series.length, 2)}, minmax(0, 1fr))` }}>
      {series.map((s) => {
        const max = Math.max(...s.values, 1);
        const first = s.values.find((v) => v > 0) ?? 0;
        const last = s.values.at(-1) ?? 0;
        const growth = first ? last / first : null;
        return (
          <div key={s.title}>
            <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold">{s.title}</span>
              <span className="text-kumo-subtle">
                {growth !== null && <b className="text-kumo-default">×{growth >= 10 ? Math.round(growth) : growth.toFixed(1)}</b>} · {s.last ?? "last"} {compact(last)}
              </span>
            </div>
            <div className="flex items-end gap-1" style={{ height }}>
              {s.values.map((v, i) => (
                <div
                  key={i}
                  title={`${compact(v)}`}
                  className="flex-1 rounded-[3px]"
                  style={{ height: `${Math.max(2, (v / max) * 100)}%`, background: fill(s.tone, i === s.values.length - 1 ? 26 : 14), boxShadow: `inset 0 0 0 1.5px ${stroke(s.tone)}` }}
                />
              ))}
            </div>
            {(s.from || s.to) && (
              <div className="mt-1 flex justify-between text-[11px] text-kumo-subtle">
                <span>{s.from}</span>
                <span>{s.to}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Bars: one row per thing, longest first or in the order given --------------------------------

export interface Bar {
  label: ReactNode;
  value: number;
  tone?: Tone;
  note?: ReactNode;
}

export function Bars({ rows, sort = false, format = compact, mono = false }: { rows: Bar[]; sort?: boolean; format?: (n: number) => string; mono?: boolean }) {
  const shown = sort ? [...rows].sort((a, b) => b.value - a.value) : rows;
  const max = Math.max(...shown.map((r) => r.value), 1e-9);
  return (
    <div className="grid items-center gap-x-3 gap-y-1.5" style={{ gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)" }}>
      {shown.map((r, i) => (
        <div key={i} className="contents">
          <div className={cn("truncate text-right text-[13px]", mono && "font-mono text-xs")}>{r.label}</div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-[18px] shrink-0 rounded-[4px]" style={{ width: `calc(${(r.value / max) * 72}% + 4px)`, background: fill(r.tone), boxShadow: `inset 0 0 0 1.5px ${stroke(r.tone)}` }} />
            <span className="shrink-0 text-xs font-semibold">{format(r.value)}</span>
            {r.note && <span className="truncate text-[11px] text-kumo-subtle">{r.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Share: parts of one whole, as one bar ----------------------------------------------------------

export interface Part {
  label: string;
  value: number;
  tone?: Tone;
  note?: string;
}

/** One bar split by share, shares worked out from the values; the first part is named inside it. */
export function Share({ parts, total: given }: { parts: Part[]; total?: number }) {
  const total = given ?? parts.reduce((sum, p) => sum + p.value, 0);
  const pct = (v: number) => (v / total) * 100;
  const shown = (v: number) => {
    const p = pct(v);
    return `${p >= 10 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3)}%`;
  };
  const [head, ...rest] = parts;
  return (
    <div>
      <div className="flex h-9 w-full overflow-hidden rounded-md" style={{ boxShadow: "inset 0 0 0 1px var(--color-kumo-line)" }}>
        {parts.map((p, i) => (
          <div key={p.label} className="flex h-full items-center overflow-hidden whitespace-nowrap px-3 text-sm font-semibold" style={{ width: `max(${pct(p.value)}%, 3px)`, background: fill(p.tone, 22), boxShadow: `inset 0 0 0 1.5px ${stroke(p.tone)}` }}>
            {i === 0 && `${p.label} · ${shown(p.value)}`}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-col items-end gap-0.5 text-xs">
        {rest.map((p) => (
          <span key={p.label}>
            <b style={{ color: p.tone === "red" ? stroke("red") : undefined }}>
              {p.label} · {shown(p.value)}
            </b>{" "}
            <span className="text-kumo-subtle">
              ({p.note ? `${p.note}; ` : ""}
              {compact(p.value)} of {compact(total)})
            </span>
          </span>
        ))}
      </div>
      {head && <span className="sr-only">{head.label}</span>}
    </div>
  );
}

// Ranges: percentiles on a log scale ------------------------------------------------------------

export interface Range {
  label: string;
  p50: number;
  p90: number;
  p99: number;
  tone?: Tone;
}

/** Durations in ms: 48 → "48", 1100 → "1.1s". */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1).replace(/\.0$/, "")}s` : String(Math.round(ms));
}

export function Ranges({ rows, marks = [], ticks = [20, 100, 1000, 10_000, 60_000, 100_000] }: { rows: Range[]; marks?: { at: number; label: string; tone?: Tone }[]; ticks?: number[] }) {
  const lo = Math.log10(Math.min(...ticks));
  const hi = Math.log10(Math.max(...ticks));
  const x = (ms: number) => `${((Math.log10(Math.max(ms, 1)) - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="grid gap-x-4" style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}>
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <div className="flex h-10 items-center justify-end text-[13px]">{r.label}</div>
          <div className="relative h-10">
            {ticks.map((t) => <div key={t} className="absolute inset-y-0 w-px bg-kumo-hairline" style={{ left: x(t) }} />)}
            {marks.map((m) => <div key={m.label} className="absolute inset-y-0 border-l border-dashed" style={{ left: x(m.at), borderColor: stroke(m.tone ?? "red") }} />)}
            <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded" style={{ left: x(r.p50), width: `calc(${x(r.p99)} - ${x(r.p50)})`, background: fill(r.tone, 45) }} />
            <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(r.p50), background: stroke(r.tone) }} />
            <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-kumo-base" style={{ left: x(r.p90), boxShadow: `inset 0 0 0 2px ${stroke(r.tone)}` }} />
            <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ left: x(r.p99), background: fill(r.tone, 70) }} />
            <span className="absolute top-0 -translate-x-1/2 text-[10px] text-kumo-subtle" style={{ left: x(r.p50) }}>{duration(r.p50)}</span>
            <span className="absolute top-0 -translate-x-1/2 text-[10px] text-kumo-subtle" style={{ left: x(r.p99) }}>{duration(r.p99)}</span>
          </div>
        </div>
      ))}
      <div />
      <div className="relative h-5 text-[10px] text-kumo-subtle">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: x(t) }}>{duration(t).replace(/^(\d+)$/, "$1 ms")}</span>)}
      </div>
      <div />
      <div className="flex gap-4 text-[11px] text-kumo-subtle">
        <span>● p50</span>
        <span>○ p90</span>
        <span>■ p99 (log scale)</span>
        {marks.map((m) => (
          <span key={m.label} style={{ color: stroke(m.tone ?? "red") }}>
            ┆ {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Scale: where values sit between zero and a limit ------------------------------------------

export function Scale({ max, fill: filled, marks: given }: { max: number; fill?: { value: number; tone?: Tone }; marks: { at: number; label: string; tone?: Tone; below?: boolean }[] }) {
  const x = (v: number) => `${(v / max) * 100}%`;
  // Labels too close to the one before them above the bar go below it.
  let lastAbove = -Infinity;
  const marks = [...given]
    .sort((a, b) => a.at - b.at)
    .map((m) => {
      const below = m.below ?? (m.at - lastAbove) / max < 0.3;
      if (!below) lastAbove = m.at;
      return { ...m, below };
    });
  return (
    <div className="relative px-1 pb-7 pt-7">
      <div className="relative h-9 rounded-md bg-kumo-tint" style={{ boxShadow: "inset 0 0 0 1px var(--color-kumo-line)" }}>
        {filled && <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: x(filled.value), background: fill(filled.tone ?? "green", 22), boxShadow: `inset 0 0 0 1.5px ${stroke(filled.tone ?? "green")}` }} />}
        {marks.map((m) => (
          <div key={m.label} className="absolute -bottom-2 -top-2 w-0.5" style={{ left: x(m.at), background: stroke(m.tone ?? "grey") }}>
            <span className={cn("absolute whitespace-nowrap text-xs font-semibold", m.below ? "top-full mt-1" : "bottom-full mb-1", m.at / max > 0.8 ? "right-0" : "-translate-x-1/2")} style={{ color: m.tone === "red" ? stroke("red") : undefined }}>
              {m.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Anatomy: a string taken apart -----------------------------------------------------------------

export interface Piece {
  text: string;
  tone?: Tone;
  label?: string;
  sub?: string;
}

/** A token, URL or key, each labelled part pointed at from below. */
export function Anatomy({ parts }: { parts: Piece[] }) {
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const [centres, setCentres] = useState<number[]>([]);
  useLayoutEffect(() => {
    const left = box.current?.getBoundingClientRect().left ?? 0;
    setCentres(refs.current.map((el) => (el ? el.getBoundingClientRect().left - left + el.getBoundingClientRect().width / 2 : 0)));
  }, [parts]);
  const labelled = parts.map((p, i) => ({ ...p, i })).filter((p) => p.label);
  // Labels spread evenly under the string, each pointed at from its part.
  const width = box.current?.clientWidth ?? 600;
  const slot = width / Math.max(labelled.length, 1);
  return (
    <div ref={box} className="relative w-full">
      <div className="font-mono text-2xl tracking-tight">
        {parts.map((p, i) => (
          <span key={i} ref={(el) => void (refs.current[i] = el)} style={{ color: p.tone ? stroke(p.tone) : "var(--text-color-kumo-subtle)", fontWeight: p.tone ? 600 : 400 }}>
            {p.text}
          </span>
        ))}
      </div>
      <svg className="mt-1 block h-10 w-full overflow-visible" aria-hidden>
        {labelled.map((p, k) => (
          <line key={p.i} x1={centres[p.i] ?? 0} y1={2} x2={slot * k + slot / 2} y2={36} stroke="var(--color-kumo-line-strong, #999)" strokeWidth={1.2} markerEnd="url(#explain-head)" />
        ))}
        <defs>
          <marker id="explain-head" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--color-kumo-line-strong, #999)" />
          </marker>
        </defs>
      </svg>
      <div className="grid text-center" style={{ gridTemplateColumns: `repeat(${labelled.length}, minmax(0, 1fr))` }}>
        {labelled.map((p) => (
          <div key={p.i} className="px-1">
            <div className="text-xs">{p.label}</div>
            {p.sub && <div className="text-[11px] text-kumo-subtle">{p.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
