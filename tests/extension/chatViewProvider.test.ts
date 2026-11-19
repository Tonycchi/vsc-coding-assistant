import type * as vscode from 'vscode';

import { ChatViewProvider } from '../../src/extension/chatViewProvider';
import type { ModelProvider } from '../../src/models';

jest.mock('vscode', () => ({ window: { activeTextEditor: undefined } }), { virtual: true });

describe('ChatViewProvider', () => {
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
