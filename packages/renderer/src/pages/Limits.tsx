import { Table } from "@cloudflare/kumo";
import { href, resolveAnchor, type Limit } from "../model";
import { AnchorLink, Anchors, Link, Page, PathRefs, useIndex } from "../ui";

const KIND_TITLE: Record<string, string> = {
  size: "Sizes",
  count: "Counts",
  timeout: "Timeouts",
  interval: "Intervals",
  rate: "Rates",
  latency: "Latencies",
  depth: "Depths",
};

export function LimitsPage() {
  const index = useIndex();
  const limits = index.model.limits;
  const kinds = Object.keys(KIND_TITLE).filter((kind) => limits.some((limit) => limit.kind === kind));
  return (
    <Page
      title="Limits"
      summary="Bounds the system imposes: sizes, counts, timeouts, intervals, and rates."
      sections={kinds.map((kind) => {
        const rows = limits.filter((limit) => limit.kind === kind);
        return { id: kind, title: KIND_TITLE[kind], count: rows.length, content: <LimitRows limits={rows} /> };
      })}
    />
  );
}

export function LimitRows({ limits }: { limits: Limit[] }) {
  return (
    <Table layout="auto">
      <Table.Header>
        <Table.Row>
          <Table.Head>Limit</Table.Head>
          <Table.Head>Value</Table.Head>
          <Table.Head>Applies to</Table.Head>
          <Table.Head>Source</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {limits.map((limit) => (
          <Table.Row key={limit.id}>
            <Table.Cell className="align-top">
              <Link to={href("limit", limit.id)} className="text-kumo-default!">
                {limit.subject}
              </Link>
            </Table.Cell>
            <Table.Cell className="align-top font-mono text-sm whitespace-nowrap tabular-nums">{String(limit.value)}</Table.Cell>
            <Table.Cell className="align-top text-sm">{limit.about && <PathRefs paths={limit.about} />}</Table.Cell>
            <Table.Cell className="align-top font-mono text-[13px] text-kumo-strong">
              <span className="flex flex-col gap-0.5">
                {limit.anchors.map((anchor, i) => (
                  <AnchorLink key={i} anchor={anchor}>
                    {resolveAnchor(anchor).symbol}
                  </AnchorLink>
                ))}
              </span>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

export function LimitPage({ id }: { id: string }) {
  const index = useIndex();
  const limit = index.limits.get(id);
  if (!limit) return null;
  return (
    <Page
      title={limit.subject}
      facts={[
        ["Value", <span className="font-mono">{String(limit.value)}</span>],
        ["Kind", limit.kind],
        ...(limit.epistemic ? ([["Known by", limit.epistemic === "stated" ? "Stated in code" : "Measured"]] as [string, React.ReactNode][]) : []),
        ...(limit.about ? ([["Applies to", <PathRefs paths={limit.about} />]] as [string, React.ReactNode][]) : []),
      ]}
      sections={[{ id: "anchors", title: "Source", count: limit.anchors.length, content: <Anchors anchors={limit.anchors} /> }]}
    />
  );
}
