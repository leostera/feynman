import { Badge } from "@cloudflare/kumo";
import { flowParticipants, type Flow, type Step } from "../model";
import { IdRef } from "../ui";

const COLUMN = 210;
const GUTTER = 28;

/**
 * Participants as lifelines across the top; each step is a row. A step with a target is an
 * arrow between lifelines; a step without one is a note on its actor's lifeline.
 */
export function SequenceDiagram({ flow }: { flow: Flow }) {
  const participants = flowParticipants(flow);
  const column = (actor: string) => participants.indexOf(actor);
  const center = (actor: string) => GUTTER + column(actor) * COLUMN + COLUMN / 2;
  const width = GUTTER * 2 + participants.length * COLUMN;

  return (
    <div className="overflow-x-auto rounded-lg bg-kumo-recessed p-3">
      <div className="relative" style={{ width }}>
        {participants.map((actor) => (
          <div
            key={`life-${actor}`}
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-kumo-line"
            style={{ left: center(actor) }}
          />
        ))}

        <div className="sticky top-0 z-10 flex" style={{ paddingLeft: GUTTER }}>
          {participants.map((actor) => (
            <div key={actor} className="flex justify-center" style={{ width: COLUMN }}>
              <div className="rounded-md bg-kumo-base px-3 py-1.5 text-sm font-medium shadow-xs ring ring-kumo-line">
                <IdRef id={actor} />
              </div>
            </div>
          ))}
        </div>

        <ol
          className="relative grid gap-y-2 pt-4 pb-2"
          style={{ gridTemplateColumns: `${GUTTER}px repeat(${participants.length}, ${COLUMN}px) ${GUTTER}px` }}
        >
          {flow.steps.map((step, i) => {
            const from = column(step.actor);
            const to = step.target && step.target !== step.actor ? column(step.target) : null;
            const first = to === null ? from : Math.min(from, to);
            const span = to === null ? 1 : Math.abs(to - from) + 1;
            return (
              <li key={i} style={{ gridRow: i + 1, gridColumn: `${first + 2} / span ${span}` }}>
                {to === null ? (
                  <Note step={step} number={i + 1} />
                ) : (
                  <Arrow step={step} number={i + 1} rightward={to > from} />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function Arrow({ step, number, rightward }: { step: Step; number: number; rightward: boolean }) {
  // The arrow runs between the centres of the first and last spanned columns.
  const inset = COLUMN / 2;
  return (
    <div className="flex flex-col" style={{ paddingLeft: inset, paddingRight: inset }}>
      <StepLabel step={step} number={number} className="px-2 pb-1 text-center" />
      <div className="relative h-2">
        <div className="absolute top-1/2 right-0 left-0 h-px bg-kumo-brand" />
        <div
          className="absolute top-0 h-0 w-0 border-y-4 border-y-transparent"
          style={
            rightward
              ? { right: 0, borderLeft: "7px solid var(--color-kumo-brand)" }
              : { left: 0, borderRight: "7px solid var(--color-kumo-brand)" }
          }
        />
      </div>
    </div>
  );
}

function Note({ step, number }: { step: Step; number: number }) {
  return (
    <div className="mx-2 rounded-md bg-kumo-base px-2 py-1.5 shadow-xs ring ring-kumo-hairline">
      <StepLabel step={step} number={number} />
    </div>
  );
}

function StepLabel({ step, number, className = "" }: { step: Step; number: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 text-xs leading-snug ${className}`}>
      <span>
        <span className="mr-1 font-mono text-kumo-subtle">{number}.</span>
        {step.action}
      </span>
      {(step.ref || step.boundary || step.properties?.length) && (
        <span className="flex flex-wrap justify-center gap-1">
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
        </span>
      )}
    </div>
  );
}
