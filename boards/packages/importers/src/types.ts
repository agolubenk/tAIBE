export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type ImportedPriority =
  | "no-priority"
  | "low"
  | "medium"
  | "high"
  | "urgent";

export type ImportedColumn = {
  key: string;
  name: string;
  isFinal: boolean;
};

export type ImportedLabel = {
  key: string;
  name: string;
  color: string;
};

export type ImportedPerson = {
  name?: string;
  email?: string;
};

export type ImportedComment = {
  author: ImportedPerson;
  body: string;
  createdAt?: string;
  // The comment's address in the source; a re-import matches comments by it.
  url?: string;
};

// What a field lost on the way: a value that looked personal (left out),
// a link reduced to its text, a signed file address or an unsafe scheme.
export type ImportedFieldLoss = {
  field: string;
  reason: "personal" | "link" | "signed" | "scheme";
};

export type ImportedTask = {
  key: string;
  number?: number;
  columnKey: string | null;
  archived?: boolean;
  title: string;
  description: string;
  priority: ImportedPriority;
  startDate?: string;
  dueDate?: string;
  createdAt?: string;
  assignee?: ImportedPerson;
  labelKeys: string[];
  comments: ImportedComment[];
  // Where the task came from, for sources that are mirrored rather than
  // imported once (Notion, R-080): the writer upserts by `lastEditedTime`.
  sourceRef?: ImportedSourceRef;
  // Source fields with no kaneo column, kept verbatim (R-024).
  extraFields?: Record<string, string | number | boolean | null>;
  // Source fields the card carries only as the body's last line (b13 В′),
  // raw and in the source's field order.
  footer?: Record<string, string | number>;
  // One entry per field and reason, for the run report.
  losses?: ImportedFieldLoss[];
  // Why an archived task left the board in the source, when it says so.
  terminalReason?: string;
};

export type ImportedSourceRef = {
  system: "notion";
  pageId: string;
  lastEditedTime: string;
  createdTime?: string;
  // The source database's title: a page without a Type field takes its kind
  // from it.
  database?: string;
};

export type ImportedRelationType = "subtask" | "blocks" | "related";

export type ImportedRelation = {
  sourceKey: string;
  targetKey: string;
  type: ImportedRelationType;
};

export type ImportedProject = {
  name: string;
  key?: string;
  description?: string;
  columns: ImportedColumn[];
  labels: ImportedLabel[];
  tasks: ImportedTask[];
  relations: ImportedRelation[];
  // Every label name the source defines, used or not: a re-import replaces
  // these on a card and leaves the card's other labels alone.
  labelNames?: string[];
  warnings: string[];
};

export type SourceProject = {
  id: string;
  name: string;
  detail?: string;
};

export type ReadProjectOptions = {
  includeComments: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
};

export type ImportSource = {
  listProjects(): Promise<SourceProject[]>;
  readProject(
    projectId: string,
    options: ReadProjectOptions,
  ): Promise<ImportedProject>;
};

export type ConnectOptions = {
  fetch?: FetchLike;
  signal?: AbortSignal;
};
