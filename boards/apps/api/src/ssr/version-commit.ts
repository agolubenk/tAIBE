// TB-98: a version is signed with the commit its files were read at. Files of
// one entity from different checkouts fall back to the sync's own commit.
export function versionCommit(
  files: Array<{ commitSha?: string }>,
  syncCommit: string,
): string {
  const [first, ...rest] = files.map((file) => file.commitSha ?? syncCommit);
  return first !== undefined && rest.every((commit) => commit === first)
    ? first
    : syncCommit;
}
