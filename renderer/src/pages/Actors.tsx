import { Badge, Table, Tabs } from "@cloudflare/kumo";
import { locationLabel, SystemGraph } from "../diagrams/SystemGraph";
import { claimsAbout, href, limitsAbout, protocolsOf, roleIn, type Actor, type FlowRole } from "../model";
import { usePreference } from "../router";
import { Anchors, Empty, Link, Page, ProvenanceBadge, provenanceDescription, Share, useIndex } from "../ui";
import { ClaimRows } from "./Claims";
import { LimitRows } from "./Limits";

export function ActorsPage() {
  const index = useIndex();
  const actors = index.model.actors;
  const total = index.model.meta.source.footprint?.lines ?? 0;
  const firstParty = actors
    .filter((actor) => actor.provenance === "first-party")
    .sort((a, b) => (b.footprint?.lines ?? 0) - (a.footprint?.lines ?? 0));
  const external = actors
    .filter((actor) => actor.provenance !== "first-party")
    .sort((a, b) => a.provenance.localeCompare(b.provenance) || a.id.localeCompare(b.id));
  const flowCount = (actor: Actor) => index.model.flows.filter((flow) => roleIn(flow, actor.id) !== null).length;
  const [view, setView] = usePreference<"table" | "graph">("actorsView", "table");
  const switcher = (
    <Tabs
      size="sm"
      value={view}
      onValueChange={(value) => setView(value as "table" | "graph")}
      tabs={[
        { value: "table", label: "Table" },
        { value: "graph", label: "Graph" },
      ]}
    />
  );

  if (view === "graph") {
    return (
      <Page
        title="Actors"
        badges={switcher}
        summary="One edge per pair of actors that interact in any flow; thicker edges carry more flows. Colour is where an actor runs; hollow nodes are external."
        sections={[{ id: "graph", title: "", content: <SystemGraph index={index} height={600} /> }]}
      />
    );
  }

  return (
    <Page
      title="Actors"
      badges={switcher}
      summary="Things that receive messages and own state. First-party actors are implemented in this repository; external actors are software, services, or platform facilities the system depends on."
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
                    <Table.Cell className="align-top">
                      {actor.footprint?.lines !== undefined ? <Share lines={actor.footprint.lines} total={total} /> : "—"}
                    </Table.Cell>
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

  return (
    <Page
      title={actor.id}
      badges={<ProvenanceBadge provenance={actor.provenance} />}
      summary={actor.summary}
      facts={[
        ["Provenance", provenanceDescription(actor.provenance)],
        ["Runs on", locationLabel(actor)],
        ...(actor.footprint?.lines !== undefined
          ? ([["Share of code", <Share lines={actor.footprint.lines} total={total} />]] as [string, React.ReactNode][])
          : []),
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
        ...(actor.footprint
          ? [
              {
                id: "code",
                title: "Code",
                count: actor.footprint.files,
                content: <Anchors anchors={actor.footprint.paths} />,
              },
            ]
          : []),
        { id: "anchors", title: "Anchors", count: actor.anchors.length, content: <Anchors anchors={actor.anchors} /> },
      ]}
    />
  );
}
