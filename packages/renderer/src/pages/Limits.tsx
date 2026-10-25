import { href, resolveAnchor, type Limit } from "../model";
import { AnchorLink, Anchors, Link, Page, PathRefs, Rows, useIndex } from "../ui";

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
    <Rows
      rows={limits}
      rowKey={(limit) => limit.id}
      columns={[
        {
          head: "Limit",
          cell: (limit) => (
            <Link to={href("limit", limit.id)} className="text-kumo-default!">
              {limit.subject}
            </Link>
          ),
        },
        { head: "Value", className: "align-top font-mono text-sm whitespace-nowrap tabular-nums", cell: (limit) => String(limit.value) },
        { head: "Applies to", className: "align-top text-sm", cell: (limit) => limit.about && <PathRefs paths={limit.about} /> },
        {
          head: "Source",
          className: "align-top font-mono text-[13px] text-kumo-strong",
          cell: (limit) => (
            <span className="flex flex-col gap-0.5">
              {limit.anchors.map((anchor, i) => (
                <AnchorLink key={i} anchor={anchor}>
                  {resolveAnchor(anchor).symbol}
                </AnchorLink>
              ))}
            </span>
          ),
        },
      ]}
    />
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
        ["Known by", limit.epistemic && (limit.epistemic === "stated" ? "Stated in code" : "Measured")],
        ["Applies to", limit.about && <PathRefs paths={limit.about} />],
      ]}
      sections={[{ id: "anchors", title: "Source", count: limit.anchors.length, content: <Anchors anchors={limit.anchors} /> }]}
    />
  );
}
