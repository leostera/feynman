import { Table } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { claimsAbout, href, type Index, type Kind } from "../model";
import { Anchors, Chips, Empty, IdRef, IdRefs, Link, Page, useIndex } from "../ui";
import { ClaimRows } from "./Actors";

/** Index and detail pages for the simpler element kinds. */

interface Column<T> {
  title: string;
  render: (item: T) => ReactNode;
  className?: string;
}

interface KindSpec<T extends { id: string; anchors: string[] }> {
  title: string;
  summary: string;
  items: (index: Index) => T[];
  describe: (item: T) => string | undefined;
  columns: Column<T>[];
  facts?: (item: T) => [string, ReactNode][];
  sections?: (item: T, index: Index) => { id: string; title: string; count?: number; content: ReactNode }[];
}

function usedInFlows(index: Index, test: (step: Index["model"]["flows"][number]["steps"][number]) => boolean): string[] {
  return index.model.flows.filter((flow) => flow.steps.some(test)).map((flow) => flow.id);
}

const SPECS: Partial<Record<Kind, KindSpec<any>>> = {
  state: {
    title: "State",
    summary: "Data each actor owns, where it lives, and how long it lasts.",
    items: (index) => index.model.state,
    describe: (item) => item.summary,
    columns: [
      { title: "Owner", render: (item) => <IdRef id={item.owner} />, className: "whitespace-nowrap" },
      { title: "Lifetime", render: (item) => item.lifetime },
    ],
    facts: (item) => [
      ["Owner", <IdRef id={item.owner} />],
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
  invariant: {
    title: "Invariants",
    summary: "Properties that must always hold, how each is enforced, and what breaks if it does not.",
    items: (index) => index.model.invariants,
    describe: (item) => item.statement,
    columns: [{ title: "Enforced by", render: (item) => <Chips items={item.enforcedBy} /> }],
    facts: (item) => [
      ["Enforced by", <Chips items={item.enforcedBy} />],
      ...(item.consequence ? ([["If it breaks", item.consequence]] as [string, ReactNode][]) : []),
    ],
  },
  boundary: {
    title: "Boundaries",
    summary: "Where untrusted or weakly structured data is parsed into trusted values.",
    items: (index) => index.model.boundaries ?? [],
    describe: (item) => item.summary,
    columns: [
      {
        title: "Effects after parse",
        render: (item) => (item.effectsAfterParse === undefined ? "—" : item.effectsAfterParse ? "Yes" : "No"),
      },
    ],
    facts: (item) => [
      ["Parses into", item.parsesInto ?? "—"],
      ["Effects only after parsing", item.effectsAfterParse === undefined ? "Not stated" : item.effectsAfterParse ? "Yes" : "No"],
    ],
    sections: (item, index) => {
      const flows = usedInFlows(index, (step) => step.boundary === item.id);
      return [{ id: "flows", title: "Crossed in", count: flows.length, content: flows.length ? <IdRefs ids={flows} /> : <Empty>Not referenced by a flow step.</Empty> }];
    },
  },
  contract: {
    title: "Contracts",
    summary: "External behaviour that must stay stable: APIs, protocols, persisted formats, and compatibility layers.",
    items: (index) => index.model.contracts ?? [],
    describe: (item) => item.summary,
    columns: [],
  },
  observability: {
    title: "Observability",
    summary: "Logs, traces, and metrics that make flows followable.",
    items: (index) => index.model.observability ?? [],
    describe: (item) => item.summary,
    columns: [{ title: "Confidence", render: (item) => item.confidence ?? "—" }],
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
          title: `All ${spec.title.toLowerCase()}`,
          count: items.length,
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
  const claims = claimsAbout(index, id);
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
