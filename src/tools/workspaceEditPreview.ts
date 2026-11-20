import { MAX_WORKSPACE_READ_BYTES, type WorkspaceFileReader } from './readFile';

export const MAX_WORKSPACE_EDIT_FILES = 5;
const MAX_PATCH_CHANGES = 20;
const MAX_DIFF_BYTES = 1_000_000;
const CONTEXT_LINES = 3;

export interface WorkspacePatchChange {
  readonly oldText: string;
  readonly newText: string;
}

export type WorkspaceEdit =
  | { readonly kind: 'create' | 'replace'; readonly path: string; readonly content: string }
  | {
      readonly kind: 'patch';
      readonly path: string;
      readonly changes: readonly WorkspacePatchChange[];
    };

export interface WorkspaceEditPreviewFile {
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly diff: string;
}

export interface WorkspaceEditPreview {
  readonly files: readonly WorkspaceEditPreviewFile[];
}

export async function previewWorkspaceEdits(
  edits: unknown,
  reader: WorkspaceFileReader
): Promise<WorkspaceEditPreview> {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_WORKSPACE_EDIT_FILES) {
    throw new Error(`Provide between 1 and ${MAX_WORKSPACE_EDIT_FILES} workspace edits.`);
  }

  const validated = Array.from(edits, validateEdit);
  const paths = new Set<string>();
  for (const edit of validated) {
    // Reject aliases on case-insensitive and normalization-insensitive filesystems too.
    const key = edit.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) {
      throw new Error(`Multiple edits target "${edit.path}". Provide one edit per file.`);
    }
    paths.add(key);
  }

  const files: WorkspaceEditPreviewFile[] = [];
  let diffBytes = 0;
  for (const edit of validated) {
    const before = await readBefore(edit, reader);
    const after =
      edit.kind === 'patch' ? applyChanges(before, edit.changes, edit.path) : edit.content;
    if (before === after) {
      throw new Error(`The proposal does not change "${edit.path}".`);
    }
    const diff = renderDiff(edit.path, before, after);
    diffBytes += Buffer.byteLength(diff);
    if (diffBytes > MAX_DIFF_BYTES) {
      throw new Error(
        'The proposed diff exceeds the preview size limit. Split it into smaller edits.'
      );
    }
    files.push({ path: edit.path, before, after, diff });
  }

  return { files };
}

function validateEdit(value: unknown): WorkspaceEdit {
  if (!isRecord(value) || typeof value.path !== 'string' || !isWorkspaceEditPath(value.path)) {
    throw new Error('Provide a workspace-relative file path using forward slashes, outside .git.');
  }
  const { kind, path } = value;
  switch (kind) {
    case 'create':
    case 'replace':
      return { kind, path, content: validateText(value.content) };
    case 'patch': {
      if (
        !Array.isArray(value.changes) ||
        value.changes.length === 0 ||
        value.changes.length > MAX_PATCH_CHANGES
      ) {
        throw new Error(`Provide between 1 and ${MAX_PATCH_CHANGES} patch changes for "${path}".`);
      }
      let patchBytes = 0;
      const changes = Array.from(value.changes, (change: unknown) => {
        if (!isRecord(change)) throw new Error('Each patch change needs oldText and newText.');
        const oldText = validateText(change.oldText);
        const newText = validateText(change.newText);
        if (!oldText || oldText === newText) {
          throw new Error('Each patch change needs nonempty oldText that differs from newText.');
        }
        patchBytes += Buffer.byteLength(oldText) + Buffer.byteLength(newText);
        if (patchBytes > 2 * MAX_WORKSPACE_READ_BYTES) {
          throw new Error(`The patch for "${path}" exceeds its input size limit.`);
        }
        return { oldText, newText };
      });
      return { kind, path, changes };
    }
    default:
      throw new Error('Unsupported workspace edit kind. Use create, replace, or patch.');
  }
}

export function isWorkspaceEditPath(path: string): boolean {
  return (
    path.length <= 1_024 &&
    path.isWellFormed() &&
    !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) &&
    !/^[a-z]:/i.test(path) &&
    path
      .split('/')
      .every(
        (part) => part.trim() && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
      )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateText(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    throw new Error('Workspace edits require valid UTF-8 text without NUL bytes.');
  }
  if (
    value.length > MAX_WORKSPACE_READ_BYTES ||
    Buffer.byteLength(value) > MAX_WORKSPACE_READ_BYTES
  ) {
    throw new Error(`Edited files must fit within ${MAX_WORKSPACE_READ_BYTES} UTF-8 bytes.`);
  }
  return value;
}

async function readBefore(
  edit: WorkspaceEdit,
  reader: WorkspaceFileReader
): Promise<string | null> {
  const file = await reader(edit.path, MAX_WORKSPACE_READ_BYTES);
  if (edit.kind === 'create' && file.kind === 'missing') return null;
  switch (file.kind) {
    case 'missing':
      throw new Error(`"${edit.path}" is missing. Refresh the proposal against the workspace.`);
    case 'not-file':
      throw new Error(`"${edit.path}" is not a regular file.`);
    case 'outside-workspace':
      throw new Error(
        `"${edit.path}" is outside the verified workspace or resolves through an alias.`
      );
    case 'unsupported-filesystem':
      throw new Error('This filesystem does not support verified workspace previews.');
    case 'unreadable':
      throw new Error(`Unable to verify "${edit.path}" for a preview.`);
    case 'file':
      if (edit.kind === 'create') {
        throw new Error(
          `"${edit.path}" already exists. Refresh the proposal against the workspace.`
        );
      }
      if (file.truncated || file.bytes.byteLength > MAX_WORKSPACE_READ_BYTES) {
        throw new Error(`"${edit.path}" exceeds the preview size limit.`);
      }
      try {
        if (file.bytes.includes(0)) throw new Error('NUL byte');
        // Preserve an existing BOM so the approval gate can compare the exact file text.
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
      } catch {
        throw new Error(`"${edit.path}" is not valid UTF-8 text.`);
      }
  }
}

function applyChanges(
  before: string | null,
  changes: readonly WorkspacePatchChange[],
  path: string
): string {
  if (before === null)
    throw new Error(`"${path}" is missing. Refresh the proposal against the workspace.`);
  let content = before;
  for (const { oldText, newText } of changes) {
    const at = content.indexOf(oldText);
    if (at === -1 || content.indexOf(oldText, at + 1) !== -1) {
      throw new Error(
        `A patch for "${path}" has no unique match. Refresh the proposal against the workspace.`
      );
    }
    content = validateText(content.slice(0, at) + newText + content.slice(at + oldText.length));
  }
  return content;
}

function renderDiff(path: string, before: string | null, after: string): string {
  const oldLines = splitLines(before ?? '');
  const newLines = splitLines(after);
  const lines = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  if (!oldLines.length && !newLines.length) return lines.join('\n');

  const commonLength = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < commonLength && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < commonLength - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const start = Math.max(0, prefix - CONTEXT_LINES);
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const tail = Math.min(suffix, CONTEXT_LINES);
  const oldCount = oldChangeEnd + tail - start;
  const newCount = newChangeEnd + tail - start;
  lines.push(
    `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@`
  );
  appendDiffLines(lines, ' ', oldLines.slice(start, prefix));
  appendDiffLines(lines, '-', oldLines.slice(prefix, oldChangeEnd));
  appendDiffLines(lines, '+', newLines.slice(prefix, newChangeEnd));
  appendDiffLines(lines, ' ', oldLines.slice(oldChangeEnd, oldChangeEnd + tail));
  return lines.join('\n');
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function appendDiffLines(output: string[], marker: string, lines: readonly string[]): void {
  for (const line of lines) {
    const hasNewline = line.endsWith('\n');
    const text = hasNewline ? line.slice(0, -1) : line;
    // Escape backslashes as well, making control-character escapes distinguishable from literal text.
    const visible = text.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
      character === '\\' ? '\\\\' : `\\u{${character.codePointAt(0)!.toString(16)}}`
    );
    output.push(marker + visible);
    if (!hasNewline) output.push('\\ No newline at end of file');
  }
}
