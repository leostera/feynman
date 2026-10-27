// Checks: what the model checker found, within its bounds, and what the scenarios broke.
// Every broken property comes with its shortest counterexample, which opens in the
// playground. A property only says "holds" when exploration finished; otherwise it held
// in the states explored, which is not a proof.
import { Badge, Button, cn } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleDashedIcon, PlayIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { Counterexample, PropertyResult, Report } from "../check/index.ts";
import { runScenario, type Event, type Spec, type World } from "../spec/index.ts";
import { labelOf, ordinal, stepTitle, time } from "./format";
import { Section, Sources, useExplorer } from "./ui";

type Verdict = "broken" | "scenario" | "untested" | "explored" | "holds";

/** Invariants a scenario breaks, by id, with the first scenario that does. */
function brokenByScenarios(spec: Spec): Map<string, string> {
  const out = new Map<string, string>();
  for (const scenario of spec.scenarios) {
    const run = runScenario(spec, scenario);
    for (const event of run.events) for (const id of event.violations) if (!out.has(id)) out.set(id, scenario.name);
  }
  return out;
}

function verdictOf(p: PropertyResult, report: Report, scenarios: Map<string, string>): Verdict {
  if (!p.holds) return "broken";
  if (scenarios.has(p.id)) return "scenario";
  if (p.tested === 0) return "untested";
  return report.exhaustive ? "holds" : "explored";
}

function headline(verdicts: Verdict[], errors: number, exhaustive: boolean): string {
  const problems = verdicts.filter((v) => v === "broken" || v === "scenario").length + errors;
  if (problems) return `${problems} problem(s)`;
  return exhaustive ? "Every property holds" : "Nothing broke in the states explored";
}

export function Checks({ onOpen, onScenario }: { onOpen: (ce: Counterexample, origin: string) => void; onScenario: (name: string) => void }) {
  const { spec, loaded } = useExplorer();
  const report = loaded.entry.report;
  const scenarios = useMemo(() => brokenByScenarios(spec), [spec]);
  const sources = Object.entries(loaded.entry.sources).filter(([, s]) => s.status === "stale" || s.status === "missing");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
        {!report ? (
          <p className="text-sm text-kumo-subtle">The checker has not run on this spec yet. Run feynman check, or wait for feynman dev to finish.</p>
        ) : (
          <>
            <div>
              <h1 className="text-lg font-semibold">{headline(report.properties.map((p) => verdictOf(p, report, scenarios)), report.errors.length, report.exhaustive)}</h1>
              <p className="text-sm text-kumo-subtle">
                Explored {report.states.toLocaleString()} states in {time(report.durationMs)}: every order of events up to {report.bounds.depth} steps deep, with up to {report.bounds.faults} fault(s)
                {Object.keys(report.bounds.instances).length ? `, and ${Object.entries(report.bounds.instances).map(([a, n]) => `${n} ${a}`).join(", ")}` : ""}.
                {!report.exhaustive && (
                  <span className="text-kumo-warning">
                    {" "}
                    It stopped at its {report.stoppedBy === "timeLimit" ? "time" : "state"} limit, so some orders were not tried: a property that held there is not proven.
                  </span>
                )}
                {report.walks?.runs ? ` Also ${report.walks.runs.toLocaleString()} random runs up to ${report.walks.deepest} steps deep, which find bugs past that depth but prove nothing.` : ""}
              </p>
            </div>
            <Section title="Properties">
              <div className="flex flex-col gap-2">
                {report.properties.map((p) => {
                  const verdict = verdictOf(p, report, scenarios);
                  const bad = verdict === "broken" || verdict === "scenario";
                  return (
                  <div key={p.id} className={cn("rounded-lg px-4 py-3 ring-1", bad ? "ring-kumo-danger/40" : "ring-kumo-hairline")}>
                    <div className="flex items-start gap-2">
                      {bad ? (
                        <XCircleIcon size={18} className="mt-px text-kumo-danger" />
                      ) : verdict === "holds" ? (
                        <CheckCircleIcon size={18} className="mt-px text-kumo-success" />
                      ) : (
                        <CircleDashedIcon size={18} className="mt-px text-kumo-warning" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{p.description}</p>
                        <p className="font-mono text-[11px] text-kumo-subtle">
                          {p.kind} · {p.id}
                          {verdict === "scenario" && <span className="font-sans text-kumo-danger"> · broken by the scenario “{scenarios.get(p.id)}”; exploration did not reach it</span>}
                          {verdict === "explored" && <span className="font-sans"> · held in the states explored</span>}
                          {p.foundBy === "walk" && <span className="font-sans"> · found by a random run, shrunk to {p.counterexample!.events.length} steps; maybe not the shortest</span>}
                          {verdict === "untested" && <span className="font-sans text-kumo-warning"> · never tested: exploration never reached a world where it applies</span>}
                        </p>
                      </div>
                      {p.counterexample && (
                        <Button size="xs" icon={<PlayIcon />} onClick={() => onOpen(p.counterexample!, `Counterexample: ${p.id}`)}>
                          Open in playground
                        </Button>
                      )}
                      {verdict === "scenario" && (
                        <Button size="xs" icon={<PlayIcon />} onClick={() => onScenario(scenarios.get(p.id)!)}>
                          Open the scenario
                        </Button>
                      )}
                    </div>
                    {p.counterexample && <Steps events={p.counterexample.events} worlds={p.counterexample.worlds} />}
                    {p.then?.length ? (
                      <>
                        <p className="mt-2 pl-7 text-xs text-kumo-subtle">Then, left alone, it never gets there:</p>
                        <Steps events={p.then} worlds={p.then.map(() => p.counterexample!.worlds.at(-1)!)} />
                      </>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            </Section>
            {report.errors.length > 0 && (
              <Section title="Spec errors">
                {report.errors.map((e, i) => (
                  <div key={i} className="rounded-lg px-4 py-3 ring-1 ring-kumo-danger/40">
                    <div className="flex items-start gap-2">
                      <p className="flex-1 text-sm text-kumo-danger">{e.message}</p>
                      <Button size="xs" icon={<PlayIcon />} onClick={() => onOpen(e.counterexample, "Spec error")}>
                        Open in playground
                      </Button>
                    </div>
                    <Steps events={e.counterexample.events} worlds={e.counterexample.worlds} />
                  </div>
                ))}
              </Section>
            )}
            <Section title="Coverage">
              <p className="text-sm">
                {report.coverage.reached.length} of {report.coverage.reached.length + report.coverage.missed.length} steps ran somewhere in the exploration.
              </p>
              {report.coverage.missed.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {report.coverage.missed.map((m) => (
                    <Badge key={m} variant="warning">
                      never ran: {m}
                    </Badge>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
        {sources.length > 0 && (
          <Section title="Sources">
            {sources.map(([source, s]) => (
              <p key={source} className="flex items-center gap-2 text-sm">
                <WarningIcon className={s.status === "missing" ? "text-kumo-danger" : "text-kumo-warning"} />
                <span className="font-mono text-xs">{source}</span>
                <span className="text-kumo-subtle">{s.status === "missing" ? s.reason : "changed since the spec was last locked; check the steps that name it"}</span>
              </p>
            ))}
          </Section>
        )}
        {spec.invariants.length === 0 && <p className="text-sm text-kumo-subtle">This spec declares no invariants; add some with spec.defineInvariants.</p>}
      </div>
    </div>
  );
}

function Steps({ events, worlds }: { events: Event[]; worlds: World[] }) {
  const { spec } = useExplorer();
  return (
    <ol className="mt-2 flex flex-col gap-0.5 pl-7">
      {events.map((e, i) => (
        <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
          <span className="w-12 shrink-0 text-right font-mono text-kumo-subtle">{ordinal(i + 1)}</span>
          <span className={cn("font-medium", (e.error || e.violations.length) && "text-kumo-danger")}>
            {labelOf(worlds[i], e.instance)} · {stepTitle(spec, e)}
          </span>
          <span className="min-w-0 flex-1 text-kumo-subtle">{e.description}</span>
          {e.sources.length > 0 && <div className="w-full pl-14"><Sources sources={e.sources} /></div>}
        </li>
      ))}
    </ol>
  );
}
