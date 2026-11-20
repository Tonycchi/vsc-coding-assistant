import * as vscode from 'vscode';

import type { RepositoryTool } from '../services/streamRepositoryTools';
import { readFile } from '../tools/readFile';
import { createVerifiedWorkspaceDiscovery } from './verifiedWorkspaceDiscovery';
import { createWorkspaceFileReader } from './workspaceFileReader';
import { createWorkspaceTextSearch } from './workspaceTextSearch';

interface StringToolOptions {
  name: string;
  description: string;
  argument: string;
  argumentDescription: string;
  run(value: string): Promise<unknown>;
}

function stringTool(options: StringToolOptions): RepositoryTool {
  return {
    definition: {
      name: options.name,
      description: options.description,
      parameters: {
        type: 'object',
        properties: {
          [options.argument]: { type: 'string', description: options.argumentDescription },
        },
        required: [options.argument],
        additionalProperties: false,
      },
    },
    async run(args) {
      const value = args[options.argument];
      if (Object.keys(args).length !== 1 || typeof value !== 'string') {
        return { error: 'Provide one string argument named ' + options.argument + '.' };
      }
      try {
        return await options.run(value);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Unable to run the workspace tool.',
        };
      }
    },
  };
}

export function getRepositoryTools(editor: vscode.TextEditor | undefined): RepositoryTool[] {
  if (
    !['linux', 'darwin'].includes(process.platform) ||
    !vscode.workspace.isTrusted ||
    vscode.workspace
      .getConfiguration('vscCodingAssistant')
      .get<boolean>('enableRepositoryTools') !== true
  ) {
    return [];
  }

  const folder = resolveRepositoryWorkspaceFolder(editor);
  if (!folder || folder.uri.scheme !== 'file') {
    return [];
  }

  const reader = createWorkspaceFileReader(folder);
  const discovery = createVerifiedWorkspaceDiscovery(folder);
  return [
    stringTool({
      name: 'read_file',
      description: 'Read a UTF-8 text file in the active workspace. The result can be truncated.',
      argument: 'path',
      argumentDescription: 'Workspace-relative file path',
      run: (path) => readFile(path, reader),
    }),
    stringTool({
      name: 'list_directory',
      description: 'List visible files and subdirectories in a workspace directory.',
      argument: 'path',
      argumentDescription: 'Workspace-relative directory path, or . for the workspace root',
      run: (path) => discovery.listDirectory(path),
    }),
    stringTool({
      name: 'search_files',
      description: 'Find visible workspace files by exact name or glob.',
      argument: 'pattern',
      argumentDescription: 'A file name or workspace-relative glob',
      run: (pattern) => discovery.searchFiles(pattern),
    }),
    stringTool({
      name: 'search_text',
      description: 'Find literal text in visible workspace files and return matching lines.',
      argument: 'query',
      argumentDescription: 'Case-sensitive text to find, without line breaks',
      run: createWorkspaceTextSearch(folder, discovery),
    }),
  ];
}

export function resolveRepositoryWorkspaceFolder(
  editor: vscode.TextEditor | undefined
): vscode.WorkspaceFolder | undefined {
  const activeUri = editor?.document.uri;
  const folders = vscode.workspace.workspaceFolders ?? [];
  return (
    (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) ??
    (folders.length === 1 ? folders[0] : undefined)
  );
}
