import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';

import { createWorkspaceFileReader } from '../../src/extension/workspaceFileReader';
import { MAX_WORKSPACE_READ_BYTES, readFile } from '../../src/tools/readFile';

jest.mock(
  'vscode',
  () => ({
    Uri: {
      joinPath: (uri: vscode.Uri, relativePath: string) => ({
        scheme: uri.scheme,
        fsPath: path.join(uri.fsPath, relativePath),
      }),
    },
  }),
  { virtual: true }
);

const localDescribe = ['darwin', 'linux'].includes(process.platform) ? describe : describe.skip;

localDescribe('VS Code workspace file reader', () => {
  let workspaceRoot: string;
  let workspace: vscode.WorkspaceFolder;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(process.cwd(), '.workspace-file-reader-test-'));
    workspace = { uri: { scheme: 'file', fsPath: workspaceRoot } } as vscode.WorkspaceFolder;
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each([0, 1])('reads a verified file with %i byte(s) past the limit', async (extraBytes) => {
    const content = 'a'.repeat(MAX_WORKSPACE_READ_BYTES);
    await fs.writeFile(path.join(workspaceRoot, 'file.txt'), content + 'b'.repeat(extraBytes));

    await expect(readFile('file.txt', createWorkspaceFileReader(workspace))).resolves.toEqual({
      path: 'file.txt',
      content,
      truncated: extraBytes > 0,
    });
  });

  it('distinguishes missing files from directories', async () => {
    const reader = createWorkspaceFileReader(workspace);
    await fs.mkdir(path.join(workspaceRoot, 'directory'));

    await expect(readFile('missing.txt', reader)).rejects.toThrow('does not exist');
    await expect(readFile('directory', reader)).rejects.toThrow('not a regular file');
  });
});

it('rejects unsupported VS Code filesystem providers', async () => {
  const remoteWorkspace = {
    uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
  } as vscode.WorkspaceFolder;

  await expect(readFile('file.txt', createWorkspaceFileReader(remoteWorkspace))).rejects.toThrow(
    'does not support safe workspace file reads'
  );
});
