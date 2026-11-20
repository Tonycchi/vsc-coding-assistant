import { isExcludedWorkspaceEntry, workspaceDiscoveryLimits } from './workspaceDiscoveryPolicy';
import { compileWorkspaceGlob } from './workspaceGlob';

export type WorkspaceEntryKind = 'file' | 'directory' | 'unsupported';

export interface WorkspaceDirectoryEntry {
  name: string;
  kind: WorkspaceEntryKind;
}

export interface WorkspaceDirectorySource {
  // Return undefined if the directory exceeds the remaining scan budget.
  readDirectory(
    components: readonly string[],
    maxEntries: number
  ): Promise<readonly WorkspaceDirectoryEntry[] | undefined>;
}

export interface WorkspaceDiscoveryEntry {
  path: string;
  kind: 'file' | 'directory';
}

export interface WorkspaceDiscoveryResult {
  entries: WorkspaceDiscoveryEntry[];
  truncated: boolean;
}

type DiscoveryLimits = typeof workspaceDiscoveryLimits;

const MAX_RELATIVE_PATH_LENGTH = 1_024;
const MAX_PATTERN_LENGTH = 256;

function isPathComponent(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_RELATIVE_PATH_LENGTH &&
    !name.endsWith('.') &&
    !name.endsWith(' ') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes(':') &&
    !name.includes('\0')
  );
}

function sortByName(a: WorkspaceDirectoryEntry, b: WorkspaceDirectoryEntry): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

function getDirectoryComponents(path: string): string[] {
  if (path === '.') {
    return [];
  }
  const components = path.split('/');
  if (path.length > MAX_RELATIVE_PATH_LENGTH || components.some((name) => !isPathComponent(name))) {
    throw new Error('Use a workspace-relative directory path, or "." for the workspace root.');
  }
  if (components.some(isExcludedWorkspaceEntry)) {
    throw new Error('This directory is excluded from workspace discovery.');
  }
  return components;
}

export class WorkspaceDiscovery {
  constructor(
    private readonly source: WorkspaceDirectorySource | undefined,
    private readonly limits: DiscoveryLimits = workspaceDiscoveryLimits
  ) {}

  async listDirectory(path = '.'): Promise<WorkspaceDiscoveryResult> {
    const components = getDirectoryComponents(path);
    const entries: WorkspaceDiscoveryEntry[] = [];
    const listing = await this.readDirectory(components, this.limits.maxEntriesScanned);
    if (!listing) {
      return { entries, truncated: true };
    }
    let truncated = false;

    for (const entry of listing) {
      if (!this.isVisible(entry)) {
        continue;
      }
      const path = [...components, entry.name].join('/');
      if (path.length > MAX_RELATIVE_PATH_LENGTH) {
        truncated = true;
        continue;
      }
      if (entries.length === this.limits.maxResults) {
        return { entries, truncated: true };
      }
      entries.push({ path, kind: entry.kind });
    }
    return { entries, truncated };
  }

  async searchFiles(pattern: string): Promise<WorkspaceDiscoveryResult> {
    if (
      pattern.length > MAX_PATTERN_LENGTH ||
      pattern.split('/').some((component) => !isPathComponent(component))
    ) {
      throw new Error('Use a file name or a workspace-relative glob.');
    }
    const matches = compileWorkspaceGlob(pattern);
    const entries: WorkspaceDiscoveryEntry[] = [];
    const directories: string[][] = [[]];
    let remainingEntries = this.limits.maxEntriesScanned;
    let scannedDirectories = 0;
    let truncated = false;

    while (directories.length > 0) {
      if (scannedDirectories === this.limits.maxDirectoriesScanned || remainingEntries === 0) {
        return { entries, truncated: true };
      }
      const components = directories.pop();
      if (!components) {
        break;
      }
      const listing = await this.readDirectory(components, remainingEntries);
      if (!listing) {
        return { entries, truncated: true };
      }
      scannedDirectories++;
      remainingEntries -= listing.length;

      const childDirectories: string[][] = [];
      for (const entry of listing) {
        if (!this.isVisible(entry)) {
          continue;
        }
        const childComponents = [...components, entry.name];
        const path = childComponents.join('/');
        if (path.length > MAX_RELATIVE_PATH_LENGTH) {
          truncated = true;
          continue;
        }
        if (entry.kind === 'directory') {
          childDirectories.push(childComponents);
          continue;
        }
        if (matches(path)) {
          if (entries.length === this.limits.maxResults) {
            return { entries, truncated: true };
          }
          entries.push({ path, kind: 'file' });
        }
      }
      // Stack insertion is reversed so directories are visited by name.
      for (const child of childDirectories.reverse()) {
        directories.push(child);
      }
    }
    return { entries, truncated };
  }

  private async readDirectory(
    components: readonly string[],
    maxEntries: number
  ): Promise<WorkspaceDirectoryEntry[] | undefined> {
    if (!this.source) {
      throw new Error('Open a workspace folder before discovering files.');
    }
    const entries = await this.source.readDirectory(components, maxEntries);
    if (!entries || entries.length > maxEntries) {
      return undefined;
    }
    return [...entries].sort(sortByName);
  }

  private isVisible(entry: WorkspaceDirectoryEntry): entry is WorkspaceDirectoryEntry & {
    kind: 'file' | 'directory';
  } {
    return (
      entry.kind !== 'unsupported' &&
      isPathComponent(entry.name) &&
      !isExcludedWorkspaceEntry(entry.name)
    );
  }
}
