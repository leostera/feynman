// @leostera/feynman/explain (RFD0013, spike): what an explainer's own figures are drawn with.
// An explainer file (`specs/<name>.explainer.tsx`) exports React components, which the
// markdown places with `::figure{name="…"}`. They draw with the playground's pieces, fed by
// recorded runs of the spec, so a picture shows what the spec does, in the explorer's look.
//
// These are declarations: the page hands an explainer module the real ones (view/explainKit.tsx),
// as it hands playground modules the kit.
import type { ReactNode } from "react";
import type { Event, World } from "../spec/index.ts";

/** A run a figure draws from: a scenario, or the shortest way the design breaks without a rule. */
export type RunSource = { scenario: string } | { breaks: string };

export interface RecordedRun {
  initial: World;
  events: Event[];
  /** The world after each event. */
  worlds: World[];
  /** For a run without a rule: the event that broke the property (1-based), and which. */
  broke?: { at: number; property: string };
}

/**
 * A moment of a run: 0 is its start, n is after its nth event (as timelines number them),
 * negative counts from the end, and "broke" is the event that broke the property.
 */
export type At = number | "broke" | "end";

/** The run, recorded. Scenarios run on the page; runs without a rule were recorded at build time. */
export declare function useRun(source: RunSource): RecordedRun;

/** The world at a moment of a run, and the event that led there (none at the start). */
export declare function moment(run: RecordedRun, at?: At): { index: number; world: World; event: Event | null };

/** The stage, frozen at a moment: every part, as the playground draws it, and nothing to click. */
export declare function Still(props: { run: RunSource; at?: At; height?: number; bubble?: boolean }): ReactNode;

/** One part of the system as the stage draws it: its node and, unless `rows` is false, its rows. */
export declare function Actor(props: { run: RunSource; at?: At; name: string; rows?: boolean }): ReactNode;

/** An arrow carrying a message, in its tone's colour: between two Actors in a Diagram. */
export declare function Message(props: { name: string; tone?: "request" | "reply" | "refused" | "stream"; fate?: "lost" | "twice"; back?: boolean; note?: string }): ReactNode;

/** Actors and messages, left to right. */
export declare function Diagram(props: { children: ReactNode; caption?: ReactNode }): ReactNode;

/** One event of a run, as the timeline shows it: its number, who, what they said, and faults. */
export declare function Moment(props: { run: RunSource; at: At }): ReactNode;

/** Several moments, one under the other: a run told in the steps that matter. */
export declare function Moments(props: { run: RunSource; at: At[] }): ReactNode;

// Data figures: numbers the explainer brings (production metrics, limits), each with its source.
// Each works its own arithmetic out (growth, shares, maxima) from the numbers it is given.

/** The palette every figure shares. */
export type Tone = "blue" | "green" | "orange" | "purple" | "red" | "grey";

/** Big numbers in a grid. */
export declare function Stats(props: { children: ReactNode; columns?: number }): ReactNode;
export declare function Stat(props: { value: number | string; label: ReactNode; tone?: Tone; source?: string }): ReactNode;

/** Small multiples of series over time, each headed by its growth (last ÷ first) and last value. */
export declare function Columns(props: { series: { title: string; values: number[]; tone?: Tone; from?: string; to?: string; last?: string }[]; height?: number }): ReactNode;

/** One horizontal bar per thing, scaled to the largest. */
export declare function Bars(props: { rows: { label: ReactNode; value: number; tone?: Tone; note?: ReactNode }[]; sort?: boolean; format?: (n: number) => string; mono?: boolean }): ReactNode;

/** Parts of one whole as one bar; the shares are worked out from the values. */
export declare function Share(props: { parts: { label: string; value: number; tone?: Tone; note?: string }[]; total?: number }): ReactNode;

/** Percentiles (in ms) on a log scale, with lines for limits such as a timeout. */
export declare function Ranges(props: { rows: { label: string; p50: number; p90: number; p99: number; tone?: Tone }[]; marks?: { at: number; label: string; tone?: Tone }[]; ticks?: number[] }): ReactNode;

/** Where limits sit between zero and a maximum. */
export declare function Scale(props: { max: number; fill?: { value: number; tone?: Tone }; marks: { at: number; label: string; tone?: Tone; below?: boolean }[] }): ReactNode;

/** A token, key or URL taken apart, each labelled part pointed at from below. */
export declare function Anatomy(props: { parts: { text: string; tone?: Tone; label?: string; sub?: string }[] }): ReactNode;

/** A box of a block diagram; one with children is a group drawn around them. */
export interface Block {
  id: string;
  title: string;
  sub?: string;
  tone?: Tone;
  dashed?: boolean;
  lines?: string[];
  step?: number;
  big?: boolean;
  children?: Block[];
  note?: string;
}
export type Edge = [string, string] | { from: string; to: string; dashed?: boolean; label?: string };

/** Boxes and arrows, laid out by ELK: say what connects to what, not where it goes. */
export declare function Blocks(props: {
  blocks: Block[];
  edges?: Edge[];
  direction?: "right" | "down";
  /** Top-level boxes by id, row by row, when the reading order matters more than ELK's layout: a pipeline. */
  rows?: string[][];
}): ReactNode;

/** Where numbers came from, as a chip. */
export declare function Source(props: { children: ReactNode }): ReactNode;

/** The words under a figure, inside its frame. */
export declare function Caption(props: { children: ReactNode }): ReactNode;

/** 17_000_000 → "17M". */
export declare function compact(n: number): string;
