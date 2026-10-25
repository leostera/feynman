import { Table, Tabs } from "@cloudflare/kumo";
import { ComponentGraph, connections, SystemGraph } from "../diagrams/SystemGraph";
import { href } from "../model";
import { usePreference } from "../router";
import { IdRef, IdRefs, Link, Page, STATUS_ORDER, useIndex } from "../ui";
import { ClaimRows } from "./Claims";

export function OverviewPage() {
  const index = useIndex();
  const { model } = index;
  const firstParty = model.actors.filter((actor) => actor.provenance === "first-party");
  const external = model.actors.filter((actor) => actor.provenance !== "first-party");
  const attention = model.claims
    .filter((claim) => claim.status !== "supported")
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  const inventory: [string, string, number, string][] = [
    ["Actors", href("actor"), model.actors.length, `${firstParty.length} run code from this repository, ${external.length} external`],
    ["Components", href("component"), model.components.length, "Units of code, and the actors they run in"],
    ["Flows", href("flow"), model.flows.length, "What the system does, from a trigger to an outcome"],
    ["Protocols", href("protocol"), model.protocols.length, "Shapes data must have to cross in, out, or rest"],
    ["State", href("state"), model.state.length, `${model.stateMachines.length} state machines`],
    ["Invariants", href("invariant"), model.invariants.length, "What the system makes sure always holds"],
    ["Claims", href("claim"), model.claims.length, `${attention.length} need attention`],
    ["Limits", href("limit"), model.limits.length, "Sizes, counts, timeouts, and rates"],
  ];

  return (
    <Page
      title={model.meta.system}
      summary={model.meta.summary}
      sections={[
        {
          id: "system",
          title: "System",
          content: <SystemView />,
        },
        {
          id: "inventory",
          title: "Inventory",
          content: (
            <Table layout="auto">
              <Table.Body>
                {inventory.map(([label, to, count, note]) => (
                  <Table.Row key={label}>
                    <Table.Cell className="w-40 font-medium">
                      <Link to={to}>{label}</Link>
                    </Table.Cell>
                    <Table.Cell className="w-16 text-right tabular-nums">{count}</Table.Cell>
                    <Table.Cell className="text-kumo-strong">{note}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ),
        },
        {
          id: "attention",
          title: "Needs attention",
          count: attention.length,
          content: attention.length > 0 ? <ClaimRows claims={attention} /> : null,
        },
        {
          id: "coverage",
          title: "Coverage",
          content: model.meta.coverage ? <p className="max-w-[70ch] text-kumo-strong">{model.meta.coverage}</p> : null,
        },
      ]}
    />
  );
}

function SystemView() {
  const index = useIndex();
  const [view, setView] = usePreference<"actors" | "components" | "table">("systemView", "actors");
  const edges = connections(index).sort((a, b) => b.flows.length - a.flows.length);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        size="sm"
        value={view}
        onValueChange={(value) => setView(value as "actors" | "components" | "table")}
        tabs={[
          { value: "actors", label: "Actors" },
          ...(index.model.components.length ? [{ value: "components", label: "Components" }] : []),
          { value: "table", label: "Interactions" },
        ]}
      />
      {view === "actors" || (view === "components" && !index.model.components.length) ? (
        <SystemGraph index={index} />
      ) : view === "components" ? (
        <ComponentGraph index={index} />
      ) : (
        <Table layout="auto">
          <Table.Header>
            <Table.Row>
              <Table.Head>Actor</Table.Head>
              <Table.Head>Actor</Table.Head>
              <Table.Head>Flows</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {edges.map((edge) => (
              <Table.Row key={`${edge.from}-${edge.to}`}>
                <Table.Cell className="align-top whitespace-nowrap">
                  <IdRef kind="actor" id={edge.from} />
                </Table.Cell>
                <Table.Cell className="align-top whitespace-nowrap">
                  <IdRef kind="actor" id={edge.to} />
                </Table.Cell>
                <Table.Cell className="align-top text-sm">
                  <IdRefs kind="flow" ids={edge.flows} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}
