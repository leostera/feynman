import type { ReactNode } from "react";
import { claimsAbout, type Anchor, type Index, type Kind } from "../model";
import { Anchors, Chips, Empty, idColumn, IdRef, Page, Rows, useIndex, type Column, type PageSection } from "../ui";
import { ClaimRows } from "./Claims";

/** Index and detail pages for the simpler element kinds. */

interface KindSpec<T extends { id: string; anchors: Anchor[] }> {
  title: string;
  summary: string;
  items: (index: Index) => T[];
  describe: (item: T) => string | undefined;
  columns: Column<T>[];
  facts?: (item: T) => [string, ReactNode][];
  sections?: (item: T) => PageSection[];
}

const SPECS: Partial<Record<Kind, KindSpec<any>>> = {
  state: {
    title: "State",
    summary: "Data each actor owns, where it lives, and how long it lasts.",
    items: (index) => index.model.state,
    describe: (item) => item.summary,
    columns: [
      { head: "Owner", className: "align-top whitespace-nowrap", cell: (item) => <IdRef kind="actor" id={item.owner} /> },
      { head: "Lifetime", cell: (item) => item.lifetime },
    ],
    facts: (item) => [
      ["Owner", <IdRef kind="actor" id={item.owner} />],
      ["Lifetime", item.lifetime],
    ],
  },
  machine: {
    title: "State machines",
    summary: "Domain states and the transitions between them.",
    items: (index) => index.model.stateMachines ?? [],
    describe: (item) => item.summary,
    columns: [{ head: "States", className: "text-right align-top tabular-nums", cell: (item) => item.states?.length ?? "—" }],
    sections: (item) => [
      { id: "states", title: "States", count: item.states?.length, content: item.states ? <Chips items={item.states} /> : <Empty>No states listed.</Empty> },
      {
        id: "transitions",
        title: "Transitions",
        count: item.transitions?.length,
        content: item.transitions ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-kumo-strong">
            {item.transitions.map((transition: string) => (
              <li key={transition}>{transition}</li>
            ))}
          </ul>
        ) : (
          <Empty>No transitions listed.</Empty>
        ),
      },
    ],
  },
};

export function hasElementPages(kind: Kind): boolean {
  return kind in SPECS;
}

export function ElementIndexPage({ kind }: { kind: Kind }) {
  const index = useIndex();
  const spec = SPECS[kind]!;
  const items = spec.items(index);
  return (
    <Page
      title={spec.title}
      summary={spec.summary}
      sections={[
        {
          id: "all",
          title: "",
          content: (
            <Rows
              rows={items}
              rowKey={(item) => item.id}
              empty="None recorded."
              columns={[
                idColumn(kind, "Name"),
                { head: "Description", className: "max-w-[60ch] align-top text-kumo-strong", cell: (item) => spec.describe(item) ?? "—" },
                ...spec.columns,
              ]}
            />
          ),
        },
      ]}
    />
  );
}

export function ElementPage({ kind, id }: { kind: Kind; id: string }) {
  const index = useIndex();
  const spec = SPECS[kind]!;
  const item = spec.items(index).find((candidate) => candidate.id === id);
  if (!item) return null;
  const claims = claimsAbout(index, { kind, id });
  return (
    <Page
      title={item.id}
      summary={spec.describe(item)}
      facts={spec.facts?.(item)}
      sections={[
        ...(spec.sections?.(item) ?? []),
        { id: "claims", title: "Claims", count: claims.length, content: claims.length ? <ClaimRows claims={claims} /> : null },
        { id: "anchors", title: "Anchors", count: item.anchors.length, content: <Anchors anchors={item.anchors} /> },
      ]}
    />
  );
}
