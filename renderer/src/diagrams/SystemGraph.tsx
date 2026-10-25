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

/** Interactions with direction dropped: one connection per pair of actors. */
export function connections(index: Index): Interaction[] {
  const byPair = new Map<string, Interaction>();
  for (const edge of interactions(index)) {
    const [a, b] = [edge.from, edge.to].sort();
    const key = `${a}|${b}`;
    const entry = byPair.get(key) ?? { from: a, to: b, flows: [] };
    for (const flow of edge.flows) if (!entry.flows.includes(flow)) entry.flows.push(flow);
    byPair.set(key, entry);
  }
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

/**
 * The architecture at a glance: actors as nodes coloured by where they run, one
 * edge per pair of actors that interact in any flow, and edge weight by flow count.
 */
export function SystemGraph({ index, height = 460 }: { index: Index; height?: number }) {
  const element = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();

  const option = useMemo(() => {
    const present = LOCATIONS.filter(({ location }) => index.model.actors.some((actor) => actor.runsOn.location === location));
    const category = new Map(present.map(({ location }, i) => [location, i]));
    const edges = connections(index);
    const degree = new Map<string, number>();
    for (const edge of edges) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const text = dark ? "#e5e5e5" : "#262626";
    const subtle = dark ? "#a3a3a3" : "#737373";
    return {
      color: present.map((_, i) => ChartPalette.categorical(i)),
      legend: { data: present.map((entry) => entry.label), top: 12, left: 12, textStyle: { color: subtle }, icon: "circle" },
      tooltip: {
        formatter: (params: { dataType: string; data: { name?: string; detail?: string; flows?: string[]; source?: string; target?: string } }) =>
          params.dataType === "edge"
            ? `${params.data.source} — ${params.data.target}<br/>${params.data.flows?.length} flows: ${params.data.flows?.join(", ")}`
            : `<b>${params.data.name}</b><br/>${params.data.detail}`,
      },
      series: [
        {
          type: "graph",
          layout: "force",
          top: 48,
          bottom: 24,
          roam: true,
          draggable: true,
          categories: present.map((entry) => ({ name: entry.label })),
          force: { repulsion: 520, edgeLength: [80, 180], gravity: 0.1 },
          label: { show: true, position: "bottom", color: text, fontSize: 12 },
          lineStyle: { color: subtle, opacity: 0.45, curveness: 0 },
          emphasis: { focus: "adjacency", lineStyle: { opacity: 0.9 } },
          data: index.model.actors.map((actor) => ({
            name: actor.id,
            detail: locationLabel(actor),
            category: category.get(actor.runsOn.location),
            symbolSize: 14 + 5 * (degree.get(actor.id) ?? 0),
            // External actors are drawn hollow.
            itemStyle:
              actor.provenance === "first-party"
                ? {}
                : { color: dark ? "#171717" : "#ffffff", borderWidth: 2, borderColor: ChartPalette.categorical(category.get(actor.runsOn.location) ?? 0) },
          })),
          links: edges.map((edge) => ({
            source: edge.from,
            target: edge.to,
            flows: edge.flows,
            lineStyle: { width: 1 + Math.log2(edge.flows.length) },
          })),
        },
      ],
    };
  }, [index, dark]);

  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chart.setOption(option);
    chart.on("click", (params) => {
      if (params.dataType === "node") window.location.hash = href("actor", (params.data as { name: string }).name);
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
