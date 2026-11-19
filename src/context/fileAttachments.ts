import type * as vscode from 'vscode';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface FileAttachment {
  filePath: string;
  fileName: string;
  fileContent: string;
  sizeBytes: number;
}

export interface AttachmentFileSystem {
  stat(uri: vscode.Uri): PromiseLike<{ size: number }>;
  readFile(uri: vscode.Uri): PromiseLike<Uint8Array>;
}

export const MAX_FILE_ATTACHMENT_SIZE_BYTES = 100_000;

export class SecureAttachmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecureAttachmentError';
  }
}

interface OpenFileHandle {
  fd: number;
  stat(): PromiseLike<{ isFile(): boolean }>;
  readFile(): PromiseLike<Uint8Array>;
  close(): PromiseLike<void>;
}

export interface SafeWorkspaceFileReaderDependencies {
  platform: string;
  open(path: string, flags: number): PromiseLike<OpenFileHandle>;
  realpath(path: string): PromiseLike<string>;
}

const defaultSafeReaderDependencies: SafeWorkspaceFileReaderDependencies = {
  platform: process.platform,
  open: (filePath, flags) => open(filePath, flags),
  realpath,
};

export async function readWorkspaceFileSafely(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  dependencies = defaultSafeReaderDependencies
): Promise<Uint8Array> {
  if (dependencies.platform !== 'linux' || uri.scheme !== 'file') {
    throw new SecureAttachmentError(
      'Secure file attachments are only supported for local files on Linux. This VS Code filesystem cannot safely verify the opened file.'
    );
  }

  const workspacePath = await dependencies.realpath(workspaceFolder.uri.fsPath);
  const fileHandle = await dependencies.open(uri.fsPath, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      throw new SecureAttachmentError('Only regular files can be attached.');
    }

    const openedFilePath = await dependencies.realpath(`/proc/self/fd/${fileHandle.fd}`);
    const relativePath = path.relative(workspacePath, openedFilePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new SecureAttachmentError('The selected file resolves outside the open workspace.');
    }

    return await fileHandle.readFile();
  } finally {
    await fileHandle.close();
  }
}

export async function collectFileAttachments(
  uris: readonly vscode.Uri[],
  fileSystem: AttachmentFileSystem,
  maxSizeBytes = MAX_FILE_ATTACHMENT_SIZE_BYTES
): Promise<FileAttachment[]> {
  const attachments: FileAttachment[] = [];

  for (const uri of uris) {
    const fileName = getFileName(uri.fsPath);
    let fileSize: number;

    try {
      ({ size: fileSize } = await fileSystem.stat(uri));
    } catch {
      throw new Error(`Unable to inspect attached file "${fileName}".`);
    }

    if (fileSize > maxSizeBytes) {
      throw new Error(`Attached file "${fileName}" exceeds the ${maxSizeBytes}-byte size limit.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await fileSystem.readFile(uri);
    } catch (error) {
      if (error instanceof SecureAttachmentError) {
        throw error;
      }
      throw new Error(`Unable to read attached file "${fileName}".`);
    }

    if (bytes.byteLength > maxSizeBytes) {
      throw new Error(`Attached file "${fileName}" exceeds the ${maxSizeBytes}-byte size limit.`);
    }

    let fileContent: string;
    try {
      fileContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Attached file "${fileName}" is not valid UTF-8 text.`);
    }

    attachments.push({
      filePath: uri.fsPath,
      fileName,
      fileContent,
      sizeBytes: bytes.byteLength,
    });
  }

  return attachments;
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}
