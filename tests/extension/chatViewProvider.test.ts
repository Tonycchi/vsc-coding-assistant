import type * as vscode from 'vscode';

import { ChatViewProvider } from '../../src/extension/chatViewProvider';
import type { ModelProvider } from '../../src/models';

jest.mock(
  'vscode',
  () => ({
    window: { activeTextEditor: undefined, showOpenDialog: jest.fn() },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      getWorkspaceFolder: jest.fn(),
      fs: { stat: jest.fn(), readFile: jest.fn() },
    },
  }),
  { virtual: true }
);

const mockVscode = jest.requireMock('vscode') as {
  window: { showOpenDialog: jest.Mock };
  workspace: {
    getWorkspaceFolder: jest.Mock;
    fs: { stat: jest.Mock; readFile: jest.Mock };
  };
};

describe('ChatViewProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/workspace' } });
  });

  it('streams assistant chunks and restores multi-turn history', async () => {
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'First ';
        yield 'answer';
      }),
    };
    const webview = createWebview();
    const view = createView(webview);
    const chatView = new ChatViewProvider(async () => provider);
    chatView.resolveWebviewView(view);
    const receiveMessage = getMessageHandler(webview);

    await receiveMessage({ type: 'ready' });
    await receiveMessage({ type: 'send', content: 'Question' });

    const sentMessages = getPostedMessages(webview);
    expect(sentMessages).toEqual(
      expect.arrayContaining([
        { type: 'user-message', content: 'Question' },
        { type: 'assistant-start' },
        { type: 'assistant-chunk', content: 'First ' },
        { type: 'assistant-chunk', content: 'answer' },
        { type: 'assistant-complete' },
        { type: 'loading', value: false },
      ])
    );

    await receiveMessage({ type: 'send', content: 'Follow-up' });
    expect(provider.stream).toHaveBeenNthCalledWith(2, {
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up' },
      ],
    });

    await receiveMessage({ type: 'ready' });
    const history = getPostedMessages(webview).filter((message) => message.type === 'history');
    expect(history.at(-1)?.messages).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'First answer' },
    ]);
  });

  it('shows provider errors and restores the input state', async () => {
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        throw new Error('Provider unavailable');
      }),
    };
    const webview = createWebview();
    const chatView = new ChatViewProvider(async () => provider);
    chatView.resolveWebviewView(createView(webview));

    await getMessageHandler(webview)({ type: 'send', content: 'Question' });

    expect(getPostedMessages(webview)).toEqual(
      expect.arrayContaining([
        { type: 'assistant-error', content: 'Provider unavailable' },
        { type: 'loading', value: false },
      ])
    );
  });

  it('discards partial assistant output and keeps failed turns out of history', async () => {
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Partial answer';
        throw new Error('Stream interrupted');
      }),
    };
    const webview = createWebview();
    const chatView = new ChatViewProvider(async () => provider);
    chatView.resolveWebviewView(createView(webview));
    const receiveMessage = getMessageHandler(webview);

    await receiveMessage({ type: 'send', content: 'Question' });

    expect(getPostedMessages(webview)).toEqual(
      expect.arrayContaining([
        { type: 'assistant-chunk', content: 'Partial answer' },
        { type: 'assistant-discard' },
        { type: 'assistant-error', content: 'Stream interrupted' },
        { type: 'loading', value: false },
      ])
    );
    expect(webview.html).toContain("currentAssistant?.closest('.message').remove()");

    await receiveMessage({ type: 'ready' });
    const history = getPostedMessages(webview).filter((message) => message.type === 'history');
    expect(history.at(-1)?.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });

  it('renders user content with textContent and uses a nonce-based content policy', () => {
    const webview = createWebview();
    const chatView = new ChatViewProvider(async () => ({
      complete: jest.fn(),
      stream: jest.fn(async function* () {}),
    }));
    chatView.resolveWebviewView(createView(webview));

    expect(webview.html).toContain("default-src 'none'");
    expect(webview.html).toContain("script-src 'nonce-");
    expect(webview.html).toContain('body.textContent = content');
    expect(webview.html).not.toContain('innerHTML');
  });

  it('attaches selected workspace files, displays metadata, and sends content in the prompt', async () => {
    const selectedUri = { fsPath: '/workspace/src/example.ts' } as vscode.Uri;
    const fileContent = 'export const value = 1;';
    mockVscode.window.showOpenDialog.mockResolvedValue([selectedUri]);
    mockVscode.workspace.fs.stat.mockResolvedValue({
      size: new TextEncoder().encode(fileContent).byteLength,
    });
    mockVscode.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode(fileContent));
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Attached answer';
      }),
    };
    const webview = createWebview();
    const chatView = new ChatViewProvider(async () => provider);
    chatView.resolveWebviewView(createView(webview));
    const receiveMessage = getMessageHandler(webview);

    await receiveMessage({ type: 'attach-files' });

    expect(mockVscode.window.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
      })
    );
    expect(getPostedMessages(webview)).toContainEqual({
      type: 'attachments',
      attachments: [
        {
          filePath: '/workspace/src/example.ts',
          fileName: 'example.ts',
          sizeBytes: new TextEncoder().encode(fileContent).byteLength,
        },
      ],
    });
    expect(webview.html).toContain('textContent = item.fileName');

    await receiveMessage({ type: 'send', content: 'Explain the attachment.' });

    const request = (provider.stream as jest.Mock).mock.calls[0]?.[0];
    expect(JSON.stringify(request)).toContain(fileContent);
    expect(JSON.stringify(request)).toContain('example.ts');
  });

  it('shows a clear error and skips reading oversized workspace files', async () => {
    const selectedUri = { fsPath: '/workspace/large.txt' } as vscode.Uri;
    mockVscode.window.showOpenDialog.mockResolvedValue([selectedUri]);
    mockVscode.workspace.fs.stat.mockResolvedValue({ size: 100_001 });
    const chatView = new ChatViewProvider(async () => ({
      complete: jest.fn(),
      stream: jest.fn(async function* () {}),
    }));
    const webview = createWebview();
    chatView.resolveWebviewView(createView(webview));

    await getMessageHandler(webview)({ type: 'attach-files' });

    expect(getPostedMessages(webview)).toContainEqual({
      type: 'assistant-error',
      content: 'Attached file "large.txt" exceeds the 100000-byte size limit.',
    });
    expect(mockVscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('rejects files outside the open workspace before reading them', async () => {
    const selectedUri = { fsPath: '/tmp/external.ts' } as vscode.Uri;
    mockVscode.window.showOpenDialog.mockResolvedValue([selectedUri]);
    mockVscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    const chatView = new ChatViewProvider(async () => ({
      complete: jest.fn(),
      stream: jest.fn(async function* () {}),
    }));
    const webview = createWebview();
    chatView.resolveWebviewView(createView(webview));

    await getMessageHandler(webview)({ type: 'attach-files' });

    expect(getPostedMessages(webview)).toContainEqual({
      type: 'assistant-error',
      content: 'Choose files inside an open workspace.',
    });
    expect(mockVscode.workspace.fs.stat).not.toHaveBeenCalled();
  });
});

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

function createView(webview: vscode.Webview): vscode.WebviewView {
  return {
    webview,
    onDidDispose: jest.fn(),
  } as unknown as vscode.WebviewView;
}

function getMessageHandler(webview: TestWebview): (value: unknown) => Promise<void> {
  const handler = webview.onMessage;
  if (!handler) {
    throw new Error('The chat webview message handler was not registered.');
  }
  return handler;
}

function getPostedMessages(webview: vscode.Webview): Array<Record<string, unknown>> {
  return (webview.postMessage as jest.Mock).mock.calls.map(([message]) => message);
}
