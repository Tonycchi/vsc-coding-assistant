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
    workspace: { getConfiguration: jest.fn() },
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

  it('validates and stores a trimmed API key through SecretStorage', async () => {
    showInputBox.mockResolvedValue('  sk-or-v1-test-key  ');
    const store = jest.fn();
    const context = { subscriptions: [], secrets: { store } } as unknown as vscode.ExtensionContext;

    activate(context);
    const handler = registerCommand.mock.calls[0]?.[1] as () => Promise<void>;
    await handler();

    const options = showInputBox.mock.calls[0]?.[0] as vscode.InputBoxOptions;
    expect(options.password).toBe(true);
    expect(options.validateInput?.('not-a-key')).toBe(
      'Enter a valid OpenRouter API key beginning with "sk-or-".'
    );
    expect(store).toHaveBeenCalledWith('vscCodingAssistant.openrouterApiKey', 'sk-or-v1-test-key');
    expect(showInformationMessage).toHaveBeenCalledWith('Coding Assistant API key saved securely.');
  });

  it('reports an invalid model setting without exposing the saved API key', async () => {
    showInputBox.mockResolvedValue('Explain this function.');
    const apiKey = 'sk-or-v1-secret-test-key';
    const getConfiguration = vscode.workspace.getConfiguration as jest.Mock;
    getConfiguration.mockReturnValue({ get: jest.fn().mockReturnValue('gpt-4o') });
    const context = {
      subscriptions: [],
      secrets: { get: jest.fn().mockResolvedValue(apiKey) },
    } as unknown as vscode.ExtensionContext;

    activate(context);
    const handler = registerCommand.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await handler();

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('provider/model identifier')
    );
    expect(showErrorMessage.mock.calls[0]?.[0]).not.toContain(apiKey);
  });

  it('asks the user to configure a malformed saved API key without exposing it', async () => {
    showInputBox.mockResolvedValue('Explain this function.');
    const apiKey = 'malformed-secret-value';
    const getConfiguration = vscode.workspace.getConfiguration as jest.Mock;
    getConfiguration.mockReturnValue({ get: jest.fn().mockReturnValue('openai/gpt-4o') });
    const context = {
      subscriptions: [],
      secrets: { get: jest.fn().mockResolvedValue(apiKey) },
    } as unknown as vscode.ExtensionContext;

    activate(context);
    const handler = registerCommand.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await handler();

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Configure Coding Assistant API Key')
    );
    expect(showErrorMessage.mock.calls[0]?.[0]).not.toContain(apiKey);
  });
});
