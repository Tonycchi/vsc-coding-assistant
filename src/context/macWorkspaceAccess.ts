import { createRequire } from 'node:module';

export interface MacWorkspaceDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'unsupported';
}

interface MacWorkspaceAccess {
  readWorkspaceFile(
    root: string,
    relative: string,
    maxBytes: number,
    allowPrefix: boolean
  ): Uint8Array;
  readWorkspaceDirectory(
    root: string,
    relative: string,
    maxEntries: number
  ): MacWorkspaceDirectoryEntry[] | undefined;
}

const requireNativeModule = createRequire(__filename);

export function loadMacWorkspaceAccess(): MacWorkspaceAccess {
  return requireNativeModule(
    '../../native/build/Release/safe_file_reader.node'
  ) as MacWorkspaceAccess;
}
