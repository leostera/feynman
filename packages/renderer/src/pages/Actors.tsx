import { Badge } from "@cloudflare/kumo";
import { connections, locationLabel, SystemGraph } from "../diagrams/SystemGraph";
import { actorLines, claimsAbout, componentsOf, limitsAbout, protocolsOf, roleIn, type Actor, type ActorKind, type FlowRole, type Index } from "../model";
import { Anchors, CELL, idColumn, IdRef, IdRefs, Page, ProvenanceBadge, provenanceDescription, Rows, Share, useIndex, type Column } from "../ui";
import { ClaimRows } from "./Claims";
import { LimitRows } from "./Limits";

const KIND_LABEL: Record<ActorKind, string> = { person: "Person", program: "Program", service: "Service" };

const ROLE: Record<FlowRole, { label: string; variant: "purple" | "blue" | "neutral" }> = {
  initiates: { label: "Initiates", variant: "purple" },
  acts: { label: "Takes part", variant: "blue" },
  receives: { label: "Receives", variant: "neutral" },
};

export function ActorsPage() {
  const index = useIndex();
  const { actors } = index.model;
  const firstParty = actors
    .filter((actor) => actor.provenance === "first-party")
    .sort((a, b) => (actorLines(index, b.id) ?? 0) - (actorLines(index, a.id) ?? 0));
  const external = actors
    .filter((actor) => actor.provenance !== "first-party")
    .sort((a, b) => a.provenance.localeCompare(b.provenance) || a.id.localeCompare(b.id));
  const flowCount: Column<Actor> = { head: "Flows", className: CELL.number, cell: (actor) => index.model.flows.filter((flow) => roleIn(flow, actor.id)).length };
  const runsOn: Column<Actor> = { head: "Runs on", className: CELL.fact, cell: locationLabel };
  return (
    <Page
      title="Actors"
      summary="Who and what takes part in the system at runtime: the people and programs that use it, the processes it runs, and the services it calls. First-party actors run code from this repository, in components."
      sections={[
        { id: "graph", title: "", content: <SystemGraph index={index} /> },
        {
          id: "first-party",
          title: "In this repository",
          count: firstParty.length,
          content: (
            <Rows
              rows={firstParty}
              rowKey={(actor) => actor.id}
              columns={[
                idColumn("actor", "Actor"),
                { head: "Summary", className: CELL.prose, cell: (actor) => actor.summary },
                runsOn,
                { head: "Components", className: "align-top text-sm", cell: (actor) => <IdRefs kind="component" ids={componentsOf(index, actor.id).map((c) => c.id)} /> },
                { head: "Share of code", cell: (actor) => <CodeShare index={index} actor={actor.id} /> },
                flowCount,
              ]}
            />
          ),
        },
        {
          id: "external",
          title: "External",
          count: external.length,
          content: (
            <Rows
              rows={external}
              rowKey={(actor) => actor.id}
              columns={[
                idColumn("actor", "Actor"),
                { head: "Kind", className: CELL.fact, cell: (actor) => KIND_LABEL[actor.kind] },
                { head: "Provenance", cell: (actor) => <ProvenanceBadge provenance={actor.provenance} /> },
                { head: "Summary", className: CELL.prose, cell: (actor) => actor.summary },
                runsOn,
                flowCount,
              ]}
            />
          ),
        },
        { id: "interactions", title: "Interactions", count: connections(index).length, content: <Interactions /> },
      ]}
    />
  );
}

function CodeShare({ index, actor }: { index: Index; actor: string }) {
  const lines = actorLines(index, actor);
  return lines === undefined ? "—" : <Share lines={lines} total={index.model.meta.source.footprint?.lines ?? 0} />;
}

export function ActorPage({ id }: { id: string }) {
  const index = useIndex();
  const actor = index.actors.get(id);
  if (!actor) return null;
  const flows = index.model.flows.flatMap((flow) => {
    const role = roleIn(flow, id);
    return role ? [{ flow, role }] : [];
  });
  const protocols = protocolsOf(index, id);
  const owned = index.model.state.filter((state) => state.owner === id);
  const claims = claimsAbout(index, { kind: "actor", id });
  const limits = limitsAbout(index, { kind: "actor", id });
  const components = componentsOf(index, id);

  return (
    <Page
      title={actor.id}
      badges={<ProvenanceBadge provenance={actor.provenance} />}
      summary={actor.summary}
      facts={[
        ["Kind", KIND_LABEL[actor.kind]],
        ["Provenance", provenanceDescription(actor.provenance)],
        ["Runs on", locationLabel(actor)],
        ["Talks to", actor.talksTo?.length ? <IdRefs kind="actor" ids={actor.talksTo} /> : null],
        ["Share of code", actorLines(index, id) === undefined ? null : <CodeShare index={index} actor={id} />],
      ]}
      sections={[
        {
          id: "flows",
          title: "Flows",
          count: flows.length,
          content: (
            <Rows
              rows={flows}
              rowKey={({ flow }) => flow.id}
              empty="Not part of any modelled flow."
              columns={[
                { head: "Flow", className: CELL.id, cell: ({ flow }) => <IdRef kind="flow" id={flow.id} /> },
                { head: "Role", className: "align-top whitespace-nowrap", cell: ({ role }) => <Badge variant={ROLE[role].variant}>{ROLE[role].label}</Badge> },
                { head: "Summary", className: CELL.prose, cell: ({ flow }) => flow.summary },
                { head: "Own steps", className: CELL.number, cell: ({ flow }) => `${flow.steps.filter((step) => step.actor === id).length} / ${flow.steps.length}` },
              ]}
            />
          ),
        },
        {
          id: "protocols",
          title: "Protocols",
          count: protocols.length,
          content: (
            <Rows
              rows={protocols}
              rowKey={({ protocol }) => protocol.id}
              columns={[
                { className: CELL.id, cell: ({ protocol }) => <IdRef kind="protocol" id={protocol.id} /> },
                { className: "align-top text-sm whitespace-nowrap text-kumo-subtle", cell: ({ role }) => role },
                { className: CELL.prose, cell: ({ protocol }) => protocol.summary },
              ]}
            />
          ),
        },
        {
          id: "owns",
          title: "Owns",
          count: owned.length,
          content: (
            <Rows
              rows={owned}
              rowKey={(state) => state.id}
              empty="Owns no modelled state."
              columns={[
                idColumn("state", "State"),
                { head: "Summary", className: CELL.prose, cell: (state) => state.summary },
                { head: "Lifetime", className: "align-top text-kumo-strong", cell: (state) => state.lifetime },
              ]}
            />
          ),
        },
        { id: "claims", title: "Claims", count: claims.length, content: claims.length ? <ClaimRows claims={claims} /> : null },
        { id: "limits", title: "Limits", count: limits.length, content: limits.length ? <LimitRows limits={limits} /> : null },
        {
          id: "components",
          title: "Components",
          count: components.length,
          content: <Rows rows={components} rowKey={(c) => c.id} columns={[idColumn("component", ""), { className: CELL.prose, cell: (c) => c.summary }]} />,
        },
        { id: "anchors", title: "Anchors", count: actor.anchors.length, content: <Anchors anchors={actor.anchors} /> },
      ]}
    />
  );
}

/** Pairs of actors that interact, and the flows in which they do. */
function Interactions() {
  const index = useIndex();
  const edges = connections(index).sort((a, b) => b.flows.length - a.flows.length);
  return (
    <Rows
      rows={edges}
      rowKey={(edge) => `${edge.from}-${edge.to}`}
      columns={[
        { head: "Actor", className: "align-top whitespace-nowrap", cell: (edge) => <IdRef kind="actor" id={edge.from} /> },
        { head: "Actor", className: "align-top whitespace-nowrap", cell: (edge) => <IdRef kind="actor" id={edge.to} /> },
        {
          head: "Flows",
          className: "align-top text-sm",
          cell: (edge) => (edge.flows.length ? <IdRefs kind="flow" ids={edge.flows} /> : <span className="text-kumo-subtle">talk; no flow shows how yet</span>),
        },
      ]}
    />
  );
}
