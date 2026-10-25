import { Badge, Button, Sidebar, Tabs } from "@cloudflare/kumo";
import {
  ArrowsSplitIcon,
  CubeIcon,
  DatabaseIcon,
  EyeIcon,
  FileTextIcon,
  GaugeIcon,
  GitCommitIcon,
  HouseIcon,
  MoonIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SunIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { href, type Index, type Kind } from "./model";
import { ActorPage, ActorsPage } from "./pages/Actors";
import { ClaimPage, ClaimsPage, MeasurementsPage } from "./pages/Claims";
import { ElementIndexPage, ElementPage, hasElementPages } from "./pages/Elements";
import { FlowPage, FlowsPage } from "./pages/Flows";
import { OverviewPage } from "./pages/Overview";
import { useRoute, type Route } from "./router";
import { initialMode, setMode, type Mode } from "./theme";
import { IndexProvider, Page, relativeTime, useIndex } from "./ui";

export function App({ index }: { index: Index }) {
  const route = useRoute();
  return (
    <IndexProvider value={index}>
      <div className="flex h-full flex-col">
        <TopBar />
        <Sidebar.Provider defaultOpen collapsible="none" contained className="min-h-0 flex-1">
          <Navigation route={route} />
          <main
            id="main"
            className="min-w-0 flex-1 overflow-y-auto bg-kumo-canvas"
            style={{
              backgroundImage: "radial-gradient(var(--color-kumo-hairline) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
            }}
          >
            <Content route={route} />
          </main>
        </Sidebar.Provider>
      </div>
    </IndexProvider>
  );
}

function Content({ route }: { route: Route }) {
  const index = useIndex();
  switch (route.page) {
    case "overview":
      return <OverviewPage />;
    case "measurements":
      return <MeasurementsPage />;
    case "index":
      if (route.kind === "actor") return <ActorsPage />;
      if (route.kind === "flow") return <FlowsPage />;
      if (route.kind === "claim") return <ClaimsPage />;
      if (hasElementPages(route.kind)) return <ElementIndexPage kind={route.kind} />;
      return <NotFound />;
    case "detail": {
      const exists = route.kind === "claim" ? index.claims.has(route.id) : index.kindOf.get(route.id) === route.kind;
      if (!exists) return <NotFound />;
      if (route.kind === "actor") return <ActorPage id={route.id} />;
      if (route.kind === "flow") return <FlowPage id={route.id} />;
      if (route.kind === "claim") return <ClaimPage id={route.id} />;
      return <ElementPage kind={route.kind} id={route.id} />;
    }
    case "missing":
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <Page
      title="Not in this model"
      summary={
        <>
          Nothing in the model matches this address. <a className="text-kumo-link hover:underline" href="#/">Go to the overview</a>.
        </>
      }
      sections={[]}
    />
  );
}

// Top bar: what this artifact describes, and which view of it you are in.

function TopBar() {
  const { model } = useIndex();
  const { source } = model.meta;
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-kumo-hairline bg-kumo-base px-4">
      <a href="#/" className="text-sm font-semibold text-kumo-default">
        {model.meta.system}
      </a>
      <SourceInfo />
      <div className="ml-4">
        <Tabs size="sm" value="current" tabs={[{ value: "current", label: "Current state" }]} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {source.url && (
          <a href={source.url} target="_blank" rel="noreferrer" className="text-xs text-kumo-subtle hover:text-kumo-link hover:underline">
            {source.url.replace(/^https:\/\//, "")}
          </a>
        )}
        <ModeToggle />
      </div>
    </header>
  );
}

function SourceInfo() {
  const { source, extractedAt } = useIndex().model.meta;
  const short = source.commit.slice(0, 7);
  const commit: ReactNode = source.commitUrl ? (
    <a href={source.commitUrl} target="_blank" rel="noreferrer" className="font-mono text-kumo-link hover:underline">
      {short}
    </a>
  ) : (
    <span className="font-mono">{short}</span>
  );
  const main = source.main;
  const position = main ? mainPosition(main) : null;
  return (
    <div className="flex items-center gap-2 text-xs text-kumo-subtle">
      <GitCommitIcon size={14} />
      {commit}
      {source.committedAt && <span title={source.committedAt}>committed {relativeTime(source.committedAt)}</span>}
      {position && main && (
        <span title={`Compared with ${main.ref} (${main.commit.slice(0, 7)}) ${relativeTime(main.checkedAt)}`}>
          <Badge variant={main.behind > 0 ? "warning" : "neutral"}>{position}</Badge>
        </span>
      )}
      {extractedAt && <span title={extractedAt}>· modelled {relativeTime(extractedAt)}</span>}
    </div>
  );
}

/** "2 behind main", "1 ahead, 3 behind main", or "at main". */
function mainPosition(main: { ref: string; ahead: number; behind: number }): string {
  const parts = [main.ahead > 0 ? `${main.ahead} ahead` : null, main.behind > 0 ? `${main.behind} behind` : null].filter(Boolean);
  return parts.length === 0 ? `at ${main.ref}` : `${parts.join(", ")} ${main.ref}`;
}

function ModeToggle() {
  const [mode, setModeState] = useState<Mode>(initialMode);
  useEffect(() => setMode(mode), [mode]);
  const next = mode === "dark" ? "light" : "dark";
  return (
    <Button variant="ghost" size="sm" shape="square" aria-label={`Switch to ${next} mode`} onClick={() => setModeState(next)}>
      {mode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </Button>
  );
}

// Left navigation: the inventory's structure.

const SECTIONS: { kind: Kind | "measurements"; label: string; icon: typeof HouseIcon }[] = [
  { kind: "actor", label: "Actors", icon: UsersThreeIcon },
  { kind: "flow", label: "Flows", icon: ArrowsSplitIcon },
  { kind: "state", label: "State", icon: DatabaseIcon },
  { kind: "invariant", label: "Invariants", icon: ShieldCheckIcon },
  { kind: "boundary", label: "Boundaries", icon: CubeIcon },
  { kind: "contract", label: "Contracts", icon: FileTextIcon },
  { kind: "observability", label: "Observability", icon: EyeIcon },
  { kind: "measurements", label: "Measurements", icon: GaugeIcon },
  { kind: "claim", label: "Claims", icon: ScalesIcon },
];

function sectionOf(route: Route): Kind | "measurements" | "overview" | null {
  if (route.page === "overview") return "overview";
  if (route.page === "measurements") return "measurements";
  if (route.page === "index" || route.page === "detail") return route.kind === "machine" ? "state" : route.kind;
  return null;
}

function Navigation({ route }: { route: Route }) {
  const { model } = useIndex();
  const current = sectionOf(route);
  const count = (kind: Kind | "measurements"): number => {
    switch (kind) {
      case "actor":
        return model.actors.length;
      case "flow":
        return model.flows.length;
      case "state":
        return model.state.length + (model.stateMachines?.length ?? 0);
      case "invariant":
        return model.invariants.length;
      case "boundary":
        return model.boundaries?.length ?? 0;
      case "contract":
        return model.contracts?.length ?? 0;
      case "observability":
        return model.observability?.length ?? 0;
      case "measurements":
        return model.measurements?.length ?? 0;
      case "claim":
        return model.claims.length;
      case "machine":
        return model.stateMachines?.length ?? 0;
    }
  };
  const activeFlow = route.page === "detail" && route.kind === "flow" ? route.id : null;

  return (
    <Sidebar>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton icon={HouseIcon} href="#/" active={current === "overview"}>
              Overview
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Inventory</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {SECTIONS.map((section) => (
              <Sidebar.MenuButton
                key={section.kind}
                icon={section.icon}
                href={section.kind === "measurements" ? "#/measurements" : href(section.kind)}
                active={current === section.kind}
              >
                <span className="flex w-full items-center justify-between">
                  {section.label}
                  <span className="text-xs text-kumo-subtle tabular-nums">{count(section.kind)}</span>
                </span>
              </Sidebar.MenuButton>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Flows</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {model.flows.map((flow) => (
              <Sidebar.MenuButton key={flow.id} size="sm" href={href("flow", flow.id)} active={activeFlow === flow.id}>
                {flow.id}
              </Sidebar.MenuButton>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
    </Sidebar>
  );
}
