import { Table } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { claimsAbout, href, type Anchor, type Index, type Kind } from "../model";
import { Anchors, Chips, Empty, IdRef, Link, Page, useIndex } from "../ui";
import { ClaimRows } from "./Claims";

/** Index and detail pages for the simpler element kinds. */

interface Column<T> {
  title: string;
  render: (item: T) => ReactNode;
  className?: string;
}

interface KindSpec<T extends { id: string; anchors: Anchor[] }> {
  title: string;
  summary: string;
  items: (index: Index) => T[];
  describe: (item: T) => string | undefined;
  columns: Column<T>[];
  facts?: (item: T) => [string, ReactNode][];
  sections?: (item: T, index: Index) => { id: string; title: string; count?: number; content: ReactNode }[];
}

const SPECS: Partial<Record<Kind, KindSpec<any>>> = {
  state: {
    title: "State",
    summary: "Data each actor owns, where it lives, and how long it lasts.",
    items: (index) => index.model.state,
    describe: (item) => item.summary,
    columns: [
      { title: "Owner", render: (item) => <IdRef kind="actor" id={item.owner} />, className: "whitespace-nowrap" },
      { title: "Lifetime", render: (item) => item.lifetime },
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
    columns: [{ title: "States", render: (item) => (item.states ? item.states.length : "—"), className: "text-right tabular-nums" }],
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
          content:
            items.length === 0 ? (
              <Empty>None recorded.</Empty>
            ) : (
              <Table layout="auto">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Name</Table.Head>
                    <Table.Head>Description</Table.Head>
                    {spec.columns.map((column) => (
                      <Table.Head key={column.title}>{column.title}</Table.Head>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {items.map((item) => (
                    <Table.Row key={item.id}>
                      <Table.Cell className="align-top font-medium whitespace-nowrap">
                        <Link to={href(kind, item.id)}>{item.id}</Link>
                      </Table.Cell>
                      <Table.Cell className="max-w-[60ch] align-top text-kumo-strong">{spec.describe(item) ?? "—"}</Table.Cell>
                      {spec.columns.map((column) => (
                        <Table.Cell key={column.title} className={`align-top ${column.className ?? ""}`}>
                          {column.render(item)}
                        </Table.Cell>
                      ))}
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
        ...(spec.sections?.(item, index) ?? []),
        ...(claims.length > 0 ? [{ id: "claims", title: "Claims", count: claims.length, content: <ClaimRows claims={claims} /> }] : []),
        { id: "anchors", title: "Anchors", count: item.anchors.length, content: <Anchors anchors={item.anchors} /> },
      ]}
    />
  );
}
