import { ChartPalette } from "@cloudflare/kumo";
import { GraphChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import type { Index } from "../model";
import { useNavigation } from "../navigation";
import { useDarkMode } from "../theme";

echarts.use([GraphChart, TooltipComponent, CanvasRenderer]);

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

/** Actors as nodes, sized by how many flows they take part in; edges are interactions. */
export function SystemGraph({ index }: { index: Index }) {
  const element = useRef<HTMLDivElement>(null);
  const { open } = useNavigation();
  const dark = useDarkMode();

  const option = useMemo(() => {
    const participation = new Map<string, number>();
    for (const flow of index.model.flows) {
      const actors = new Set(flow.steps.flatMap((step) => [step.actor, step.target].filter(Boolean) as string[]));
      for (const actor of actors) participation.set(actor, (participation.get(actor) ?? 0) + 1);
    }
    const text = dark ? "#e5e5e5" : "#262626";
    return {
      tooltip: {
        formatter: (params: { dataType: string; data: { name?: string; flows?: string[]; source?: string; target?: string } }) =>
          params.dataType === "edge"
            ? `${params.data.source} → ${params.data.target}<br/>${params.data.flows?.join("<br/>")}`
            : `${params.data.name}`,
      },
      series: [
        {
          type: "graph",
          layout: "force",
          roam: true,
          draggable: true,
          force: { repulsion: 420, edgeLength: [90, 200], gravity: 0.08 },
          edgeSymbol: ["none", "arrow"],
          edgeSymbolSize: 7,
          label: { show: true, position: "bottom", color: text, fontSize: 12 },
          lineStyle: { color: "source", opacity: 0.5, curveness: 0.15 },
          emphasis: { focus: "adjacency", lineStyle: { width: 3 } },
          data: index.model.actors.map((actor, i) => ({
            name: actor.id,
            symbolSize: 18 + 6 * (participation.get(actor.id) ?? 0),
            itemStyle: { color: ChartPalette.categorical(i % 10) },
          })),
          links: interactions(index).map((edge) => ({
            source: edge.from,
            target: edge.to,
            flows: edge.flows,
            lineStyle: { width: 1 + edge.flows.length },
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
      if (params.dataType === "node") open({ kind: "actor", id: (params.data as { name: string }).name });
    });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [option, open]);

  return <div ref={element} className="h-[420px] w-full rounded-lg bg-kumo-recessed" />;
}
