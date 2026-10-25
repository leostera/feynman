import { ComponentGraph } from "../diagrams/SystemGraph";
import { flowsOfComponent, limitsAbout, type Component } from "../model";
import { Anchors, CELL, idColumn, IdRefs, Page, Rows, Share, useIndex } from "../ui";
import { LimitRows } from "./Limits";

/** A component's lines as a share of the repository's, or "—" before measuring. */
function CodeShare({ component }: { component: Component }) {
  const total = useIndex().model.meta.source.footprint?.lines ?? 0;
  return component.footprint.lines === undefined ? "—" : <Share lines={component.footprint.lines} total={total} />;
}

export function ComponentsPage() {
  const index = useIndex();
  const components = [...index.model.components].sort((a, b) => (b.footprint.lines ?? 0) - (a.footprint.lines ?? 0));
  const hasDependencies = components.some((component) => component.dependsOn?.length);
  return (
    <Page
      title="Components"
      summary="The code in this repository, by unit: what each part does, which actors it runs in, and what it depends on."
      sections={[
        { id: "graph", title: "", content: hasDependencies ? <ComponentGraph index={index} height={420} /> : null },
        {
          id: "components",
          title: "",
          content: (
            <Rows
              rows={components}
              rowKey={(component) => component.id}
              empty="This model has no components."
              columns={[
                idColumn("component", "Component"),
                { head: "Summary", className: CELL.prose, cell: (component) => component.summary },
                { head: "Runs in", className: "align-top text-sm", cell: (component) => <IdRefs kind="actor" ids={component.actors} /> },
                { head: "Share of code", cell: (component) => <CodeShare component={component} /> },
              ]}
            />
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
  const usedBy = index.model.components.filter((other) => other.dependsOn?.includes(id)).map((other) => other.id);
  const flows = flowsOfComponent(index, id);
  const limits = limitsAbout(index, { kind: "component", id });

  return (
    <Page
      title={component.id}
      summary={component.summary}
      facts={[
        ["Runs in", <IdRefs kind="actor" ids={component.actors} />],
        ["Depends on", component.dependsOn?.length ? <IdRefs kind="component" ids={component.dependsOn} /> : null],
        ["Used by", usedBy.length ? <IdRefs kind="component" ids={usedBy} /> : null],
        ["Share of code", component.footprint.lines === undefined ? null : <CodeShare component={component} />],
      ]}
      sections={[
        {
          id: "flows",
          title: "Flows",
          count: flows.length,
          content: (
            <Rows
              rows={flows}
              rowKey={(flow) => flow.id}
              empty="No flow step names this component."
              columns={[idColumn("flow", ""), { className: CELL.prose, cell: (flow) => flow.summary }]}
            />
          ),
        },
        { id: "limits", title: "Limits", count: limits.length, content: limits.length ? <LimitRows limits={limits} /> : null },
        { id: "code", title: "Code", count: component.footprint.files, content: <Anchors anchors={component.footprint.paths} /> },
        { id: "anchors", title: "Anchors", count: component.anchors.length, content: <Anchors anchors={component.anchors} /> },
      ]}
    />
  );
}
