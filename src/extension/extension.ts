import * as vscode from 'vscode';

import type { ModelProvider } from '../models';
import { OpenRouterProvider } from '../models';
import { executeChat } from '../services';

export interface ChatCommandDependencies {
  provider: ModelProvider;
}

const API_KEY_SECRET = 'vscCodingAssistant.openrouterApiKey';

async function configuredDependencies(
  context: vscode.ExtensionContext
): Promise<ChatCommandDependencies> {
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  const model = vscode.workspace
    .getConfiguration('vscCodingAssistant')
    .get<string>('model')
    ?.trim();

  if (!apiKey || !model) {
    throw new Error(
      'Configure vscCodingAssistant.model and run "Configure Coding Assistant API Key" before starting a chat.'
    );
  }

  return { provider: new OpenRouterProvider({ apiKey, model }) };
}

export function activate(
  context: vscode.ExtensionContext,
  dependencies?: ChatCommandDependencies
): void {
  const setApiKeyDisposable = vscode.commands.registerCommand(
    'vscCodingAssistant.setApiKey',
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your OpenRouter API key',
        password: true,
        ignoreFocusOut: true,
      });

      if (apiKey) {
        await context.secrets.store(API_KEY_SECRET, apiKey);
        await vscode.window.showInformationMessage('Coding Assistant API key saved securely.');
      }
    }
  );
  const disposable = vscode.commands.registerCommand('vscCodingAssistant.openChat', async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Ask the coding assistant a question',
      placeHolder: 'Explain this function',
    });

    if (!prompt) {
      return;
    }

    try {
      const configured = dependencies ?? (await configuredDependencies(context));
      const response = await executeChat(prompt, configured.provider);
      await vscode.window.showInformationMessage(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The chat request failed.';
      await vscode.window.showErrorMessage(message);
    }
  });

  context.subscriptions.push(setApiKeyDisposable, disposable);
}

export function deactivate(): void {
  // Reserved for future provider and session cleanup.
}
