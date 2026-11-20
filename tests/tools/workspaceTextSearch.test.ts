import type { WorkspaceFileRead, WorkspaceFileReader } from '../../src/tools/readFile';
import { WorkspaceDiscovery } from '../../src/tools/workspaceDiscovery';
import { searchWorkspaceText } from '../../src/tools/workspaceTextSearch';

function textFile(content: string, truncated = false): WorkspaceFileRead {
  return { kind: 'file', bytes: Buffer.from(content), truncated };
}

function discover(paths: string[], truncated = false) {
  return {
    searchFiles: jest.fn().mockResolvedValue({
      entries: paths.map((path) => ({ path, kind: 'file' })),
      truncated,
    }),
  };
}

describe('workspace text search', () => {
  it('returns one literal, case-sensitive match per line in discovery order', async () => {
    const discovery = discover(['one.txt', 'nested/two.txt']);
    const read = jest
      .fn<ReturnType<WorkspaceFileReader>, Parameters<WorkspaceFileReader>>()
      .mockResolvedValueOnce(textFile('A+B\r\na+b a+b\ra+b\naxb'))
      .mockResolvedValueOnce(textFile('first\na+b'));

    expect(await searchWorkspaceText('a+b', discovery, read)).toEqual({
      matches: [
        { path: 'one.txt', line: 2, snippet: 'a+b a+b' },
        { path: 'one.txt', line: 3, snippet: 'a+b' },
        { path: 'nested/two.txt', line: 2, snippet: 'a+b' },
      ],
      truncated: false,
      skippedFiles: 0,
    });
    expect(discovery.searchFiles).toHaveBeenCalledWith('*');
  });

  it.each(['', 'two\nlines', 'x'.repeat(201)])(
    'rejects an invalid query before discovery',
    async (query) => {
      const discovery = discover([]);
      const read = jest.fn();

      await expect(searchWorkspaceText(query, discovery, read)).rejects.toThrow(
        'single-line text query'
      );
      expect(discovery.searchFiles).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  );

  it('inherits discovery exclusions and does not read unsupported directory entries', async () => {
    const discovery = new WorkspaceDiscovery({
      readDirectory: jest.fn().mockResolvedValue([
        { name: '.git', kind: 'directory' },
        { name: 'node_modules', kind: 'directory' },
        { name: 'local.txt', kind: 'file' },
        { name: 'alias', kind: 'unsupported' },
      ]),
    });
    const read = jest.fn().mockResolvedValue(textFile('different text'));

    expect(await searchWorkspaceText('needle', discovery, read)).toEqual({
      matches: [],
      truncated: false,
      skippedFiles: 0,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('local.txt', 100_000);
  });

  it('counts unreadable and non-text files while continuing with available text', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unreadable' })
      .mockResolvedValueOnce(textFile('binary\0'))
      .mockResolvedValueOnce({ kind: 'file', bytes: Uint8Array.of(0xff), truncated: false })
      .mockResolvedValueOnce(textFile('needle'));

    expect(await searchWorkspaceText('needle', discover(['a', 'b', 'c', 'd']), read)).toEqual({
      matches: [{ path: 'd', line: 1, snippet: 'needle' }],
      truncated: false,
      skippedFiles: 3,
    });
  });

  it('surfaces unsupported filesystem errors', async () => {
    const read = jest.fn().mockResolvedValue({ kind: 'unsupported-filesystem' });

    await expect(searchWorkspaceText('needle', discover(['a']), read)).rejects.toThrow(
      'does not support safe workspace text search'
    );
  });

  it('caps results and keeps matches visible when clipping long lines', async () => {
    const longLine = 'a'.repeat(316) + 'needle' + '😀'.repeat(205);
    const read = jest
      .fn()
      .mockResolvedValue(textFile([longLine, ...Array(200).fill('needle')].join('\n')));

    const result = await searchWorkspaceText('needle', discover(['a']), read);
    expect(result.matches).toHaveLength(200);
    expect(result.truncated).toBe(true);
    const snippet = result.matches[0]?.snippet ?? '';
    expect(snippet.length).toBeLessThanOrEqual(300);
    expect(snippet).toMatch(/^….*needle.*…$/u);
    expect(Buffer.from(snippet).toString()).toBe(snippet);
  });

  it('reports truncation from discovery and discards an incomplete trailing UTF-8 sequence', async () => {
    const read = jest.fn().mockResolvedValue({
      kind: 'file',
      bytes: Buffer.concat([Buffer.from('needle'), Buffer.from([0xf0, 0x9f])]),
      truncated: true,
    });

    expect(await searchWorkspaceText('needle', discover(['a']), read)).toEqual({
      matches: [{ path: 'a', line: 1, snippet: 'needle' }],
      truncated: true,
      skippedFiles: 0,
    });
    expect(await searchWorkspaceText('needle', discover([], true), read)).toEqual({
      matches: [],
      truncated: true,
      skippedFiles: 0,
    });
  });

  it('bounds aggregate reads including one probe byte per truncated file', async () => {
    const files = Array.from({ length: 12 }, (_, index) => `file-${index}`);
    const read = jest.fn<ReturnType<WorkspaceFileReader>, Parameters<WorkspaceFileReader>>(
      async (_path, maxBytes) => ({
        kind: 'file',
        bytes: Buffer.alloc(maxBytes, 'x'),
        truncated: true,
      })
    );

    const result = await searchWorkspaceText('needle', discover(files), read);
    expect(result).toEqual({ matches: [], truncated: true, skippedFiles: 0 });
    expect(read).toHaveBeenCalledTimes(10);
    expect(read.mock.calls[9]).toEqual(['file-9', 99_990]);
    expect(read.mock.calls.reduce((total, [, maxBytes]) => total + maxBytes + 1, 0)).toBe(
      1_000_000
    );
  });

  it('rejects a reader that exceeds the requested byte limit', async () => {
    const read = jest.fn().mockResolvedValue(textFile('x'.repeat(100_001)));

    await expect(searchWorkspaceText('needle', discover(['a']), read)).rejects.toThrow(
      'reader exceeded its byte limit'
    );
  });
});
