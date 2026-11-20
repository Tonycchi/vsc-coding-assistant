import { createRequire } from 'node:module';

export interface MacWorkspaceDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'unsupported';
}

export interface MacWorkspaceRootIdentity {
  path: string;
  device: bigint;
  inode: bigint;
}

interface MacWorkspaceAccess {
  readWorkspaceFile(
    root: string,
    relative: string,
    maxBytes: number,
    allowPrefix: boolean,
    rootDevice?: bigint,
    rootInode?: bigint
  ): Uint8Array;
  readWorkspaceDirectory(
    root: string,
    relative: string,
    maxEntries: number,
    rootDevice?: bigint,
    rootInode?: bigint
  ): MacWorkspaceDirectoryEntry[] | undefined;
  applyWorkspaceFile(
    root: string,
    rootDevice: bigint,
    rootInode: bigint,
    relative: string,
    before: Buffer | null,
    after: Buffer
  ): 'applied' | 'stale';
}

const requireNativeModule = createRequire(__filename);

export function loadMacWorkspaceAccess(): MacWorkspaceAccess {
  return requireNativeModule(
    '../../native/build/Release/safe_file_reader.node'
  ) as MacWorkspaceAccess;
}
