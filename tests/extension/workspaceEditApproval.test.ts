import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';
import {
  createWorkspaceEditApproval,
  createWorkspaceFileWriter,
} from '../../src/extension/workspaceEditApproval';

jest.mock(
  'vscode',
  () => ({
    Uri: {
      joinPath: (uri: vscode.Uri, relative: string) => ({
        scheme: uri.scheme,
        fsPath: path.join(uri.fsPath, relative),
      }),
    },
  }),
  { virtual: true }
);

const supportedDescribe = process.platform === 'darwin' ? describe : describe.skip;

supportedDescribe('workspace file edit adapter', () => {
  let testRoot: string;
  let root: string;
  let folder: vscode.WorkspaceFolder;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(process.cwd(), '.workspace-edit-test-'));
    root = path.join(testRoot, 'workspace');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    folder = { uri: { scheme: 'file', fsPath: root } } as vscode.WorkspaceFolder;
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('applies approved creation and replacement and preserves permission bits', async () => {
    const existing = path.join(root, 'src', 'old.txt');
    const created = path.join(root, 'src', 'new.txt');
    await fs.writeFile(existing, 'before', { mode: 0o751 });
    await fs.chmod(existing, 0o751);

    const approval = createWorkspaceEditApproval(folder)!;
    const proposal = approval.request({
      files: [
        { path: 'src/old.txt', before: 'before', after: 'after', diff: 'old' },
        { path: 'src/new.txt', before: null, after: 'new', diff: 'new' },
      ],
    });
    await expect(fs.stat(created)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(existing, 'utf8')).toBe('before');

    await expect(approval.approve(proposal.id)).resolves.toMatchObject({ status: 'applied' });
    expect(await fs.readFile(existing, 'utf8')).toBe('after');
    expect(await fs.readFile(created, 'utf8')).toBe('new');
    expect((await fs.stat(existing)).mode & 0o777).toBe(0o751);
    expect((await fs.readdir(path.dirname(existing))).sort()).toEqual(['new.txt', 'old.txt']);
  });

  it('validates current bytes and uses exclusive creation', async () => {
    const filePath = path.join(root, 'file.txt');
    await fs.writeFile(filePath, 'current');
    const write = createWorkspaceFileWriter(folder)!;

    await expect(write('file.txt', Buffer.from('earlier'), Buffer.from('edit'))).resolves.toBe(
      'stale'
    );
    await expect(write('file.txt', null, Buffer.from('new'))).resolves.toBe('stale');
    expect(await fs.readFile(filePath, 'utf8')).toBe('current');
    expect((await fs.readdir(root)).sort()).toEqual(['file.txt', 'src']);
  });

  it('requires a verified workspace root and existing parent directory', async () => {
    const write = createWorkspaceFileWriter(folder)!;
    await expect(write('missing/file.txt', null, Buffer.from('edit'))).rejects.toThrow();
    await expect(write('../file.txt', null, Buffer.from('edit'))).rejects.toThrow();
    await fs.rename(root, path.join(testRoot, 'old-workspace'));
    await fs.mkdir(root);
    await expect(write('file.txt', null, Buffer.from('edit'))).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects protected, read-only and linked paths without changing them', async () => {
    const write = createWorkspaceFileWriter(folder)!;
    const existing = path.join(root, 'existing.txt');
    await fs.writeFile(existing, 'before');
    await fs.chmod(existing, 0o444);
    await fs.symlink('src', path.join(root, 'alias'));

    await expect(write('.GIT/config', null, Buffer.from('new'))).rejects.toThrow();
    await expect(write('alias/new.txt', null, Buffer.from('new'))).rejects.toThrow();
    await expect(
      write('existing.txt', Buffer.from('before'), Buffer.from('new'))
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'src'))).toEqual([]);
    expect(await fs.readFile(existing, 'utf8')).toBe('before');
  });

  it('leaves files with extended ACLs or attributes unchanged', async () => {
    const aclPath = path.join(root, 'restricted.txt');
    const attributePath = path.join(root, 'attributes.txt');
    await fs.writeFile(aclPath, 'before');
    await fs.writeFile(attributePath, 'before');
    execFileSync('/bin/chmod', ['+a', 'everyone deny write', aclPath]);
    execFileSync('/usr/bin/xattr', ['-w', 'com.example.keep', 'original', attributePath]);
    const write = createWorkspaceFileWriter(folder)!;

    await expect(
      write('restricted.txt', Buffer.from('before'), Buffer.from('after'))
    ).rejects.toThrow();
    await expect(
      write('attributes.txt', Buffer.from('before'), Buffer.from('after'))
    ).rejects.toThrow();
    expect(await fs.readFile(aclPath, 'utf8')).toBe('before');
    expect(await fs.readFile(attributePath, 'utf8')).toBe('before');
    expect((await fs.readdir(root)).sort()).toEqual(['attributes.txt', 'restricted.txt', 'src']);
  });

  it('rejects creation or replacement when staging would inherit an extended ACL', async () => {
    const directory = path.join(root, 'src');
    const existing = path.join(directory, 'existing.txt');
    await fs.writeFile(existing, 'before');
    execFileSync('/bin/chmod', ['+a', 'everyone allow read,file_inherit,only_inherit', directory]);
    const write = createWorkspaceFileWriter(folder)!;

    await expect(write('src/new.txt', null, Buffer.from('new'))).rejects.toThrow();
    await expect(
      write('src/existing.txt', Buffer.from('before'), Buffer.from('after'))
    ).rejects.toThrow();
    expect(await fs.readFile(existing, 'utf8')).toBe('before');
    expect(await fs.readdir(directory)).toEqual(['existing.txt']);
  });
});

it('does not offer writes for a virtual filesystem', () => {
  const remote = {
    uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
  } as vscode.WorkspaceFolder;
  expect(createWorkspaceEditApproval(remote)).toBeUndefined();
});

(process.platform === 'darwin' ? it.skip : it)('does not offer writes outside macOS', () => {
  const folder = {
    uri: { scheme: 'file', fsPath: process.cwd() },
  } as vscode.WorkspaceFolder;
  expect(createWorkspaceEditApproval(folder)).toBeUndefined();
});
