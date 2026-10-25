import { Button, Empty, Sidebar, Text } from "@cloudflare/kumo";
import {
  ArrowsSplitIcon,
  CheckCircleIcon,
  CubeIcon,
  DatabaseIcon,
  EyeIcon,
  FileTextIcon,
  GaugeIcon,
  HouseIcon,
  MoonIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SunIcon,
  UsersThreeIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Card } from "./cards";
import { formatAddress, type Address, type Index } from "./model";
import { NavigationProvider, useNavigation } from "./navigation";
import { initialMode, setMode, type Mode } from "./theme";

export function App({ index }: { index: Index }) {
  return (
    <NavigationProvider index={index}>
      <Sidebar.Provider defaultOpen collapsible="none" className="h-full">
        <Navigation />
        <main className="h-full min-w-0 flex-1 overflow-y-auto">
          <Story />
        </main>
      </Sidebar.Provider>
    </NavigationProvider>
  );
}

const SECTIONS: { id: string; label: string; icon: typeof HouseIcon }[] = [
  { id: "actors", label: "Actors", icon: UsersThreeIcon },
  { id: "flows", label: "Flows", icon: ArrowsSplitIcon },
  { id: "state", label: "State", icon: DatabaseIcon },
  { id: "invariants", label: "Invariants", icon: ShieldCheckIcon },
  { id: "boundaries", label: "Boundaries", icon: CubeIcon },
  { id: "contracts", label: "Contracts", icon: FileTextIcon },
  { id: "observability", label: "Observability", icon: EyeIcon },
  { id: "measurements", label: "Measurements", icon: GaugeIcon },
  { id: "claims", label: "Claims", icon: ScalesIcon },
];

function Navigation() {
  const { index, open, story } = useNavigation();
  const top = story[0];
  const isTop = (address: Address) => top !== undefined && formatAddress(top) === formatAddress(address);
  return (
    <Sidebar>
      <Sidebar.Header>
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="min-w-0">
            <Text variant="heading" truncate>
              {index.model.meta.system}
            </Text>
            <p className="font-mono text-xs text-kumo-subtle">{index.model.meta.source.commit.slice(0, 7)}</p>
          </div>
          <ModeToggle />
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={HouseIcon}
              active={isTop({ kind: "overview", id: "system" })}
              onClick={() => open({ kind: "overview", id: "system" })}
            >
              Overview
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Model</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {SECTIONS.map((section) => (
              <Sidebar.MenuButton
                key={section.id}
                icon={section.icon}
                active={isTop({ kind: "index", id: section.id })}
                onClick={() => open({ kind: "index", id: section.id })}
              >
                {section.label}
              </Sidebar.MenuButton>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Flows</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {index.model.flows.map((flow) => (
              <Sidebar.MenuButton
                key={flow.id}
                size="sm"
                active={isTop({ kind: "flow", id: flow.id })}
                onClick={() => open({ kind: "flow", id: flow.id })}
              >
                {flow.id}
              </Sidebar.MenuButton>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer>
        <ClaimSummary />
      </Sidebar.Footer>
    </Sidebar>
  );
}

function ClaimSummary() {
  const { index, open } = useNavigation();
  const claims = index.model.claims;
  const supported = claims.filter((claim) => claim.status === "supported").length;
  const other = claims.length - supported;
  return (
    <button
      type="button"
      onClick={() => open({ kind: "index", id: "claims" })}
      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-xs text-kumo-subtle hover:bg-kumo-tint"
    >
      <span className="flex items-center gap-1">
        <CheckCircleIcon className="text-kumo-success" size={14} /> {supported} supported
      </span>
      <span className="flex items-center gap-1">
        <XCircleIcon className="text-kumo-warning" size={14} /> {other} to review
      </span>
    </button>
  );
}

function ModeToggle() {
  const [mode, setModeState] = useState<Mode>(initialMode);
  useEffect(() => setMode(mode), [mode]);
  const next = mode === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      aria-label={`Switch to ${next} mode`}
      onClick={() => setModeState(next)}
    >
      {mode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </Button>
  );
}

function Story() {
  const { story, closeAll, open } = useNavigation();
  if (story.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Empty
          title="Nothing open"
          description="Pick something from the sidebar, or start from the overview."
          contents={<Button onClick={() => open({ kind: "overview", id: "system" })}>Open overview</Button>}
        />
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={closeAll}>
          Close all
        </Button>
      </div>
      {story.map((address) => (
        <Card key={formatAddress(address)} address={address} />
      ))}
    </div>
  );
}
