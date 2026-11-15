import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { graphHitRadius } from "./graph-hit-radius";
import { GraphNodeShape } from "./graph-node-shape";
import type { GraphData } from "./graph-model";
import { layoutGraph } from "./layout-graph";
import { sectorRings } from "./sector-rings";

const WIDTH = 640;
const HEIGHT = 440;
// Labels for every node only while they still fit.
const ALL_LABELS_UP_TO = 40;

const EDGE_STYLE: Record<string, string> = {
  subtask: "text-foreground/45",
  blocks: "text-destructive/70",
  related: "text-foreground/35 [stroke-dasharray:4_3]",
  file: "text-muted-foreground/40 [stroke-dasharray:1_3]",
  decision: "text-primary/45 [stroke-dasharray:1_3]",
  cluster: "text-foreground/30",
};

type GraphCanvasProps = {
  graph: GraphData;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

// The graph as SVG scaled to the width of the screen: no horizontal scroll at
// 400 px (AC-018). Arrows show blocks; dashes show weaker links. A click on
// the empty canvas or Escape clears the selection.
export function GraphCanvas({ graph, selectedId, onSelect }: GraphCanvasProps) {
  const { t } = useTranslation();
  const positions = useMemo(() => {
    const groupOf = new Map(
      graph.nodes.map((node) => [
        node.id,
        node.kind === "card" ? (node.card.sectorIds[0] ?? null) : null,
      ]),
    );
    return layoutGraph({
      ids: graph.nodes.map((node) => node.id),
      links: graph.edges,
      groupOf: (id) => groupOf.get(id) ?? null,
      width: WIDTH,
      height: HEIGHT,
    });
  }, [graph]);
  const rings = useMemo(
    () => sectorRings(graph, positions),
    [graph, positions],
  );
  const near = new Set(
    selectedId
      ? graph.edges.flatMap((edge) =>
          edge.source === selectedId || edge.target === selectedId
            ? [edge.source, edge.target]
            : [],
        )
      : [],
  );
  const allLabels = graph.nodes.length <= ALL_LABELS_UP_TO;
  // The hit radius follows the rendered SVG width, not the window (TB-223).
  const svgRef = useRef<SVGSVGElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(0);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRenderedWidth(entry.contentRect.width);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const hitRadius = graphHitRadius(renderedWidth, WIDTH);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="group"
      aria-label={t("workspace:forest.graph.canvasLabel")}
      className="h-auto w-full touch-manipulation rounded-lg border bg-card"
      onClick={() => onSelect(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onSelect(null);
      }}
    >
      <defs>
        <marker
          id="forest-graph-arrow"
          viewBox="0 0 10 10"
          refX="16"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path
            d="M0 0L10 5L0 10z"
            className="fill-current text-destructive/70"
          />
        </marker>
      </defs>
      {rings.map((ring) => (
        <g key={ring.id} className="text-primary">
          <circle
            cx={ring.x}
            cy={ring.y}
            r={ring.r}
            className="fill-current stroke-current opacity-10"
          />
          <text
            x={ring.x}
            y={Math.max(ring.y - ring.r - 4, 10)}
            textAnchor="middle"
            className="pointer-events-none fill-current text-[11px] opacity-70"
          >
            {ring.name}
          </text>
        </g>
      ))}
      {graph.edges.map((edge) => {
        const from = positions.get(edge.source);
        const to = positions.get(edge.target);
        if (!from || !to) return null;
        const lit =
          selectedId !== null &&
          (edge.source === selectedId || edge.target === selectedId);
        return (
          <line
            key={`${edge.type}|${edge.source}|${edge.target}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            strokeWidth={Math.min(1 + Math.log2(edge.weight), 5)}
            markerEnd={
              edge.type === "blocks" ? "url(#forest-graph-arrow)" : undefined
            }
            className={cn(
              "stroke-current",
              EDGE_STYLE[edge.type],
              lit && "text-foreground",
              selectedId !== null && !lit && "opacity-40",
            )}
          />
        );
      })}
      {graph.nodes.map((node) => {
        const at = positions.get(node.id);
        if (!at) return null;
        return (
          <GraphNodeShape
            key={node.id}
            node={node}
            x={at.x}
            y={at.y}
            selected={node.id === selectedId}
            dimmed={
              selectedId !== null &&
              node.id !== selectedId &&
              !near.has(node.id)
            }
            showLabel={
              allLabels ||
              node.kind === "cluster" ||
              node.id === selectedId ||
              near.has(node.id)
            }
            onSelect={onSelect}
            hitRadius={hitRadius}
          />
        );
      })}
    </svg>
  );
}
