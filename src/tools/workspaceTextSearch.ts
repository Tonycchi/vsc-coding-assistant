import { MAX_WORKSPACE_READ_BYTES, type WorkspaceFileReader } from './readFile';
import type { WorkspaceDiscovery } from './workspaceDiscovery';
import { workspaceDiscoveryLimits } from './workspaceDiscoveryPolicy';

const MAX_QUERY_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 300;
const MAX_BYTES_SCANNED = 1_000_000;

export interface WorkspaceTextMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface WorkspaceTextSearchResult {
  matches: WorkspaceTextMatch[];
  truncated: boolean;
  skippedFiles: number;
}

function clipLine(line: string, matchStart: number, queryLength: number): string {
  if (line.length <= MAX_SNIPPET_LENGTH) {
    return line;
  }

  const available = MAX_SNIPPET_LENGTH - 2;
  let start = Math.max(
    0,
    Math.min(matchStart - Math.floor((available - queryLength) / 2), line.length - available)
  );
  let end = start + available;
  // Avoid splitting a surrogate pair at a snippet edge.
  if (start > 0 && line.charCodeAt(start) >= 0xdc00 && line.charCodeAt(start) <= 0xdfff) {
    start++;
  }
  if (line.charCodeAt(end - 1) >= 0xd800 && line.charCodeAt(end - 1) <= 0xdbff) {
    end--;
  }
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

export async function searchWorkspaceText(
  query: string,
  discovery: Pick<WorkspaceDiscovery, 'searchFiles'>,
  read: WorkspaceFileReader
): Promise<WorkspaceTextSearchResult> {
  if (
    typeof query !== 'string' ||
    query.length === 0 ||
    query.length > MAX_QUERY_LENGTH ||
    /[\r\n]/.test(query) ||
    query.includes('\0')
  ) {
    throw new Error('Provide a single-line text query of 1 to 200 characters.');
  }

  const files = await discovery.searchFiles('*');
  const result: WorkspaceTextSearchResult = {
    matches: [],
    truncated: files.truncated,
    skippedFiles: 0,
  };
  let remainingBytes = MAX_BYTES_SCANNED;

  for (const { path } of files.entries) {
    // Reserve one byte for the verified reader's probe at the end of the prefix.
    if (remainingBytes <= 1) {
      result.truncated = true;
      break;
    }
    const maxBytes = Math.min(MAX_WORKSPACE_READ_BYTES, remainingBytes - 1);
    const file = await read(path, maxBytes);
    if (file.kind === 'unsupported-filesystem') {
      throw new Error('This filesystem does not support safe workspace text search.');
    }
    if (file.kind !== 'file') {
      if (file.kind === 'unreadable') {
        // A failed read may have consumed bytes before it returned the error.
        remainingBytes -= maxBytes + 1;
      }
      result.skippedFiles++;
      continue;
    }
    if (file.bytes.byteLength > maxBytes) {
      throw new Error('The workspace file reader exceeded its byte limit.');
    }
    remainingBytes -= file.bytes.byteLength + Number(file.truncated);
    result.truncated ||= file.truncated;

    let content: string;
    try {
      if (file.bytes.includes(0)) {
        result.skippedFiles++;
        continue;
      }
      content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes, {
        stream: file.truncated,
      });
    } catch {
      result.skippedFiles++;
      continue;
    }

    const lines = content.split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
      const matchStart = line.indexOf(query);
      if (matchStart === -1) {
        continue;
      }
      if (result.matches.length === workspaceDiscoveryLimits.maxResults) {
        result.truncated = true;
        return result;
      }
      result.matches.push({
        path,
        line: index + 1,
        snippet: clipLine(line, matchStart, query.length),
      });
    }
  }
  return result;
}
