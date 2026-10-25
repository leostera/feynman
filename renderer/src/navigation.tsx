import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { formatAddress, parseAddress, type Address, type Index } from "./model";

interface Navigation {
  index: Index;
  open: (address: Address) => void;
  close: (address: Address) => void;
  closeAll: () => void;
  story: Address[];
}

const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("useNavigation outside NavigationProvider");
  return navigation;
}

const DEFAULT_STORY: Address[] = [{ kind: "overview", id: "system" }];

function readStory(): Address[] {
  const raw = decodeURIComponent(window.location.hash.slice(1));
  const story = raw
    .split(",")
    .map(parseAddress)
    .filter((address): address is Address => address !== null);
  return story.length > 0 ? story : DEFAULT_STORY;
}

function same(a: Address, b: Address): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * The story river: the ordered list of open cards, newest first, mirrored in the URL
 * fragment so a view can be shared or bookmarked.
 */
export function NavigationProvider({ index, children }: { index: Index; children: ReactNode }) {
  const [story, setStory] = useState<Address[]>(readStory);

  useEffect(() => {
    const hash = story.map(formatAddress).join(",");
    if (window.location.hash.slice(1) !== hash) history.replaceState(null, "", `#${hash}`);
  }, [story]);

  useEffect(() => {
    const onHashChange = () => setStory(readStory());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const open = useCallback((address: Address) => {
    setStory((current) => [address, ...current.filter((other) => !same(other, address))]);
    requestAnimationFrame(() => {
      document.getElementById(cardDomId(address))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const close = useCallback((address: Address) => {
    setStory((current) => current.filter((other) => !same(other, address)));
  }, []);

  const closeAll = useCallback(() => setStory([]), []);

  return (
    <NavigationContext.Provider value={{ index, open, close, closeAll, story }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function cardDomId(address: Address): string {
  return `card-${address.kind}-${address.id}`;
}

/** A persisted reader preference, such as the preferred flow notation. */
export function usePreference<T extends string>(key: string, fallback: T): [T, (value: T) => void] {
  const storageKey = `feynman.${key}`;
  const [value, setValue] = useState<T>(() => (localStorage.getItem(storageKey) as T | null) ?? fallback);
  const update = useCallback(
    (next: T) => {
      localStorage.setItem(storageKey, next);
      setValue(next);
      window.dispatchEvent(new CustomEvent("feynman:preference", { detail: { key: storageKey, value: next } }));
    },
    [storageKey],
  );
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; value: T }>).detail;
      if (detail.key === storageKey) setValue(detail.value);
    };
    window.addEventListener("feynman:preference", onChange);
    return () => window.removeEventListener("feynman:preference", onChange);
  }, [storageKey]);
  return [value, update];
}
