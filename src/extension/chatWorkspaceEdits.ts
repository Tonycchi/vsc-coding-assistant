import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import * as vscode from 'vscode';

import type { RepositoryTool } from '../services/streamRepositoryTools';
import type { WorkspaceEditPreview } from '../tools/workspaceEditPreview';
import { resolveRepositoryWorkspaceFolder } from './repositoryTools';
import { createWorkspaceEditApproval } from './workspaceEditApproval';
import { createWorkspaceEditPreviewer } from './workspaceEditPreview';

const REVIEW_LIFETIME_MS = 5 * 60 * 1000;
const WORKSPACE_CHANGED = 'Editing is disabled or the workspace changed. Ask for a new preview.';
const DIRTY_TARGET =
  'Save or discard unsaved changes in the proposed files, then ask for a new preview.';

export interface ChatEditPreview {
  id: string;
  workspaceName: string;
  files: ReadonlyArray<{ path: string; diff: string }>;
}

export interface PendingChatEdit {
  preview: ChatEditPreview;
  approve(): Promise<string>;
  reject(): void;
}

interface ChatEditTurn {
  tool: RepositoryTool;
  finalize(): PendingChatEdit | undefined;
}

function workspaceEditsEnabled(): boolean {
  return (
    vscode.workspace.isTrusted &&
    vscode.workspace.getConfiguration('vscCodingAssistant').get<boolean>('enableWorkspaceEdits') ===
      true
  );
}

function isCurrentWorkspace(folder: vscode.WorkspaceFolder): boolean {
  const current = resolveRepositoryWorkspaceFolder(vscode.window.activeTextEditor);
  return (
    current?.uri.scheme === 'file' &&
    current.uri.fsPath === folder.uri.fsPath &&
    vscode.workspace.workspaceFolders?.some(
      ({ uri }) => uri.scheme === 'file' && uri.fsPath === folder.uri.fsPath
    ) === true
  );
}

function hasDirtyTarget(folder: vscode.WorkspaceFolder, paths: readonly string[]): boolean {
  const dirtyFiles = vscode.workspace.textDocuments.filter(
    ({ isDirty, uri }) =>
      isDirty && (uri.scheme === 'file' || (uri.scheme === 'untitled' && isAbsolute(uri.fsPath)))
  );
  if (dirtyFiles.length === 0) {
    return false;
  }
  // Existing files may also be open through an alias. A not-yet-created file
  // still has a lexical path that can match a buffer associated with that path.
  const comparable = (path: string) => path.normalize('NFC').toLowerCase();
  const aliases = (path: string) => {
    try {
      return [comparable(path), comparable(realpathSync(path))];
    } catch {
      return [comparable(path)];
    }
  };
  const targets = new Set(
    paths.flatMap((path) => aliases(vscode.Uri.joinPath(folder.uri, path).fsPath))
  );
  return dirtyFiles.some(({ uri }) => aliases(uri.fsPath).some((path) => targets.has(path)));
}

export function createChatEditTurn(
  editor: vscode.TextEditor | undefined
): ChatEditTurn | undefined {
  if (!workspaceEditsEnabled()) {
    return undefined;
  }
  const folder = resolveRepositoryWorkspaceFolder(editor);
  if (!folder || folder.uri.scheme !== 'file') {
    return undefined;
  }
  let dirtyBeforeWrite = false;
  const approval = createWorkspaceEditApproval(folder, (path) => {
    if (!workspaceEditsEnabled() || !isCurrentWorkspace(folder)) {
      return false;
    }
    dirtyBeforeWrite = hasDirtyTarget(folder, [path]);
    return !dirtyBeforeWrite;
  });
  if (!approval) {
    return undefined;
  }
  const previewEdits = createWorkspaceEditPreviewer(folder, approval.expectedMacRoot);
  let candidate: WorkspaceEditPreview | undefined;

  return {
    tool: {
      definition: {
        name: 'propose_workspace_edits',
        description:
          'Prepare one user-reviewed proposal containing workspace-relative text edits. Nothing is applied by this tool. For create and replace provide content. For patch provide changes containing unique exact oldText and replacement newText.',
        parameters: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['create', 'replace', 'patch'] },
                  path: { type: 'string' },
                  content: { type: 'string' },
                  changes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
                      required: ['oldText', 'newText'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['kind', 'path'],
                additionalProperties: false,
              },
            },
          },
          required: ['edits'],
          additionalProperties: false,
        },
      },
      async run(args) {
        if (!workspaceEditsEnabled()) {
          return { error: 'Workspace edit proposals are disabled.' };
        }
        if (Object.keys(args).length !== 1 || !Array.isArray(args.edits)) {
          return { error: 'Provide an edits array.' };
        }
        if (candidate) {
          return { error: 'This turn already has a proposal. Ask the user to review it.' };
        }
        if (!approval.isWorkspaceCurrent()) {
          return { error: WORKSPACE_CHANGED };
        }
        try {
          const preview = await previewEdits(args.edits);
          if (!approval.isWorkspaceCurrent()) {
            return { error: WORKSPACE_CHANGED };
          }
          candidate = preview;
        } catch (error) {
          return {
            error:
              error instanceof Error ? error.message : 'Unable to preview the workspace edits.',
          };
        }
        return { status: 'awaiting-user-review', files: candidate.files.map(({ path }) => path) };
      },
    },
    finalize() {
      if (!candidate || !workspaceEditsEnabled() || !approval.isWorkspaceCurrent()) {
        return undefined;
      }
      const requested = approval.request(candidate);
      candidate = undefined;
      const preview: ChatEditPreview = {
        id: requested.id,
        workspaceName: folder.name,
        files: requested.files.map(({ path, diff }) => ({ path, diff })),
      };
      const expiresAt = Date.now() + REVIEW_LIFETIME_MS;
      const reject = () => {
        approval.reject(preview.id);
      };
      return {
        preview,
        reject,
        async approve() {
          if (Date.now() >= expiresAt) {
            reject();
            return 'The proposal expired. Ask for a new preview.';
          }
          if (
            !workspaceEditsEnabled() ||
            !isCurrentWorkspace(folder) ||
            !approval.isWorkspaceCurrent()
          ) {
            reject();
            return WORKSPACE_CHANGED;
          }
          if (
            hasDirtyTarget(
              folder,
              preview.files.map(({ path }) => path)
            )
          ) {
            reject();
            return DIRTY_TARGET;
          }

          const result = await approval.approve(preview.id);
          const summary = {
            applied: 'Applied workspace edits.',
            stale: dirtyBeforeWrite
              ? DIRTY_TARGET
              : 'The proposal is stale. Ask for a new preview.',
            failed: 'Some workspace edits could not be applied.',
            'not-pending': 'The proposal is no longer pending.',
          }[result.status];
          return [summary, ...result.files.map(({ path, status }) => status + ': ' + path)].join(
            '\n'
          );
        },
      };
    },
  };
}
