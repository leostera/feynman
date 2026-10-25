import type { Journey, Stage } from "../model";
import { AnchorLink, IdRef, Link, Page, useIndex } from "../ui";
import { href } from "../model";
import { ActorsPage } from "./Actors";
import { StepList } from "./Flows";

/**
 * The home page: what the system is for, journey by journey, each as the stages the
 * person goes through. Models without journeys open on the actors instead.
 */
export function JourneysPage() {
  const { model } = useIndex();
  if (!model.journeys.length) return <ActorsPage />;
  return (
    <Page
      title="How it works"
      summary={model.meta.summary}
      sections={[
        {
          id: "journeys",
          title: "",
          content: (
            <div className="flex flex-col divide-y divide-kumo-hairline">
              {model.journeys.map((journey) => (
                <JourneySummary key={journey.id} journey={journey} />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

function JourneySummary({ journey }: { journey: Journey }) {
  return (
    <section className="flex flex-col gap-3 py-5 first:pt-0">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-kumo-default">
          <Link to={href("journey", journey.id)}>{journey.summary}</Link>
        </h2>
        <p className="max-w-[80ch] text-sm text-kumo-strong">
          <span className="text-kumo-subtle">For </span>
          <IdRef kind="actor" id={journey.actor} />
          <span className="text-kumo-subtle">: </span>
          {journey.need} <span className="text-kumo-subtle">→</span> {journey.value}
        </p>
      </div>
      <ol className="flex flex-wrap items-stretch gap-2">
        {journey.stages.map((stage, i) => (
          <li key={i} className="flex max-w-[30ch] min-w-[18ch] flex-1 flex-col gap-1 rounded-md bg-kumo-elevated px-3 py-2 text-sm">
            <span className="text-xs text-kumo-subtle tabular-nums">{i + 1}</span>
            <span className="text-kumo-default">{stage.action}</span>
            {stage.sees && <span className="text-xs text-kumo-strong">{stage.sees}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One journey from the person's side, each stage opening into the flows that carry it out, down to their call stacks. */
export function JourneyPage({ id }: { id: string }) {
  const index = useIndex();
  const journey = index.journeys.get(id);
  if (!journey) return null;
  return (
    <Page
      title={journey.summary}
      facts={[
        ["For", <IdRef kind="actor" id={journey.actor} />],
        ["Need", journey.need],
        ["Value", journey.value],
      ]}
      sections={[
        {
          id: "stages",
          title: "",
          content: (
            <ol className="flex flex-col gap-6">
              {journey.stages.map((stage, i) => (
                <StageItem key={i} stage={stage} number={i + 1} />
              ))}
            </ol>
          ),
        },
      ]}
    />
  );
}

function StageItem({ stage, number }: { stage: Stage; number: number }) {
  const index = useIndex();
  const flows = (stage.flows ?? []).flatMap((id) => index.flows.get(id) ?? []);
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3">
      <span className="flex size-7 items-center justify-center rounded-full bg-kumo-elevated text-sm font-medium text-kumo-default tabular-nums">{number}</span>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-medium text-kumo-default">{stage.action}</span>
          {stage.sees && <span className="text-sm text-kumo-strong">{stage.sees}</span>}
          {stage.entry && (
            <span className="font-mono text-xs text-kumo-subtle">
              enters at <AnchorLink anchor={stage.entry} />
            </span>
          )}
        </div>
        {flows.map((flow) => (
          <div key={flow.id} className="flex flex-col gap-1 border-l-2 border-kumo-hairline pl-4">
            <div className="text-sm">
              <Link to={href("flow", flow.id)}>{flow.id}</Link>
              <span className="text-kumo-subtle">: </span>
              <span className="text-kumo-strong">{flow.summary}</span>
            </div>
            <StepList flow={flow} />
          </div>
        ))}
      </div>
    </li>
  );
}
