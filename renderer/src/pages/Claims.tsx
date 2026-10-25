import { Badge, Table, Tabs } from "@cloudflare/kumo";
import { useState } from "react";
import { claimId, type ClaimStatus } from "../model";
import { Anchors, Empty, IdRefs, Page, STATUS_ORDER, StatusBadge, statusLabel, useIndex } from "../ui";
import { ClaimRows } from "./Actors";

export function ClaimsPage() {
  const index = useIndex();
  const claims = index.model.claims.map((claim, i) => ({ id: claimId(i), claim }));
  const [filter, setFilter] = useState<ClaimStatus | "all">("all");
  const shown = claims
    .filter(({ claim }) => filter === "all" || claim.status === filter)
    .sort((a, b) => STATUS_ORDER.indexOf(a.claim.status) - STATUS_ORDER.indexOf(b.claim.status));
  const count = (status: ClaimStatus) => claims.filter(({ claim }) => claim.status === status).length;

  return (
    <Page
      title="Claims"
      summary="Statements about the system and how the evidence relates to them. Contradicted and unverified claims come first."
      sections={[
        {
          id: "claims",
          title: filter === "all" ? "All claims" : statusLabel(filter),
          count: shown.length,
          content: (
            <div className="flex flex-col gap-4">
              <Tabs
                size="sm"
                value={filter}
                onValueChange={(value) => setFilter(value as ClaimStatus | "all")}
                tabs={[
                  { value: "all", label: `All ${claims.length}` },
                  ...STATUS_ORDER.filter((status) => count(status) > 0).map((status) => ({
                    value: status,
                    label: `${statusLabel(status)} ${count(status)}`,
                  })),
                ]}
              />
              <ClaimRows claims={shown} />
            </div>
          ),
        },
      ]}
    />
  );
}

export function ClaimPage({ id }: { id: string }) {
  const index = useIndex();
  const claim = index.claims.get(id);
  if (!claim) return null;
  return (
    <Page
      title={claim.statement}
      badges={
        <>
          <StatusBadge status={claim.status} />
          <Badge variant="outline">{claim.epistemic}</Badge>
        </>
      }
      facts={claim.about ? [["About", <IdRefs ids={claim.about} />]] : undefined}
      sections={[
        { id: "note", title: "Note", content: claim.note ? <p className="max-w-[70ch] text-kumo-strong">{claim.note}</p> : null },
        {
          id: "evidence",
          title: "Evidence",
          count: claim.evidence.length,
          content: claim.evidence.length ? <Anchors anchors={claim.evidence} /> : <Empty>No evidence recorded.</Empty>,
        },
      ]}
    />
  );
}

export function MeasurementsPage() {
  const index = useIndex();
  const measurements = index.model.measurements ?? [];
  const kinds = [...new Set(measurements.map((m) => m.kind))];
  return (
    <Page
      title="Measurements"
      summary="Limits, sizes, timeouts, intervals, and rates stated in code, tests, or benchmarks."
      sections={kinds.map((kind) => {
        const rows = measurements.filter((m) => m.kind === kind);
        return {
          id: kind,
          title: kind[0].toUpperCase() + kind.slice(1),
          count: rows.length,
          content: (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Subject</Table.Head>
                  <Table.Head>Value</Table.Head>
                  <Table.Head>Source</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((m) => (
                  <Table.Row key={m.subject}>
                    <Table.Cell className="align-top text-kumo-default">{m.subject}</Table.Cell>
                    <Table.Cell className="align-top font-mono text-sm whitespace-nowrap tabular-nums">{String(m.value)}</Table.Cell>
                    <Table.Cell className="align-top">
                      <Anchors anchors={m.anchors} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ),
        };
      })}
    />
  );
}
