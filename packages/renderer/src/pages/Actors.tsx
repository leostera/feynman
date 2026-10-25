import { Badge, Table } from "@cloudflare/kumo";
import { locationLabel } from "../diagrams/SystemGraph";
import { actorLines, claimsAbout, componentsOf, href, limitsAbout, protocolsOf, roleIn, type Actor, type ActorKind, type FlowRole } from "../model";
import { Anchors, Empty, IdRefs, Link, Page, ProvenanceBadge, provenanceDescription, Share, useIndex } from "../ui";
import { ClaimRows } from "./Claims";
import { LimitRows } from "./Limits";

export function ActorsPage() {
  const index = useIndex();
  const actors = index.model.actors;
  const total = index.model.meta.source.footprint?.lines ?? 0;
  const firstParty = actors
    .filter((actor) => actor.provenance === "first-party")
    .sort((a, b) => (actorLines(index, b.id) ?? 0) - (actorLines(index, a.id) ?? 0));
  const external = actors
    .filter((actor) => actor.provenance !== "first-party")
    .sort((a, b) => a.provenance.localeCompare(b.provenance) || a.id.localeCompare(b.id));
  const flowCount = (actor: Actor) => index.model.flows.filter((flow) => roleIn(flow, actor.id) !== null).length;
  return (
    <Page
      title="Actors"
      summary="Who and what takes part in the system at runtime: the people and programs that use it, the processes it runs, and the services it calls. First-party actors run code from this repository, in components."
      sections={[
        {
          id: "first-party",
          title: "In this repository",
          count: firstParty.length,
          content: (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Actor</Table.Head>
                  <Table.Head>Summary</Table.Head>
                  <Table.Head>Runs on</Table.Head>
                  <Table.Head>Components</Table.Head>
                  <Table.Head>Share of code</Table.Head>
                  <Table.Head className="text-right">Flows</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {firstParty.map((actor) => (
                  <Table.Row key={actor.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("actor", actor.id)}>{actor.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[52ch] align-top text-kumo-strong">{actor.summary}</Table.Cell>
                    <Table.Cell className="align-top text-sm text-kumo-strong">{locationLabel(actor)}</Table.Cell>
                    <Table.Cell className="align-top text-sm">
                      <IdRefs kind="component" ids={componentsOf(index, actor.id).map((component) => component.id)} />
                    </Table.Cell>
                    <Table.Cell className="align-top">{lines(index, actor) !== undefined ? <Share lines={lines(index, actor)!} total={total} /> : "—"}</Table.Cell>
                    <Table.Cell className="text-right align-top tabular-nums">{flowCount(actor)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ),
        },
        {
          id: "external",
          title: "External",
          count: external.length,
          content: (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Actor</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Provenance</Table.Head>
                  <Table.Head>Summary</Table.Head>
                  <Table.Head>Runs on</Table.Head>
                  <Table.Head className="text-right">Flows</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {external.map((actor) => (
                  <Table.Row key={actor.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("actor", actor.id)}>{actor.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="align-top text-sm text-kumo-strong">{actor.kind ? KIND_LABEL[actor.kind] : "—"}</Table.Cell>
                    <Table.Cell className="align-top">
                      <ProvenanceBadge provenance={actor.provenance} />
                    </Table.Cell>
                    <Table.Cell className="max-w-[60ch] align-top text-kumo-strong">{actor.summary}</Table.Cell>
                    <Table.Cell className="align-top text-sm text-kumo-strong">{locationLabel(actor)}</Table.Cell>
                    <Table.Cell className="text-right align-top tabular-nums">{flowCount(actor)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ),
        },
      ]}
    />
  );
}

const KIND_LABEL: Record<ActorKind, string> = { person: "Person", program: "Program", service: "Service" };

const lines = (index: ReturnType<typeof useIndex>, actor: Actor) => actorLines(index, actor.id);

const ROLE_LABEL: Record<FlowRole, string> = {
  initiates: "Initiates",
  acts: "Takes part",
  receives: "Receives",
};

export function ActorPage({ id }: { id: string }) {
  const index = useIndex();
  const actor = index.actors.get(id);
  if (!actor) return null;
  const total = index.model.meta.source.footprint?.lines ?? 0;
  const flows = index.model.flows
    .map((flow) => ({ flow, role: roleIn(flow, id) }))
    .filter((entry): entry is { flow: typeof entry.flow; role: FlowRole } => entry.role !== null);
  const protocols = protocolsOf(index, id);
  const owned = index.model.state.filter((state) => state.owner === id);
  const claims = claimsAbout(index, { kind: "actor", id });
  const limits = limitsAbout(index, { kind: "actor", id });
  const components = componentsOf(index, id);
  const code = actorLines(index, id);

  return (
    <Page
      title={actor.id}
      badges={<ProvenanceBadge provenance={actor.provenance} />}
      summary={actor.summary}
      facts={[
        ...(actor.kind ? ([["Kind", KIND_LABEL[actor.kind]]] as [string, React.ReactNode][]) : []),
        ["Provenance", provenanceDescription(actor.provenance)],
        ["Runs on", locationLabel(actor)],
        ...(actor.talksTo?.length ? ([["Talks to", <IdRefs kind="actor" ids={actor.talksTo} />]] as [string, React.ReactNode][]) : []),
        ...(code !== undefined ? ([["Share of code", <Share lines={code} total={total} />]] as [string, React.ReactNode][]) : []),
      ]}
      sections={[
        {
          id: "flows",
          title: "Flows",
          count: flows.length,
          content:
            flows.length === 0 ? (
              <Empty>Not part of any modelled flow.</Empty>
            ) : (
              <Table layout="auto">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Flow</Table.Head>
                    <Table.Head>Role</Table.Head>
                    <Table.Head>Summary</Table.Head>
                    <Table.Head className="text-right whitespace-nowrap">Own steps</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {flows.map(({ flow, role }) => (
                    <Table.Row key={flow.id}>
                      <Table.Cell className="align-top font-medium whitespace-nowrap">
                        <Link to={href("flow", flow.id)}>{flow.id}</Link>
                      </Table.Cell>
                      <Table.Cell className="align-top whitespace-nowrap">
                        <Badge variant={role === "receives" ? "neutral" : role === "initiates" ? "purple" : "blue"}>
                          {ROLE_LABEL[role]}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="max-w-[56ch] align-top text-kumo-strong">{flow.summary}</Table.Cell>
                      <Table.Cell className="text-right align-top tabular-nums">
                        {flow.steps.filter((step) => step.actor === id).length} / {flow.steps.length}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            ),
        },
        {
          id: "protocols",
          title: "Protocols",
          count: protocols.length,
          content: protocols.length ? (
            <Table layout="auto">
              <Table.Body>
                {protocols.map(({ protocol, role }) => (
                  <Table.Row key={protocol.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("protocol", protocol.id)}>{protocol.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="align-top text-sm whitespace-nowrap text-kumo-subtle">{role}</Table.Cell>
                    <Table.Cell className="max-w-[56ch] align-top text-kumo-strong">{protocol.summary}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : null,
        },
        {
          id: "owns",
          title: "Owns",
          count: owned.length,
          content:
            owned.length === 0 ? (
              <Empty>Owns no modelled state.</Empty>
            ) : (
              <Table layout="auto">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>State</Table.Head>
                    <Table.Head>Summary</Table.Head>
                    <Table.Head>Lifetime</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {owned.map((state) => (
                    <Table.Row key={state.id}>
                      <Table.Cell className="align-top font-medium whitespace-nowrap">
                        <Link to={href("state", state.id)}>{state.id}</Link>
                      </Table.Cell>
                      <Table.Cell className="max-w-[56ch] align-top text-kumo-strong">{state.summary}</Table.Cell>
                      <Table.Cell className="align-top text-kumo-strong">{state.lifetime}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            ),
        },
        {
          id: "claims",
          title: "Claims",
          count: claims.length,
          content: claims.length ? <ClaimRows claims={claims} /> : null,
        },
        { id: "limits", title: "Limits", count: limits.length, content: limits.length ? <LimitRows limits={limits} /> : null },
        {
          id: "components",
          title: "Components",
          count: components.length,
          content: components.length ? (
            <Table layout="auto">
              <Table.Body>
                {components.map((component) => (
                  <Table.Row key={component.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("component", component.id)}>{component.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[60ch] align-top text-kumo-strong">{component.summary}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : null,
        },
        { id: "anchors", title: "Anchors", count: actor.anchors.length, content: <Anchors anchors={actor.anchors} /> },
      ]}
    />
  );
}
