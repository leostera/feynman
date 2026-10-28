// The explorer's shell: a navigation rail (pages, commit, theme) and one page that fills the
// rest; the playground's top bar picks the spec. Playground sessions are kept per spec while you move between pages.
import { Sidebar, useSidebar } from "@cloudflare/kumo";
import { ArrowsSplitIcon, GearIcon, PlayCircleIcon, ShieldCheckIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { Counterexample } from "../check/index.ts";
import type { Spec } from "../spec/index.ts";
import { Checks } from "./Checks";
import type { Bundle } from "./data";
import { Flows, parseSelection, selectionItem, type FlowRun } from "./Flows";
import { Playground } from "./Playground";
import { SettingsPage } from "./Settings";
import { freshSession, replay, runScenarioSession, sessionFromRun, type Session } from "./sessions";
import { href, NEW_SCENARIO, parsePlaygroundUrlState, parseRoute, sessionKey, writePlaygroundUrlState, type Page, type Route } from "./url";
import { ExplorerProvider, type Loaded } from "./ui";

const PAGES: { page: Page; label: string; icon: typeof PlayCircleIcon }[] = [
  { page: "play", label: "Playground", icon: PlayCircleIcon },
  { page: "flows", label: "Flows", icon: ArrowsSplitIcon },
  { page: "checks", label: "Checks", icon: ShieldCheckIcon },
];

function useRoute(fallback: string): [Route, (route: Route) => void, (route: Route) => void, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash, fallback));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash, fallback));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, [fallback]);
  const navigate = (next: Route) => { location.hash = href(next); };
  const replace = (next: Route) => {
    const address = href(next);
    history.replaceState(null, "", address);
    setRoute(parseRoute(address, fallback));
  };
  const replaceUrl = (next: Route) => history.replaceState(null, "", href(next));
  return [route, navigate, replace, replaceUrl];
}

export function App({ bundle, loaded }: { bundle: Bundle; loaded: Loaded[] }) {
  const fallbackSpec = loaded[0]?.entry.id ?? "";
  const [route, go, replaceRoute, replaceUrl] = useRoute(fallbackSpec);
  const currentRoute = () => parseRoute(location.hash, fallbackSpec);
  const current = loaded.find((l) => l.entry.id === route.spec) ?? loaded[0];
  const [activeSession, setActiveSession] = useState<{ key: string; session: Session } | null>(null);
  const queryKey = route.query.toString();
  const viewState = useMemo(() => parsePlaygroundUrlState(new URLSearchParams(queryKey)), [queryKey]);
  const key = sessionKey(route);
  const session = useMemo(() => {
    if (!current?.spec) return null;
    if (activeSession?.key === key) return activeSession.session;
    return restore(current.spec, route, viewState.ops);
    // `key` contains the route identity and serialized timeline; camera/speed updates must not rebuild a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, current?.spec, key]);
  const setSession = (next: Session) => {
    if (!current?.spec) return;
    const source = currentRoute();
    const currentView = parsePlaygroundUrlState(source.query);
    const item = next.origin === "New scenario" ? NEW_SCENARIO : source.item ?? NEW_SCENARIO;
    const query = writePlaygroundUrlState(source.query, { ...currentView, ops: next.ops });
    const updated = { ...source, page: "play" as const, item, query };
    replaceRoute(updated);
    setActiveSession({ key: sessionKey(updated), session: next });
  };
  const updateViewState = (next: Omit<ReturnType<typeof parsePlaygroundUrlState>, "ops">) => {
    const source = currentRoute();
    const currentView = parsePlaygroundUrlState(source.query);
    const shouldSerializeTimeline = source.query.has("state") || session?.origin === "New scenario";
    const ops = shouldSerializeTimeline ? session?.ops ?? currentView.ops : null;
    const query = writePlaygroundUrlState(source.query, { ...next, ops });
    if (query.toString() !== source.query.toString()) replaceUrl({ ...source, query });
  };
  const selectScenario = (name: string) => {
    if (!current?.spec) return;
    const source = currentRoute();
    const currentView = parsePlaygroundUrlState(source.query);
    const scenario = current.spec.scenarios.find((candidate) => candidate.name === name);
    const nextSession = scenario ? runScenarioSession(current.spec, scenario) : freshSession(current.spec);
    const item = scenario ? scenario.name : NEW_SCENARIO;
    const query = writePlaygroundUrlState(source.query, { ...currentView, ops: scenario ? null : nextSession.ops });
    const updated = { spec: current.entry.id, page: "play" as const, item, query };
    setActiveSession({ key: sessionKey(updated), session: nextSession });
    go(updated);
  };
  const selectSpec = (id: string) => {
    const source = currentRoute();
    const currentView = parsePlaygroundUrlState(source.query);
    const nextSpec = loaded.find((entry) => entry.entry.id === id)?.spec;
    if (!nextSpec) return;
    const nextSession = freshSession(nextSpec);
    const query = writePlaygroundUrlState(source.query, { ...currentView, ops: nextSession.ops });
    const updated = { spec: id, page: "play" as const, item: NEW_SCENARIO, query };
    setActiveSession({ key: sessionKey(updated), session: nextSession });
    go(updated);
  };
  const openFlow = (flow: FlowRun) => selectScenario(flow.scenario.name);
  const openCounterexample = (ce: Counterexample, origin: string) => {
    const source = currentRoute();
    const currentView = parsePlaygroundUrlState(source.query);
    const from = ce.from ? `${origin}, from ${ce.from.at === "end" ? "the end" : "the setup"} of “${ce.from.scenario}”` : origin;
    const nextSession = sessionFromRun({ initial: ce.initial, events: ce.events, worlds: ce.worlds }, from);
    const query = writePlaygroundUrlState(source.query, { ...currentView, ops: nextSession.ops });
    const updated = { spec: current.entry.id, page: "play" as const, item: NEW_SCENARIO, query };
    setActiveSession({ key: sessionKey(updated), session: nextSession });
    go(updated);
  };
  const openScenario = (name: string) => selectScenario(name);
  const pageRoute = (page: Page, source: Route): Route => {
    const query = new URLSearchParams(source.query);
    if (source.page === "play") query.set("scenario", source.item ?? NEW_SCENARIO);
    const savedScenario = query.get("scenario");
    const item = page === "play"
      ? source.page === "flows" ? parseSelection(source.item).scenario ?? savedScenario ?? NEW_SCENARIO : savedScenario ?? NEW_SCENARIO
      : page === "flows"
        ? source.page === "play" ? source.item === NEW_SCENARIO ? null : source.item : source.page === "flows" ? source.item : savedScenario
        : null;
    if (page === "play" || page === "flows") query.delete("scenario");
    return { spec: source.spec, page, item, query };
  };
  const navigatePage = (page: Page) => go(pageRoute(page, currentRoute()));
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();
  return (
    <Sidebar.Provider open={sidebarOpen} onOpenChange={setSidebarOpen} collapsible="icon" contained className="flex h-full">
      <Sidebar>
        <Sidebar.Rail />
        <Sidebar.Header>
          <button type="button" onClick={() => navigatePage("play")} aria-label="Playground" className="flex items-center gap-2 px-1 py-1">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-kumo-contrast text-sm font-semibold text-kumo-inverse">F</span>
          </button>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {PAGES.map((p) => (
                <Sidebar.MenuButton key={p.page} icon={p.icon} onClick={() => navigatePage(p.page)} active={route.page === p.page} tooltip={p.label}>
                  {p.label}
                  {p.page === "checks" && current?.entry.report && current.entry.report.properties.some((x) => !x.holds) && (
                    <Sidebar.MenuBadge className="ml-auto">{current.entry.report.properties.filter((x) => !x.holds).length}</Sidebar.MenuBadge>
                  )}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        {/* Kumo's footer is one row; this one holds two: settings, then the collapse button. */}
        <Sidebar.Footer className="h-auto flex-col items-stretch gap-px py-2">
          <Sidebar.Menu>
            <Sidebar.MenuButton icon={GearIcon} onClick={() => navigatePage("settings")} active={route.page === "settings"} tooltip="Settings">
              Settings
            </Sidebar.MenuButton>
            <SidebarToggle />
          </Sidebar.Menu>
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-hidden">
        {route.page === "settings" ? (
          <SettingsPage bundle={bundle} />
        ) : !current ? (
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
                  items: [{ value: "New scenario", label: "New scenario" }, ...current.spec.scenarios.map((s) => ({ value: s.name, label: s.name }))],
                  onPick: selectScenario,
                }}
                specs={{
                  value: current.entry.id,
                  items: loaded.map((l) => ({ value: l.entry.id, label: l.spec?.name ?? l.entry.id })),
                  onPick: selectSpec,
                }}
                initialSpeed={viewState.speed}
                initialCamera={viewState.camera}
                initialLayout={viewState.layout}
                onViewStateChange={updateViewState}
              />
            )}
            {route.page === "flows" && (
              <Flows
                tree={loaded.map((l) => ({ id: l.entry.id, name: l.spec?.name ?? l.entry.id }))}
                selection={parseSelection(route.item)}
                onSelect={(spec, selection) => {
                  const query = new URLSearchParams(route.query);
                  query.delete("state");
                  query.delete("scenario");
                  go({ ...route, spec, page: "flows", item: selectionItem(selection), query });
                }}
                onOpen={openFlow}
              />
            )}
            {route.page === "checks" && <Checks onOpen={openCounterexample} onScenario={openScenario} />}
          </ExplorerProvider>
        )}
      </main>
    </Sidebar.Provider>
  );
}

/** Collapses the sidebar to icons, or expands it to names. */
function SidebarToggle() {
  const { open, toggleSidebar } = useSidebar();
  const label = open ? "Collapse sidebar" : "Expand sidebar";
  return (
    <Sidebar.MenuButton icon={SidebarSimpleIcon} onClick={toggleSidebar} tooltip={label} aria-label={label}>
      {label}
    </Sidebar.MenuButton>
  );
}

/** Whether the sidebar is expanded, kept across reloads; it starts collapsed to icons. */
function useSidebarOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem("feynman.sidebar") === "open");
  return [open, (next) => (setOpen(next), localStorage.setItem("feynman.sidebar", next ? "open" : "closed"))];
}

/** Restore the playground from its scenario path and optional serialized operation timeline. */
function restore(spec: Spec, route: Route, ops: ReturnType<typeof parsePlaygroundUrlState>["ops"]): Session {
  if (route.query.has("state")) {
    return ops ? replay(spec, ops, route.item === NEW_SCENARIO ? "New scenario" : route.item ?? "New scenario") : freshSession(spec);
  }
  const scenarioName = route.page === "play" ? route.item : route.query.get("scenario");
  const scenario = scenarioName && scenarioName !== NEW_SCENARIO ? spec.scenarios.find((candidate) => candidate.name === scenarioName) : null;
  return scenario ? runScenarioSession(spec, scenario) : freshSession(spec);
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-sm text-kumo-subtle">{text}</div>;
}
