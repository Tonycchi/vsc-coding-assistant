import type * as vscode from 'vscode';

import {
  collectFileAttachments,
  MAX_FILE_ATTACHMENT_SIZE_BYTES,
  type AttachmentFileSystem,
} from '../../src/context';

function uri(fsPath: string): vscode.Uri {
  return { fsPath } as vscode.Uri;
}

function fileSystem(files: Record<string, string>): AttachmentFileSystem {
  return {
    stat: jest.fn(async ({ fsPath }: vscode.Uri) => ({
      size: new TextEncoder().encode(files[fsPath] ?? '').byteLength,
    })),
    readFile: jest.fn(async ({ fsPath }: vscode.Uri) =>
      new TextEncoder().encode(files[fsPath] ?? '')
    ),
  };
}

describe('collectFileAttachments', () => {
  it('returns selected files with paths, names, content, size, and selection order', async () => {
    const fs = fileSystem({
      '/workspace/src/first.ts': 'const first = 1;',
      '/workspace/README.md': '# Project',
    });

    await expect(
      collectFileAttachments([uri('/workspace/src/first.ts'), uri('/workspace/README.md')], fs)
    ).resolves.toEqual([
      {
        filePath: '/workspace/src/first.ts',
        fileName: 'first.ts',
        fileContent: 'const first = 1;',
        sizeBytes: new TextEncoder().encode('const first = 1;').byteLength,
      },
      {
        filePath: '/workspace/README.md',
        fileName: 'README.md',
        fileContent: '# Project',
        sizeBytes: new TextEncoder().encode('# Project').byteLength,
      },
    ]);
  });

  it('rejects an oversized file before reading its contents', async () => {
    const fs: AttachmentFileSystem = {
      stat: jest.fn().mockResolvedValue({ size: MAX_FILE_ATTACHMENT_SIZE_BYTES + 1 }),
      readFile: jest.fn(),
    };

    await expect(collectFileAttachments([uri('/workspace/large.txt')], fs)).rejects.toThrow(
      'Attached file "large.txt" exceeds the 100000-byte size limit.'
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('rejects a file that grows beyond the limit between stat and read', async () => {
    const fs: AttachmentFileSystem = {
      stat: jest.fn().mockResolvedValue({ size: 2 }),
      readFile: jest.fn().mockResolvedValue(new Uint8Array(MAX_FILE_ATTACHMENT_SIZE_BYTES + 1)),
    };

    await expect(collectFileAttachments([uri('/workspace/changing.txt')], fs)).rejects.toThrow(
      'Attached file "changing.txt" exceeds the 100000-byte size limit.'
    );
  });

  it('reports inaccessible files without exposing filesystem errors', async () => {
    const fs: AttachmentFileSystem = {
      stat: jest.fn().mockRejectedValue(new Error('private path detail')),
      readFile: jest.fn(),
    };

    await expect(collectFileAttachments([uri('/workspace/secret.txt')], fs)).rejects.toThrow(
      'Unable to inspect attached file "secret.txt".'
    );
  });

  it('rejects non-UTF-8 content as a text file error', async () => {
    const fs: AttachmentFileSystem = {
      stat: jest.fn().mockResolvedValue({ size: 2 }),
      readFile: jest.fn().mockResolvedValue(new Uint8Array([0xc3, 0x28])),
    };

    await expect(collectFileAttachments([uri('/workspace/binary.bin')], fs)).rejects.toThrow(
      'Attached file "binary.bin" is not valid UTF-8 text.'
    );
  });
});
