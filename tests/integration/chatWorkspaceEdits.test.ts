import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import { ChatViewProvider } from '../../src/extension/chatViewProvider';
import { createWorkspaceEditApproval } from '../../src/extension/workspaceEditApproval';
import { createWorkspaceEditPreviewer } from '../../src/extension/workspaceEditPreview';
import { createWorkspaceFileReader } from '../../src/extension/workspaceFileReader';
import type { ModelProvider, ModelToolEvent, ModelToolRequest } from '../../src/models';

jest.mock('../../src/extension/workspaceEditApproval', () => ({
  createWorkspaceEditApproval: jest.fn(),
}));
jest.mock('../../src/extension/workspaceEditPreview', () => ({
  createWorkspaceEditPreviewer: jest.fn(),
}));
jest.mock('../../src/extension/workspaceFileReader', () => {
  const actual = jest.requireActual<typeof import('../../src/extension/workspaceFileReader')>(
    '../../src/extension/workspaceFileReader'
  );
  return { createWorkspaceFileReader: jest.fn(actual.createWorkspaceFileReader) };
});

jest.mock(
  'vscode',
  () => ({
    Uri: {
      joinPath: ({ fsPath }: { fsPath: string }, name: string) => ({
        scheme: 'file',
        fsPath: fsPath + '/' + name,
      }),
    },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      workspaceFolders: [],
      getConfiguration: jest.fn(),
      getWorkspaceFolder: jest.fn(),
    },
    window: { activeTextEditor: undefined },
  }),
  { virtual: true }
);

const mockVscode = jest.requireMock('vscode') as {
  workspace: {
    isTrusted: boolean;
    textDocuments: vscode.TextDocument[];
    workspaceFolders: vscode.WorkspaceFolder[];
    getConfiguration: jest.Mock;
    getWorkspaceFolder: jest.Mock;
  };
  window: { activeTextEditor: vscode.TextEditor | undefined };
};

const folder = {
  name: 'First root',
  uri: { scheme: 'file', fsPath: '/first' },
} as vscode.WorkspaceFolder;
const otherFolder = {
  name: 'Second root',
  uri: { scheme: 'file', fsPath: '/second' },
} as vscode.WorkspaceFolder;

const edits = [
  { kind: 'create', path: 'new.txt', content: 'new contents' },
  { kind: 'replace', path: 'replace.txt', content: 'replaced' },
  { kind: 'patch', path: 'patch.txt', changes: [{ oldText: 'old', newText: 'new' }] },
];
const preview = {
  files: [
    { path: 'new.txt', before: null, after: 'new contents', diff: '+new contents' },
    { path: 'replace.txt', before: 'before', after: 'replaced', diff: '-before\n+replaced' },
    { path: 'patch.txt', before: 'old', after: 'new', diff: '-old\n+new' },
  ],
};

function registerChat(provider: ModelProvider) {
  const postMessage = jest.fn().mockResolvedValue(true);
  const onDidReceiveMessage = jest.fn().mockReturnValue({ dispose: jest.fn() });
  const onDidDispose = jest.fn();
  const webview = { html: '', postMessage, onDidReceiveMessage };
  const chat = new ChatViewProvider(async () => provider);
  chat.resolveWebviewView({ webview, onDidDispose } as unknown as vscode.WebviewView);
  const receive = onDidReceiveMessage.mock.calls[0]?.[0] as (message: unknown) => Promise<void>;
  return {
    html: webview.html,
    postMessage,
    receive,
    dispose: onDidDispose.mock.calls[0]?.[0] as () => void,
  };
}

function modelProposingEdits(failAfterTool = false) {
  const streamWithTools = jest.fn(async function* (
    request: ModelToolRequest
  ): AsyncIterable<ModelToolEvent> {
    if (request.messages.at(-1)?.role === 'tool') {
      if (failAfterTool) throw new Error('Stream disconnected');
      yield { type: 'text', content: 'Please review the edits.' };
      return;
    }
    yield {
      type: 'tool-calls',
      calls: [
        {
          id: 'a-tool-call',
          name: 'propose_workspace_edits',
          arguments: JSON.stringify({ edits }),
        },
      ],
    };
  });
  return { streamWithTools, complete: jest.fn(), stream: jest.fn(async function* () {}) };
}

describe('workspace edit approvals in chat', () => {
  const previewEdits = jest.fn();
  const gate = {
    expectedMacRoot: { path: '/first', device: 1n, inode: 2n },
    isWorkspaceCurrent: jest.fn(),
    request: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
    clear: jest.fn(),
  };
  let enabled: boolean;
  let readOnlyEnabled: boolean;

  beforeEach(() => {
    jest.clearAllMocks();
    enabled = true;
    readOnlyEnabled = false;
    mockVscode.workspace.isTrusted = true;
    mockVscode.workspace.workspaceFolders = [folder];
    mockVscode.workspace.textDocuments = [];
    mockVscode.window.activeTextEditor = undefined;
    mockVscode.workspace.getConfiguration.mockReturnValue({
      get: (name: string) =>
        name === 'enableWorkspaceEdits'
          ? enabled
          : name === 'enableRepositoryTools' && readOnlyEnabled,
    });
    mockVscode.workspace.getWorkspaceFolder.mockImplementation(({ fsPath }) =>
      fsPath.startsWith('/first/') ? folder : otherFolder
    );
    previewEdits.mockResolvedValue(preview);
    gate.isWorkspaceCurrent.mockReturnValue(true);
    gate.request.mockReturnValue({ ...preview, id: 'review-id' });
    gate.approve.mockResolvedValue({
      status: 'applied',
      files: preview.files.map(({ path }) => ({ path, status: 'applied' })),
    });
    jest.mocked(createWorkspaceEditPreviewer).mockReturnValue(previewEdits);
    jest
      .mocked(createWorkspaceEditApproval)
      .mockReturnValue(gate as unknown as ReturnType<typeof createWorkspaceEditApproval>);
  });

  it('previews all three operations and waits for explicit approval from the sidebar', async () => {
    const provider = modelProposingEdits();
    const chat = registerChat(provider);
    await chat.receive({ type: 'send', content: 'Suggest updates to these files.' });

    expect(createWorkspaceEditApproval).toHaveBeenCalledWith(folder, expect.any(Function));
    expect(createWorkspaceEditPreviewer).toHaveBeenCalledWith(folder, gate.expectedMacRoot);
    expect(previewEdits).toHaveBeenCalledWith(edits);
    expect(gate.request).toHaveBeenCalledWith(preview);
    expect(gate.approve).not.toHaveBeenCalled();
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-proposal',
      proposal: {
        id: 'review-id',
        workspaceName: 'First root',
        files: preview.files.map(({ path, diff }) => ({ path, diff })),
      },
    });
    expect(chat.html).toContain('diff.textContent = file.diff');
    expect(chat.html).toContain('Apply changes');
    expect(chat.html).toContain('Reject');
    const followUp = provider.streamWithTools.mock.calls[1]?.[0].messages.at(-1);
    expect(followUp).toEqual({
      role: 'tool',
      toolCallId: 'a-tool-call',
      content: JSON.stringify({
        status: 'awaiting-user-review',
        files: ['new.txt', 'replace.txt', 'patch.txt'],
      }),
    });

    await chat.receive({ type: 'approve-edit', proposalId: 'a-tool-call' });
    expect(gate.approve).not.toHaveBeenCalled();
    await Promise.all([
      chat.receive({ type: 'approve-edit', proposalId: 'review-id' }),
      chat.receive({ type: 'approve-edit', proposalId: 'review-id' }),
    ]);
    expect(gate.approve).toHaveBeenCalledTimes(1);
    expect(gate.approve).toHaveBeenCalledWith('review-id');
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-outcome',
      content:
        'Applied workspace edits.\napplied: new.txt\napplied: replace.txt\napplied: patch.txt',
    });
  });

  const macTest = process.platform === 'darwin' ? it : it.skip;
  macTest.each(['approve', 'reject'] as const)(
    'previews real create, replace and patch operations and handles %s',
    async (decision) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'chat-edit-preview-')));
      try {
        const localFolder = { name: 'Preview workspace', uri: { scheme: 'file', fsPath: root } };
        mockVscode.workspace.workspaceFolders = [localFolder as vscode.WorkspaceFolder];
        const newFile = join(root, 'new.txt');
        const existingFile = join(root, 'replace.txt');
        const patchFile = join(root, 'patch.txt');
        await writeFile(existingFile, 'before');
        await writeFile(patchFile, 'old contents');
        const realPreview = jest.requireActual<
          typeof import('../../src/extension/workspaceEditPreview')
        >('../../src/extension/workspaceEditPreview');
        jest
          .mocked(createWorkspaceEditPreviewer)
          .mockImplementationOnce(realPreview.createWorkspaceEditPreviewer);
        const realApproval = jest.requireActual<
          typeof import('../../src/extension/workspaceEditApproval')
        >('../../src/extension/workspaceEditApproval');
        jest
          .mocked(createWorkspaceEditApproval)
          .mockImplementationOnce(realApproval.createWorkspaceEditApproval);
        const chat = registerChat(modelProposingEdits());

        await chat.receive({ type: 'send', content: 'Suggest edits' });
        const posted = chat.postMessage.mock.calls.map(([message]) => message);
        const proposal = posted.find(({ type }) => type === 'edit-proposal')?.proposal;
        expect(proposal).toMatchObject({
          id: expect.any(String),
          files: [
            { path: 'new.txt', diff: expect.stringContaining('+new contents') },
            { path: 'replace.txt', diff: expect.stringContaining('+replaced') },
            { path: 'patch.txt', diff: expect.stringContaining('+new contents') },
          ],
        });
        await expect(readFile(newFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(existingFile, 'utf8')).resolves.toBe('before');
        await expect(readFile(patchFile, 'utf8')).resolves.toBe('old contents');

        await chat.receive({ type: decision + '-edit', proposalId: proposal.id });
        if (decision === 'approve') {
          await expect(readFile(newFile, 'utf8')).resolves.toBe('new contents');
          await expect(readFile(existingFile, 'utf8')).resolves.toBe('replaced');
          await expect(readFile(patchFile, 'utf8')).resolves.toBe('new contents');
          expect(chat.postMessage).toHaveBeenCalledWith({
            type: 'edit-outcome',
            content:
              'Applied workspace edits.\napplied: new.txt\napplied: replace.txt\napplied: patch.txt',
          });
        } else {
          await expect(readFile(newFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(readFile(existingFile, 'utf8')).resolves.toBe('before');
          await expect(readFile(patchFile, 'utf8')).resolves.toBe('old contents');
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  macTest('rechecks the dirty buffer after preflight at the real write boundary', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'chat-edit-dirty-')));
    try {
      const localFolder = { name: 'Preview workspace', uri: { scheme: 'file', fsPath: root } };
      mockVscode.workspace.workspaceFolders = [localFolder as vscode.WorkspaceFolder];
      const target = join(root, 'replace.txt');
      await writeFile(target, 'before');
      previewEdits.mockResolvedValueOnce({ files: [preview.files[1]!] });
      const reader = jest.fn(async () => {
        mockVscode.workspace.textDocuments = [
          { isDirty: true, uri: { scheme: 'file', fsPath: target } } as vscode.TextDocument,
        ];
        return { kind: 'file' as const, bytes: Buffer.from('before'), truncated: false };
      });
      jest.mocked(createWorkspaceFileReader).mockReturnValueOnce(reader);
      const realApproval = jest.requireActual<
        typeof import('../../src/extension/workspaceEditApproval')
      >('../../src/extension/workspaceEditApproval');
      jest
        .mocked(createWorkspaceEditApproval)
        .mockImplementationOnce(realApproval.createWorkspaceEditApproval);
      const chat = registerChat(modelProposingEdits());
      await chat.receive({ type: 'send', content: 'Suggest edits' });

      const proposal = chat.postMessage.mock.calls
        .map(([message]) => message)
        .find(({ type }) => type === 'edit-proposal')?.proposal;
      expect(proposal).toMatchObject({ id: expect.any(String) });
      expect(mockVscode.workspace.textDocuments).toHaveLength(0);
      await chat.receive({ type: 'approve-edit', proposalId: proposal.id });
      expect(reader).toHaveBeenCalledTimes(1);
      await expect(readFile(target, 'utf8')).resolves.toBe('before');
      expect(chat.postMessage).toHaveBeenCalledWith({
        type: 'edit-outcome',
        content:
          'Save or discard unsaved changes in the proposed files, then ask for a new preview.\nstale: replace.txt',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('declines a draft when the pinned workspace identity changes during preview', async () => {
    gate.isWorkspaceCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const provider = modelProposingEdits();
    const chat = registerChat(provider);
    await chat.receive({ type: 'send', content: 'Suggest edits' });
    expect(previewEdits).toHaveBeenCalledWith(edits);
    expect(gate.request).not.toHaveBeenCalled();
    expect(chat.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'edit-proposal' })
    );
    expect(provider.streamWithTools.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      content: expect.stringContaining('workspace changed'),
    });
  });

  it('declines approval if the physical identity no longer matches the preview', async () => {
    const chat = registerChat(modelProposingEdits());
    await chat.receive({ type: 'send', content: 'Suggest edits' });
    gate.isWorkspaceCurrent.mockReturnValue(false);
    await chat.receive({ type: 'approve-edit', proposalId: 'review-id' });
    expect(gate.reject).toHaveBeenCalledWith('review-id');
    expect(gate.approve).not.toHaveBeenCalled();
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-outcome',
      content: 'Editing is disabled or the workspace changed. Ask for a new preview.',
    });
  });

  it('rejects a proposal without calling the writer', async () => {
    const chat = registerChat(modelProposingEdits());
    await chat.receive({ type: 'send', content: 'Suggest edits' });
    await chat.receive({ type: 'reject-edit', proposalId: 'review-id' });
    expect(gate.reject).toHaveBeenCalledWith('review-id');
    expect(gate.approve).not.toHaveBeenCalled();
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-outcome',
      content: 'Rejected the proposed changes.',
    });
  });

  it('rejects a previous proposal when a new turn starts', async () => {
    gate.request.mockReturnValueOnce({ ...preview, id: 'first-id' });
    gate.request.mockReturnValueOnce({ ...preview, id: 'second-id' });
    const chat = registerChat(modelProposingEdits());
    await chat.receive({ type: 'send', content: 'First proposal' });
    await chat.receive({ type: 'send', content: 'Second proposal' });
    expect(gate.reject).toHaveBeenCalledWith('first-id');

    await chat.receive({ type: 'approve-edit', proposalId: 'first-id' });
    expect(gate.approve).not.toHaveBeenCalled();
    await chat.receive({ type: 'approve-edit', proposalId: 'second-id' });
    expect(gate.approve).toHaveBeenCalledWith('second-id');
  });

  it('reports stale and partial outcomes from the approval gate', async () => {
    gate.approve.mockResolvedValueOnce({
      status: 'stale',
      files: [
        { path: 'new.txt', status: 'stale' },
        { path: 'patch.txt', status: 'skipped' },
      ],
    });
    gate.approve.mockResolvedValueOnce({
      status: 'failed',
      files: [
        { path: 'new.txt', status: 'applied' },
        { path: 'patch.txt', status: 'failed' },
      ],
    });
    const chat = registerChat(modelProposingEdits());

    for (let index = 0; index < 2; index++) {
      await chat.receive({ type: 'send', content: 'Suggest edits' });
      await chat.receive({ type: 'approve-edit', proposalId: 'review-id' });
    }
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-outcome',
      content: 'The proposal is stale. Ask for a new preview.\nstale: new.txt\nskipped: patch.txt',
    });
    expect(chat.postMessage).toHaveBeenCalledWith({
      type: 'edit-outcome',
      content: 'Some workspace edits could not be applied.\napplied: new.txt\nfailed: patch.txt',
    });
  });

  it('expires proposals and rejects dirty, disabled, or switched workspace approvals', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const chat = registerChat(modelProposingEdits());
    const send = () => chat.receive({ type: 'send', content: 'Suggest edits' });
    const approve = () => chat.receive({ type: 'approve-edit', proposalId: 'review-id' });

    try {
      await send();
      clock.mockReturnValue(301_000);
      await approve();
      await send();
      mockVscode.workspace.textDocuments = [
        {
          isDirty: true,
          uri: { scheme: 'file', fsPath: '/first/patch.txt' },
        } as vscode.TextDocument,
      ];
      await approve();
      mockVscode.workspace.textDocuments = [];
      await send();
      enabled = false;
      await approve();
      enabled = true;
      await send();
      mockVscode.workspace.workspaceFolders = [folder, otherFolder];
      mockVscode.window.activeTextEditor = {
        document: { uri: { scheme: 'file', fsPath: '/second/editor.txt' } },
      } as vscode.TextEditor;
      await approve();
      expect(gate.approve).not.toHaveBeenCalled();
      expect(gate.reject).toHaveBeenCalledTimes(4);
      const posted = chat.postMessage.mock.calls.map(([message]) => message);
      expect(posted).toContainEqual({
        type: 'edit-outcome',
        content: 'The proposal expired. Ask for a new preview.',
      });
      expect(posted).toContainEqual({
        type: 'edit-outcome',
        content:
          'Save or discard unsaved changes in the proposed files, then ask for a new preview.',
      });
      expect(
        posted.filter(
          ({ content }) =>
            content === 'Editing is disabled or the workspace changed. Ask for a new preview.'
        )
      ).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not expose a proposal after a failed turn or allow messages from a disposed sidebar', async () => {
    const disconnected = registerChat(modelProposingEdits(true));
    await disconnected.receive({ type: 'send', content: 'Suggest edits' });
    expect(gate.request).not.toHaveBeenCalled();
    expect(disconnected.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'edit-proposal' })
    );

    const chat = registerChat(modelProposingEdits());
    await chat.receive({ type: 'send', content: 'Suggest edits' });
    chat.dispose();
    await chat.receive({ type: 'approve-edit', proposalId: 'review-id' });
    expect(gate.reject).toHaveBeenCalledWith('review-id');
    expect(gate.approve).not.toHaveBeenCalled();
  });

  it('does not offer proposals when the local writer is unavailable', async () => {
    readOnlyEnabled = true;
    jest.mocked(createWorkspaceEditApproval).mockReturnValueOnce(undefined);
    const provider = modelProposingEdits();
    const chat = registerChat(provider);
    await chat.receive({ type: 'send', content: 'Explore workspace' });

    expect(createWorkspaceEditApproval).toHaveBeenCalledWith(folder, expect.any(Function));
    expect(createWorkspaceEditPreviewer).not.toHaveBeenCalled();
    expect(chat.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'edit-proposal' })
    );
    if (['linux', 'darwin'].includes(process.platform)) {
      expect(provider.streamWithTools.mock.calls[0]?.[0].tools.map(({ name }) => name)).toEqual([
        'read_file',
        'list_directory',
        'search_files',
        'search_text',
      ]);
    } else {
      expect(provider.stream).toHaveBeenCalled();
    }
  });

  it('does not offer an edit tool to an untrusted workspace and preserves read-only opt-in', async () => {
    const provider = modelProposingEdits();
    const chat = registerChat(provider);
    mockVscode.workspace.isTrusted = false;
    await chat.receive({ type: 'send', content: 'Suggest edits' });
    expect(provider.stream).toHaveBeenCalled();
    expect(provider.streamWithTools).not.toHaveBeenCalled();

    mockVscode.workspace.isTrusted = true;
    enabled = false;
    readOnlyEnabled = true;
    await chat.receive({ type: 'send', content: 'Explore workspace' });
    if (['linux', 'darwin'].includes(process.platform)) {
      expect(provider.streamWithTools.mock.calls[0]?.[0].tools.map(({ name }) => name)).toEqual([
        'read_file',
        'list_directory',
        'search_files',
        'search_text',
      ]);
    }
    expect(createWorkspaceEditApproval).not.toHaveBeenCalled();
    expect(previewEdits).not.toHaveBeenCalled();
  });
});
