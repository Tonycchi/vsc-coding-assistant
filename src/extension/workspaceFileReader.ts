import * as vscode from 'vscode';

import {
  readWorkspaceFilePrefix,
  readWorkspaceFilePrefixAtPath,
  SecureAttachmentError,
} from '../context';
import type { MacWorkspaceRootIdentity } from '../context/macWorkspaceAccess';
import type { WorkspaceFileReader } from '../tools/readFile';

export function createWorkspaceFileReader(
  workspaceFolder: vscode.WorkspaceFolder,
  {
    requireExactPath = false,
    expectedMacRoot,
  }: {
    requireExactPath?: boolean;
    expectedMacRoot?: MacWorkspaceRootIdentity;
  } = {}
): WorkspaceFileReader {
  return async (relativePath, maxBytes) => {
    if (workspaceFolder.uri.scheme !== 'file') {
      return { kind: 'unsupported-filesystem' };
    }

    try {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
      const result =
        requireExactPath || expectedMacRoot
          ? await readWorkspaceFilePrefixAtPath(
              uri,
              workspaceFolder,
              maxBytes,
              undefined,
              expectedMacRoot
            )
          : await readWorkspaceFilePrefix(uri, workspaceFolder, maxBytes);
      return { kind: 'file', ...result };
    } catch (error) {
      return { kind: error instanceof SecureAttachmentError ? error.code : 'unreadable' };
    }
  };
}
