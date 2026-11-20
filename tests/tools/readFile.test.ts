import {
  MAX_WORKSPACE_READ_BYTES,
  readFile,
  type WorkspaceFileRead,
  type WorkspaceFileReader,
} from '../../src/tools/readFile';

function mockReader(result: WorkspaceFileRead) {
  return jest
    .fn<ReturnType<WorkspaceFileReader>, Parameters<WorkspaceFileReader>>()
    .mockResolvedValue(result);
}

describe('readFile', () => {
  it('reads workspace text with an explicit byte limit', async () => {
    const reader = mockReader({
      kind: 'file',
      bytes: Buffer.from('const answer = 42;\n'),
      truncated: false,
    });

    await expect(readFile('src/answer.ts', reader)).resolves.toEqual({
      path: 'src/answer.ts',
      content: 'const answer = 42;\n',
      truncated: false,
    });
    expect(reader).toHaveBeenCalledWith('src/answer.ts', MAX_WORKSPACE_READ_BYTES);
  });

  it('reports truncation and drops a UTF-8 character cut off at the byte limit', async () => {
    const bytes = Buffer.alloc(MAX_WORKSPACE_READ_BYTES, 'a');
    bytes[bytes.length - 1] = 0xe2;
    const reader = mockReader({ kind: 'file', bytes, truncated: true });

    await expect(readFile('README.md', reader)).resolves.toEqual({
      path: 'README.md',
      content: 'a'.repeat(MAX_WORKSPACE_READ_BYTES - 1),
      truncated: true,
    });
  });

  it('rejects a reader that returns more than the requested byte limit', async () => {
    const reader = mockReader({
      kind: 'file',
      bytes: Buffer.alloc(MAX_WORKSPACE_READ_BYTES + 1),
      truncated: false,
    });

    await expect(readFile('README.md', reader)).rejects.toThrow('exceeded its byte limit');
  });

  it.each(['', '  ', '/tmp/file', '../file', 'src/../file', 'C:/file', 'C:file', 'a\\b', 'a\0b'])(
    'rejects invalid path %p without calling the reader',
    async (relativePath) => {
      const reader = mockReader({ kind: 'missing' });

      await expect(readFile(relativePath, reader)).rejects.toThrow('workspace-relative file path');
      expect(reader).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing', 'does not exist'],
    ['not-file', 'not a regular file'],
    ['outside-workspace', 'outside the workspace'],
    ['unsupported-filesystem', 'does not support safe workspace file reads'],
    ['unreadable', 'could not be read'],
  ] as const)('reports the reader failure %s clearly', async (kind, message) => {
    const reader = mockReader({ kind });

    await expect(readFile('src/example', reader)).rejects.toThrow(message);
  });

  it.each([
    { bytes: Uint8Array.of(0x00), truncated: false },
    { bytes: Uint8Array.of(0xe2), truncated: false },
    { bytes: Uint8Array.of(0xff), truncated: true },
  ])('rejects unsupported text content (%p)', async ({ bytes, truncated }) => {
    const reader = mockReader({ kind: 'file', bytes, truncated });

    await expect(readFile('data.bin', reader)).rejects.toThrow('not valid UTF-8 text');
  });
});
