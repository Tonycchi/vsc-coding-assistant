import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';

import { createWorkspaceEditPreviewer } from '../../src/extension/workspaceEditPreview';

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

localDescribe('VS Code workspace edit previewer', () => {
  let workspaceRoot: string;
  let workspace: vscode.WorkspaceFolder;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(process.cwd(), '.workspace-edit-preview-test-'));
    workspace = { uri: { scheme: 'file', fsPath: workspaceRoot } } as vscode.WorkspaceFolder;
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('previews verified text and new files without changing the workspace', async () => {
    const before = '\ufeffold\r\n';
    const existing = path.join(workspaceRoot, 'existing.txt');
    await fs.writeFile(existing, before);
    await fs.mkdir(path.join(workspaceRoot, 'sub'));
    const preview = createWorkspaceEditPreviewer(workspace);
    const result = await preview([
      { kind: 'replace', path: 'existing.txt', content: 'new\n' },
      { kind: 'create', path: 'sub/new.txt', content: 'created\n' },
    ]);

    expect(result.files.map(({ path, before, after }) => ({ path, before, after }))).toEqual([
      { path: 'existing.txt', before, after: 'new\n' },
      { path: 'sub/new.txt', before: null, after: 'created\n' },
    ]);
    await expect(fs.readFile(existing, 'utf-8')).resolves.toBe(before);
    await expect(fs.readdir(path.join(workspaceRoot, 'sub'))).resolves.toEqual([]);
  });

  it('rejects creation without an existing verified parent directory', async () => {
    await expect(
      createWorkspaceEditPreviewer(workspace)([
        { kind: 'create', path: 'missing/new.txt', content: '' },
      ])
    ).rejects.toThrow('parent directory is missing');
  });
});

it('rejects unsupported filesystem providers', async () => {
  const workspace = {
    uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
  } as vscode.WorkspaceFolder;
  await expect(
    createWorkspaceEditPreviewer(workspace)([{ kind: 'create', path: 'new.txt', content: '' }])
  ).rejects.toThrow('does not support verified workspace previews');
});
