import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ForestTaskLink } from "../forest-task-link";
import { type GraphData, type GraphNode, neighboursOf } from "./graph-model";

type GraphDetailsProps = {
  workspaceId: string;
  graph: GraphData;
  node: GraphNode | null;
  onSelect: (id: string) => void;
  onExpand: (group: string) => void;
};

// How the node at the other end relates to the selected one.
function relation(type: string, outgoing: boolean) {
  if (type === "subtask") return outgoing ? "subtask" : "parent";
  if (type === "blocks") return outgoing ? "blocks" : "blockedBy";
  if (type === "file" || type === "decision") return outgoing ? type : "card";
  return type;
}

// The selected node and what it links to: the canvas shows the shape, this
// list carries the names and the way to each card, for keyboard and screen.
export function GraphDetails({
  workspaceId,
  graph,
  node,
  onSelect,
  onExpand,
}: GraphDetailsProps) {
  const { t } = useTranslation();
  if (!node) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("workspace:forest.graph.hint")}
      </p>
    );
  }
  const neighbours = neighboursOf(graph, node.id);

  return (
    <section
      aria-live="polite"
      className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        {node.kind === "card" ? (
          <>
            <ForestTaskLink
              workspaceId={workspaceId}
              projectId={node.card.projectId}
              taskId={node.card.id}
              number={node.card.number}
              title={node.card.title}
              className="font-medium"
            />
            <span className="text-muted-foreground text-xs">
              {node.card.projectName}
            </span>
          </>
        ) : (
          <span className="min-w-0 break-all font-medium">
            {node.kind === "file" ? node.path : node.label}
          </span>
        )}
        {node.kind === "cluster" ? (
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            onClick={() => onExpand(node.group)}
          >
            {t("workspace:forest.graph.expand", { size: String(node.size) })}
          </Button>
        ) : null}
      </div>
      {neighbours.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {neighbours.map(({ node: other, type, outgoing }) => (
            <li
              key={`${type}|${outgoing}|${other.id}`}
              className="flex min-w-0 items-baseline gap-2"
            >
              <span className="shrink-0 text-muted-foreground text-xs">
                {t(
                  `workspace:forest.graph.relation.${relation(type, outgoing)}`,
                )}
              </span>
              <button
                type="button"
                className="min-w-0 truncate rounded-sm text-start outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-sm:py-1"
                onClick={() => onSelect(other.id)}
              >
                {other.kind === "card"
                  ? `${other.label} ${other.card.title}`
                  : other.kind === "file"
                    ? other.path
                    : other.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("workspace:forest.graph.noLinks")}
        </p>
      )}
    </section>
  );
}
