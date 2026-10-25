import { Badge, Table, Tabs } from "@cloudflare/kumo";
import { SequenceDiagram } from "../diagrams/SequenceDiagram";
import { Swimlane } from "../diagrams/Swimlane";
import { claimsAbout, flowParticipants, href, type Flow } from "../model";
import { usePreference } from "../router";
import { Anchors, Empty, IdRef, IdRefs, Link, Page, useIndex } from "../ui";
import { ClaimRows } from "./Claims";

export function FlowsPage() {
  const index = useIndex();
  return (
    <Page
      title="Flows"
      summary="Named paths from a trigger, through semantic actions across actors, to their effects."
      sections={[
        {
          id: "flows",
          title: "All flows",
          count: index.model.flows.length,
          content: (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Flow</Table.Head>
                  <Table.Head>Summary</Table.Head>
                  <Table.Head>Actors</Table.Head>
                  <Table.Head className="text-right">Steps</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {index.model.flows.map((flow) => (
                  <Table.Row key={flow.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("flow", flow.id)}>{flow.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[48ch] align-top text-kumo-strong">{flow.summary}</Table.Cell>
                    <Table.Cell className="max-w-[28ch] align-top text-sm">
                      <IdRefs kind="actor" ids={flowParticipants(flow)} />
                    </Table.Cell>
                    <Table.Cell className="text-right align-top tabular-nums">{flow.steps.length}</Table.Cell>
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

type FlowView = "sequence" | "swimlane" | "steps";

export function FlowPage({ id }: { id: string }) {
  const index = useIndex();
  const flow = index.flows.get(id);
  const [view, setView] = usePreference<FlowView>("flowView", "sequence");
  if (!flow) return null;
  const callers = index.usedBy.get(flow.id) ?? [];
  const calls = [...new Set(flow.steps.map((step) => step.ref).filter((ref): ref is string => ref !== undefined))];
  const claims = claimsAbout(index, { kind: "flow", id });

  return (
    <Page
      title={flow.id}
      summary={flow.summary}
      facts={[
        ["Trigger", flow.trigger],
        ["Actors", <IdRefs kind="actor" ids={flowParticipants(flow)} />],
      ]}
      sections={[
        {
          id: "steps",
          title: "Steps",
          count: flow.steps.length,
          content: (
            <div className="flex flex-col gap-4">
              <Tabs
                size="sm"
                value={view}
                onValueChange={(value) => setView(value as FlowView)}
                tabs={[
                  { value: "sequence", label: "Sequence" },
                  { value: "swimlane", label: "Swimlane" },
                  { value: "steps", label: "List" },
                ]}
              />
              {view === "sequence" && <SequenceDiagram flow={flow} />}
              {view === "swimlane" && <Swimlane flow={flow} />}
              {view === "steps" && <StepList flow={flow} />}
            </div>
          ),
        },
        {
          id: "related",
          title: "Related flows",
          count: callers.length + calls.length,
          content:
            callers.length + calls.length === 0 ? (
              <Empty>Does not call or get called by other flows.</Empty>
            ) : (
              <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
                {calls.length > 0 && (
                  <>
                    <span className="text-kumo-subtle">Calls</span>
                    <IdRefs kind="flow" ids={calls} />
                  </>
                )}
                {callers.length > 0 && (
                  <>
                    <span className="text-kumo-subtle">Called by</span>
                    <IdRefs kind="flow" ids={callers} />
                  </>
                )}
              </div>
            ),
        },
        {
          id: "claims",
          title: "Claims",
          count: claims.length,
          content: claims.length === 0 ? <Empty>No claims are about this flow.</Empty> : <ClaimRows claims={claims} />,
        },
        { id: "anchors", title: "Anchors", count: flow.anchors.length, content: <Anchors anchors={flow.anchors} /> },
      ]}
    />
  );
}

function StepList({ flow }: { flow: Flow }) {
  return (
    <ol className="flex flex-col divide-y divide-kumo-hairline">
      {flow.steps.map((step, i) => (
        <li key={i} className="grid grid-cols-[2rem_1fr] gap-2 py-2.5">
          <span className="text-sm text-kumo-subtle tabular-nums">{i + 1}</span>
          <div className="flex flex-col gap-1.5">
            <div className="text-sm text-kumo-default">
              <span className="font-medium">
                <IdRef kind="actor" id={step.actor} />
              </span>
              {step.target && (
                <>
                  <span className="text-kumo-subtle"> → </span>
                  <IdRef kind="actor" id={step.target} />
                </>
              )}
              <span className="text-kumo-subtle">: </span>
              {step.action}
            </div>
            {(step.ref || step.protocol || step.properties?.length) && (
              <div className="flex flex-wrap gap-1">
                {step.ref && (
                  <Badge variant="purple">
                    calls <IdRef kind="flow" id={step.ref} />
                  </Badge>
                )}
                {step.protocol && (
                  <Badge variant="orange">
                    speaks <IdRef kind="protocol" id={step.protocol} />
                  </Badge>
                )}
                {step.properties?.map((property) => (
                  <Badge key={property} variant="neutral">
                    {property}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
