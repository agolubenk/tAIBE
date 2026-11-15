import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { GraphNode } from "./graph-model";

// A wider transparent circle under each node: a finger hits it on a phone.
// The canvas passes a radius from the real SVG scale (graph-hit-radius.ts).
const HIT_RADIUS = 14;
const LABEL_MAX = 18;

const short = (text: string) =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

function Shape({ node }: { node: GraphNode }) {
  if (node.kind === "file") {
    return <rect x={-6} y={-6} width={12} height={12} rx={2} />;
  }
  if (node.kind === "decision") return <path d="M0 -8L8 0L0 8L-8 0z" />;
  if (node.kind === "cluster") {
    return <circle r={Math.min(12 + Math.sqrt(node.size) * 2.5, 34)} />;
  }
  return <circle r={7} />;
}

function tone(node: GraphNode) {
  if (node.kind === "file") return "text-muted-foreground";
  if (node.kind === "decision") return "text-primary";
  if (node.kind === "cluster") return "text-foreground/70";
  if (node.card.isBug) return "text-destructive";
  return node.card.isCompleted ? "text-foreground/35" : "text-foreground";
}

type GraphNodeShapeProps = {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  onSelect: (id: string) => void;
  hitRadius?: number;
};

export function GraphNodeShape({
  node,
  x,
  y,
  selected,
  dimmed,
  showLabel,
  onSelect,
  hitRadius = HIT_RADIUS,
}: GraphNodeShapeProps) {
  const { t } = useTranslation();
  const name =
    node.kind === "card" ? `${node.label} ${node.card.title}` : node.label;
  const label =
    node.kind === "cluster"
      ? t("workspace:forest.graph.node.cluster", {
          label: node.label,
          size: String(node.size),
        })
      : t(`workspace:forest.graph.node.${node.kind}`, { label: name });
  const select = () => onSelect(node.id);

  return (
    // SVG has no <button>, so the node group takes the role.
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      transform={`translate(${x} ${y})`}
      className={cn(
        "cursor-pointer outline-none",
        tone(node),
        dimmed && "opacity-35",
        "[&:focus-visible_.node-shape]:stroke-ring [&:focus-visible_.node-shape]:stroke-[3]",
      )}
      onClick={(event) => {
        event.stopPropagation();
        select();
      }}
      onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      <circle r={hitRadius} className="fill-transparent" />
      <g
        className={cn(
          "node-shape fill-current stroke-background stroke-2",
          selected && "stroke-ring stroke-[3]",
        )}
      >
        <Shape node={node} />
      </g>
      {node.kind === "cluster" ? (
        <text
          textAnchor="middle"
          dy="0.35em"
          className="pointer-events-none fill-background font-semibold text-[11px] tabular-nums"
        >
          {node.size}
        </text>
      ) : null}
      {showLabel ? (
        <text
          dy={node.kind === "cluster" ? "-2.6em" : "1.9em"}
          textAnchor="middle"
          className="pointer-events-none fill-current text-[11px]"
        >
          {short(node.label)}
        </text>
      ) : null}
    </g>
  );
}
