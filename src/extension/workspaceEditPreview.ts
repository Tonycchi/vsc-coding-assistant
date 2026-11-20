import type * as vscode from 'vscode';

import { previewWorkspaceEdits, type WorkspaceEditPreview } from '../tools/workspaceEditPreview';
import { createVerifiedWorkspaceDirectorySource } from './verifiedWorkspaceDiscovery';
import { createWorkspaceFileReader } from './workspaceFileReader';

export function createWorkspaceEditPreviewer(
  workspaceFolder: vscode.WorkspaceFolder
): (edits: unknown) => Promise<WorkspaceEditPreview> {
  const reader = createWorkspaceFileReader(workspaceFolder, { requireExactPath: true });
  const directories = createVerifiedWorkspaceDirectorySource(workspaceFolder);

  return (edits) =>
    previewWorkspaceEdits(edits, async (path, maxBytes) => {
      const file = await reader(path, maxBytes);
      if (file.kind === 'missing') {
        try {
          // A missing target can be previewed only under an existing, verified parent.
          await directories.readDirectory(path.split('/').slice(0, -1), 0);
        } catch {
          throw new Error('The target parent directory is missing or could not be verified.');
        }
      }
      return file;
    });
}
