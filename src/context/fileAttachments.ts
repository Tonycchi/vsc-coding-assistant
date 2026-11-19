import type * as vscode from 'vscode';

export interface FileAttachment {
  filePath: string;
  fileName: string;
  fileContent: string;
  sizeBytes: number;
}

export interface AttachmentFileSystem {
  stat(uri: vscode.Uri): Promise<{ size: number }>;
  readFile(uri: vscode.Uri): Promise<Uint8Array>;
}

export const MAX_FILE_ATTACHMENT_SIZE_BYTES = 100_000;

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
    } catch {
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
