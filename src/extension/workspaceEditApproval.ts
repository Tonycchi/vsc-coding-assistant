import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as vscode from 'vscode';

import { loadMacWorkspaceAccess } from '../context/macWorkspaceAccess';
import { MAX_WORKSPACE_READ_BYTES } from '../tools/readFile';
import { WorkspaceEditApproval, type WorkspaceFileWriter } from '../tools/workspaceEditApproval';
import { isWorkspaceEditPath } from '../tools/workspaceEditPreview';
import { createWorkspaceFileReader } from './workspaceFileReader';

export function createWorkspaceFileWriter(
  folder: Pick<vscode.WorkspaceFolder, 'uri'>
): WorkspaceFileWriter | undefined {
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

    return async (relative, before, after) => {
      if (
        typeof relative !== 'string' ||
        !isWorkspaceEditPath(relative) ||
        (before !== null && before.byteLength > MAX_WORKSPACE_READ_BYTES) ||
        after.byteLength > MAX_WORKSPACE_READ_BYTES
      ) {
        throw new Error('Provide a bounded edit for a workspace-relative file.');
      }
      return mac.applyWorkspaceFile(
        workspacePath,
        stat.dev,
        stat.ino,
        relative,
        before === null ? null : Buffer.from(before),
        Buffer.from(after)
      );
    };
  } catch {
    return undefined;
  }
}

export function createWorkspaceEditApproval(
  folder: vscode.WorkspaceFolder
): WorkspaceEditApproval | undefined {
  const write = createWorkspaceFileWriter(folder);
  return (
    write &&
    new WorkspaceEditApproval(createWorkspaceFileReader(folder, { requireExactPath: true }), write)
  );
}
