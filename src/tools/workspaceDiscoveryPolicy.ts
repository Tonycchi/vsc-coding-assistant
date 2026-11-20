export const workspaceDiscoveryLimits = {
  maxResults: 200,
  maxEntriesScanned: 20_000,
  maxDirectoriesScanned: 1_000,
};

const excludedNames = new Set(['.git', 'node_modules']);

export function isExcludedWorkspaceEntry(name: string): boolean {
  return excludedNames.has(name.toLowerCase());
}
