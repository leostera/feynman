import { parseOps, type Op } from "./session";

export type Page = "play" | "flows" | "checks" | "settings";
export const NEW_SCENARIO = "new";
const PAGES: Page[] = ["play", "flows", "checks", "settings"];
const SPEEDS = [0.25, 1, 5, 25];

export interface Route {
  spec: string;
  page: Page;
  item: string | null;
  query: URLSearchParams;
}

declare const zoomLevelBrand: unique symbol;
export type ZoomLevel = number & { readonly [zoomLevelBrand]: true };
export const ZOOM_UNITS_PER_PERCENT = 1000;
export const ZOOM_FACTOR_UNITS = 1000;
export const POSITION_UNITS_PER_PIXEL = 1000;
export const FIT_SCALE_UNITS = 1_000_000;
export const DEFAULT_ZOOM = (100 * ZOOM_UNITS_PER_PERCENT) as ZoomLevel;
const MIN_ZOOM = 35 * ZOOM_UNITS_PER_PERCENT;
const MAX_ZOOM = 400 * ZOOM_UNITS_PER_PERCENT;

export interface CameraState {
  /** Integer thousandths of a percent: 1000 = 1%, 100_000 = 100% (1×). */
  zoom: ZoomLevel;
  /** Integer thousandths of a CSS pixel. */
  x: number;
  y: number;
  /** Integer millionths of the initial fit scale. */
  fitScale: number | null;
  manual: boolean;
}

export interface PlaygroundUrlState {
  speed: number;
  camera: CameraState;
  ops: Op[] | null;
}

const DEFAULT_CAMERA: CameraState = { zoom: DEFAULT_ZOOM, x: 0, y: 0, fitScale: null, manual: false };

/** Parse the readable page roots and earlier spec/page/item URLs. */
export function parseRoute(hash: string, fallback: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  if (["playground", "flows", "checks", "settings"].includes(parts[0])) {
    const root = parts[0];
    const page: Page = root === "playground" ? "play" : root as Page;
    return {
      spec: decode(parts[1]) || fallback,
      page,
      item: decode(parts.slice(2).join("/")) || (page === "play" ? NEW_SCENARIO : null),
      query: params,
    };
  }
  const [spec, legacyPage, ...item] = parts;
  const page = PAGES.includes(legacyPage as Page) ? (legacyPage as Page) : "play";
  return { spec: decode(spec) || fallback, page, item: item.length ? decode(item.join("/")) : null, query: params };
}

/** Page roots stay stable; the selected spec and scenario are nested beneath them. */
export function href(route: Omit<Route, "query"> & { query?: URLSearchParams }): string {
  const path = route.page === "play"
    ? `#/playground/${encodeURIComponent(route.spec)}/${encodeURIComponent(route.item ?? NEW_SCENARIO)}`
    : route.page === "flows"
      ? `#/flows/${encodeURIComponent(route.spec)}${route.item ? `/${encodeURIComponent(route.item)}` : ""}`
      : `#/${route.page}/${encodeURIComponent(route.spec)}${route.item ? `/${encodeURIComponent(route.item)}` : ""}`;
  const query = route.query?.toString();
  return query ? `${path}?${query}` : path;
}

/** Session identity excludes view-only speed and camera preferences. */
export function sessionKey(route: Route): string {
  return `${route.spec}\u0000${route.page}\u0000${route.item ?? ""}\u0000${route.query.get("state") ?? ""}`;
}

export function parseZoomLevel(value: unknown): ZoomLevel | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_ZOOM && value <= MAX_ZOOM ? value as ZoomLevel : null;
}

export function zoomScale(zoom: ZoomLevel): number {
  return zoom / (100 * ZOOM_UNITS_PER_PERCENT);
}

/** Apply a fixed-point factor (1000 = 1×) and keep the saved zoom integral. */
export function scaleZoom(zoom: ZoomLevel, factor: number): ZoomLevel {
  const safeFactor = Number.isFinite(factor) ? Math.round(factor) : ZOOM_FACTOR_UNITS;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * safeFactor / ZOOM_FACTOR_UNITS))) as ZoomLevel;
}

export function parsePlaygroundUrlState(query: URLSearchParams): PlaygroundUrlState {
  const speedValue = Number(query.get("speed"));
  const speed = SPEEDS.includes(speedValue) ? speedValue : 1;
  return {
    speed,
    camera: parseCamera(query.get("camera")) ?? { ...DEFAULT_CAMERA },
    ops: parseOperations(query.get("state")),
  };
}

export function writePlaygroundUrlState(query: URLSearchParams, state: PlaygroundUrlState): URLSearchParams {
  const next = new URLSearchParams(query);
  next.set("speed", String(state.speed));
  const { camera } = state;
  next.set("camera", JSON.stringify({ v: 2, zoom: camera.zoom, x: camera.x, y: camera.y, fitScale: camera.fitScale, manual: camera.manual }));
  if (state.ops) next.set("state", JSON.stringify(state.ops));
  else next.delete("state");
  return next;
}

function parseCamera(raw: string | null): CameraState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || typeof value.manual !== "boolean") return null;
    if (value.v === 2) {
      const zoom = parseZoomLevel(value.zoom);
      const rawFitScale = value.fitScale;
      if (!zoom || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) return null;
      if (rawFitScale !== null && rawFitScale !== undefined && (!isFiniteNumber(rawFitScale) || !Number.isSafeInteger(rawFitScale) || rawFitScale <= 0)) return null;
      const fitScale = rawFitScale === null || rawFitScale === undefined ? null : rawFitScale;
      return { zoom, x: value.x, y: value.y, fitScale, manual: value.manual };
    }
    return parseLegacyCamera(value);
  } catch {
    return null;
  }
}

function parseLegacyCamera(value: Record<string, unknown>): CameraState | null {
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || typeof value.manual !== "boolean") return null;
  const legacyScale = value.zoom;
  const zoom = typeof legacyScale === "number" && legacyScale > 0 && legacyScale < 4.01
    ? parseZoomLevel(Math.round(legacyScale * 100 * ZOOM_UNITS_PER_PERCENT))
    : parseZoomLevel(legacyScale);
  const fitScale = value.fitScale === null || value.fitScale === undefined
    ? null
    : isFiniteNumber(value.fitScale) && value.fitScale > 0 ? Math.round(value.fitScale * FIT_SCALE_UNITS) : NaN;
  const x = Math.round(value.x * POSITION_UNITS_PER_PIXEL);
  const y = Math.round(value.y * POSITION_UNITS_PER_PIXEL);
  if (!zoom || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || (fitScale !== null && !Number.isSafeInteger(fitScale))) return null;
  return { zoom, x, y, fitScale, manual: value.manual };
}

function parseOperations(raw: string | null): Op[] | null {
  if (raw === null) return null;
  try {
    return parseOps(JSON.parse(raw));
  } catch {
    return null;
  }
}

function decode(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

