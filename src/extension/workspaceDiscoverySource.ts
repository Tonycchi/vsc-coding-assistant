import * as vscode from 'vscode';
import {
  WorkspaceDiscovery,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectorySource,
  type WorkspaceEntryKind,
} from '../tools/workspaceDiscovery';

function entryKind(type: vscode.FileType): WorkspaceEntryKind {
  if (type === vscode.FileType.File) {
    return 'file';
  }
  if (type === vscode.FileType.Directory) {
    return 'directory';
  }
  return 'unsupported';
}

class VSCodeWorkspaceDirectorySource implements WorkspaceDirectorySource {
  constructor(
    private readonly root: vscode.Uri,
    private readonly fileSystem: Pick<vscode.FileSystem, 'stat' | 'readDirectory'>
  ) {}

  async readDirectory(
    components: readonly string[],
    maxEntries: number
  ): Promise<WorkspaceDirectoryEntry[] | undefined> {
    const path = components.join('/') || '.';
    let directory = this.root;
    for (const component of components) {
      directory = vscode.Uri.joinPath(directory, component);
      const { type } = await this.withDirectoryError(path, () => this.fileSystem.stat(directory));
      if (entryKind(type) !== 'directory') {
        throw new Error(`Not a workspace directory: ${path}`);
      }
    }

    const entries = await this.withDirectoryError(path, () =>
      this.fileSystem.readDirectory(directory)
    );
    // VS Code returns the entire directory in one array. Check the length before mapping it.
    if (entries.length > maxEntries) {
      return undefined;
    }
    return entries.map(([name, type]) => ({ name, kind: entryKind(type) }));
  }

  private async withDirectoryError<T>(path: string, operation: () => Thenable<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        throw new Error(`Workspace directory not found: ${path}`, { cause: error });
      }
      throw new Error(`Could not list workspace directory: ${path}`, { cause: error });
    }
  }
}

export function createWorkspaceDiscovery(
  workspaceFolder: Pick<vscode.WorkspaceFolder, 'uri'> | undefined,
  fileSystem: Pick<vscode.FileSystem, 'stat' | 'readDirectory'> = vscode.workspace.fs
): WorkspaceDiscovery {
  return new WorkspaceDiscovery(
    workspaceFolder
      ? new VSCodeWorkspaceDirectorySource(workspaceFolder.uri, fileSystem)
      : undefined
  );
}
