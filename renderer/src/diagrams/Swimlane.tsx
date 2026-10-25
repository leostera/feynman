import { flowParticipants, type Flow } from "../model";
import { IdRef } from "../ui";

const LANE_HEADER = 150;
const STEP = 190;

/** One lane per participant, one column per step; time runs left to right. */
export function Swimlane({ flow }: { flow: Flow }) {
  const participants = flowParticipants(flow);
  const columns = `${LANE_HEADER}px repeat(${flow.steps.length}, ${STEP}px)`;

  return (
    <div className="overflow-x-auto rounded-lg bg-kumo-recessed p-3">
      <div className="grid gap-y-1" style={{ gridTemplateColumns: columns }}>
        {participants.map((actor, lane) => (
          <div key={actor} className="contents">
            <div
              className="sticky left-0 z-10 flex items-center rounded-l-md bg-kumo-elevated px-3 text-sm font-medium ring ring-kumo-hairline"
              style={{ gridRow: lane + 1, gridColumn: 1 }}
            >
              <IdRef id={actor} />
            </div>
            <div
              aria-hidden
              className="bg-kumo-base/60 rounded-r-md"
              style={{ gridRow: lane + 1, gridColumn: `2 / span ${flow.steps.length}` }}
            />
          </div>
        ))}

        {flow.steps.map((step, i) => {
          const lane = participants.indexOf(step.actor);
          const target = step.target && step.target !== step.actor ? step.target : null;
          return (
            <div
              key={i}
              className="z-0 m-1.5 flex flex-col gap-1 rounded-md bg-kumo-base p-2 text-xs leading-snug shadow-xs ring ring-kumo-line"
              style={{ gridRow: lane + 1, gridColumn: i + 2 }}
            >
              <span>
                <span className="mr-1 font-mono text-kumo-subtle">{i + 1}.</span>
                {step.action}
              </span>
              {target && (
                <span className="text-kumo-subtle">
                  → <IdRef id={target} />
                </span>
              )}
              {step.ref && (
                <span className="text-kumo-subtle">
                  ↳ <IdRef id={step.ref} />
                </span>
              )}
            </div>
          );
        })}

        {flow.steps.map((step, i) => {
          const target = step.target && step.target !== step.actor ? step.target : null;
          if (!target) return null;
          return (
            <div
              key={`recv-${i}`}
              aria-hidden
              className="m-1.5 flex items-center justify-center rounded-md border border-dashed border-kumo-line text-xs text-kumo-subtle"
              style={{ gridRow: participants.indexOf(target) + 1, gridColumn: i + 2 }}
            >
              receives {i + 1}
            </div>
          );
        })}
      </div>
    </div>
  );
}
