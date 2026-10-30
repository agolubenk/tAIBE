export type NotionRichText = {
  type?: string;
  plain_text: string;
  href?: string | null;
  // Only the kind is read: a user mention also carries the person's email.
  mention?: { type?: string; page?: { id?: string } };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
};

export type NotionSelectOption = {
  id?: string;
  name: string;
  color?: string;
};

export type NotionStatusGroup = {
  id?: string;
  name: string;
  option_ids?: string[];
};

export type NotionPropertySchema = {
  id: string;
  name: string;
  type: string;
  select?: { options: NotionSelectOption[] };
  status?: { options: NotionSelectOption[]; groups?: NotionStatusGroup[] };
  multi_select?: { options: NotionSelectOption[] };
};

export type NotionDatabase = {
  id: string;
  title: NotionRichText[];
  description?: NotionRichText[];
  properties: Record<string, NotionPropertySchema>;
  archived?: boolean;
  in_trash?: boolean;
};

export type NotionUser = {
  object: string;
  id: string;
  name?: string | null;
  type?: string;
};

// A page-level comment (GET /v1/comments). Notion gives the author's id only.
export type NotionComment = {
  id: string;
  discussion_id: string;
  created_time: string;
  last_edited_time?: string;
  created_by?: { id?: string };
  rich_text?: NotionRichText[];
};

export type NotionDateValue = {
  start: string;
  end?: string | null;
};

export type NotionPerson = {
  name?: string | null;
  person?: { email?: string };
};

export type NotionUniqueId = {
  prefix?: string | null;
  number: number;
};

export type NotionPropertyValue = {
  id: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: NotionSelectOption | null;
  status?: NotionSelectOption | null;
  multi_select?: NotionSelectOption[];
  number?: number | null;
  checkbox?: boolean;
  date?: NotionDateValue | null;
  people?: NotionPerson[];
  relation?: Array<{ id: string }>;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  unique_id?: NotionUniqueId | null;
};

export type NotionPage = {
  object: "page";
  id: string;
  archived: boolean;
  in_trash?: boolean;
  created_time: string;
  last_edited_time: string;
  url?: string;
  properties: Record<string, NotionPropertyValue>;
};

export type NotionBlockPayload = {
  rich_text?: NotionRichText[];
  checked?: boolean;
  language?: string;
  title?: string;
  external?: { url?: string };
  file?: { url?: string };
  url?: string;
  caption?: NotionRichText[];
  expression?: string;
  cells?: NotionRichText[][];
};

export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
} & Record<string, unknown>;

export type NotionListResponse<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export function plainText(rich: NotionRichText[] | undefined): string {
  return (rich ?? [])
    .map((part) => part.plain_text)
    .join("")
    .trim();
}

export function blockPayload(block: NotionBlock): NotionBlockPayload {
  const payload = block[block.type];
  return typeof payload === "object" && payload !== null
    ? (payload as NotionBlockPayload)
    : {};
}
