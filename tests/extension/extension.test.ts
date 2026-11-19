import * as vscode from 'vscode';

import { activate } from '../../src/extension/extension';
import { CHAT_VIEW_ID } from '../../src/extension/chatViewProvider';

jest.mock(
  'vscode',
  () => ({
    commands: { executeCommand: jest.fn(), registerCommand: jest.fn() },
    window: {
      registerWebviewViewProvider: jest.fn(),
      showInformationMessage: jest.fn(),
      showInputBox: jest.fn(),
      showErrorMessage: jest.fn(),
    },
    workspace: { getConfiguration: jest.fn() },
  }),
  { virtual: true }
);

const registerCommand = vscode.commands.registerCommand as jest.Mock;
const executeCommand = vscode.commands.executeCommand as jest.Mock;
const registerWebviewViewProvider = vscode.window.registerWebviewViewProvider as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
const showInputBox = vscode.window.showInputBox as jest.Mock;

describe('extension activation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerCommand.mockReturnValue({ dispose: jest.fn() });
    registerWebviewViewProvider.mockReturnValue({ dispose: jest.fn() });
  });

  it('registers the chat view and commands', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(registerWebviewViewProvider).toHaveBeenCalledWith(CHAT_VIEW_ID, expect.any(Object));
    expect(registerCommand).toHaveBeenCalledWith(
      'vscCodingAssistant.openChat',
      expect.any(Function)
    );
    expect(registerCommand).toHaveBeenCalledWith(
      'vscCodingAssistant.setApiKey',
      expect.any(Function)
    );
    expect(context.subscriptions).toHaveLength(3);
  });

  it('opens the Explorer sidebar when the chat command runs', async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context);
    const handler = registerCommand.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await handler();

    expect(executeCommand).toHaveBeenCalledWith('workbench.view.extension.vscCodingAssistant');
  });

  it('validates and stores a trimmed API key through SecretStorage', async () => {
    showInputBox.mockResolvedValue('  sk-or-v1-test-key  ');
    const store = jest.fn();
    const context = {
      subscriptions: [],
      secrets: { store },
    } as unknown as vscode.ExtensionContext;

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
});
