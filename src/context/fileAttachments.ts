import type * as vscode from 'vscode';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
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
  readFile(uri: vscode.Uri, maxBytes?: number): PromiseLike<Uint8Array>;
}

export const MAX_FILE_ATTACHMENT_SIZE_BYTES = 100_000;
export const MAX_SAFE_WORKSPACE_READ_BYTES = 16 * 1024 * 1024;

export class SecureAttachmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecureAttachmentError';
  }
}

interface OpenFileHandle {
  fd: number;
  stat(): PromiseLike<{ isFile(): boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): PromiseLike<{
    bytesRead: number;
  }>;
  close(): PromiseLike<void>;
}

export interface SafeWorkspaceFileReaderDependencies {
  platform: string;
  open(path: string, flags: number): PromiseLike<OpenFileHandle>;
  realpath(path: string): PromiseLike<string>;
  readMacWorkspaceFile?(workspacePath: string, relativePath: string, maxBytes: number): Uint8Array;
}

const defaultSafeReaderDependencies: SafeWorkspaceFileReaderDependencies = {
  platform: process.platform,
  open: (filePath, flags) => open(filePath, flags),
  realpath,
  readMacWorkspaceFile: loadMacWorkspaceFileReader,
};
const requireNativeModule = createRequire(__filename);

export async function readWorkspaceFileSafely(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  maxBytes = MAX_FILE_ATTACHMENT_SIZE_BYTES,
  dependencies = defaultSafeReaderDependencies
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SAFE_WORKSPACE_READ_BYTES) {
    throw new SecureAttachmentError('Invalid secure attachment size limit.');
  }
  if (uri.scheme !== 'file' || workspaceFolder.uri.scheme !== 'file') {
    throw new SecureAttachmentError(
      'Secure file attachments are only supported for local files on macOS or Linux. This VS Code filesystem cannot safely verify the opened file.'
    );
  }

  if (dependencies.platform === 'darwin') {
    if (!dependencies.readMacWorkspaceFile) {
      throw new SecureAttachmentError('The secure macOS file reader is unavailable.');
    }
    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new SecureAttachmentError('The selected file is outside the open workspace.');
    }
    try {
      return dependencies.readMacWorkspaceFile(workspaceFolder.uri.fsPath, relativePath, maxBytes);
    } catch (error) {
      if (error instanceof SecureAttachmentError) {
        throw error;
      }
      throw new SecureAttachmentError('The selected file could not be safely read.');
    }
  }

  if (dependencies.platform !== 'linux') {
    throw new SecureAttachmentError(
      'Secure file attachments are supported only on macOS or Linux for local files.'
    );
  }

  let workspacePath: string;
  try {
    workspacePath = await dependencies.realpath(workspaceFolder.uri.fsPath);
  } catch {
    throw new SecureAttachmentError('Unable to verify the workspace path for secure attachment.');
  }
  const fileHandle = await dependencies.open(
    uri.fsPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );

  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      throw new SecureAttachmentError('Only regular files can be attached.');
    }
    if (fileStat.size > maxBytes) {
      throw new SecureAttachmentError(`The selected file exceeds the ${maxBytes}-byte limit.`);
    }

    let openedFilePath: string;
    try {
      openedFilePath = await dependencies.realpath(`/proc/self/fd/${fileHandle.fd}`);
    } catch {
      throw new SecureAttachmentError(
        'This Linux environment cannot safely verify the opened file. Ensure /proc/self/fd is available.'
      );
    }
    const relativePath = path.relative(workspacePath, openedFilePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new SecureAttachmentError('The selected file resolves outside the open workspace.');
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await fileHandle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) {
      throw new SecureAttachmentError(`The selected file exceeds the ${maxBytes}-byte limit.`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function loadMacWorkspaceFileReader(
  workspacePath: string,
  relativePath: string,
  maxBytes: number
): Uint8Array {
  let nativeReader: {
    readWorkspaceFile(root: string, relative: string, byteLimit: number): Uint8Array;
  };
  try {
    nativeReader = requireNativeModule(
      '../../native/build/Release/safe_file_reader.node'
    ) as typeof nativeReader;
  } catch {
    throw new SecureAttachmentError(
      'The secure macOS file reader is unavailable. Rebuild or reinstall the extension package.'
    );
  }
  return nativeReader.readWorkspaceFile(workspacePath, relativePath, maxBytes);
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
      bytes = await fileSystem.readFile(uri, maxSizeBytes);
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
