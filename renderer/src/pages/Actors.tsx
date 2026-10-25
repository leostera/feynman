import { Badge, Table } from "@cloudflare/kumo";
import { claimsAbout, href, roleIn, type Actor, type Claim, type FlowRole } from "../model";
import {
  Anchors,
  Code,
  Empty,
  IdRef,
  Link,
  Page,
  ProvenanceBadge,
  provenanceDescription,
  Share,
  StatusBadge,
  useIndex,
} from "../ui";

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

  return (
    <Page
      title="Actors"
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
  const messages = index.model.messages.filter((set) => set.actor === id);
  const owned = index.model.state.filter((state) => state.owner === id);
  const claims = claimsAbout(index, id);

  return (
    <Page
      title={actor.id}
      badges={<ProvenanceBadge provenance={actor.provenance} />}
      summary={actor.summary}
      facts={[
        ["Provenance", provenanceDescription(actor.provenance)],
        ...(actor.transports ? ([["Transports", <Code items={actor.transports} />]] as [string, React.ReactNode][]) : []),
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
          id: "messages",
          title: "Messages",
          count: messages.reduce((n, set) => n + (set.accepts?.length ?? 0), 0),
          content:
            messages.length === 0 ? (
              <Empty>No messages recorded for this actor.</Empty>
            ) : (
              <div className="flex flex-col gap-6">
                {messages.map((set) => (
                  <div key={set.transport} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <h3 className="font-mono text-sm font-medium text-kumo-default">{set.transport}</h3>
                      {set.summary && <p className="max-w-[70ch] text-sm leading-relaxed text-kumo-strong">{set.summary}</p>}
                    </div>
                    {set.accepts && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-kumo-subtle">Accepts</span>
                        <Code items={set.accepts} />
                      </div>
                    )}
                    {set.emits && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-kumo-subtle">Emits</span>
                        <Code items={set.emits} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ),
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
          content:
            claims.length === 0 ? (
              <Empty>No claims are about this actor.</Empty>
            ) : (
              <ClaimRows claims={claims} />
            ),
        },
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

export function ClaimRows({ claims }: { claims: { id: string; claim: Claim }[] }) {
  return (
    <Table layout="auto">
      <Table.Header>
        <Table.Row>
          <Table.Head>Status</Table.Head>
          <Table.Head>Claim</Table.Head>
          <Table.Head>About</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {claims.map(({ id, claim }) => (
          <Table.Row key={id}>
            <Table.Cell className="align-top whitespace-nowrap">
              <StatusBadge status={claim.status} />
            </Table.Cell>
            <Table.Cell className="max-w-[64ch] align-top">
              <Link to={href("claim", id)} className="text-kumo-default!">
                {claim.statement}
              </Link>
            </Table.Cell>
            <Table.Cell className="align-top text-sm">
              {claim.about && (
                <span className="flex flex-col gap-0.5">
                  {claim.about.map((ref) => (
                    <IdRef key={ref} id={ref} />
                  ))}
                </span>
              )}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}
