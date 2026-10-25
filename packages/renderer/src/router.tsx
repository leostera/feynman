import { useEffect, useState } from "react";
import { kindOfSegment, type Kind } from "./model";

/** What the current URL fragment points at. */
export type Route =
  | { page: "index"; kind: Kind }
  | { page: "detail"; kind: Kind; id: string }
  | { page: "missing"; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  // The home page is the journeys index (the actors, for models without journeys).
  if (path === "") return { page: "index", kind: "journey" };
  const [segment, ...rest] = path.split("/");
  const kind = kindOfSegment(segment);
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
