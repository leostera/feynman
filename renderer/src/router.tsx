import { useEffect, useState } from "react";
import { SEGMENT, type Kind } from "./model";

/** What the current URL fragment points at. */
export type Route =
  | { page: "overview" }
  | { page: "index"; kind: Kind }
  | { page: "measurements" }
  | { page: "detail"; kind: Kind; id: string }
  | { page: "missing"; path: string };

const KIND_BY_SEGMENT = new Map(Object.entries(SEGMENT).map(([kind, segment]) => [segment, kind as Kind]));

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "") return { page: "overview" };
  const [segment, ...rest] = path.split("/");
  if (segment === "measurements" && rest.length === 0) return { page: "measurements" };
  const kind = KIND_BY_SEGMENT.get(segment);
  if (!kind) return { page: "missing", path };
  if (rest.length === 0) return { page: "index", kind };
  return { page: "detail", kind, id: decodeURIComponent(rest.join("/")) };
}

/** The current route, following the URL fragment; links are plain `#/…` anchors. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      document.getElementById("main")?.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** A persisted reader preference, such as the preferred flow notation. */
export function usePreference<T extends string>(key: string, fallback: T): [T, (value: T) => void] {
  const storageKey = `feynman.${key}`;
  const [value, setValue] = useState<T>(() => (localStorage.getItem(storageKey) as T | null) ?? fallback);
  const update = (next: T) => {
    localStorage.setItem(storageKey, next);
    setValue(next);
  };
  return [value, update];
}
