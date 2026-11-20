import * as vscode from 'vscode';

import { activate } from '../../src/extension/extension';
import { ChatViewProvider } from '../../src/extension/chatViewProvider';
import { createWorkspaceFileReader } from '../../src/extension/workspaceFileReader';
import type { ModelProvider, ModelToolEvent, ModelToolRequest } from '../../src/models';

jest.mock('../../src/extension/workspaceFileReader');

jest.mock(
  'vscode',
  () => ({
    commands: { executeCommand: jest.fn(), registerCommand: jest.fn() },
    window: {
      activeTextEditor: undefined,
      registerWebviewViewProvider: jest.fn(),
      showErrorMessage: jest.fn(),
      showInformationMessage: jest.fn(),
      showInputBox: jest.fn(),
    },
    workspace: { getConfiguration: jest.fn(), getWorkspaceFolder: jest.fn() },
  }),
  { virtual: true }
);

const registerCommand = vscode.commands.registerCommand as jest.Mock;
const registerWebviewViewProvider = vscode.window.registerWebviewViewProvider as jest.Mock;

describe('chat webview integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerCommand.mockReturnValue({ dispose: jest.fn() });
    registerWebviewViewProvider.mockReturnValue({ dispose: jest.fn() });
  });

  it('streams to the webview and includes prior turns in the next provider request', async () => {
    const responses = [['First ', 'answer'], ['Second answer']];
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        for (const chunk of responses.shift() ?? []) {
          yield chunk;
        }
      }),
    };
    const { webview, receiveMessage } = registerChatView(provider);

    await receiveMessage({ type: 'ready' });
    await receiveMessage({ type: 'send', content: 'First question' });
    await receiveMessage({ type: 'send', content: 'Follow-up' });

    expect(provider.stream).toHaveBeenNthCalledWith(2, {
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up' },
      ],
    });
    expect(postedMessages(webview)).toEqual(
      expect.arrayContaining([
        { type: 'assistant-chunk', content: 'First ' },
        { type: 'assistant-chunk', content: 'answer' },
        { type: 'assistant-complete' },
        { type: 'assistant-chunk', content: 'Second answer' },
        { type: 'assistant-complete' },
      ])
    );

    await receiveMessage({ type: 'ready' });
    const histories = postedMessages(webview).filter((message) => message.type === 'history');
    expect(histories.at(-1)?.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'Second answer' },
    ]);
  });

  it('uses the editor and tool workspace selected before the sidebar send awaits', async () => {
    const configuration = vscode.workspace.getConfiguration as jest.Mock;
    configuration.mockReturnValue({ get: jest.fn().mockReturnValue(true) });
    Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: true });
    const folders = [
      { uri: { scheme: 'file', fsPath: '/first' } },
      { uri: { scheme: 'file', fsPath: '/second' } },
    ];
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: folders,
    });
    const editors = folders.map(({ uri }) => ({
      document: {
        uri: { scheme: 'file', fsPath: uri.fsPath + '/index.ts' },
        getText: () => uri.fsPath + ' editor context',
      },
      selection: { isEmpty: true },
    }));
    Object.defineProperty(vscode.window, 'activeTextEditor', {
      configurable: true,
      writable: true,
      value: editors[0],
    });
    const getWorkspaceFolder = vscode.workspace.getWorkspaceFolder as jest.Mock;
    getWorkspaceFolder.mockImplementation((uri) =>
      folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath + '/'))
    );
    const reader = jest.fn().mockResolvedValue({
      kind: 'file',
      bytes: new TextEncoder().encode('workspace text'),
      truncated: false,
    });
    jest.mocked(createWorkspaceFileReader).mockReturnValue(reader);

    const streamWithTools = jest.fn(async function* (
      request: ModelToolRequest
    ): AsyncIterable<ModelToolEvent> {
      if (request.messages.at(-1)?.role === 'tool') {
        yield { type: 'text', content: 'Summary of workspace text' };
        return;
      }
      yield {
        type: 'tool-calls',
        calls: [{ id: 'read-1', name: 'read_file', arguments: '{"path":"README.md"}' }],
      };
    });
    const provider: ModelProvider = { complete: jest.fn(), stream: jest.fn(), streamWithTools };
    const { webview, receiveMessage } = registerChatView(provider);

    jest.mocked(webview.postMessage).mockImplementation(async (message) => {
      if (message.type === 'loading' && message.value) {
        Object.defineProperty(vscode.window, 'activeTextEditor', { value: editors[1] });
      }
      return true;
    });
    try {
      await receiveMessage({ type: 'send', content: 'Summarize the README' });
      expect(getWorkspaceFolder).toHaveBeenCalledTimes(1);
      expect(getWorkspaceFolder).toHaveBeenCalledWith(editors[0]?.document.uri);
      expect(createWorkspaceFileReader).toHaveBeenCalledWith(folders[0]);
      expect(createWorkspaceFileReader).not.toHaveBeenCalledWith(folders[1]);
      expect(streamWithTools.mock.calls[0]?.[0].messages).toContainEqual({
        role: 'user',
        content: expect.stringContaining('/first editor context'),
      });
      expect(reader).toHaveBeenCalledWith('README.md', 100_000);
      expect(streamWithTools.mock.calls[0]?.[0].tools.map(({ name }) => name)).toEqual([
        'read_file',
        'list_directory',
        'search_files',
        'search_text',
      ]);
      expect(streamWithTools.mock.calls[1]?.[0].messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'read-1',
        content: JSON.stringify({ path: 'README.md', content: 'workspace text', truncated: false }),
      });
      expect(postedMessages(webview)).toEqual(
        expect.arrayContaining([
          { type: 'assistant-chunk', content: 'Summary of workspace text' },
          { type: 'assistant-complete' },
        ])
      );
      await receiveMessage({ type: 'ready' });
      const histories = postedMessages(webview).filter((message) => message.type === 'history');
      expect(histories.at(-1)?.messages).toEqual([
        { role: 'user', content: 'Summarize the README' },
        { role: 'assistant', content: 'Summary of workspace text' },
      ]);
    } finally {
      Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: false });
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(vscode.window, 'activeTextEditor', { value: undefined });
      getWorkspaceFolder.mockReset();
      configuration.mockReset();
    }
  });

  it('uses ordinary chat streaming when workspace tools are not enabled', async () => {
    const streamWithTools = jest.fn();
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Plain answer';
      }),
      streamWithTools,
    };
    const { webview, receiveMessage } = registerChatView(provider);

    await receiveMessage({ type: 'send', content: 'Hello' });
    expect(streamWithTools).not.toHaveBeenCalled();
    expect(postedMessages(webview)).toContainEqual({
      type: 'assistant-chunk',
      content: 'Plain answer',
    });
  });

  it('clears partial output and keeps failed assistant turns out of session history', async () => {
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Partial answer';
        throw new Error('Stream interrupted');
      }),
    };
    const { webview, receiveMessage } = registerChatView(provider);

    await receiveMessage({ type: 'send', content: 'Question' });

    expect(postedMessages(webview)).toEqual(
      expect.arrayContaining([
        { type: 'assistant-chunk', content: 'Partial answer' },
        { type: 'assistant-discard' },
        { type: 'assistant-error', content: 'Stream interrupted' },
        { type: 'loading', value: false },
      ])
    );

    await receiveMessage({ type: 'ready' });
    const histories = postedMessages(webview).filter((message) => message.type === 'history');
    expect(histories.at(-1)?.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });
});

function registerChatView(provider: ModelProvider): {
  webview: TestWebview;
  receiveMessage: (value: unknown) => Promise<void>;
} {
  activate({ subscriptions: [] } as unknown as vscode.ExtensionContext, { provider });

  const chatView = registerWebviewViewProvider.mock.calls[0]?.[1] as ChatViewProvider | undefined;
  if (!chatView) {
    throw new Error('The extension did not register its chat view provider.');
  }

  const webview = createWebview();
  chatView.resolveWebviewView({
    webview,
    onDidDispose: jest.fn(),
  } as unknown as vscode.WebviewView);

  const receiveMessage = webview.onMessage;
  if (!receiveMessage) {
    throw new Error('The chat view did not register a message handler.');
  }

  return { webview, receiveMessage };
}

interface TestWebview extends vscode.Webview {
  readonly onMessage?: (value: unknown) => Promise<void>;
}

function createWebview(): TestWebview {
  let onMessage: ((value: unknown) => Promise<void>) | undefined;
  const webview = {
    options: undefined,
    html: '',
    onDidReceiveMessage: jest.fn(),
    postMessage: jest.fn().mockResolvedValue(true),
  };
  webview.onDidReceiveMessage.mockImplementation((handler: (value: unknown) => unknown) => {
    onMessage = handler as (value: unknown) => Promise<void>;
    return { dispose: jest.fn() };
  });
  Object.defineProperty(webview, 'onMessage', { get: () => onMessage });
  return webview as unknown as TestWebview;
}

function postedMessages(webview: vscode.Webview): Array<Record<string, unknown>> {
  return (webview.postMessage as jest.Mock).mock.calls.map(([message]) => message);
}
