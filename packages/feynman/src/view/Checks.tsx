// Checks: what the model checker found, within its bounds, and what the scenarios broke.
// Every broken property comes with its shortest counterexample, which opens in the
// playground. A property only says "holds" when exploration finished; otherwise it held
// in the states explored, which is not a proof.
import { Badge, Button, cn } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleDashedIcon, PlayIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { Counterexample, PropertyBroken, PropertyResult, RuleVerdict } from "../check/index.ts";
import { verdictOf, type Verdict } from "../check/verdict.ts";
import { runScenario, type Event, type Spec, type World } from "../spec/index.ts";
import { isFault, labelOf, ordinal, stepTitle, time } from "./format";
import { Section, Sources, useExplorer } from "./ui";

type Open = (ce: Counterexample, origin: string) => void;

/** Properties a scenario breaks, by id, with the first scenario that does. */
function brokenByScenarios(spec: Spec): Map<string, string> {
  const out = new Map<string, string>();
  for (const scenario of spec.scenarios) {
    const run = runScenario(spec, scenario);
    for (const event of run.events) for (const id of event.violations) if (!out.has(id)) out.set(id, scenario.name);
  }
  return out;
}

function headline(verdicts: Verdict[], errors: number, exhaustive: boolean): string {
  const problems = verdicts.filter((v) => v === "broken" || v === "fixed").length + errors;
  if (problems) return `${problems} problem(s)`;
  return exhaustive ? "Every property holds" : "Nothing broke in the states explored";
}

export function Checks({ onOpen, onScenario }: { onOpen: Open; onScenario: (name: string) => void }) {
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
              <h1 className="text-lg font-semibold">{headline(report.properties.map((p) => verdictOf(p, { report, brokenBy: scenarios })), report.errors.length, report.exhaustive)}</h1>
              <p className="text-sm text-kumo-subtle">
                Explored {report.states.toLocaleString()} states in {time(report.durationMs)}: every order of events up to {report.bounds.depth} steps deep
                {Object.keys(report.bounds.instances).length ? `, and ${Object.entries(report.bounds.instances).map(([a, n]) => `${n} ${a}`).join(", ")}` : ""}.
                {!report.exhaustive && (
                  <span className="text-kumo-warning">
                    {" "}
                    It stopped at its {report.stoppedBy === "timeLimit" ? "time" : report.stoppedBy === "memoryLimit" ? "memory" : "state"} limit, so some orders were not tried: a property that held there is not proven.
                  </span>
                )}
                {report.walks?.runs ? ` Also ${report.walks.runs.toLocaleString()} random runs up to ${report.walks.deepest} steps deep, which find bugs past that depth but prove nothing.` : ""}
              </p>
            </div>
            <Section title="Properties">
              <div className="flex flex-col gap-2">
                {report.properties.map((p) => (
                  <PropertyCard key={p.id} p={p} verdict={verdictOf(p, { report, brokenBy: scenarios })} scenario={scenarios.get(p.id)} onOpen={onOpen} onScenario={onScenario} />
                ))}
              </div>
            </Section>
            {report.rules && report.rules.length > 0 && (
              <Section title="Rules">
                <div className="flex flex-col gap-2">
                  {report.rules.map((rule) => (
                    <RuleCard key={rule.name} rule={rule} />
                  ))}
                </div>
              </Section>
            )}
            {report.stuck && (
              <Section title="Stuck">
                <div className="rounded-lg px-4 py-3 ring-1 ring-kumo-danger/40">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm text-kumo-danger">Nothing can happen here, and the spec does not call this world final (finalState in defineSpec).</p>
                    <Button size="xs" icon={<PlayIcon />} onClick={() => onOpen(report.stuck!.counterexample, "Stuck")}>
                      Open in playground
                    </Button>
                  </div>
                  <Steps events={report.stuck.counterexample.events} worlds={report.stuck.counterexample.worlds} />
                </div>
              </Section>
            )}
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
        {spec.properties.length === 0 && <p className="text-sm text-kumo-subtle">This spec declares no properties; add some with defineProperty, listed in defineSpec's properties.</p>}
      </div>
    </div>
  );
}

/** One property: its verdict, and how it breaks, if it does. */
/** A rule of the design (RFD0010): whether each property that needs it broke without it. */
function RuleCard({ rule }: { rule: RuleVerdict }) {
  const held = rule.neededBy.filter((n) => n.verdict === "holds");
  const open = rule.neededBy.filter((n) => n.verdict === "unfinished");
  const verdict: Verdict = held.length ? "broken" : open.length ? "unfinished" : "holds";
  return (
    <div className={cn("rounded-lg px-4 py-3 ring-1", held.length ? "ring-kumo-danger/40" : "ring-kumo-hairline")}>
      <div className="flex items-start gap-2">
        <VerdictIcon verdict={verdict} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{rule.description}</p>
          <p className="font-mono text-[11px] text-kumo-subtle">
            rule · {rule.name}
            <span className="font-sans">
              {held.length
                ? ` · not needed by ${held.map((n) => n.property).join(", ")}: it held without the rule. The rule does nothing here, or the property is too weak to see what it prevents.`
                : open.length
                  ? ` · needed by ${open.map((n) => n.property).join(", ")}? It held without the rule, but the search stopped early.`
                  : ` · without it, ${rule.neededBy.map((n) => `${n.property} breaks in ${n.events} events`).join(", ")}`}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function PropertyCard({ p, verdict, scenario, onOpen, onScenario }: { p: PropertyResult; verdict: Verdict; scenario?: string; onOpen: Open; onScenario: (name: string) => void }) {
  // Broken while exploration found it holding: a scenario broke it.
  const byScenario = (verdict === "broken" || verdict === "known") && p.holds ? scenario : undefined;
  const broken = p.holds ? undefined : p;
  const bad = verdict === "broken" || verdict === "fixed";
  return (
    <div className={cn("rounded-lg px-4 py-3 ring-1", bad ? "ring-kumo-danger/40" : "ring-kumo-hairline")}>
      <div className="flex items-start gap-2">
        <VerdictIcon verdict={verdict} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{p.description}</p>
          <p className="font-mono text-[11px] text-kumo-subtle">
            {p.kind} · {p.id}
            {byScenario && <span className="font-sans text-kumo-danger"> · broken by the scenario “{byScenario}”; exploration did not reach it</span>}
            {verdict === "unfinished" && <span className="font-sans"> · held in the states explored</span>}
            {verdict === "known" && <span className="font-sans text-kumo-warning"> · known bug: {p.known}</span>}
            {verdict === "fixed" && <span className="font-sans text-kumo-danger"> · marked known (“{p.known}”), but holds now: remove known</span>}
            {verdict === "untested" && <span className="font-sans text-kumo-warning"> · never tested: exploration never reached a world where it applies</span>}
            {broken && <HowFound p={broken} />}
          </p>
        </div>
        {broken && (
          <Button size="xs" icon={<PlayIcon />} onClick={() => onOpen(withLoop(broken.counterexample, broken.loop), `Counterexample: ${p.id}`)}>
            Open in playground
          </Button>
        )}
        {byScenario && (
          <Button size="xs" icon={<PlayIcon />} onClick={() => onScenario(byScenario)}>
            Open the scenario
          </Button>
        )}
      </div>
      {broken && <BrokenSteps p={broken} />}
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === "broken" || verdict === "fixed") return <XCircleIcon size={18} className="mt-px text-kumo-danger" />;
  if (verdict === "known") return <XCircleIcon size={18} className="mt-px text-kumo-warning" />;
  if (verdict === "holds") return <CheckCircleIcon size={18} className="mt-px text-kumo-success" />;
  return <CircleDashedIcon size={18} className="mt-px text-kumo-warning" />;
}

function HowFound({ p }: { p: PropertyBroken }) {
  const faults = p.counterexample.events.filter(isFault).length;
  return (
    <>
      <span className="font-sans"> · {faults ? `needs ${faults} fault(s)` : "needs no faults"}</span>
      {p.foundBy === "walk" && <span className="font-sans"> · found by a random run, shrunk to {p.counterexample.events.length} steps; maybe not the shortest</span>}
    </>
  );
}

/** The way to the break, and for liveness the loop after it. */
function BrokenSteps({ p }: { p: PropertyBroken }) {
  const { counterexample: ce, loop } = p;
  return (
    <>
      <Steps events={ce.events} worlds={ce.worlds} />
      {loop?.events.length ? (
        <>
          <p className="mt-2 pl-7 text-xs text-kumo-subtle">Then this repeats forever, and it never gets there:</p>
          <Steps events={loop.events} worlds={loop.worlds} />
        </>
      ) : loop ? (
        <p className="mt-2 pl-7 text-xs text-kumo-subtle">Then nothing fair can happen: it stays there forever, and never gets there.</p>
      ) : null}
    </>
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

/** A liveness counterexample with one round of its loop, to play through. */
function withLoop(ce: Counterexample, loop: Counterexample | undefined): Counterexample {
  if (!loop?.events.length) return ce;
  return { ...ce, choices: [...ce.choices, ...loop.choices], events: [...ce.events, ...loop.events], worlds: [...ce.worlds, ...loop.worlds] };
}
