import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { createWorkspaceTextSearch } from '../../src/extension/workspaceTextSearch';

jest.mock(
  'vscode',
  () => ({
    FileType: { File: 1, Directory: 2 },
    Uri: {
      joinPath: (uri: vscode.Uri, relativePath: string) => ({
        scheme: uri.scheme,
        fsPath: path.join(uri.fsPath, relativePath),
      }),
    },
    workspace: { fs: { readDirectory: jest.fn(), stat: jest.fn() } },
  }),
  { virtual: true }
);

const readDirectory = jest.mocked(vscode.workspace.fs.readDirectory);

beforeEach(() => {
  readDirectory.mockReset();
});

it('rejects virtual workspaces before enumerating their files', async () => {
  const workspace = {
    uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
  } as vscode.WorkspaceFolder;

  await expect(createWorkspaceTextSearch(workspace)('needle')).rejects.toThrow(
    'does not support safe workspace text search'
  );
  expect(readDirectory).not.toHaveBeenCalled();
});

const itOnLocalPlatform = ['darwin', 'linux'].includes(process.platform) ? it : it.skip;

itOnLocalPlatform(
  'finds literal text from discovered files using the verified reader',
  async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(process.cwd(), '.workspace-text-search-test-')
    );
    const uri = { scheme: 'file', fsPath: workspaceRoot };
    const workspace = { uri } as vscode.WorkspaceFolder;
    try {
      await fs.writeFile(path.join(workspaceRoot, 'example.txt'), 'intro\nneedle\n');
      readDirectory.mockResolvedValue([
        ['example.txt', vscode.FileType.File],
        ['gone.txt', vscode.FileType.File],
      ]);

      await expect(createWorkspaceTextSearch(workspace)('needle')).resolves.toEqual({
        matches: [{ path: 'example.txt', line: 2, snippet: 'needle' }],
        truncated: false,
        skippedFiles: 1,
      });
      expect(readDirectory).toHaveBeenCalledWith(uri);
      expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
);
