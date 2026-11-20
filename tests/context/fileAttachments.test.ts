import type * as vscode from 'vscode';
import { constants } from 'node:fs';

import {
  collectFileAttachments,
  MAX_FILE_ATTACHMENT_SIZE_BYTES,
  readWorkspaceFileSafely,
  SecureAttachmentError,
  type AttachmentFileSystem,
  type SafeWorkspaceFileReaderDependencies,
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

  it('surfaces secure attachment errors so unsupported platforms can explain the limitation', async () => {
    const fs: AttachmentFileSystem = {
      stat: jest.fn().mockResolvedValue({ size: 2 }),
      readFile: jest
        .fn()
        .mockRejectedValue(
          new SecureAttachmentError(
            'Secure file attachments are only supported for local files on Linux. This VS Code filesystem cannot safely verify the opened file.'
          )
        ),
    };

    await expect(collectFileAttachments([uri('/workspace/file.txt')], fs)).rejects.toThrow(
      'Secure file attachments are only supported for local files on Linux.'
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

describe('readWorkspaceFileSafely', () => {
  const uri = { scheme: 'file', fsPath: '/workspace/link/secrets.txt' } as vscode.Uri;
  const workspaceFolder = {
    uri: { scheme: 'file', fsPath: '/workspace' },
  } as vscode.WorkspaceFolder;

  function dependencies(openedPath: string) {
    const content = Buffer.from('workspace data');
    const handle = {
      fd: 42,
      stat: jest.fn().mockResolvedValue({ isFile: () => true, size: content.byteLength }),
      read: jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = content.copy(buffer, offset, position, position + length);
        return { bytesRead };
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const deps: SafeWorkspaceFileReaderDependencies = {
      platform: 'linux',
      open: jest.fn().mockResolvedValue(handle),
      realpath: jest.fn(async (inputPath) =>
        inputPath === '/workspace' ? '/workspace' : openedPath
      ),
    };
    return { deps, handle };
  }

  it('reads from the opened descriptor after confirming its resolved path is inside the workspace', async () => {
    const { deps, handle } = dependencies('/workspace/src/file.ts');

    await expect(readWorkspaceFileSafely(uri, workspaceFolder, 100, deps)).resolves.toEqual(
      new TextEncoder().encode('workspace data')
    );
    expect(deps.open).toHaveBeenCalledWith(uri.fsPath, expect.any(Number));
    expect(deps.open.mock.calls[0]?.[1] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(deps.realpath).toHaveBeenCalledWith('/proc/self/fd/42');
    expect(handle.read).toHaveBeenCalledTimes(2);
    expect(handle.read.mock.calls[0]?.[2]).toBe(101);
    expect(handle.read.mock.calls[1]?.[2]).toBe(87);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a path redirected outside the workspace before reading the opened descriptor', async () => {
    const { deps, handle } = dependencies('/outside/secrets.txt');

    await expect(readWorkspaceFileSafely(uri, workspaceFolder, 100, deps)).rejects.toThrow(
      'The selected file resolves outside the open workspace.'
    );
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('uses the macOS descriptor-relative reader with the per-call byte limit', async () => {
    const { deps } = dependencies('/workspace/src/file.ts');
    deps.platform = 'darwin';
    const result = new TextEncoder().encode('mac data');
    deps.readMacWorkspaceFile = jest.fn(() => result);
    const selectedUri = { scheme: 'file', fsPath: '/workspace/src/file.ts' } as vscode.Uri;

    await expect(readWorkspaceFileSafely(selectedUri, workspaceFolder, 12, deps)).resolves.toBe(
      result
    );
    expect(deps.readMacWorkspaceFile).toHaveBeenCalledWith('/workspace', 'src/file.ts', 12);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it.each(['win32', 'freebsd'])(
    'fails closed on %s before opening or reading the selected path',
    async (platform) => {
      const { deps, handle } = dependencies('/workspace/src/file.ts');
      deps.platform = platform;

      await expect(readWorkspaceFileSafely(uri, workspaceFolder, 100, deps)).rejects.toThrow(
        'Secure file attachments are supported only on macOS or Linux'
      );
      expect(deps.open).not.toHaveBeenCalled();
      expect(handle.read).not.toHaveBeenCalled();
    }
  );

  it('fails closed for virtual filesystem URIs on Linux', async () => {
    const { deps, handle } = dependencies('/workspace/src/file.ts');
    const virtualUri = { ...uri, scheme: 'vscode-remote' } as vscode.Uri;

    await expect(readWorkspaceFileSafely(virtualUri, workspaceFolder, 100, deps)).rejects.toThrow(
      'This VS Code filesystem cannot safely verify the opened file.'
    );
    expect(deps.open).not.toHaveBeenCalled();
    expect(handle.read).not.toHaveBeenCalled();
  });

  it('fails closed when the workspace folder does not use the local file provider', async () => {
    const { deps, handle } = dependencies('/workspace/src/file.ts');
    const virtualWorkspace = {
      uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
    } as vscode.WorkspaceFolder;

    await expect(readWorkspaceFileSafely(uri, virtualWorkspace, 100, deps)).rejects.toThrow(
      'This VS Code filesystem cannot safely verify the opened file.'
    );
    expect(deps.open).not.toHaveBeenCalled();
    expect(handle.read).not.toHaveBeenCalled();
  });

  it('fails closed when the opened descriptor cannot be resolved through procfs', async () => {
    const { deps, handle } = dependencies('/workspace/src/file.ts');
    deps.realpath = jest.fn(async (inputPath) => {
      if (inputPath.startsWith('/proc/self/fd/')) {
        throw new Error('procfs unavailable');
      }
      return '/workspace';
    });

    await expect(readWorkspaceFileSafely(uri, workspaceFolder, 100, deps)).rejects.toThrow(
      'This Linux environment cannot safely verify the opened file.'
    );
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('reads at most the per-call byte limit plus one from the verified Linux descriptor', async () => {
    const { deps, handle } = dependencies('/workspace/src/file.ts');
    const content = Buffer.from('a'.repeat(30));
    handle.stat.mockResolvedValue({ isFile: () => true, size: 1 });
    handle.read.mockImplementation(async (buffer, offset, length, position) => {
      const bytesRead = content.copy(buffer, offset, position, position + length);
      return { bytesRead };
    });

    await expect(readWorkspaceFileSafely(uri, workspaceFolder, 8, deps)).rejects.toThrow(
      'The selected file exceeds the 8-byte limit.'
    );
    expect(handle.read).toHaveBeenCalledTimes(1);
    expect(handle.read.mock.calls[0]?.[2]).toBe(9);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
