// The explorer's shell: a navigation rail (spec, pages, commit, theme) and one page that
// fills the rest. Playground sessions are kept per spec while you move between pages.
import { Badge, Button, Sidebar } from "@cloudflare/kumo";
import { ArrowsSplitIcon, BookOpenIcon, GitCommitIcon, MoonIcon, PlayCircleIcon, ShieldCheckIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Counterexample } from "@feynman/check";
import type { Spec } from "@feynman/spec";
import { Checks } from "./Checks";
import type { Bundle } from "./data";
import { Flows, type FlowRun } from "./Flows";
import { Playground } from "./Playground";
import { Reference } from "./Reference";
import { freshSession, replay, runScenarioSession, type Session } from "./sessions";
import { ExplorerProvider, type Loaded } from "./ui";

type Page = "play" | "flows" | "checks" | "reference";
const PAGES: { page: Page; label: string; icon: typeof PlayCircleIcon }[] = [
  { page: "play", label: "Playground", icon: PlayCircleIcon },
  { page: "flows", label: "Flows", icon: ArrowsSplitIcon },
  { page: "checks", label: "Checks", icon: ShieldCheckIcon },
  { page: "reference", label: "Reference", icon: BookOpenIcon },
];

interface Route {
  spec: string;
  page: Page;
  item: string | null;
}

function parseRoute(hash: string, fallback: string): Route {
  const [spec, page, ...item] = hash.replace(/^#\/?/, "").split("/");
  return {
    spec: spec ? decodeURIComponent(spec) : fallback,
    page: PAGES.some((p) => p.page === page) ? (page as Page) : "play",
    item: item.length ? decodeURIComponent(item.join("/")) : null,
  };
}

function href(route: Route): string {
  return `#/${encodeURIComponent(route.spec)}/${route.page}${route.item ? `/${encodeURIComponent(route.item)}` : ""}`;
}

function useRoute(fallback: string): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash, fallback));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash, fallback));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, [fallback]);
  return [route, (r) => (location.hash = href(r))];
}

export function App({ bundle, loaded }: { bundle: Bundle; loaded: Loaded[] }) {
  const [route, go] = useRoute(loaded[0]?.entry.id ?? "");
  const current = loaded.find((l) => l.entry.id === route.spec) ?? loaded[0];
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const session = current?.spec ? (sessions[current.entry.id] ?? restore(current.entry.id, current.spec, route.page === "play" ? route.item : null)) : null;
  const setSession = (s: Session) => {
    setSessions({ ...sessions, [current.entry.id]: s });
    if (s.ops) sessionStorage.setItem(storageKey(current.entry.id), JSON.stringify({ origin: s.origin, ops: s.ops }));
    else sessionStorage.removeItem(storageKey(current.entry.id));
  };
  const openFlow = (flow: FlowRun) => {
    setSession(runScenarioSession(current.spec!, flow.scenario));
    go({ ...route, page: "play", item: null });
  };
  const openCounterexample = (ce: Counterexample, origin: string) => {
    setSession({ initial: ce.initial, steps: ce.events.map((event, i) => ({ event, world: ce.worlds[i] })), ops: null, origin });
    go({ ...route, page: "play", item: null });
  };
  return (
    <Sidebar.Provider defaultOpen={false} collapsible="icon" contained className="flex h-full">
      <Sidebar>
        <Sidebar.Header>
          <a href={href({ spec: current?.entry.id ?? "", page: "play", item: null })} className="flex items-center gap-2 px-1 py-1">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-kumo-contrast text-sm font-semibold text-kumo-inverse">F</span>
            <span className="truncate text-sm font-semibold group-data-[state=collapsed]/sidebar:hidden">{current?.spec?.name ?? "Feynman"}</span>
          </a>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {PAGES.map((p) => (
                <Sidebar.MenuButton key={p.page} icon={p.icon} href={href({ spec: current?.entry.id ?? "", page: p.page, item: null })} active={route.page === p.page} tooltip={p.label}>
                  {p.label}
                  {p.page === "checks" && current?.entry.report && current.entry.report.properties.some((x) => !x.holds) && (
                    <Sidebar.MenuBadge className="ml-auto">{current.entry.report.properties.filter((x) => !x.holds).length}</Sidebar.MenuBadge>
                  )}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
          {loaded.length > 1 && (
            <Sidebar.Group>
              <Sidebar.GroupLabel>Specs</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {loaded.map((l) => (
                  <Sidebar.MenuButton key={l.entry.id} href={href({ spec: l.entry.id, page: route.page, item: null })} active={l === current} tooltip={l.spec?.name ?? l.entry.id}>
                    {l.spec?.name ?? l.entry.id}
                  </Sidebar.MenuButton>
                ))}
              </Sidebar.Menu>
            </Sidebar.Group>
          )}
        </Sidebar.Content>
        <Sidebar.Footer>
          <Footer bundle={bundle} />
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-hidden">
        {!current ? (
          <Empty text="No specs found. Write one in specs/<name>.ts next to a package.json." />
        ) : !current.spec || !session ? (
          <Empty text={current.entry.error ?? "This spec did not load."} />
        ) : (
          <ExplorerProvider value={{ bundle, loaded: current }}>
            {route.page === "play" && (
              <Playground
                session={session}
                setSession={setSession}
                scenarios={{
                  items: [{ value: "Fresh start", label: "Fresh start" }, ...current.spec.scenarios.map((s) => ({ value: s.name, label: s.name }))],
                  onPick: (v) => {
                    const scenario = current.spec!.scenarios.find((s) => s.name === v);
                    setSession(scenario ? runScenarioSession(current.spec!, scenario) : freshSession(current.spec!));
                  },
                }}
              />
            )}
            {route.page === "flows" && <Flows selected={route.item} onSelect={(item) => go({ ...route, item })} onOpen={openFlow} />}
            {route.page === "checks" && <Checks onOpen={openCounterexample} />}
            {route.page === "reference" && <Reference />}
          </ExplorerProvider>
        )}
      </main>
    </Sidebar.Provider>
  );
}

function storageKey(id: string) {
  return `feynman.session.${id}`;
}

/** A session kept across reloads: its operations replayed against the spec as it is now. */
function restore(id: string, spec: Spec, scenarioName: string | null): Session {
  const scenario = scenarioName ? spec.scenarios.find((s) => s.name === scenarioName) : null;
  if (scenario) return runScenarioSession(spec, scenario);
  const saved = sessionStorage.getItem(storageKey(id));
  if (!saved) return freshSession(spec);
  try {
    const { origin, ops } = JSON.parse(saved);
    return replay(spec, ops, origin);
  } catch {
    return freshSession(spec);
  }
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-sm text-kumo-subtle">{text}</div>;
}

function Footer({ bundle }: { bundle: Bundle }) {
  const [mode, setMode] = useState(() => document.documentElement.dataset.mode ?? "light");
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    localStorage.setItem("feynman.mode", mode);
  }, [mode]);
  const { repository } = bundle;
  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center gap-1.5 truncate text-xs text-kumo-subtle" title={`${repository.name} at ${repository.commit}${repository.dirty ? " with uncommitted changes" : ""}`}>
        <GitCommitIcon size={14} className="shrink-0" />
        <span className="font-mono group-data-[state=collapsed]/sidebar:hidden">{repository.commit.slice(0, 7)}</span>
        {repository.dirty && <span className="group-data-[state=collapsed]/sidebar:hidden"><Badge variant="warning">+ changes</Badge></span>}
      </div>
      <Button variant="ghost" size="sm" shape="square" aria-label="Switch theme" onClick={() => setMode(mode === "dark" ? "light" : "dark")} icon={mode === "dark" ? <SunIcon /> : <MoonIcon />} />
    </div>
  );
}

