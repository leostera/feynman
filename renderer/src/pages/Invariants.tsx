import { Table } from "@cloudflare/kumo";
import { claimsAbout, href, type Enforcement, type Frame, type Invariant } from "../model";
import { AnchorLink, Anchors, Empty, Link, Page, useIndex } from "../ui";
import { ClaimRows } from "./Claims";

const ENFORCEMENT_ORDER: Enforcement[] = ["compile-time", "runtime", "test-time", "documented"];

const ENFORCEMENT_HELP: Record<Enforcement, string> = {
  "compile-time": "Types make violations unrepresentable",
  runtime: "Code checks or restores it while running",
  "test-time": "Tests exercise it",
  documented: "Stated in comments or docs only",
};

/** "runtime · test-time": small, ordered, with a tooltip per mechanism. */
export function EnforcementLabel({ enforcement }: { enforcement: Enforcement[] }) {
  const sorted = ENFORCEMENT_ORDER.filter((kind) => enforcement.includes(kind));
  return (
    <span className="text-xs whitespace-nowrap text-kumo-strong">
      {sorted.map((kind, i) => (
        <span key={kind} title={ENFORCEMENT_HELP[kind]}>
          {i > 0 && <span className="text-kumo-subtle"> · </span>}
          {kind}
        </span>
      ))}
    </span>
  );
}

export function InvariantsPage() {
  const index = useIndex();
  const invariants = index.model.invariants;
  return (
    <Page
      title="Invariants"
      summary="What the system makes sure always holds, and how."
      sections={[
        {
          id: "invariants",
          title: "",
          content: (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Description</Table.Head>
                  <Table.Head>Enforced</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {invariants.map((invariant) => (
                  <Table.Row key={invariant.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("invariant", invariant.id)}>{invariant.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[64ch] align-top text-kumo-strong">{invariant.statement}</Table.Cell>
                    <Table.Cell className="align-top">
                      <EnforcementLabel enforcement={invariant.enforcement} />
                    </Table.Cell>
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

export function InvariantPage({ id }: { id: string }) {
  const index = useIndex();
  const invariant = index.invariants.get(id);
  if (!invariant) return null;
  const claims = claimsAbout(index, { kind: "invariant", id });
  return (
    <Page
      title={invariant.id}
      summary={invariant.statement}
      facts={[
        ["Enforced", <EnforcementLabel enforcement={invariant.enforcement} />],
        ...(invariant.consequence ? ([["If it breaks", invariant.consequence]] as [string, React.ReactNode][]) : []),
      ]}
      sections={[
        {
          id: "enforced-at",
          title: "Enforced at",
          count: invariant.enforcedAt.length,
          content: invariant.enforcedAt.length ? <CallPaths invariant={invariant} /> : <Empty>No code path enforces this; it is documented only.</Empty>,
        },
        {
          id: "tests",
          title: "Tests",
          count: invariant.tests?.length,
          content: invariant.tests?.length ? <Anchors anchors={invariant.tests} /> : null,
        },
        { id: "claims", title: "Claims", count: claims.length, content: claims.length ? <ClaimRows claims={claims} /> : null },
        { id: "anchors", title: "Anchors", count: invariant.anchors.length, content: <Anchors anchors={invariant.anchors} /> },
      ]}
    />
  );
}

/** One call stack per trigger, outermost frame first; the last frame is where it is enforced. */
function CallPaths({ invariant }: { invariant: Invariant }) {
  return (
    <div className="flex flex-col gap-6">
      {invariant.enforcedAt.map((path) => (
        <div key={path.trigger} className="flex flex-col gap-2">
          <div className="text-sm text-kumo-subtle">
            On <span className="font-medium text-kumo-default">{path.trigger}</span>
          </div>
          <ol className="flex flex-col">
            {path.frames.map((frame, i) => (
              <FrameRow key={`${frame.symbol}-${i}`} frame={frame} last={i === path.frames.length - 1} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function FrameRow({ frame, last }: { frame: Frame; last: boolean }) {
  return (
    <li className="relative grid grid-cols-[1.25rem_minmax(12rem,max-content)_1fr] items-baseline gap-x-3 pb-2 last:pb-0">
      {/* Rail joining frames into one stack. */}
      {!last && <span aria-hidden className="absolute top-3 bottom-0 left-[0.3rem] w-px bg-kumo-hairline" />}
      <span
        aria-hidden
        className={`relative top-[0.15rem] size-2.5 rounded-full ${last ? "bg-kumo-brand" : "border border-kumo-line bg-kumo-base"}`}
      />
      <code className={`font-mono text-[13px] ${last ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}>
        <AnchorLink anchor={frame.anchor}>{frame.symbol}</AnchorLink>
      </code>
      <span className="text-sm text-kumo-subtle">{frame.note}</span>
    </li>
  );
}
