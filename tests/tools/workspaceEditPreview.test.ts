import { MAX_WORKSPACE_READ_BYTES, type WorkspaceFileRead } from '../../src/tools/readFile';
import { previewWorkspaceEdits } from '../../src/tools/workspaceEditPreview';

function file(text: string): WorkspaceFileRead {
  return { kind: 'file', bytes: Buffer.from(text), truncated: false };
}

describe('previewWorkspaceEdits', () => {
  it('previews new files, full replacements, and ordered patches in input order', async () => {
    const read = jest.fn(async (path: string): Promise<WorkspaceFileRead> => {
      if (path === 'new.txt') return { kind: 'missing' };
      if (path === 'existing.txt') return file('old\n');
      return file('before\nold target\nafter\n');
    });
    const edits = [
      { kind: 'create', path: 'new.txt', content: 'new\n' },
      { kind: 'replace', path: 'existing.txt', content: 'replacement' },
      {
        kind: 'patch',
        path: 'patch.txt',
        changes: [
          { oldText: 'old target', newText: 'new target' },
          { oldText: 'new target', newText: 'final text' },
        ],
      },
    ];
    const expected = {
      files: [
        {
          path: 'new.txt',
          before: null,
          after: 'new\n',
          diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+new',
        },
        {
          path: 'existing.txt',
          before: 'old\n',
          after: 'replacement',
          diff: '--- a/existing.txt\n+++ b/existing.txt\n@@ -1,1 +1,1 @@\n-old\n+replacement\n\\ No newline at end of file',
        },
        {
          path: 'patch.txt',
          before: 'before\nold target\nafter\n',
          after: 'before\nfinal text\nafter\n',
          diff: '--- a/patch.txt\n+++ b/patch.txt\n@@ -1,3 +1,3 @@\n before\n-old target\n+final text\n after',
        },
      ],
    };

    await expect(previewWorkspaceEdits(edits, read)).resolves.toEqual(expected);
    expect(read.mock.calls).toEqual(
      ['new.txt', 'existing.txt', 'patch.txt'].map((path) => [path, MAX_WORKSPACE_READ_BYTES])
    );
    await expect(previewWorkspaceEdits(edits, read)).resolves.toEqual(expected);
  });

  it.each([
    '/absolute',
    'a/../outside',
    'a//b',
    'a\\b',
    'C:drive',
    'a/.GIT/HEAD',
    'a/file\nname',
    'a/file\u202ename',
    'x'.repeat(1_025),
  ])('rejects invalid path %p before reading', async (path) => {
    const read = jest.fn();
    await expect(
      previewWorkspaceEdits(
        [
          { kind: 'create', path: 'valid.txt', content: '' },
          { kind: 'create', path, content: '' },
        ],
        read
      )
    ).rejects.toThrow('workspace-relative');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a duplicate path even if spelling differs by case or Unicode normalization', async () => {
    const read = jest.fn();
    await expect(
      previewWorkspaceEdits(
        [
          { kind: 'create', path: 'Café.txt', content: '' },
          { kind: 'create', path: 'cafe\u0301.txt', content: '' },
        ],
        read
      )
    ).rejects.toThrow('Multiple edits target');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'missing'],
    ['not-file', 'not a regular file'],
    ['outside-workspace', 'outside the verified workspace'],
    ['unsupported-filesystem', 'does not support verified workspace previews'],
    ['unreadable', 'Unable to verify'],
  ] as const)('handles verified reader failure %s', async (kind, message) => {
    await expect(
      previewWorkspaceEdits(
        [{ kind: 'replace', path: 'file.txt', content: 'after' }],
        async () => ({
          kind,
        })
      )
    ).rejects.toThrow(message);
  });

  it('rejects a creation if its file already exists, even when empty', async () => {
    await expect(
      previewWorkspaceEdits([{ kind: 'create', path: 'file.txt', content: 'text' }], async () =>
        file('')
      )
    ).rejects.toThrow('already exists');
  });

  it.each(['absent', 'aa'])(
    'rejects a patch with absent or overlapping match %p',
    async (oldText) => {
      await expect(
        previewWorkspaceEdits(
          [{ kind: 'patch', path: 'file.txt', changes: [{ oldText, newText: 'new' }] }],
          async () => file('aaa')
        )
      ).rejects.toThrow('no unique match');
    }
  );

  it('rejects replacements and composed patches that exceed the UTF-8 byte limit', async () => {
    const read = jest.fn(async () => file('a'.repeat(MAX_WORKSPACE_READ_BYTES - 1) + 'b'));
    await expect(
      previewWorkspaceEdits(
        [
          {
            kind: 'replace',
            path: 'file.txt',
            content: 'é'.repeat(MAX_WORKSPACE_READ_BYTES / 2 + 1),
          },
        ],
        read
      )
    ).rejects.toThrow('UTF-8 bytes');
    expect(read).not.toHaveBeenCalled();
    await expect(
      previewWorkspaceEdits(
        [{ kind: 'patch', path: 'file.txt', changes: [{ oldText: 'b', newText: 'bb' }] }],
        read
      )
    ).rejects.toThrow('UTF-8 bytes');
  });

  it.each([Buffer.from([0xff]), Buffer.from([0])])(
    'rejects non-text existing files',
    async (bytes) => {
      await expect(
        previewWorkspaceEdits(
          [{ kind: 'replace', path: 'file.txt', content: 'new' }],
          async () => ({
            kind: 'file',
            bytes,
            truncated: false,
          })
        )
      ).rejects.toThrow('not valid UTF-8');
    }
  );

  it('rejects an incomplete before snapshot', async () => {
    await expect(
      previewWorkspaceEdits([{ kind: 'replace', path: 'file.txt', content: 'new' }], async () => ({
        kind: 'file',
        bytes: Buffer.from('prefix'),
        truncated: true,
      }))
    ).rejects.toThrow('preview size limit');
  });

  it('preserves BOM and shows line endings, control characters, and literal escapes distinctly', async () => {
    const before = '\ufefffirst\r\nsecond\\u{9}\n';
    const after = 'first\nsecond\t\n';
    const result = await previewWorkspaceEdits(
      [{ kind: 'replace', path: 'file.txt', content: after }],
      async () => file(before)
    );
    expect(result.files[0]).toEqual({
      path: 'file.txt',
      before,
      after,
      diff: '--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-\\u{feff}first\\u{d}\n-second\\\\u{9}\n+first\n+second\\u{9}',
    });
  });

  it('distinguishes creation of an empty file from a replacement with no changes', async () => {
    await expect(
      previewWorkspaceEdits([{ kind: 'create', path: 'file.txt', content: '' }], async () => ({
        kind: 'missing',
      }))
    ).resolves.toEqual({
      files: [{ path: 'file.txt', before: null, after: '', diff: '--- /dev/null\n+++ b/file.txt' }],
    });
    await expect(
      previewWorkspaceEdits([{ kind: 'replace', path: 'file.txt', content: '' }], async () =>
        file('')
      )
    ).rejects.toThrow('does not change');
  });

  it('caps proposals and the rendered diff', async () => {
    const edits = Array.from({ length: 6 }, (_, index) => ({
      kind: 'create',
      path: `file-${index}.txt`,
      content: '\x01'.repeat(MAX_WORKSPACE_READ_BYTES),
    }));
    const read = jest.fn(async (): Promise<WorkspaceFileRead> => ({ kind: 'missing' }));
    await expect(previewWorkspaceEdits(edits, read)).rejects.toThrow('between 1 and 5');
    expect(read).not.toHaveBeenCalled();
    await expect(previewWorkspaceEdits(edits.slice(0, 5), read)).rejects.toThrow('diff exceeds');
  });
});
