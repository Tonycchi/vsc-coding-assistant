import * as vscode from 'vscode';

import { activate, type ChatCommandDependencies } from '../../src/extension/extension';

jest.mock(
  'vscode',
  () => ({
    commands: { registerCommand: jest.fn() },
    window: {
      showInformationMessage: jest.fn(),
      showInputBox: jest.fn(),
      showErrorMessage: jest.fn(),
    },
  }),
  { virtual: true }
);

const registerCommand = vscode.commands.registerCommand as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
const showInputBox = vscode.window.showInputBox as jest.Mock;
const showErrorMessage = vscode.window.showErrorMessage as jest.Mock;

describe('extension activation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerCommand.mockReturnValue({ dispose: jest.fn() });
  });

  it('registers the assistant command', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'vscCodingAssistant.openChat',
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'vscCodingAssistant.setApiKey',
      expect.any(Function)
    );
    expect(context.subscriptions).toHaveLength(2);
  });

  it('completes one chat exchange and displays the response', async () => {
    showInputBox.mockResolvedValue('Explain this function.');
    const provider = {
      complete: jest.fn().mockResolvedValue({ content: 'It validates input.' }),
    } as unknown as ChatCommandDependencies['provider'];
    const dependencies: ChatCommandDependencies = {
      provider,
    };
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context, dependencies);
    const handler = registerCommand.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await handler();

    expect(provider.complete).toHaveBeenCalledWith({
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'Explain this function.' },
      ],
    });
    expect(showInformationMessage).toHaveBeenCalledWith('It validates input.');
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('sends the active editor context through the chat request', async () => {
    showInputBox.mockResolvedValue('Explain this function.');
    const selection = { isEmpty: false } as vscode.Selection;
    const document = {
      uri: { fsPath: '/workspace/src/example.ts' },
      getText: jest.fn((range?: vscode.Range) =>
        range ? 'return value;' : 'function example() { return value; }'
      ),
    } as unknown as vscode.TextDocument;
    Object.defineProperty(vscode.window, 'activeTextEditor', {
      configurable: true,
      value: { document, selection } as vscode.TextEditor,
    });
    const provider = {
      complete: jest.fn().mockResolvedValue({ content: 'It returns a value.' }),
    } as unknown as ChatCommandDependencies['provider'];
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context, { provider });
    const handler = registerCommand.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await handler();

    expect(provider.complete).toHaveBeenCalledWith({
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        {
          role: 'user',
          content:
            'Current editor context (JSON):\n' +
            JSON.stringify({
              filePath: '/workspace/src/example.ts',
              fileContent: 'function example() { return value; }',
              selectedText: 'return value;',
            }),
        },
        { role: 'user', content: 'Explain this function.' },
      ],
    });
    expect(showInformationMessage).toHaveBeenCalledWith('It returns a value.');
  });
});
