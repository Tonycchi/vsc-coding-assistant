import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('vscCodingAssistant.openChat', async () => {
    await vscode.window.showInformationMessage('Coding Assistant is ready for a chat.');
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // Reserved for future provider and session cleanup.
}
