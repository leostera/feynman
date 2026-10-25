import { Badge, Tabs } from "@cloudflare/kumo";
import { useState } from "react";
import { SequenceDiagram } from "../diagrams/SequenceDiagram";
import { Swimlane } from "../diagrams/Swimlane";
import { claimsAbout, flowParticipants, type Flow, type Step } from "../model";
import { usePreference } from "../router";
import { AnchorLink, Anchors, CELL, Empty, idColumn, IdRef, IdRefs, Page, Rows, useIndex } from "../ui";
import { CallTree } from "../diagrams/CallTree";
import { ClaimRows } from "./Claims";

export function FlowsPage() {
  const index = useIndex();
  return (
    <Page
      title="Flows"
      summary="What the system does: each flow runs from a trigger, through semantic actions across actors, to an outcome."
      sections={[
        {
          id: "flows",
          title: "All flows",
          count: index.model.flows.length,
          content: (
            <Rows
              rows={index.model.flows}
              rowKey={(flow) => flow.id}
              columns={[
                idColumn("flow", "Flow"),
                { head: "Summary", className: "max-w-[48ch] align-top text-kumo-strong", cell: (flow) => flow.summary },
                { head: "Actors", className: "max-w-[28ch] align-top text-sm", cell: (flow) => <IdRefs kind="actor" ids={flowParticipants(flow)} /> },
                { head: "Steps", className: CELL.number, cell: (flow) => flow.steps.length },
              ]}
            />
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
        ["Outcome", flow.outcome],
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

/** A flow's steps, each with where it happens in code and the call stack under it. */
export function StepList({ flow }: { flow: Flow }) {
  return (
    <ol className="flex flex-col divide-y divide-kumo-hairline">
      {flow.steps.map((step, i) => (
        <StepItem key={i} step={step} number={i + 1} />
      ))}
    </ol>
  );
}

function StepItem({ step, number }: { step: Step; number: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-2 py-2.5">
      <span className="text-sm text-kumo-subtle tabular-nums">{number}</span>
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
        {(step.ref || step.protocol || step.component || step.properties?.length || step.anchor) && (
          <div className="flex flex-wrap items-center gap-1 [&_a]:text-current">
            {step.component && (
              <Badge variant="neutral">
                in <IdRef kind="component" id={step.component} />
              </Badge>
            )}
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
            {step.anchor && (
              <span className="font-mono text-xs text-kumo-subtle">
                <AnchorLink anchor={step.anchor} />
              </span>
            )}
            {step.calls && (
              <button type="button" onClick={() => setOpen(!open)} className="text-xs text-kumo-link hover:underline">
                {open ? "Hide" : "Show"} call stack
              </button>
            )}
          </div>
        )}
        {open && step.calls && <CallTree root={step.calls} />}
      </div>
    </li>
  );
}
