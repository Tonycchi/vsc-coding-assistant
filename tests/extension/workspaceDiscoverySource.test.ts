import * as vscode from 'vscode';
import { createWorkspaceDiscovery } from '../../src/extension/workspaceDiscoverySource';
import { workspaceDiscoveryLimits } from '../../src/tools/workspaceDiscoveryPolicy';

jest.mock(
  'vscode',
  () => ({
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    FileSystemError: class extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    },
    Uri: {
      joinPath: (parent: { path: string }, name: string) => ({ path: `${parent.path}/${name}` }),
    },
  }),
  { virtual: true }
);

const folder = { uri: { path: '/workspace' } as vscode.Uri };

describe('VS Code workspace discovery source', () => {
  it('queries nested directories under the selected workspace URI', async () => {
    const readDirectory = jest.fn(async (): Promise<[string, vscode.FileType][]> => [['x.ts', 1]]);
    const stat = jest.fn(async () => ({ type: 2, size: 0, mtime: 0, ctime: 0 }));
    const discovery = createWorkspaceDiscovery(folder, { stat, readDirectory });

    await expect(discovery.listDirectory('src/lib')).resolves.toEqual({
      entries: [{ path: 'src/lib/x.ts', kind: 'file' }],
      truncated: false,
    });
    expect(stat).toHaveBeenNthCalledWith(1, { path: '/workspace/src' });
    expect(stat).toHaveBeenNthCalledWith(2, { path: '/workspace/src/lib' });
    expect(readDirectory).toHaveBeenCalledWith({ path: '/workspace/src/lib' });
  });

  it('skips linked entries and refuses to enumerate a selected symbolic directory', async () => {
    const readDirectory = jest.fn(
      async (): Promise<[string, vscode.FileType][]> => [['linked', (2 | 64) as vscode.FileType]]
    );
    const stat = jest.fn(async () => ({
      type: (2 | 64) as vscode.FileType,
      size: 0,
      mtime: 0,
      ctime: 0,
    }));
    const discovery = createWorkspaceDiscovery(folder, { stat, readDirectory });

    await expect(discovery.listDirectory()).resolves.toEqual({ entries: [], truncated: false });
    readDirectory.mockClear();
    await expect(discovery.listDirectory('linked')).rejects.toThrow('Not a workspace directory');
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('does not map an oversized directory returned by VS Code', async () => {
    const entries = new Array<[string, vscode.FileType]>(
      workspaceDiscoveryLimits.maxEntriesScanned + 1
    );
    const map = jest.spyOn(entries, 'map');
    const readDirectory = jest.fn(async () => entries);
    const stat = jest.fn();
    const discovery = createWorkspaceDiscovery(folder, { stat, readDirectory });

    await expect(discovery.listDirectory()).resolves.toEqual({ entries: [], truncated: true });
    expect(map).not.toHaveBeenCalled();
  });

  it('adds workspace-relative context to missing-directory errors', async () => {
    const readDirectory = jest.fn();
    const stat = jest.fn(async () => {
      throw new vscode.FileSystemError('FileNotFound');
    });
    const discovery = createWorkspaceDiscovery(folder, { stat, readDirectory });

    await expect(discovery.listDirectory('missing')).rejects.toThrow(
      'Workspace directory not found: missing'
    );
  });
});
