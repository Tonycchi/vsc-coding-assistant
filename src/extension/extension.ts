import * as vscode from 'vscode';

import type { ModelProvider } from '../models';
import { OpenRouterProvider } from '../models';
import {
  getModelValidationError,
  getOpenRouterApiKeyValidationError,
} from './providerConfiguration';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatViewProvider';

export interface ChatCommandDependencies {
  provider: ModelProvider;
}

const API_KEY_SECRET = 'vscCodingAssistant.openrouterApiKey';

async function configuredDependencies(
  context: vscode.ExtensionContext
): Promise<ChatCommandDependencies> {
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  const model = vscode.workspace.getConfiguration('vscCodingAssistant').get<unknown>('model');

  const apiKeyError = getOpenRouterApiKeyValidationError(apiKey);
  if (apiKeyError) {
    throw new Error(`${apiKeyError} Run "Configure Coding Assistant API Key" to save a key.`);
  }

  const modelError = getModelValidationError(model);
  if (modelError) {
    throw new Error(modelError);
  }

  return {
    provider: new OpenRouterProvider({
      apiKey: (apiKey as string).trim(),
      model: (model as string).trim(),
    }),
  };
}

export function activate(
  context: vscode.ExtensionContext,
  dependencies?: ChatCommandDependencies
): void {
  const chatViewProvider = new ChatViewProvider(async () => {
    const configured = dependencies ?? (await configuredDependencies(context));
    return configured.provider;
  });
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    CHAT_VIEW_ID,
    chatViewProvider
  );
  const setApiKeyDisposable = vscode.commands.registerCommand(
    'vscCodingAssistant.setApiKey',
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your OpenRouter API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: getOpenRouterApiKeyValidationError,
      });

      if (apiKey !== undefined) {
        const validationError = getOpenRouterApiKeyValidationError(apiKey);
        if (validationError) {
          await vscode.window.showErrorMessage(validationError);
          return;
        }

        await context.secrets.store(API_KEY_SECRET, apiKey.trim());
        await vscode.window.showInformationMessage('Coding Assistant API key saved securely.');
      }
    }
  );
  const disposable = vscode.commands.registerCommand('vscCodingAssistant.openChat', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.vscCodingAssistant');
  });

  context.subscriptions.push(viewRegistration, setApiKeyDisposable, disposable);
}

export function deactivate(): void {
  // Reserved for future provider and session cleanup.
}
