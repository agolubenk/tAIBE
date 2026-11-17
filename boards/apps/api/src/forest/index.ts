import { apiRouter, type BaseVariables } from "../openapi";
import { approvalRoutes } from "./routes/approval-routes";
import { bugsRoutes } from "./routes/bugs-routes";
import { cardRoutes } from "./routes/card-routes";
import { contextRoutes } from "./routes/context-routes";
import { costRoutes } from "./routes/cost-routes";
import { fellRoutes } from "./routes/fell-routes";
import { graphRoutes } from "./routes/graph-routes";
import { historyRoutes } from "./routes/history-routes";
import { leaseRoutes } from "./routes/lease-routes";
import { memoryRoutes } from "./routes/memory-routes";
import { mirrorRoutes } from "./routes/mirror-routes";
import { pulseRoutes } from "./routes/pulse-routes";
import { readRoutes } from "./routes/read-routes";
import { treeRoutes } from "./routes/tree-routes";
import { workersRoutes } from "./routes/workers-routes";
import { workStateRoutes } from "./routes/work-state-routes";

// t-boards forest model (spec R-026…R-029, N-011): leases, the owner's «да»,
// felling into logs and seeds, sectors, growing from seeds, and the card
// fields Notion keeps (R-024), the card history with rollback (R-023), and
// the context pack an agent reads to pick up a card (R-031), and the reads
// the forest page and the board show: trees with their branches, live leases,
// the agents' feed, what is on fire and the links graph (R-090), who is on
// a card and its bugs, and what agents spent on a card (R-036).
const forest = apiRouter<BaseVariables & { workspaceId: string }>()
  .route("/", leaseRoutes)
  .route("/", approvalRoutes)
  .route("/", fellRoutes)
  .route("/", readRoutes)
  .route("/", cardRoutes)
  .route("/", historyRoutes)
  .route("/", contextRoutes)
  .route("/", memoryRoutes)
  .route("/", costRoutes)
  .route("/", mirrorRoutes)
  .route("/", treeRoutes)
  .route("/", workStateRoutes)
  .route("/", workersRoutes)
  .route("/", bugsRoutes)
  .route("/", pulseRoutes)
  .route("/", graphRoutes);

export default forest;
