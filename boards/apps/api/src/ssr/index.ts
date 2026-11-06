import { apiRouter, type BaseVariables } from "../openapi";
import { ssrRoutes } from "./routes";
import { ssrDraftRoutes } from "./routes/drafts";

// tAI-Boards SSR: versioned registry of sessions, skills and rules (spec
// prototipes/grill/taiboards-ssr/spec.md, approved 31.10).
const ssr = apiRouter<BaseVariables & { workspaceId: string }>()
  .route("/", ssrRoutes)
  .route("/", ssrDraftRoutes);

export default ssr;
