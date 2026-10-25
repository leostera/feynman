import { Table } from "@cloudflare/kumo";
import { flowsOfComponent, href, limitsAbout, type Component } from "../model";
import { Anchors, Empty, IdRefs, Link, Page, Share, useIndex } from "../ui";
import { LimitRows } from "./Limits";

export function ComponentsPage() {
  const index = useIndex();
  const total = index.model.meta.source.footprint?.lines ?? 0;
  const components = [...index.model.components].sort((a, b) => (b.footprint.lines ?? 0) - (a.footprint.lines ?? 0));
  return (
    <Page
      title="Components"
      summary="The code in this repository, by unit: what each part does, which actors it runs in, and what it depends on."
      sections={[
        {
          id: "components",
          title: "",
          content: components.length ? (
            <Table layout="auto">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Component</Table.Head>
                  <Table.Head>Summary</Table.Head>
                  <Table.Head>Runs in</Table.Head>
                  <Table.Head>Share of code</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {components.map((component) => (
                  <Table.Row key={component.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("component", component.id)}>{component.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[56ch] align-top text-kumo-strong">{component.summary}</Table.Cell>
                    <Table.Cell className="align-top text-sm">
                      <IdRefs kind="actor" ids={component.actors} />
                    </Table.Cell>
                    <Table.Cell className="align-top">
                      {component.footprint.lines !== undefined ? <Share lines={component.footprint.lines} total={total} /> : "—"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : (
            <Empty>This model has no components.</Empty>
          ),
        },
      ]}
    />
  );
}

export function ComponentPage({ id }: { id: string }) {
  const index = useIndex();
  const component = index.components.get(id);
  if (!component) return null;
  const total = index.model.meta.source.footprint?.lines ?? 0;
  const usedBy = index.model.components.filter((other: Component) => other.dependsOn?.includes(id)).map((other) => other.id);
  const flows = flowsOfComponent(index, id);
  const limits = limitsAbout(index, { kind: "component", id });

  return (
    <Page
      title={component.id}
      summary={component.summary}
      facts={[
        ["Runs in", <IdRefs kind="actor" ids={component.actors} />],
        ...(component.dependsOn?.length ? ([["Depends on", <IdRefs kind="component" ids={component.dependsOn} />]] as [string, React.ReactNode][]) : []),
        ...(usedBy.length ? ([["Used by", <IdRefs kind="component" ids={usedBy} />]] as [string, React.ReactNode][]) : []),
        ...(component.footprint.lines !== undefined
          ? ([["Share of code", <Share lines={component.footprint.lines} total={total} />]] as [string, React.ReactNode][])
          : []),
      ]}
      sections={[
        {
          id: "flows",
          title: "Flows",
          count: flows.length,
          content: flows.length ? (
            <Table layout="auto">
              <Table.Body>
                {flows.map((flow) => (
                  <Table.Row key={flow.id}>
                    <Table.Cell className="align-top font-medium whitespace-nowrap">
                      <Link to={href("flow", flow.id)}>{flow.id}</Link>
                    </Table.Cell>
                    <Table.Cell className="max-w-[60ch] align-top text-kumo-strong">{flow.summary}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : (
            <Empty>No flow step names this component.</Empty>
          ),
        },
        { id: "limits", title: "Limits", count: limits.length, content: limits.length ? <LimitRows limits={limits} /> : null },
        { id: "code", title: "Code", count: component.footprint.files, content: <Anchors anchors={component.footprint.paths} /> },
        { id: "anchors", title: "Anchors", count: component.anchors.length, content: <Anchors anchors={component.anchors} /> },
      ]}
    />
  );
}
