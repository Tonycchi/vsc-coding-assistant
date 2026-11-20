import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';

import {
  loadMacWorkspaceAccess,
  type MacWorkspaceRootIdentity,
} from '../context/macWorkspaceAccess';
import {
  WorkspaceDiscovery,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectorySource,
} from '../tools/workspaceDiscovery';
import { workspaceDiscoveryLimits } from '../tools/workspaceDiscoveryPolicy';

interface DirectoryHandle {
  fd: number;
  close(): PromiseLike<void>;
}

export interface VerifiedDirectoryDependencies {
  platform: string;
  openDirectory(path: string): PromiseLike<DirectoryHandle>;
  realpath(path: string): PromiseLike<string>;
  entries(path: string): AsyncIterable<WorkspaceDirectoryEntry>;
  readMacDirectory(
    root: string,
    relative: string,
    maxEntries: number,
    expectedMacRoot?: MacWorkspaceRootIdentity
  ): WorkspaceDirectoryEntry[] | undefined;
}

const defaults: VerifiedDirectoryDependencies = {
  platform: process.platform,
  openDirectory: (path) =>
    open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  realpath,
  async *entries(path) {
    const directory = await opendir(path);
    for await (const entry of directory) {
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'unsupported';
      yield { name: entry.name, kind };
    }
  },
  readMacDirectory: (root, relative, maxEntries, expectedMacRoot) =>
    expectedMacRoot
      ? loadMacWorkspaceAccess().readWorkspaceDirectory(
          root,
          relative,
          maxEntries,
          expectedMacRoot.device,
          expectedMacRoot.inode
        )
      : loadMacWorkspaceAccess().readWorkspaceDirectory(root, relative, maxEntries),
};

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function descriptorPath(handle: DirectoryHandle): string {
  return '/proc/self/fd/' + handle.fd;
}

async function readLinuxDirectory(
  workspacePath: string,
  components: readonly string[],
  maxEntries: number,
  deps: VerifiedDirectoryDependencies
): Promise<WorkspaceDirectoryEntry[] | undefined> {
  const canonicalRoot = await deps.realpath(workspacePath);
  const root = await deps.openDirectory(canonicalRoot);
  let current = root;
  try {
    for (const component of components) {
      const previous = current;
      current = await deps.openDirectory(descriptorPath(previous) + '/' + component);
      if (previous !== root) {
        await previous.close();
      }
    }

    const openedRoot = await deps.realpath(descriptorPath(root));
    const openedPath = current === root ? openedRoot : await deps.realpath(descriptorPath(current));
    if (openedRoot !== canonicalRoot || !isWithin(openedRoot, openedPath)) {
      throw new Error('The opened directory is outside the workspace.');
    }

    const entries: WorkspaceDirectoryEntry[] = [];
    for await (const entry of deps.entries(descriptorPath(current))) {
      if (entries.length === maxEntries) {
        return undefined;
      }
      entries.push(entry);
    }
    return entries;
  } finally {
    await Promise.all(current === root ? [root.close()] : [root.close(), current.close()]);
  }
}

export function createVerifiedWorkspaceDiscovery(
  folder: Pick<vscode.WorkspaceFolder, 'uri'>,
  deps: VerifiedDirectoryDependencies = defaults
): WorkspaceDiscovery {
  return new WorkspaceDiscovery(createVerifiedWorkspaceDirectorySource(folder, deps));
}

export function createVerifiedWorkspaceDirectorySource(
  folder: Pick<vscode.WorkspaceFolder, 'uri'>,
  deps: VerifiedDirectoryDependencies = defaults,
  expectedMacRoot?: MacWorkspaceRootIdentity
): WorkspaceDirectorySource {
  return {
    async readDirectory(components, maxEntries) {
      if (folder.uri.scheme !== 'file' || !['linux', 'darwin'].includes(deps.platform)) {
        throw new Error('Safe directory discovery requires a local macOS or Linux workspace.');
      }
      if (
        !Number.isSafeInteger(maxEntries) ||
        maxEntries < 0 ||
        maxEntries > workspaceDiscoveryLimits.maxEntriesScanned ||
        components.some(
          (name) =>
            !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')
        )
      ) {
        throw new Error('Provide a safe workspace directory and scan limit.');
      }
      try {
        if (expectedMacRoot) {
          if (deps.platform !== 'darwin') {
            throw new Error('The pinned macOS directory reader is unavailable.');
          }
          return deps.readMacDirectory(
            expectedMacRoot.path,
            components.join('/'),
            maxEntries,
            expectedMacRoot
          );
        }
        return deps.platform === 'linux'
          ? await readLinuxDirectory(folder.uri.fsPath, components, maxEntries, deps)
          : deps.readMacDirectory(folder.uri.fsPath, components.join('/'), maxEntries);
      } catch {
        throw new Error('Unable to enumerate the workspace directory safely.');
      }
    },
  };
}
