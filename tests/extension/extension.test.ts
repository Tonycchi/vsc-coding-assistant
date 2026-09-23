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
});
