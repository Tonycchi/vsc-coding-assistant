import * as vscode from 'vscode';

import {
  readWorkspaceFilePrefix,
  readWorkspaceFilePrefixAtPath,
  SecureAttachmentError,
} from '../context';
import type { WorkspaceFileReader } from '../tools/readFile';

export function createWorkspaceFileReader(
  workspaceFolder: vscode.WorkspaceFolder,
  { requireExactPath = false } = {}
): WorkspaceFileReader {
  const readPrefix = requireExactPath ? readWorkspaceFilePrefixAtPath : readWorkspaceFilePrefix;
  return async (relativePath, maxBytes) => {
    if (workspaceFolder.uri.scheme !== 'file') {
      return { kind: 'unsupported-filesystem' };
    }

    try {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
      const result = await readPrefix(uri, workspaceFolder, maxBytes);
      return { kind: 'file', ...result };
    } catch (error) {
      return { kind: error instanceof SecureAttachmentError ? error.code : 'unreadable' };
    }
  };
}
