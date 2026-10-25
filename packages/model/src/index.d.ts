// Types for the plain-ESM model tools.

export interface Kind {
  key: "actors" | "flows" | "protocols" | "state" | "stateMachines" | "invariants" | "claims" | "limits";
  dir: string;
  schema: string;
}
export const KINDS: Kind[];

export type Element = { id: string } & Record<string, unknown>;
export interface Model {
  meta: Record<string, any>;
  actors: Element[];
  flows: Element[];
  protocols: Element[];
  state: Element[];
  stateMachines: Element[];
  invariants: Element[];
  claims: Element[];
  limits: Element[];
}
export function loadModel(modelDir: string): Model;
export function readElements(modelDir: string, kind: Kind): { id: string; path: string; value: Record<string, unknown> }[];
export function writeElement(modelDir: string, kind: Kind, element: Element): void;
export function writeMeta(modelDir: string, meta: Record<string, unknown>): void;
export function writeModel(modelDir: string, model: Model): void;

export type Outcome = "modelled" | "no-behaviour" | "vendored" | "generated";
export interface LedgerEntry {
  path: string;
  outcome: Outcome;
  note?: string;
}
export interface Ledger {
  commit: string;
  summary: string;
  files: LedgerEntry[];
}
export function readCoverage(modelDir: string): { batch: string; path: string; value: Ledger }[];

export const SCHEMA_DIR: string;
export function checkModel(modelDir: string, repository?: string): string[];
export interface ParsedAnchor {
  file: string;
  start?: number;
  end?: number;
}
export function parseAnchor(anchor: string | { file: string; span?: { start: { line: number }; end?: { line: number } } }): ParsedAnchor;
export function modelAnchors(model: Model): ParsedAnchor[];
export function anchoredFiles(model: Model): Set<string>;

export const MODEL_ROOT: string;
export class CoverageError extends Error {}
export interface CoverageReport {
  mode: "bootstrap" | "update";
  commit: string;
  base?: string;
  required: string[];
  missing: string[];
  deleted: string[];
  stale: string[];
  unknown: string[];
  /** Pathspecs excluded by .feynman/config.json. */
  exclude: string[];
  /** Update only: elements whose source files changed since they were derived. */
  outdated: OutdatedElement[];
  problems: string[];
}
export function computeCoverage(repository: string, modelDir: string): CoverageReport;
export function groupMissing(missing: string[]): [string, number][];
export function describeCoverage(report: CoverageReport): string;
export function recordReviewed(modelDir: string, batch: string, commit: string, summary: string, entries: LedgerEntry[]): Ledger;

export function measureModel(repository: string, modelDir: string, mainRef?: string): string;
export function indexModel(modelDir: string, only?: string[]): string;

export function git(repository: string, ...args: string[]): string;
export function tryGit(repository: string, ...args: string[]): string | null;
export function trackedFiles(repository: string, commit: string, exclude?: string[]): string[];

export interface Config {
  /** Git pathspecs that are not part of the modelled system. */
  exclude: string[];
}
export function configPath(modelDir: string): string;
export function readConfig(modelDir: string): Config;
export function excludePathspecs(exclude: string[]): string[];

export interface OutdatedElement {
  /** Model directory of the kind, e.g. "flows". */
  kind: string;
  id: string;
  /** Sources whose content changed or that no longer exist. */
  files: string[];
}
export function blobIds(repository: string, commit: string): Map<string, string>;
export function stampSources(repository: string, modelDir: string): number;
export function outdatedElements(repository: string, modelDir: string, commit: string): OutdatedElement[];
