// An explainer (RFD0013, spike): a story told around the explorer's own figures. The prose
// comes rendered from the explainer file; every figure is a recorded run of the spec, drawn by
// the same components the explorer uses: the playground's stage, the Flows page's sequence
// diagram, the Checks page's cards. Each figure mounts when it scrolls into view, and plays.
import { Badge, cn } from "@cloudflare/kumo";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { At } from "../explain/index.ts";
import { moment, Moments, RunsContext, RunsProvider, StageStill, useRun } from "./explainKit";
import { bubbleText } from "./playground/Stage";
import { verdictOf } from "../check/verdict.ts";
import { runScenario, type Run } from "../spec/index.ts";
import { brokenByScenarios, PropertyCard, RuleCard } from "./Checks";
import type { Bundle, Explainer, ExplainerBlock, FigureRun } from "./data";
import { Sequence, type Row } from "./Flows";
import { isFault, time } from "./format";
import { Playground } from "./Playground";
import { freshSession, runScenarioSession, sessionFromRun, type Session } from "./sessions";
import { EventDetail, ExplorerProvider, useExplorer, type Loaded } from "./ui";
import { DEFAULT_ZOOM, type CameraState } from "./url";

const CAMERA: CameraState = { zoom: DEFAULT_ZOOM, x: 0, y: 0, fitScale: null, manual: false };

type Figures = Record<string, ComponentType>;
const FiguresContext = createContext<Figures>({});

export function ExplainerPage({ explainer, bundle, loaded, figures }: { explainer: Explainer; bundle: Bundle; loaded: Loaded | null; figures: Figures }) {
  const sections = explainer.blocks.filter((b): b is Extract<ExplainerBlock, { kind: "section" }> => b.kind === "section");
  if (loaded && !loaded.spec) return <p className="p-8 text-sm text-kumo-danger">{loaded.entry.error ?? "The spec did not load."}</p>;
  // With no spec, the explorer's context is empty: only data figures, which don't read it.
  const explorer = loaded ? { bundle, loaded } : null;
  return (
    <ExplorerProvider value={explorer}>
     <RunsProvider value={explainer.runs}>
     <FiguresContext.Provider value={figures}>
      <div className="h-full overflow-y-auto bg-kumo-canvas">
        <article className="mx-auto px-6 pb-32 pt-16">
          <header className="mx-auto max-w-[42rem]">
            {loaded?.spec && <p className="font-mono text-xs uppercase tracking-wider text-kumo-subtle">An explainer · {loaded.spec.name}</p>}
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance">{explainer.title}</h1>
            <p className="mt-4 text-lg text-kumo-subtle text-pretty">{explainer.lede}</p>
            {sections.length > 1 && (
              <nav className="mt-8 rounded-xl bg-kumo-base px-5 py-4 ring-1 ring-kumo-hairline">
                <p className="mb-2 text-sm font-semibold">The walk-through</p>
                <ol className={cn("grid gap-x-8 gap-y-1 text-sm", sections.length > 8 && "sm:grid-flow-col sm:grid-cols-2")} style={sections.length > 8 ? { gridTemplateRows: `repeat(${Math.ceil(sections.length / 2)}, auto)` } : undefined}>
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`} className="flex gap-3 text-kumo-default hover:text-kumo-brand">
                        <span className="w-5 font-mono text-kumo-subtle">{s.number}</span>
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
          </header>
          {explainer.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
          <footer className="mx-auto mt-24 max-w-[42rem] border-t border-kumo-hairline pt-4 text-xs text-kumo-subtle">
            {loaded ? (
              <>
                Every figure of the system on this page was recorded from <span className="font-mono">{loaded.entry.path}</span> at{" "}
                <span className="font-mono">{explainer.provenance.commit.slice(0, 8) || "no commit"}</span>
                {explainer.provenance.dirty ? ", with uncommitted changes" : ""}, and checked to depth {explainer.provenance.depth}.
              </>
            ) : (
              <>
                Built at <span className="font-mono">{explainer.provenance.commit.slice(0, 8) || "no commit"}</span>
                {explainer.provenance.dirty ? ", with uncommitted changes" : ""}.
              </>
            )}{" "}
            Made with Feynman.
          </footer>
        </article>
      </div>
     </FiguresContext.Provider>
     </RunsProvider>
    </ExplorerProvider>
  );
}

function Block({ block }: { block: ExplainerBlock }) {
  switch (block.kind) {
    case "section":
      return (
        <h2 id={block.id} className="mx-auto mt-20 flex max-w-[42rem] scroll-mt-8 items-baseline gap-3 text-2xl font-semibold tracking-tight">
          <span className="font-mono text-base text-kumo-subtle">{String(block.number).padStart(2, "0")}</span>
          {block.title}
        </h2>
      );
    case "prose":
      return <div className="explainer-prose mx-auto max-w-[42rem]" dangerouslySetInnerHTML={{ __html: block.html }} />;
    case "callout":
      return <aside data-tone={block.tone} className="explain-callout mx-auto my-6 max-w-[42rem]" dangerouslySetInnerHTML={{ __html: block.html }} />;
    case "map":
      return <MapFigure scenario={block.scenario} />;
    case "still":
      return <StillFigure run={block.run} at={block.at} />;
    case "figure":
      return <OwnFigure name={block.name} />;
    case "steps":
      return (
        <figure className="mx-auto my-8 max-w-[46rem]">
          <Card>
            <Moments run={block.run} at={block.at} />
          </Card>
        </figure>
      );
    case "play":
      return <PlayFigure run={block.run} />;
    case "flow":
      return <FlowFigure run={block.run} />;
    case "verdicts":
      return <Verdicts />;
    case "rules":
      return <Rules />;
  }
}

/** Figures break out of the text column, as wide as the page allows. */
function Figure({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <figure className="mx-auto my-10 max-w-[68rem]">
      {children}
      {caption && <figcaption className="mx-auto mt-3 max-w-[42rem] text-sm text-kumo-subtle text-pretty">{caption}</figcaption>}
    </figure>
  );
}

/** Mounts its children once scrolled near: a page of stages laid out at once would stall. */
function WhenVisible({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setSeen(true), { rootMargin: "-20% 0px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ height }} className="relative overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-hairline">
      {seen ? children : null}
    </div>
  );
}

function MapFigure({ scenario }: { scenario?: string }) {
  const { spec } = useExplorer();
  const world = useMemo(() => {
    const found = scenario === undefined ? undefined : spec.scenarios.find((s) => s.name === scenario);
    return found ? runScenario(spec, found).initial : freshSession(spec).initial;
  }, [spec, scenario]);
  return (
    <Figure>
      <Card>
        <StageStill index={0} world={world} event={null} height={340} />
      </Card>
    </Figure>
  );
}

function StillFigure({ run, at }: { run: FigureRun; at?: At }) {
  const recorded = useRun(run);
  const shown = moment(recorded, at);
  const { spec } = useExplorer();
  const caption =
    "breaks" in run ? <BreaksCaption rule={run.breaks} at={shown.index} /> : <>“{run.scenario}”, {shown.index === 0 ? "at its start" : shown.index === recorded.events.length ? "at its end" : `after event ${shown.index} of ${recorded.events.length}`}{shown.event ? `: ${bubbleText(spec, shown.event, shown.world)}` : ""}.</>;
  return (
    <Figure caption={caption}>
      <Card>
        <StageStill {...shown} height={380} />
      </Card>
    </Figure>
  );
}

function OwnFigure({ name }: { name: string }) {
  const Component = useContext(FiguresContext)[name];
  return (
    <figure className="mx-auto my-8 max-w-[52rem]">
      {Component ? (
        <div className="rounded-xl bg-kumo-base px-6 py-6 ring-1 ring-kumo-hairline">
          <Component />
        </div>
      ) : (
        <p className="text-sm text-kumo-danger">The explainer's figures do not export {name}.</p>
      )}
    </figure>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-hairline">{children}</div>;
}

function StageFigure({ height, make, caption }: { height: number; make: (spec: ReturnType<typeof useExplorer>["spec"]) => Session; caption: ReactNode }) {
  const { spec } = useExplorer();
  const [session, setSession] = useState(() => make(spec));
  return (
    <Figure caption={caption}>
      <WhenVisible height={height}>
        <Playground
          session={session}
          setSession={setSession}
          scenarios={{ items: [{ value: session.origin, label: session.origin }], onPick: () => setSession(make(spec)) }}
          specs={null}
          initialSpeed={1}
          initialCamera={CAMERA}
          initialLayout="auto"
          onViewStateChange={() => {}}
        />
      </WhenVisible>
    </Figure>
  );
}

function PlayFigure({ run }: { run: FigureRun }) {
  const { spec } = useExplorer();
  const runs = useContext(RunsContext);
  if ("scenario" in run) {
    const scenario = spec.scenarios.find((s) => s.name === run.scenario)!;
    return <StageFigure height={560} make={() => runScenarioSession(spec, scenario)} caption={<>{scenario.description}</>} />;
  }
  return (
    <Without rule={run.breaks}>
      <StageFigure height={560} make={() => sessionFromRun(runs[run.breaks]!, `Without ${run.breaks}`)} caption={<BreaksCaption rule={run.breaks} />} />
    </Without>
  );
}

/** A counterexample of the design without a rule plays on that design: on the spec, the rule would step in. */
function Without({ rule, children }: { rule: string; children: ReactNode }) {
  const { bundle, loaded } = useExplorer();
  const variant = useMemo(() => ({ ...loaded, spec: loaded.spec!.withoutRules([rule]) }), [loaded, rule]);
  return <ExplorerProvider value={{ bundle, loaded: variant }}>{children}</ExplorerProvider>;
}

function BreaksCaption({ rule, at }: { rule: string; at?: number }) {
  const { spec } = useExplorer();
  const run = useContext(RunsContext)[rule]!;
  const property = spec.properties.find((p) => p.id === run.property);
  const faults = run.events.filter(isFault).length;
  return (
    <>
      {at !== undefined && at !== run.brokeAt && <>After event {at} of {run.events.length}. </>}
      <Badge variant="error">without {rule}</Badge> <span className="font-medium text-kumo-default">{property?.description ?? run.property}</span> breaks, in {run.brokeAt} events
      {faults ? `, ${faults === 1 ? "one of them a fault" : `${faults} of them faults`}` : ", with no faults at all"}
      {run.ending === "loops" ? ", and from there it goes round in a loop forever" : run.ending === "stays" ? ", and from there nothing more can happen: it stays that way forever" : ""}. The shortest way it can happen.
    </>
  );
}

function FlowFigure({ run }: { run: FigureRun }) {
  const { spec, playground } = useExplorer();
  const [chosen, setChosen] = useState<number | null>(null);
  const runs = useContext(RunsContext);
  const recorded: Run = useMemo(() => {
    if ("scenario" in run) return runScenario(spec, spec.scenarios.find((s) => s.name === run.scenario)!);
    const { initial, events, worlds } = runs[run.breaks]!;
    return { spec: spec.name, seed: 0, initial, events, worlds };
  }, [spec, run, runs]);
  const rows: Row[] = recorded.events.map((event, i) => ({ status: "same", event, head: event, position: i + 1, world: recorded.worlds[i]! }));
  const order = "scenario" in run ? (playground?.flowOrder[run.scenario] ?? []) : [];
  const row = chosen !== null ? rows[chosen] : null;
  const figure = (
    <Figure caption={"scenario" in run ? `“${run.scenario}”, as a sequence: click a step to see what it did.` : <BreaksCaption rule={run.breaks} />}>
      <div className="overflow-x-auto rounded-xl bg-kumo-base px-4 py-5 ring-1 ring-kumo-hairline">
        <Sequence rows={rows} run={recorded} actorOrder={order} chosen={chosen} onChoose={(i) => setChosen(chosen === i ? null : i)} />
        {row && (
          <div className="mt-4 border-t border-kumo-hairline pt-4">
            <EventDetail event={row.event} world={row.world} />
          </div>
        )}
      </div>
    </Figure>
  );
  return "breaks" in run ? <Without rule={run.breaks}>{figure}</Without> : figure;
}

function Verdicts() {
  const { spec, loaded } = useExplorer();
  const report = loaded.entry.report!;
  const brokenBy = useMemo(() => brokenByScenarios(spec), [spec]);
  return (
    <Figure
      caption={
        <>
          Checked every order of events up to {report.bounds.depth} steps deep: {report.states.toLocaleString()} states in {time(report.durationMs)}
          {report.exhaustive ? "" : ", stopped early, so a property that held there is not proven"}. A property marked as held in the states explored may still break deeper than that.
        </>
      }
    >
      <div className="mx-auto grid max-w-[48rem] gap-2">
        {report.properties.map((p) => (
          <PropertyCard key={p.id} p={p} verdict={verdictOf(p, { report, brokenBy })} scenario={brokenBy.get(p.id)} onOpen={() => {}} onScenario={() => {}} />
        ))}
      </div>
    </Figure>
  );
}

function Rules() {
  const { loaded } = useExplorer();
  return (
    <Figure caption="Each rule was checked by turning it off: a rule is needed when some property breaks without it.">
      <div className="mx-auto grid max-w-[48rem] gap-2">
        {(loaded.entry.report?.rules ?? []).map((rule) => (
          <RuleCard key={rule.name} rule={rule} />
        ))}
      </div>
    </Figure>
  );
}
