import { Badge, Button, LayerCard, Table, Tabs, Text } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { SequenceDiagram } from "./diagrams/SequenceDiagram";
import { Swimlane } from "./diagrams/Swimlane";
import { interactions, SystemGraph } from "./diagrams/SystemGraph";
import { claimId, flowParticipants, type Address, type Claim, type Flow, type Index } from "./model";
import { cardDomId, useNavigation, usePreference } from "./navigation";
import {
  Anchors,
  Chips,
  IdRef,
  KindBadge,
  Ref,
  Section,
  STATUS_ORDER,
  StatusBadge,
  statusLabel,
} from "./ui";

export function Card({ address }: { address: Address }) {
  const { index, close } = useNavigation();
  const content = renderCard(index, address);
  return (
    <LayerCard id={cardDomId(address)} className="scroll-mt-4">
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <KindBadge kind={address.kind} />
          <Text variant="heading" as="h2" truncate>
            {content?.title ?? address.id}
          </Text>
        </div>
        <Button variant="ghost" size="sm" shape="square" aria-label="Close card" onClick={() => close(address)}>
          <XIcon size={16} />
        </Button>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-5">
        {content?.body ?? <Text variant="secondary">This element is not in the model.</Text>}
      </LayerCard.Primary>
    </LayerCard>
  );
}

interface CardContent {
  title: string;
  body: ReactNode;
}

function renderCard(index: Index, address: Address): CardContent | null {
  const { kind, id } = address;
  switch (kind) {
    case "overview":
      return { title: index.model.meta.system, body: <Overview index={index} /> };
    case "index":
      return INDEX_CARDS[id] ? { title: INDEX_CARDS[id].title, body: INDEX_CARDS[id].render(index) } : null;
    case "actor": {
      const actor = index.actors.get(id);
      return actor ? { title: actor.id, body: <ActorBody index={index} id={id} /> } : null;
    }
    case "flow": {
      const flow = index.flows.get(id);
      return flow ? { title: flow.id, body: <FlowBody index={index} flow={flow} /> } : null;
    }
    case "state": {
      const state = index.state.get(id);
      if (!state) return null;
      return {
        title: state.id,
        body: (
          <>
            <Text>{state.summary}</Text>
            <Facts rows={[["Owner", <IdRef id={state.owner} />], ["Lifetime", state.lifetime]]} />
            <Anchors anchors={state.anchors} />
          </>
        ),
      };
    }
    case "machine": {
      const machine = index.machines.get(id);
      if (!machine) return null;
      return {
        title: machine.id,
        body: (
          <>
            {machine.summary && <Text>{machine.summary}</Text>}
            {machine.states && (
              <Section title="States">
                <Chips items={machine.states} />
              </Section>
            )}
            {machine.transitions && (
              <Section title="Transitions">
                <BulletList items={machine.transitions} />
              </Section>
            )}
            <Anchors anchors={machine.anchors} />
          </>
        ),
      };
    }
    case "boundary": {
      const boundary = index.boundaries.get(id);
      if (!boundary) return null;
      return {
        title: boundary.id,
        body: (
          <>
            <Text>{boundary.summary}</Text>
            <Facts
              rows={[
                ["Parses into", boundary.parsesInto ?? "—"],
                [
                  "Effects only after parsing",
                  boundary.effectsAfterParse === undefined ? "not stated" : boundary.effectsAfterParse ? "yes" : "no",
                ],
              ]}
            />
            <UsedIn index={index} test={(flow) => flow.steps.some((step) => step.boundary === id)} />
            <Anchors anchors={boundary.anchors} />
          </>
        ),
      };
    }
    case "invariant": {
      const invariant = index.invariants.get(id);
      if (!invariant) return null;
      return {
        title: invariant.id,
        body: (
          <>
            <Text size="lg">{invariant.statement}</Text>
            <Section title="Enforced by">
              <Chips items={invariant.enforcedBy} />
            </Section>
            {invariant.consequence && (
              <Section title="If it breaks">
                <Text>{invariant.consequence}</Text>
              </Section>
            )}
            <Anchors anchors={invariant.anchors} />
          </>
        ),
      };
    }
    case "contract": {
      const contract = index.contracts.get(id);
      if (!contract) return null;
      return {
        title: contract.id,
        body: (
          <>
            {contract.summary && <Text>{contract.summary}</Text>}
            <Anchors anchors={contract.anchors} />
          </>
        ),
      };
    }
    case "observability": {
      const item = index.observability.get(id);
      if (!item) return null;
      return {
        title: item.id,
        body: (
          <>
            {item.summary && <Text>{item.summary}</Text>}
            {item.confidence && <Facts rows={[["Confidence", item.confidence]]} />}
            <Anchors anchors={item.anchors} />
          </>
        ),
      };
    }
    case "claim": {
      const claim = index.claims.get(id);
      return claim ? { title: "Claim", body: <ClaimBody claim={claim} /> } : null;
    }
  }
}

function Overview({ index }: { index: Index }) {
  const { meta } = index.model;
  const counts: [string, number, string][] = [
    ["Actors", index.actors.size, "actors"],
    ["Flows", index.flows.size, "flows"],
    ["Invariants", index.invariants.size, "invariants"],
    ["Claims", index.claims.size, "claims"],
    ["Measurements", index.model.measurements?.length ?? 0, "measurements"],
  ];
  const attention = index.model.claims.filter((claim) => claim.status !== "supported").length;
  return (
    <>
      <Text size="lg">{meta.summary}</Text>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {counts.map(([label, count, id]) => (
          <Ref plain key={id} to={{ kind: "index", id }}>
            <div className="rounded-lg bg-kumo-recessed p-3">
              <div className="text-2xl font-semibold text-kumo-default">{count}</div>
              <div className="text-xs text-kumo-subtle">{label}</div>
            </div>
          </Ref>
        ))}
      </div>
      {attention > 0 && (
        <div className="flex items-center gap-2">
          <Badge variant="warning">{attention} claims need attention</Badge>
          <Ref to={{ kind: "index", id: "claims" }}>Review claims</Ref>
        </div>
      )}
      <Section title="System">
        <SystemView index={index} />
      </Section>
      <Facts
        rows={[
          ["Source", `${meta.source.repository} @ ${meta.source.commit.slice(0, 7)}`],
          ["Extraction", `${meta.extraction}${meta.extractedBy ? ` by ${meta.extractedBy}` : ""}`],
          ...(meta.coverage ? ([["Coverage", meta.coverage]] as [string, ReactNode][]) : []),
        ]}
      />
    </>
  );
}

function SystemView({ index }: { index: Index }) {
  const [view, setView] = usePreference<"graph" | "table">("systemView", "graph");
  return (
    <div className="flex flex-col gap-3">
      <Tabs
        size="sm"
        value={view}
        onValueChange={(value) => setView(value as "graph" | "table")}
        tabs={[
          { value: "graph", label: "Graph" },
          { value: "table", label: "Interactions" },
        ]}
      />
      {view === "graph" ? <SystemGraph index={index} /> : <InteractionTable index={index} />}
    </div>
  );
}

function InteractionTable({ index }: { index: Index }) {
  const edges = interactions(index).sort((a, b) => b.flows.length - a.flows.length);
  return (
    <Table>
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
            <Table.Cell>
              <IdRef id={edge.from} />
            </Table.Cell>
            <Table.Cell>
              <IdRef id={edge.to} />
            </Table.Cell>
            <Table.Cell>
              <InlineRefs ids={edge.flows} />
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function ActorBody({ index, id }: { index: Index; id: string }) {
  const actor = index.actors.get(id)!;
  const messages = index.model.messages.filter((set) => set.actor === id);
  const owned = index.model.state.filter((state) => state.owner === id);
  return (
    <>
      <Text size="lg">{actor.summary}</Text>
      {actor.transports && (
        <Section title="Transports">
          <Chips items={actor.transports} />
        </Section>
      )}
      {messages.map((set) => (
        <Section key={set.transport} title={`Messages · ${set.transport}`}>
          {set.summary && <Text variant="secondary">{set.summary}</Text>}
          {set.accepts && (
            <div className="flex flex-col gap-1">
              <Text size="xs" variant="secondary">
                Accepts
              </Text>
              <MonoList items={set.accepts} />
            </div>
          )}
          {set.emits && (
            <div className="flex flex-col gap-1">
              <Text size="xs" variant="secondary">
                Emits
              </Text>
              <MonoList items={set.emits} />
            </div>
          )}
        </Section>
      ))}
      {owned.length > 0 && (
        <Section title="Owns">
          <InlineRefs ids={owned.map((state) => state.id)} />
        </Section>
      )}
      <UsedIn index={index} test={(flow) => flowParticipants(flow).includes(id)} title="Takes part in" />
      <Anchors anchors={actor.anchors} />
    </>
  );
}

type FlowView = "sequence" | "swimlane" | "steps";

function FlowBody({ index, flow }: { index: Index; flow: Flow }) {
  const [view, setView] = usePreference<FlowView>("flowView", "sequence");
  const callers = index.usedBy.get(flow.id) ?? [];
  return (
    <>
      <Text size="lg">{flow.summary}</Text>
      <Facts rows={[["Trigger", flow.trigger]]} />
      <div className="flex flex-col gap-3">
        <Tabs
          size="sm"
          value={view}
          onValueChange={(value) => setView(value as FlowView)}
          tabs={[
            { value: "sequence", label: "Sequence" },
            { value: "swimlane", label: "Swimlane" },
            { value: "steps", label: "Steps" },
          ]}
        />
        {view === "sequence" && <SequenceDiagram flow={flow} />}
        {view === "swimlane" && <Swimlane flow={flow} />}
        {view === "steps" && <StepList flow={flow} />}
      </div>
      {callers.length > 0 && (
        <Section title="Used by">
          <InlineRefs ids={callers} />
        </Section>
      )}
      <Anchors anchors={flow.anchors} />
    </>
  );
}

function StepList({ flow }: { flow: Flow }) {
  return (
    <ol className="flex flex-col gap-2">
      {flow.steps.map((step, i) => (
        <li key={i} className="flex gap-3 rounded-md bg-kumo-recessed p-3">
          <span className="font-mono text-sm text-kumo-subtle">{i + 1}</span>
          <div className="flex flex-col gap-1">
            <div className="text-sm">
              <span className="font-medium">
                <IdRef id={step.actor} />
              </span>
              {step.target && (
                <>
                  {" → "}
                  <IdRef id={step.target} />
                </>
              )}
              <span className="text-kumo-subtle">: </span>
              {step.action}
            </div>
            <div className="flex flex-wrap gap-1">
              {step.ref && (
                <Badge variant="purple">
                  ↳ <IdRef id={step.ref} />
                </Badge>
              )}
              {step.boundary && (
                <Badge variant="orange">
                  ⇥ <IdRef id={step.boundary} />
                </Badge>
              )}
              {step.properties?.map((property) => (
                <Badge key={property} variant="neutral">
                  {property}
                </Badge>
              ))}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ClaimBody({ claim }: { claim: Claim }) {
  return (
    <>
      <div className="flex gap-2">
        <StatusBadge status={claim.status} />
        <Badge variant="outline">{claim.epistemic}</Badge>
      </div>
      <Text size="lg">{claim.statement}</Text>
      {claim.note && (
        <Section title="Note">
          <Text>{claim.note}</Text>
        </Section>
      )}
      <Anchors anchors={claim.evidence} label="Evidence" />
    </>
  );
}

// Index cards: one list per element kind.

const INDEX_CARDS: Record<string, { title: string; render: (index: Index) => ReactNode }> = {
  actors: {
    title: "Actors",
    render: (index) => (
      <SummaryList kind="actor" items={index.model.actors.map((actor) => [actor.id, actor.summary])} />
    ),
  },
  flows: {
    title: "Flows",
    render: (index) => <SummaryList kind="flow" items={index.model.flows.map((flow) => [flow.id, flow.summary])} />,
  },
  state: {
    title: "State",
    render: (index) => (
      <>
        <SummaryList kind="state" items={index.model.state.map((state) => [state.id, state.summary])} />
        {index.model.stateMachines && (
          <Section title="State machines">
            <SummaryList
              kind="machine"
              items={index.model.stateMachines.map((machine) => [machine.id, machine.summary ?? ""])}
            />
          </Section>
        )}
      </>
    ),
  },
  invariants: {
    title: "Invariants",
    render: (index) => (
      <SummaryList kind="invariant" items={index.model.invariants.map((item) => [item.id, item.statement])} />
    ),
  },
  boundaries: {
    title: "Boundaries",
    render: (index) => (
      <SummaryList kind="boundary" items={(index.model.boundaries ?? []).map((item) => [item.id, item.summary])} />
    ),
  },
  contracts: {
    title: "Contracts",
    render: (index) => (
      <SummaryList kind="contract" items={(index.model.contracts ?? []).map((item) => [item.id, item.summary ?? ""])} />
    ),
  },
  observability: {
    title: "Observability",
    render: (index) => (
      <SummaryList
        kind="observability"
        items={(index.model.observability ?? []).map((item) => [item.id, item.summary ?? ""])}
      />
    ),
  },
  claims: { title: "Claims", render: (index) => <ClaimsIndex index={index} /> },
  measurements: { title: "Measurements", render: (index) => <MeasurementsIndex index={index} /> },
};

export const INDEX_IDS = Object.keys(INDEX_CARDS);

function ClaimsIndex({ index }: { index: Index }) {
  const claims = index.model.claims.map((claim, i) => ({ claim, id: claimId(i) }));
  return (
    <>
      {STATUS_ORDER.map((status) => {
        const group = claims.filter(({ claim }) => claim.status === status);
        if (group.length === 0) return null;
        return (
          <Section key={status} title={`${statusLabel(status)} (${group.length})`}>
            <ul className="flex flex-col gap-2">
              {group.map(({ claim, id }) => (
                <li key={id} className="flex flex-col gap-1 rounded-md bg-kumo-recessed p-3">
                  <div className="flex gap-2">
                    <StatusBadge status={claim.status} />
                    <Badge variant="outline">{claim.epistemic}</Badge>
                  </div>
                  <Ref plain to={{ kind: "claim", id }}>
                    <span className="text-sm">{claim.statement}</span>
                  </Ref>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
    </>
  );
}

function MeasurementsIndex({ index }: { index: Index }) {
  const measurements = index.model.measurements ?? [];
  const kinds = [...new Set(measurements.map((m) => m.kind))];
  return (
    <>
      {kinds.map((kind) => (
        <Section key={kind} title={kind}>
          <Table>
            <Table.Body>
              {measurements
                .filter((m) => m.kind === kind)
                .map((m) => (
                  <Table.Row key={m.subject}>
                    <Table.Cell>{m.subject}</Table.Cell>
                    <Table.Cell className="font-mono whitespace-nowrap">{String(m.value)}</Table.Cell>
                    <Table.Cell className="font-mono text-xs text-kumo-subtle">{m.anchors.join(", ")}</Table.Cell>
                  </Table.Row>
                ))}
            </Table.Body>
          </Table>
        </Section>
      ))}
    </>
  );
}

// Small building blocks.

function SummaryList({ kind, items }: { kind: Address["kind"]; items: [string, string][] }) {
  return (
    <ul className="flex flex-col divide-y divide-kumo-hairline">
      {items.map(([id, summary]) => (
        <li key={id} className="flex flex-col gap-0.5 py-2">
          <Ref to={{ kind, id }}>
            <span className="font-medium">{id}</span>
          </Ref>
          <Text variant="secondary" size="sm">
            {summary}
          </Text>
        </li>
      ))}
    </ul>
  );
}

function UsedIn({ index, test, title = "Appears in" }: { index: Index; test: (flow: Flow) => boolean; title?: string }) {
  const flows = index.model.flows.filter(test).map((flow) => flow.id);
  if (flows.length === 0) return null;
  return (
    <Section title={title}>
      <InlineRefs ids={flows} />
    </Section>
  );
}

function InlineRefs({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {ids.map((id) => (
        <IdRef key={id} id={id} />
      ))}
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-kumo-subtle">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 text-sm">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function MonoList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <code key={item} className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-xs">
          {item}
        </code>
      ))}
    </div>
  );
}
