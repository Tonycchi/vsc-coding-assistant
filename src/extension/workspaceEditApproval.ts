import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as vscode from 'vscode';

import {
  loadMacWorkspaceAccess,
  type MacWorkspaceRootIdentity,
} from '../context/macWorkspaceAccess';
import { MAX_WORKSPACE_READ_BYTES } from '../tools/readFile';
import { WorkspaceEditApproval, type WorkspaceFileWriter } from '../tools/workspaceEditApproval';
import { isWorkspaceEditPath } from '../tools/workspaceEditPreview';
import { createWorkspaceFileReader } from './workspaceFileReader';

interface PinnedWorkspaceWriter {
  expectedMacRoot: MacWorkspaceRootIdentity;
  isWorkspaceCurrent(): boolean;
  write: WorkspaceFileWriter;
}

type CanWriteWorkspaceFile = (relativePath: string) => boolean;

type ScopedWorkspaceEditApproval = WorkspaceEditApproval &
  Pick<PinnedWorkspaceWriter, 'expectedMacRoot' | 'isWorkspaceCurrent'>;

function createPinnedWorkspaceWriter(
  folder: Pick<vscode.WorkspaceFolder, 'uri'>,
  canWrite?: CanWriteWorkspaceFile
): PinnedWorkspaceWriter | undefined {
  if (process.platform !== 'darwin' || folder.uri.scheme !== 'file') {
    return undefined;
  }

  try {
    const workspacePath = realpathSync(folder.uri.fsPath);
    if (workspacePath.split(path.sep).some((component) => component.toLowerCase() === '.git')) {
      return undefined;
    }
    const stat = statSync(workspacePath, { bigint: true });
    if (!stat.isDirectory()) {
      return undefined;
    }
    const mac = loadMacWorkspaceAccess();
    if (typeof mac.applyWorkspaceFile !== 'function') {
      return undefined;
    }

    const expectedMacRoot = Object.freeze({
      path: workspacePath,
      device: stat.dev,
      inode: stat.ino,
    });
    function isWorkspaceCurrent(): boolean {
      try {
        const currentPath = realpathSync(folder.uri.fsPath);
        if (currentPath !== workspacePath) {
          return false;
        }
        const current = statSync(currentPath, { bigint: true });
        return current.isDirectory() && current.dev === stat.dev && current.ino === stat.ino;
      } catch {
        return false;
      }
    }

    return {
      expectedMacRoot,
      isWorkspaceCurrent,
      async write(relative, before, after) {
        if (
          typeof relative !== 'string' ||
          !isWorkspaceEditPath(relative) ||
          (before !== null && before.byteLength > MAX_WORKSPACE_READ_BYTES) ||
          after.byteLength > MAX_WORKSPACE_READ_BYTES
        ) {
          throw new Error('Provide a bounded edit for a workspace-relative file.');
        }
        if (canWrite && !canWrite(relative)) {
          return 'stale';
        }
        return mac.applyWorkspaceFile(
          workspacePath,
          stat.dev,
          stat.ino,
          relative,
          before === null ? null : Buffer.from(before),
          Buffer.from(after)
        );
      },
    };
  } catch {
    return undefined;
  }
}

export function createWorkspaceFileWriter(
  folder: Pick<vscode.WorkspaceFolder, 'uri'>
): WorkspaceFileWriter | undefined {
  return createPinnedWorkspaceWriter(folder)?.write;
}

export function createWorkspaceEditApproval(
  folder: vscode.WorkspaceFolder,
  canWrite?: CanWriteWorkspaceFile
): ScopedWorkspaceEditApproval | undefined {
  const pinned = createPinnedWorkspaceWriter(folder, canWrite);
  if (!pinned) {
    return undefined;
  }
  const { expectedMacRoot, isWorkspaceCurrent } = pinned;
  const reader = createWorkspaceFileReader(folder, { expectedMacRoot });
  return Object.assign(
    new WorkspaceEditApproval(
      (relativePath, maxBytes) =>
        pinned.isWorkspaceCurrent()
          ? reader(relativePath, maxBytes)
          : Promise.resolve({ kind: 'outside-workspace' }),
      pinned.write
    ),
    { expectedMacRoot, isWorkspaceCurrent }
  );
}
