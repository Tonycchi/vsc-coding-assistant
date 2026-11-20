import type * as vscode from 'vscode';
import { searchWorkspaceText } from '../tools/workspaceTextSearch';
import { createWorkspaceDiscovery } from './workspaceDiscoverySource';
import { createWorkspaceFileReader } from './workspaceFileReader';

export function createWorkspaceTextSearch(workspaceFolder: vscode.WorkspaceFolder) {
  const discovery = createWorkspaceDiscovery(workspaceFolder);
  const reader = createWorkspaceFileReader(workspaceFolder);
  return async (query: string) => {
    if (workspaceFolder.uri.scheme !== 'file') {
      throw new Error('This filesystem does not support safe workspace text search.');
    }
    return searchWorkspaceText(query, discovery, reader);
  };
}
