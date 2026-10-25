import { ChartPalette } from "@cloudflare/kumo";
import { GraphChart } from "echarts/charts";
import { LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import { href, type Actor, type Index, type Location } from "../model";
import { useDarkMode } from "../theme";

echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface Interaction {
  from: string;
  to: string;
  flows: string[];
}

/** Directed actor-to-actor interactions, from flow steps that name a target. */
export function interactions(index: Index): Interaction[] {
  const byPair = new Map<string, Interaction>();
  for (const flow of index.model.flows) {
    for (const step of flow.steps) {
      if (!step.target || step.target === step.actor) continue;
      const key = `${step.actor}→${step.target}`;
      const entry = byPair.get(key) ?? { from: step.actor, to: step.target, flows: [] };
      if (!entry.flows.includes(flow.id)) entry.flows.push(flow.id);
      byPair.set(key, entry);
    }
  }
  return [...byPair.values()];
}

/**
 * Interactions with direction dropped: one connection per pair of actors, from
 * flow steps and from the actors' `talksTo` (a connection no flow shows yet).
 */
export function connections(index: Index): Interaction[] {
  const byPair = new Map<string, Interaction>();
  const add = (x: string, y: string, flows: string[]) => {
    if (x === y || !index.actors.has(x) || !index.actors.has(y)) return;
    const [a, b] = [x, y].sort();
    const key = `${a}|${b}`;
    const entry = byPair.get(key) ?? { from: a, to: b, flows: [] };
    for (const flow of flows) if (!entry.flows.includes(flow)) entry.flows.push(flow);
    byPair.set(key, entry);
  };
  for (const edge of interactions(index)) add(edge.from, edge.to, edge.flows);
  for (const actor of index.model.actors) for (const other of actor.talksTo ?? []) add(actor.id, other, []);
  return [...byPair.values()].sort((x, y) => `${x.from}|${x.to}`.localeCompare(`${y.from}|${y.to}`));
}

export const LOCATIONS: { location: Location; label: string }[] = [
  { location: "local", label: "Local machine" },
  { location: "browser", label: "Browser" },
  { location: "remote", label: "Remote server" },
  { location: "cloud", label: "Cloud" },
];

export function locationLabel(actor: Actor): string {
  const base = LOCATIONS.find((entry) => entry.location === actor.runsOn.location)?.label ?? actor.runsOn.location;
  const detail = [actor.runsOn.provider, actor.runsOn.platform].filter(Boolean).join(" ");
  return detail ? `${base} · ${detail}` : base;
}

/** A person, for actors of kind `person`: a head and shoulders. */
const PERSON = "path://M12 2a5 5 0 1 1 0 10a5 5 0 1 1 0-10z M2 24c0-6 4.5-10 10-10s10 4 10 10z";

interface GraphNode {
  name: string;
  detail: string;
  category: number;
  size: number;
  hollow?: boolean;
  symbol?: string;
  link: string;
}

interface GraphLink {
  source: string;
  target: string;
  /** Tooltip HTML. */
  tip: string;
  width?: number;
  directed?: boolean;
}

/** A force-directed graph with one colour per category; clicking a node follows its link. */
function ForceGraph({ categories, nodes, links, height }: { categories: string[]; nodes: GraphNode[]; links: GraphLink[]; height: number }) {
  const element = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();

  const option = useMemo(() => {
    const text = dark ? "#e5e5e5" : "#262626";
    const subtle = dark ? "#a3a3a3" : "#737373";
    const background = dark ? "#171717" : "#ffffff";
    return {
      color: categories.map((_, i) => ChartPalette.categorical(i)),
      legend: { data: categories, top: 12, left: 12, textStyle: { color: subtle }, icon: "circle" },
      tooltip: {
        formatter: (params: { dataType: string; data: { name?: string; detail?: string; tip?: string } }) =>
          params.dataType === "edge" ? params.data.tip : `<b>${params.data.name}</b><br/>${params.data.detail}`,
      },
      series: [
        {
          type: "graph",
          layout: "force",
          top: 48,
          bottom: 24,
          roam: true,
          draggable: true,
          categories: categories.map((name) => ({ name })),
          force: { repulsion: 520, edgeLength: [80, 180], gravity: 0.1 },
          label: { show: true, position: "bottom", color: text, fontSize: 12 },
          lineStyle: { color: subtle, opacity: 0.45, curveness: 0 },
          edgeSymbolSize: 7,
          emphasis: { focus: "adjacency", lineStyle: { opacity: 0.9 } },
          data: nodes.map((node) => ({
            ...node,
            label: { formatter: node.name },
            symbol: node.symbol ?? "circle",
            symbolSize: node.symbol ? node.size * 1.2 : node.size,
            itemStyle: node.hollow ? { color: background, borderWidth: 2, borderColor: ChartPalette.categorical(node.category) } : {},
          })),
          links: links.map((link) => ({
            ...link,
            symbol: link.directed ? ["none", "arrow"] : ["none", "none"],
            lineStyle: { width: link.width ?? 1 },
          })),
        },
      ],
    };
  }, [categories, nodes, links, dark]);

  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chart.setOption(option);
    chart.on("click", (params) => {
      if (params.dataType === "node") window.location.hash = (params.data as GraphNode).link;
    });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [option]);

  return <div ref={element} style={{ height }} className="w-full rounded-lg bg-kumo-recessed" />;
}

/**
 * Who takes part in the system: actors coloured by where they run (people drawn
 * as people, external actors hollow), one edge per pair of actors that interact.
 */
export function SystemGraph({ index, height = 520 }: { index: Index; height?: number }) {
  const { categories, nodes, links } = useMemo(() => {
    const present = LOCATIONS.filter(({ location }) => index.model.actors.some((actor) => actor.runsOn.location === location));
    const category = new Map(present.map(({ location }, i) => [location, i]));
    const edges = connections(index);
    const degree = new Map<string, number>();
    for (const edge of edges) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    return {
      categories: present.map((entry) => entry.label),
      nodes: index.model.actors.map(
        (actor: Actor): GraphNode => ({
          name: actor.id,
          detail: locationLabel(actor),
          category: category.get(actor.runsOn.location) ?? 0,
          size: 14 + 5 * (degree.get(actor.id) ?? 0),
          hollow: actor.provenance !== "first-party",
          symbol: actor.kind === "person" ? PERSON : undefined,
          link: href("actor", actor.id),
        }),
      ),
      links: edges.map(
        (edge): GraphLink => ({
          source: edge.from,
          target: edge.to,
          tip: edge.flows.length ? `${edge.from} — ${edge.to}<br/>${edge.flows.length} flows: ${edge.flows.join(", ")}` : `${edge.from} — ${edge.to}<br/>talk; no flow shows how yet`,
          width: 1 + Math.log2(Math.max(1, edge.flows.length)),
        }),
      ),
    };
  }, [index]);
  return <ForceGraph categories={categories} nodes={nodes} links={links} height={height} />;
}

/** How the code fits together: components coloured by the actor they run in, arrows to what they depend on. */
export function ComponentGraph({ index, height = 520 }: { index: Index; height?: number }) {
  const { categories, nodes, links } = useMemo(() => {
    const components = index.model.components;
    const hosts = [...new Set(components.map((component) => component.actors[0]))].sort();
    const used = new Map<string, number>();
    for (const component of components) for (const id of component.dependsOn ?? []) used.set(id, (used.get(id) ?? 0) + 1);
    return {
      categories: hosts,
      nodes: components.map(
        (component): GraphNode => ({
          name: component.id,
          detail: `runs in ${component.actors.join(", ")}${component.footprint.lines !== undefined ? `<br/>${component.footprint.lines.toLocaleString()} lines` : ""}`,
          category: hosts.indexOf(component.actors[0]),
          size: 14 + 5 * (used.get(component.id) ?? 0),
          link: href("component", component.id),
        }),
      ),
      links: components.flatMap((component) =>
        (component.dependsOn ?? [])
          .filter((id) => index.components.has(id))
          .map((id): GraphLink => ({ source: component.id, target: id, tip: `${component.id} depends on ${id}`, directed: true })),
      ),
    };
  }, [index]);
  return <ForceGraph categories={categories} nodes={nodes} links={links} height={height} />;
}
