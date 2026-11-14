export type ExternalLinkMetadata = {
  syncFilterPaused?: boolean;
  state?: string;
  merged?: boolean;
  mergedAt?: string;
  draft?: boolean;
  branch?: string;
  author?: string;
  createdFrom?:
    | "github"
    | "kaneo"
    | "gitea"
    | "gitea-import"
    | "github-import"
    | "gitlab"
    | "gitlab-import";
  lastCommit?: {
    sha: string;
    message: string;
    author?: string;
    timestamp: string;
  };
  // TB-172: review on a button. The server keeps the state of the run.
  reviewRequested?: boolean;
  reviewDoneAt?: string;
  reviewUrl?: string;
  // Absent on links made before the handler wrote it: unknown, not «no».
  fromFork?: boolean;
};

export type ExternalLink = {
  id: string;
  taskId: string;
  integrationId: string | null;
  resourceType: string;
  externalId: string;
  url: string;
  title: string | null;
  metadata: ExternalLinkMetadata | null;
  createdAt?: string;
  updatedAt?: string;
  integration?: {
    id: string;
    type: string;
  } | null;
};
