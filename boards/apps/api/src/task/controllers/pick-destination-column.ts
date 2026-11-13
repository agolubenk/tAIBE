// Where a card moved to another project lands: the requested column, else the
// column with the card's current slug, else the first one. `columns` are in
// board order. The move route and the agent guard share this, so the guard
// judges the column the move writes (TB-82). `undefined`: the requested
// column is not in the project, or the project has no columns.
export function pickDestinationColumn<T extends { slug: string }>(
  columns: readonly T[],
  currentStatus: string,
  requestedStatus?: string,
): T | undefined {
  if (requestedStatus) {
    return columns.find((column) => column.slug === requestedStatus);
  }
  return columns.find((column) => column.slug === currentStatus) ?? columns[0];
}
