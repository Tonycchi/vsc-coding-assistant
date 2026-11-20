import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';

import { loadMacWorkspaceAccess } from '../../src/context/macWorkspaceAccess';
import {
  createVerifiedWorkspaceDiscovery,
  type VerifiedDirectoryDependencies,
} from '../../src/extension/verifiedWorkspaceDiscovery';
import { workspaceDiscoveryLimits } from '../../src/tools/workspaceDiscoveryPolicy';

function workspace(fsPath: string) {
  return { uri: { scheme: 'file', fsPath } as vscode.Uri };
}

function linuxDependencies() {
  const closeRoot = jest.fn().mockResolvedValue(undefined);
  const closeChild = jest.fn().mockResolvedValue(undefined);
  const dependencies: VerifiedDirectoryDependencies = {
    platform: 'linux',
    openDirectory: jest
      .fn()
      .mockResolvedValueOnce({ fd: 10, close: closeRoot })
      .mockResolvedValueOnce({ fd: 20, close: closeChild }),
    realpath: jest
      .fn()
      .mockResolvedValueOnce('/workspace')
      .mockResolvedValueOnce('/workspace')
      .mockResolvedValueOnce('/workspace/src'),
    entries: jest.fn(async function* () {
      yield { name: 'index.ts', kind: 'file' } as const;
      yield { name: 'alias', kind: 'unsupported' } as const;
    }),
    readMacDirectory: jest.fn(),
  };
  return { dependencies, closeRoot, closeChild };
}

describe('verified workspace discovery', () => {
  it('opens Linux path components and enumerates through verified descriptors', async () => {
    const { dependencies, closeRoot, closeChild } = linuxDependencies();
    const discovery = createVerifiedWorkspaceDiscovery(workspace('/workspace'), dependencies);
    await expect(discovery.listDirectory('src')).resolves.toEqual({
      entries: [{ path: 'src/index.ts', kind: 'file' }],
      truncated: false,
    });
    expect(dependencies.openDirectory).toHaveBeenNthCalledWith(1, '/workspace');
    expect(dependencies.openDirectory).toHaveBeenNthCalledWith(2, '/proc/self/fd/10/src');
    expect(dependencies.entries).toHaveBeenCalledWith('/proc/self/fd/20');
    expect(closeRoot).toHaveBeenCalledTimes(1);
    expect(closeChild).toHaveBeenCalledTimes(1);
  });

  it('returns no directory entries if verifying the opened Linux handle fails', async () => {
    const { dependencies, closeRoot, closeChild } = linuxDependencies();
    jest
      .mocked(dependencies.realpath)
      .mockReset()
      .mockResolvedValueOnce('/workspace')
      .mockResolvedValueOnce('/workspace')
      .mockRejectedValueOnce(new Error('Descriptor is unavailable'));
    await expect(
      createVerifiedWorkspaceDiscovery(workspace('/workspace'), dependencies).listDirectory('src')
    ).rejects.toThrow('Unable to enumerate the workspace directory safely.');
    expect(dependencies.entries).not.toHaveBeenCalled();
    expect(closeRoot).toHaveBeenCalledTimes(1);
    expect(closeChild).toHaveBeenCalledTimes(1);
  });

  it('discards an oversized Linux directory after probing one extra entry', async () => {
    const { dependencies, closeRoot } = linuxDependencies();
    let enumerated = 0;
    const maxEntries = workspaceDiscoveryLimits.maxEntriesScanned;
    dependencies.entries = jest.fn(async function* () {
      while (enumerated < maxEntries + 2) {
        enumerated++;
        yield { name: 'file-' + enumerated, kind: 'file' } as const;
      }
    });

    await expect(
      createVerifiedWorkspaceDiscovery(workspace('/workspace'), dependencies).listDirectory()
    ).resolves.toEqual({ entries: [], truncated: true });
    expect(enumerated).toBe(maxEntries + 1);
    expect(closeRoot).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to unverified directory operations on other platforms', async () => {
    const { dependencies } = linuxDependencies();
    dependencies.platform = 'win32';
    await expect(
      createVerifiedWorkspaceDiscovery(workspace('/workspace'), dependencies).listDirectory()
    ).rejects.toThrow('requires a local macOS or Linux workspace');
    expect(dependencies.openDirectory).not.toHaveBeenCalled();
    expect(dependencies.readMacDirectory).not.toHaveBeenCalled();
  });
});

const supportedDescribe = ['linux', 'darwin'].includes(process.platform) ? describe : describe.skip;
supportedDescribe('local directory discovery adapters', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(process.cwd(), '.directory-test-'));
    await mkdir(path.join(directory, 'src'));
    await writeFile(path.join(directory, 'src', 'index.ts'), 'export {};');
    await symlink('src', path.join(directory, 'alias'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('lists regular entries and never follows links during path traversal', async () => {
    const discovery = createVerifiedWorkspaceDiscovery(workspace(directory));
    await expect(discovery.listDirectory()).resolves.toEqual({
      entries: [{ path: 'src', kind: 'directory' }],
      truncated: false,
    });
    await expect(discovery.listDirectory('src')).resolves.toEqual({
      entries: [{ path: 'src/index.ts', kind: 'file' }],
      truncated: false,
    });
    await expect(discovery.listDirectory('alias')).rejects.toThrow('Unable to enumerate');
  });

  (process.platform === 'darwin' ? it : it.skip)(
    'discards an oversized native directory listing',
    () => {
      const nativeReader = loadMacWorkspaceAccess();
      expect(nativeReader.readWorkspaceDirectory(directory, '', 1)).toBeUndefined();
      expect(nativeReader.readWorkspaceDirectory(directory, 'src', 1)).toEqual([
        { name: 'index.ts', kind: 'file' },
      ]);
    }
  );
});
