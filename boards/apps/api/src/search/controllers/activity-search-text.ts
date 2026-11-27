import { type SQL, sql } from "drizzle-orm";
import { activityTable } from "../../database/schema";

const value = (key: string, fallback = "") =>
  sql`coalesce(${activityTable.eventData} ->> ${key}, ${fallback})`;

// The words of getActivitySearchContent, with the values as `->>` gives them:
// not escaped, in their stored case. ILIKE ignores case and a query word has
// no white space, so each word of the shown text is in this text. Both
// branches of an event that has two are in it.
const eventTemplate = sql`CASE ${activityTable.type}
  WHEN 'status_changed' THEN 'changed status from ' || ${value("oldStatus")} || ' to ' || ${value("newStatus")}
  WHEN 'priority_changed' THEN 'changed priority from ' || ${value("oldPriority")} || ' to ' || ${value("newPriority")}
  WHEN 'unassigned' THEN 'unassigned the task'
  WHEN 'assignee_changed' THEN 'assigned the task to themselves ' || ${value("newAssignee", "someone")}
  WHEN 'due_date_changed' THEN 'cleared the due date set due date to changed due date from ' || ${value("oldDueDate")} || ' to ' || ${value("newDueDate")}
  WHEN 'title_changed' THEN 'changed title from "' || ${value("oldTitle")} || '" to "' || ${value("newTitle")} || '"'
  WHEN 'task' THEN 'created the task'
  ELSE ''
END`;

/**
 * TB-197: the text of an activity that the SQL filter of global search
 * matches. An activity with no text of its own shows its rendered event
 * (getActivitySearchContent), so the filter reads the template words and the
 * values of that event. Before, it read only `CAST(eventData AS text)`: that
 * text has no template words ("changed status from") and escapes quotes and
 * backslashes, so a word of the shown text found nothing. The JSON text
 * stays, so the owner finds all it found before; a caller with a token is
 * checked again on the shown text (TB-191). Keep the template in step with
 * getActivitySearchContent: `search-activity-text.test.ts` searches each
 * word of each rendered event.
 */
export const searchableActivityText: SQL<string> = sql<string>`CASE
  WHEN COALESCE(${activityTable.content}, '') <> '' THEN ${activityTable.content}
  WHEN jsonb_typeof(${activityTable.eventData}) = 'object' THEN ${eventTemplate} || ' ' || CAST(${activityTable.eventData} AS text)
  ELSE COALESCE(CAST(${activityTable.eventData} AS text), '')
END`;
