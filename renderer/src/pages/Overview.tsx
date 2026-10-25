import { Table, Tabs } from "@cloudflare/kumo";
import { interactions, SystemGraph } from "../diagrams/SystemGraph";
import { claimId, href, type Kind } from "../model";
import { usePreference } from "../router";
import { IdRef, IdRefs, Link, Page, STATUS_ORDER, useIndex } from "../ui";
import { ClaimRows } from "./Actors";

export function OverviewPage() {
  const index = useIndex();
  const { model } = index;
  const firstParty = model.actors.filter((actor) => actor.provenance === "first-party");
  const external = model.actors.filter((actor) => actor.provenance !== "first-party");
  const attention = model.claims
    .map((claim, i) => ({ id: claimId(i), claim }))
    .filter(({ claim }) => claim.status !== "supported")
    .sort((a, b) => STATUS_ORDER.indexOf(a.claim.status) - STATUS_ORDER.indexOf(b.claim.status));

  const inventory: [string, string, number, string][] = [
    ["Actors", href("actor"), model.actors.length, `${firstParty.length} in this repository, ${external.length} external`],
    ["Flows", href("flow"), model.flows.length, "Paths from a trigger to its effects"],
    ["State", href("state"), model.state.length, `${model.stateMachines?.length ?? 0} state machines`],
    ["Invariants", href("invariant"), model.invariants.length, "Properties that must always hold"],
    ["Boundaries", href("boundary"), model.boundaries?.length ?? 0, "Where data becomes trusted"],
    ["Contracts", href("contract"), model.contracts?.length ?? 0, "External behaviour that must stay stable"],
    ["Observability", href("observability"), model.observability?.length ?? 0, "How flows can be followed"],
    ["Measurements", "#/measurements", model.measurements?.length ?? 0, "Limits, timeouts, and rates"],
    ["Claims", href("claim" as Kind), model.claims.length, `${attention.length} need attention`],
  ];

  return (
    <Page
      title={model.meta.system}
      summary={model.meta.summary}
      sections={[
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
          id: "system",
          title: "System",
          content: <SystemView />,
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
  const [view, setView] = usePreference<"graph" | "table">("systemView", "graph");
  const edges = interactions(index).sort((a, b) => b.flows.length - a.flows.length);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        size="sm"
        value={view}
        onValueChange={(value) => setView(value as "graph" | "table")}
        tabs={[
          { value: "graph", label: "Graph" },
          { value: "table", label: "Interactions" },
        ]}
      />
      {view === "graph" ? (
        <SystemGraph index={index} />
      ) : (
        <Table layout="auto">
          <Table.Header>
            <Table.Row>
              <Table.Head>From</Table.Head>
              <Table.Head>To</Table.Head>
              <Table.Head>Flows</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {edges.map((edge) => (
              <Table.Row key={`${edge.from}-${edge.to}`}>
                <Table.Cell className="align-top whitespace-nowrap">
                  <IdRef id={edge.from} />
                </Table.Cell>
                <Table.Cell className="align-top whitespace-nowrap">
                  <IdRef id={edge.to} />
                </Table.Cell>
                <Table.Cell className="align-top text-sm">
                  <IdRefs ids={edge.flows} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}
