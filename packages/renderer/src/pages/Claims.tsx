import { Badge, Tabs } from "@cloudflare/kumo";
import { useState } from "react";
import { href, type Claim, type ClaimStatus } from "../model";
import { Anchors, Empty, Link, Page, PathRefs, Rows, STATUS_ORDER, StatusBadge, statusLabel, useIndex } from "../ui";

export function ClaimsPage() {
  const index = useIndex();
  const claims = index.model.claims;
  const [filter, setFilter] = useState<ClaimStatus | "all">("all");
  const shown = claims
    .filter((claim) => filter === "all" || claim.status === filter)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const count = (status: ClaimStatus) => claims.filter((claim) => claim.status === status).length;

  return (
    <Page
      title="Claims"
      summary="What we believe the system does, and how the evidence relates to it. Contradicted and unverified claims come first."
      sections={[
        {
          id: "claims",
          title: "",
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
      facts={claim.about ? [["About", <PathRefs paths={claim.about} />]] : undefined}
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

export function ClaimRows({ claims }: { claims: Claim[] }) {
  return (
    <Rows
      rows={claims}
      rowKey={(claim) => claim.id}
      columns={[
        { head: "Status", className: "align-top whitespace-nowrap", cell: (claim) => <StatusBadge status={claim.status} /> },
        {
          head: "Claim",
          className: "max-w-[64ch] align-top",
          cell: (claim) => (
            <Link to={href("claim", claim.id)} className="text-kumo-default!">
              {claim.statement}
            </Link>
          ),
        },
        { head: "About", className: "align-top text-sm", cell: (claim) => claim.about && <PathRefs paths={claim.about} /> },
      ]}
    />
  );
}
