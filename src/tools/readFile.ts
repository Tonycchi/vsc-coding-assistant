export const MAX_WORKSPACE_READ_BYTES = 100_000;

type WorkspaceFileReadFailure =
  | 'missing'
  | 'not-file'
  | 'outside-workspace'
  | 'unsupported-filesystem'
  | 'unreadable';

export type WorkspaceFileRead =
  | { kind: 'file'; bytes: Uint8Array; truncated: boolean }
  | { kind: WorkspaceFileReadFailure };

/**
 * Read a workspace-relative path using a verified file handle.
 * Return at most maxBytes, probing at most one extra byte to detect truncation.
 */
export type WorkspaceFileReader = (
  relativePath: string,
  maxBytes: number
) => Promise<WorkspaceFileRead>;

const readErrorMessages: Record<WorkspaceFileReadFailure, string> = {
  missing: 'The workspace file does not exist.',
  'not-file': 'The workspace path is not a regular file.',
  'outside-workspace': 'The path resolves outside the workspace.',
  'unsupported-filesystem': 'This filesystem does not support safe workspace file reads.',
  unreadable: 'The workspace file could not be read.',
};

export async function readFile(
  relativePath: string,
  reader: WorkspaceFileReader
): Promise<{ path: string; content: string; truncated: boolean }> {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    /^[a-z]:/i.test(relativePath) ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Provide a workspace-relative file path using forward slashes.');
  }

  const result = await reader(relativePath, MAX_WORKSPACE_READ_BYTES);
  if (result.kind !== 'file') {
    throw new Error(readErrorMessages[result.kind]);
  }

  if (result.bytes.byteLength > MAX_WORKSPACE_READ_BYTES) {
    throw new Error('The workspace file reader exceeded its byte limit.');
  }

  try {
    if (result.bytes.includes(0)) {
      throw new Error('NUL byte');
    }

    return {
      path: relativePath,
      // A valid character can span the byte limit. Streaming discards only an incomplete suffix.
      content: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes, {
        stream: result.truncated,
      }),
      truncated: result.truncated,
    };
  } catch {
    throw new Error('The workspace file is not valid UTF-8 text.');
  }
}
