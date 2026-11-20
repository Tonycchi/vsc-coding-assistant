import * as vscode from 'vscode';

import { activate } from '../../src/extension/extension';
import { ChatViewProvider } from '../../src/extension/chatViewProvider';
import type { ModelProvider } from '../../src/models';

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
    workspace: { getConfiguration: jest.fn() },
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
