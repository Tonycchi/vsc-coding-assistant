import {
  WorkspaceDiscovery,
  type WorkspaceDirectoryEntry,
} from '../../src/tools/workspaceDiscovery';

const tree: Record<string, WorkspaceDirectoryEntry[]> = {
  '': [
    { name: 'src', kind: 'directory' },
    { name: 'node_modules', kind: 'directory' },
    { name: 'test.ts', kind: 'file' },
    { name: '.git', kind: 'directory' },
    { name: 'a.ts', kind: 'file' },
    { name: 'linked', kind: 'unsupported' },
    { name: 'bad/name', kind: 'file' },
  ],
  src: [
    { name: 'xyz.ts', kind: 'file' },
    { name: 'test.ts', kind: 'file' },
    { name: 'nested', kind: 'directory' },
  ],
  'src/nested': [{ name: 'test.ts', kind: 'file' }],
};

function discovery(limits?: ConstructorParameters<typeof WorkspaceDiscovery>[1]) {
  const readDirectory = jest.fn(async (components: readonly string[]) => {
    const entries = tree[components.join('/')];
    if (!entries) {
      throw new Error('Directory not found.');
    }
    return entries;
  });
  return { tools: new WorkspaceDiscovery({ readDirectory }, limits), readDirectory };
}

describe('workspace discovery', () => {
  it('lists the selected directory in stable order and excludes unsupported entries', async () => {
    const { tools } = discovery();
    await expect(tools.listDirectory()).resolves.toEqual({
      entries: [
        { path: 'a.ts', kind: 'file' },
        { path: 'src', kind: 'directory' },
        { path: 'test.ts', kind: 'file' },
      ],
      truncated: false,
    });
    await expect(tools.listDirectory('src')).resolves.toEqual({
      entries: [
        { path: 'src/nested', kind: 'directory' },
        { path: 'src/test.ts', kind: 'file' },
        { path: 'src/xyz.ts', kind: 'file' },
      ],
      truncated: false,
    });
  });

  it('finds a name at any depth without visiting excluded or symbolic directories', async () => {
    const { tools, readDirectory } = discovery();
    await expect(tools.searchFiles('test.ts')).resolves.toEqual({
      entries: ['test.ts', 'src/test.ts', 'src/nested/test.ts'].map((path) => ({
        path,
        kind: 'file',
      })),
      truncated: false,
    });
    expect(readDirectory.mock.calls).toEqual([
      [[], 20_000],
      [['src'], 19_993],
      [['src', 'nested'], 19_990],
    ]);
  });

  it('supports single-character and recursive glob matching', async () => {
    const { tools } = discovery();
    const result = await tools.searchFiles('src/**/t?st.*');
    expect(result.entries.map(({ path }) => path)).toEqual(['src/test.ts', 'src/nested/test.ts']);
    await expect(tools.searchFiles('**/*.ts')).resolves.toMatchObject({ truncated: false });
    await expect(tools.searchFiles('missing.*')).resolves.toEqual({
      entries: [],
      truncated: false,
    });
  });

  it('reports an incomplete result when a result or scan limit is reached', async () => {
    const resultLimited = discovery({
      maxResults: 2,
      maxEntriesScanned: 100,
      maxDirectoriesScanned: 100,
    }).tools;
    await expect(resultLimited.listDirectory()).resolves.toMatchObject({ truncated: true });
    await expect(resultLimited.searchFiles('test.ts')).resolves.toMatchObject({ truncated: true });
    const directoryLimited = discovery({
      maxResults: 10,
      maxEntriesScanned: 100,
      maxDirectoriesScanned: 1,
    }).tools;
    await expect(directoryLimited.searchFiles('test.ts')).resolves.toEqual({
      entries: [{ path: 'test.ts', kind: 'file' }],
      truncated: true,
    });
    const entryLimited = discovery({
      maxResults: 10,
      maxEntriesScanned: 1,
      maxDirectoriesScanned: 100,
    }).tools;
    await expect(entryLimited.searchFiles('test.ts')).resolves.toEqual({
      entries: [],
      truncated: true,
    });
  });

  it('does not copy or sort a directory that does not fit the remaining budget', async () => {
    const entries = tree['src'] ?? [];
    const iterator = jest.spyOn(entries, Symbol.iterator);
    const tools = new WorkspaceDiscovery(
      { readDirectory: async () => entries },
      { maxResults: 10, maxEntriesScanned: 2, maxDirectoriesScanned: 10 }
    );

    try {
      await expect(tools.listDirectory()).resolves.toEqual({ entries: [], truncated: true });
      await expect(tools.searchFiles('*.ts')).resolves.toEqual({ entries: [], truncated: true });
      expect(iterator).not.toHaveBeenCalled();
    } finally {
      iterator.mockRestore();
    }
  });

  it('keeps matches and stops before opening another directory when the entry budget is exhausted', async () => {
    const { tools, readDirectory } = discovery({
      maxResults: 10,
      maxEntriesScanned: 7,
      maxDirectoriesScanned: 10,
    });

    await expect(tools.searchFiles('test.ts')).resolves.toEqual({
      entries: [{ path: 'test.ts', kind: 'file' }],
      truncated: true,
    });
    expect(readDirectory.mock.calls).toEqual([[[], 7]]);
  });

  it('does not mark a fully scanned exact result limit as truncated', async () => {
    const { tools } = discovery({
      maxResults: 3,
      maxEntriesScanned: 100,
      maxDirectoriesScanned: 100,
    });
    await expect(tools.searchFiles('test.ts')).resolves.toMatchObject({ truncated: false });
  });

  it.each(['..', '../src', '/tmp', 'src/../tests', 'src//nested', 'C:/tmp', 'src\\nested'])(
    'rejects non-relative or ambiguous input %s without enumeration',
    async (path) => {
      const { tools, readDirectory } = discovery();
      await expect(tools.listDirectory(path)).rejects.toThrow('workspace-relative');
      await expect(tools.searchFiles(path)).rejects.toThrow('workspace-relative');
      expect(readDirectory).not.toHaveBeenCalled();
    }
  );

  it('rejects excluded paths, missing directories, and an unavailable workspace', async () => {
    const { tools } = discovery();
    await expect(tools.listDirectory('.git')).rejects.toThrow('excluded');
    await expect(tools.listDirectory('missing')).rejects.toThrow('not found');
    await expect(new WorkspaceDiscovery(undefined).searchFiles('*.ts')).rejects.toThrow(
      'Open a workspace folder'
    );
  });
});
