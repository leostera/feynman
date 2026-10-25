import type { ReactNode } from "react";
import { claimsAbout, limitsAbout, type Field, type Message, type MessageKind, type Protocol } from "../model";
import { Anchors, CELL, Empty, idColumn, IdRef, IdRefs, Page, Rows, useIndex } from "../ui";
import { ClaimRows } from "./Claims";
import { LimitRows } from "./Limits";

const KIND_TITLE: Record<MessageKind, string> = {
  call: "Calls",
  event: "Events",
  record: "Records",
  route: "Routes",
  table: "Tables",
};
const KIND_ORDER: MessageKind[] = ["call", "route", "record", "event", "table"];

export function ProtocolsPage() {
  const index = useIndex();
  return (
    <Page
      title="Protocols"
      summary="Shapes data must have to enter, leave, or rest inside the system: wire protocols, APIs, files, and database schemas."
      sections={[
        {
          id: "protocols",
          title: "",
          content: (
            <Rows
              rows={index.model.protocols}
              rowKey={(protocol) => protocol.id}
              columns={[
                idColumn("protocol", "Name"),
                { head: "Description", className: CELL.prose, cell: (protocol) => protocol.summary },
                { head: "Style", className: `${CELL.fact} whitespace-nowrap`, cell: (protocol) => protocol.style },
                { head: "Owner", className: "align-top text-sm whitespace-nowrap", cell: (protocol) => (protocol.server ? <IdRef kind="actor" id={protocol.server} /> : "—") },
                { head: "Messages", className: CELL.number, cell: (protocol) => protocol.messages.length },
              ]}
            />
          ),
        },
      ]}
    />
  );
}

export function ProtocolPage({ id }: { id: string }) {
  const index = useIndex();
  const protocol = index.protocols.get(id);
  if (!protocol) return null;
  const ref = { kind: "protocol" as const, id };
  const claims = claimsAbout(index, ref);
  const limits = limitsAbout(index, ref);
  const flows = index.model.flows.filter((flow) => flow.steps.some((step) => step.protocol === id)).map((flow) => flow.id);
  const kinds = KIND_ORDER.filter((kind) => protocol.messages.some((message) => message.kind === kind));

  return (
    <Page
      title={protocol.id}
      summary={protocol.summary}
      facts={facts(protocol)}
      sections={[
        ...kinds.map((kind) => {
          const messages = protocol.messages.filter((message) => message.kind === kind);
          return { id: kind, title: KIND_TITLE[kind], count: messages.length, content: <Messages protocol={protocol} messages={messages} /> };
        }),
        {
          id: "parsing",
          title: "Parsing",
          count: protocol.parsing?.length,
          content: protocol.parsing?.length ? (
            <ul className="flex flex-col gap-4">
              {protocol.parsing.map((entry) => (
                <li key={entry.summary} className="flex flex-col gap-1.5">
                  <p className="max-w-[70ch] text-sm text-kumo-strong">{entry.summary}</p>
                  <Anchors anchors={entry.anchors} />
                </li>
              ))}
            </ul>
          ) : null,
        },
        { id: "limits", title: "Limits", count: limits.length, content: limits.length ? <LimitRows limits={limits} /> : null },
        { id: "flows", title: "Used in flows", count: flows.length, content: flows.length ? <IdRefs kind="flow" ids={flows} /> : null },
        { id: "claims", title: "Claims", count: claims.length, content: claims.length ? <ClaimRows claims={claims} /> : null },
        {
          id: "definitions",
          title: "Definitions",
          count: protocol.definitions?.length,
          content: protocol.definitions?.length ? <Anchors anchors={protocol.definitions} /> : null,
        },
        { id: "anchors", title: "Anchors", count: protocol.anchors.length, content: <Anchors anchors={protocol.anchors} /> },
      ]}
    />
  );
}

function facts(protocol: Protocol): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [
    ["Style", protocol.style],
    ["Transport", protocol.transport],
  ];
  if (protocol.server) rows.push(["Owner", <IdRef kind="actor" id={protocol.server} />]);
  if (protocol.clients?.length) rows.push(["Clients", <IdRefs kind="actor" ids={protocol.clients} />]);
  if (protocol.framing) rows.push(["Framing", protocol.framing]);
  if (protocol.version) rows.push(["Version", protocol.version]);
  if (protocol.compatibility) rows.push(["Compatibility", protocol.compatibility]);
  return rows;
}

function Messages({ protocol, messages }: { protocol: Protocol; messages: Message[] }) {
  // Only name the sender when a protocol has messages flowing both ways.
  const senders = new Set(protocol.messages.map((message) => message.from ?? ""));
  return (
    <ul className="flex flex-col divide-y divide-kumo-hairline">
      {messages.map((message) => (
        <li key={message.name} id={`${message.kind}-${message.name}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="font-mono text-sm font-semibold text-kumo-default">{message.name}</code>
            {message.from && senders.size > 1 && (
              <span className="text-xs text-kumo-subtle">
                from <IdRef kind="actor" id={message.from} />
              </span>
            )}
          </div>
          {message.summary && <p className="max-w-[70ch] text-sm text-kumo-strong">{message.summary}</p>}
          {message.fields && message.fields.length > 0 && <Fields fields={message.fields} />}
          {message.kind === "call" && message.fields?.length === 0 && <span className="text-xs text-kumo-subtle">No parameters</span>}
          {message.returns && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-kumo-subtle">Returns</span>
              {message.returns.length ? <Fields fields={message.returns} /> : <Empty>Nothing</Empty>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Fields({ fields }: { fields: Field[] }) {
  return (
    <dl className="grid grid-cols-[max-content_max-content_1fr] gap-x-4 gap-y-0.5 text-[13px]">
      {fields.map((field) => (
        <div key={field.name} className="contents">
          <dt className="font-mono text-kumo-default">
            {field.name}
            {field.required === false && <span className="text-kumo-subtle">?</span>}
          </dt>
          <dd className="font-mono text-kumo-strong">{field.type}</dd>
          <dd className="text-kumo-subtle">{field.note}</dd>
        </div>
      ))}
    </dl>
  );
}
