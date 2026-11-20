import { randomUUID } from 'node:crypto';
import {
  MAX_WORKSPACE_READ_BYTES,
  type WorkspaceFileRead,
  type WorkspaceFileReader,
} from './readFile';
import {
  isWorkspaceEditPath,
  MAX_WORKSPACE_EDIT_FILES,
  type WorkspaceEditPreview,
  type WorkspaceEditPreviewFile,
} from './workspaceEditPreview';

export interface PendingWorkspaceEdit {
  readonly id: string;
  readonly files: readonly WorkspaceEditPreviewFile[];
}

export type WorkspaceFileWriter = (
  path: string,
  before: Uint8Array | null,
  after: Uint8Array
) => Promise<'applied' | 'stale'>;

export interface WorkspaceEditResult {
  status: 'applied' | 'stale' | 'failed' | 'not-pending';
  files: readonly { path: string; status: 'applied' | 'stale' | 'failed' | 'skipped' }[];
}

function editBytes(text: string): Buffer {
  if (typeof text !== 'string' || text.length > MAX_WORKSPACE_READ_BYTES || !text.isWellFormed()) {
    throw new Error('Workspace edits must contain bounded UTF-8 text.');
  }
  const bytes = Buffer.from(text);
  if (bytes.length > MAX_WORKSPACE_READ_BYTES || bytes.includes(0)) {
    throw new Error('Workspace edits must contain bounded UTF-8 text.');
  }
  return bytes;
}

function classifyFileState(result: WorkspaceFileRead, before: Buffer | null) {
  if (result.kind === 'missing') {
    return before === null ? 'ready' : 'stale';
  }
  if (result.kind === 'file') {
    return before !== null && !result.truncated && before.equals(result.bytes) ? 'ready' : 'stale';
  }
  return result.kind === 'not-file' ? 'stale' : 'failed';
}

export class WorkspaceEditApproval {
  private pending: PendingWorkspaceEdit | undefined;
  private applying = false;

  constructor(
    private readonly read: WorkspaceFileReader,
    private readonly write: WorkspaceFileWriter
  ) {}

  request(preview: WorkspaceEditPreview): PendingWorkspaceEdit {
    if (
      this.applying ||
      preview.files.length === 0 ||
      preview.files.length > MAX_WORKSPACE_EDIT_FILES
    ) {
      throw new Error('Unable to accept this workspace edit preview.');
    }

    const paths = new Set<string>();
    const files = preview.files.map(({ path, before, after, diff }) => {
      if (typeof path !== 'string' || !isWorkspaceEditPath(path) || paths.has(path)) {
        throw new Error('Each workspace edit must use a distinct, workspace-relative path.');
      }
      paths.add(path);
      if (before !== null) {
        editBytes(before);
      }
      editBytes(after);
      return Object.freeze({ path, before, after, diff });
    });

    this.pending = Object.freeze({ id: randomUUID(), files: Object.freeze(files) });
    return this.pending;
  }

  reject(id: string): boolean {
    if (this.pending?.id !== id) {
      return false;
    }
    this.clear();
    return true;
  }

  clear(): void {
    this.pending = undefined;
  }

  async approve(id: string): Promise<WorkspaceEditResult> {
    if (!this.pending || this.pending.id !== id) {
      return { status: 'not-pending', files: [] };
    }

    const { files } = this.pending;
    this.clear();
    this.applying = true;
    try {
      const prepared = files.map(({ before, after, path }) => {
        const outcome: WorkspaceEditResult['files'][number] = { path, status: 'skipped' };
        return {
          outcome,
          before: before === null ? null : editBytes(before),
          after: editBytes(after),
        };
      });
      const results = prepared.map(({ outcome }) => outcome);

      for (const { outcome, before } of prepared) {
        try {
          const result = classifyFileState(
            await this.read(outcome.path, MAX_WORKSPACE_READ_BYTES),
            before
          );
          if (result !== 'ready') {
            outcome.status = result;
            return { status: result, files: results };
          }
        } catch {
          outcome.status = 'failed';
          return { status: 'failed', files: results };
        }
      }

      for (const { outcome, before, after } of prepared) {
        try {
          const result = await this.write(outcome.path, before, after);
          outcome.status = result;
          if (result === 'stale') {
            return { status: result, files: results };
          }
        } catch {
          outcome.status = 'failed';
          return { status: 'failed', files: results };
        }
      }

      return { status: 'applied', files: results };
    } finally {
      this.applying = false;
    }
  }
}
