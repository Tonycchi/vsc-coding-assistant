import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type * as vscode from 'vscode';

import { readWorkspaceFileSafely } from '../../src/context';
import { loadMacWorkspaceAccess } from '../../src/context/macWorkspaceAccess';

const nativeReaderPath = path.resolve(
  __dirname,
  '../../native/build/Release/safe_file_reader.node'
);
const requireNativeModule = createRequire(__filename);
const macNativeDescribe = process.platform === 'darwin' ? describe : describe.skip;

macNativeDescribe('macOS native workspace file reader', () => {
  let testRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let workspaceFolder: vscode.WorkspaceFolder;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(process.cwd(), '.mac-file-reader-test-'));
    workspaceRoot = path.join(testRoot, 'workspace');
    outsideRoot = path.join(testRoot, 'outside');
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outsideRoot);
    workspaceFolder = { uri: { scheme: 'file', fsPath: workspaceRoot } } as vscode.WorkspaceFolder;
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('reads a regular workspace file from the compiled native helper', async () => {
    const filePath = path.join(workspaceRoot, 'src', 'example.ts');
    await fs.mkdir(path.dirname(filePath));
    await fs.writeFile(filePath, 'export const safe = true;');

    await expect(
      readWorkspaceFileSafely(
        { scheme: 'file', fsPath: filePath } as vscode.Uri,
        workspaceFolder,
        100
      )
    ).resolves.toEqual(Buffer.from('export const safe = true;'));
  });

  it('rejects a directory symlink that points outside the workspace', async () => {
    const secretPath = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secretPath, 'outside secret');
    await fs.symlink(outsideRoot, path.join(workspaceRoot, 'linked-directory'));

    await expect(
      readWorkspaceFileSafely(
        {
          scheme: 'file',
          fsPath: path.join(workspaceRoot, 'linked-directory', 'secret.txt'),
        } as vscode.Uri,
        workspaceFolder,
        100
      )
    ).rejects.toThrow('The selected file could not be safely read.');
  });

  it('rejects a final file symlink that points outside the workspace', async () => {
    const secretPath = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secretPath, 'outside secret');
    const linkPath = path.join(workspaceRoot, 'secret.txt');
    await fs.symlink(secretPath, linkPath);

    await expect(
      readWorkspaceFileSafely(
        { scheme: 'file', fsPath: linkPath } as vscode.Uri,
        workspaceFolder,
        100
      )
    ).rejects.toThrow('The selected file could not be safely read.');
  });

  it('rejects a relative path that escapes the workspace and enforces the byte limit', async () => {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    await fs.writeFile(outsidePath, 'outside file');
    await expect(
      readWorkspaceFileSafely(
        { scheme: 'file', fsPath: outsidePath } as vscode.Uri,
        workspaceFolder,
        100
      )
    ).rejects.toThrow('The selected file is outside the open workspace.');

    const largePath = path.join(workspaceRoot, 'large.txt');
    await fs.writeFile(largePath, '0123456789');
    await expect(
      readWorkspaceFileSafely(
        { scheme: 'file', fsPath: largePath } as vscode.Uri,
        workspaceFolder,
        8
      )
    ).rejects.toThrow('The selected file could not be safely read.');
  });

  it('rejects a FIFO without blocking while checking the opened file type', async () => {
    const fifoPath = path.join(workspaceRoot, 'pipe');
    execFileSync('mkfifo', [fifoPath]);

    await expect(
      readWorkspaceFileSafely(
        { scheme: 'file', fsPath: fifoPath } as vscode.Uri,
        workspaceFolder,
        100
      )
    ).rejects.toThrow('The selected file could not be safely read.');
  });

  it('rejects malformed native limits and NUL-containing paths', async () => {
    const nativeReader = requireNativeModule(nativeReaderPath) as {
      readWorkspaceFile(root: string, relative: string, byteLimit: number): Uint8Array;
    };

    expect(() => nativeReader.readWorkspaceFile(workspaceRoot, 'file.txt', Number.NaN)).toThrow(
      'Invalid secure file reader arguments.'
    );
    expect(() =>
      nativeReader.readWorkspaceFile(workspaceRoot, 'file.txt', Number.POSITIVE_INFINITY)
    ).toThrow('Invalid secure file reader arguments.');
    expect(() => nativeReader.readWorkspaceFile(workspaceRoot, 'file.txt', 1.5)).toThrow(
      'Invalid secure file reader arguments.'
    );
    expect(() => nativeReader.readWorkspaceFile(workspaceRoot, 'file\0.txt', 100)).toThrow(
      'File paths cannot contain null bytes.'
    );
    expect(() => nativeReader.readWorkspaceFile(workspaceRoot, '../outside/file.txt', 100)).toThrow(
      'The selected file path contains an unsafe component.'
    );
  });

  it('requires the pinned root identity for file reads and parent checks', async () => {
    const native = loadMacWorkspaceAccess();
    const root = await fs.realpath(workspaceRoot);
    const { dev, ino } = await fs.stat(root, { bigint: true });
    await fs.writeFile(path.join(root, 'file.txt'), 'content');
    await fs.mkdir(path.join(root, 'empty'));

    expect(native.readWorkspaceFile(root, 'file.txt', 100, true, dev, ino)).toEqual(
      Buffer.from('content')
    );
    expect(native.readWorkspaceDirectory(root, 'empty', 0, dev, ino)).toEqual([]);

    expect(() => native.readWorkspaceFile(root, 'file.txt', 100, true, dev, ino + 1n)).toThrow(
      'The opened workspace identity changed.'
    );
    expect(() => native.readWorkspaceDirectory(root, 'empty', 0, dev + 1n, ino)).toThrow(
      'The opened workspace identity changed.'
    );
  });

  it('requires the native helper to be present for macOS reads', async () => {
    await expect(fs.access(nativeReaderPath)).resolves.toBeUndefined();
  });
});
