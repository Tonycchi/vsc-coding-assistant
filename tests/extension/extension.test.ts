import * as vscode from 'vscode';

import { activate } from '../../src/extension/extension';

jest.mock(
  'vscode',
  () => ({
    commands: {
      registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    },
    window: {
      showInformationMessage: jest.fn(),
    },
  }),
  { virtual: true }
);

describe('extension activation', () => {
  it('registers the placeholder assistant command', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'vscCodingAssistant.openChat',
      expect.any(Function)
    );
    expect(context.subscriptions).toHaveLength(1);
  });
});
