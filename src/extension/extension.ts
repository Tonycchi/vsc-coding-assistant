import * as vscode from 'vscode';

import { collectEditorContext } from '../context';
import type { ModelProvider } from '../models';
import { OpenRouterProvider } from '../models';
import { executeChat } from '../services';
import {
  getModelValidationError,
  getOpenRouterApiKeyValidationError,
} from './providerConfiguration';

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
    const editorContext = collectEditorContext(vscode.window.activeTextEditor);
    const prompt = await vscode.window.showInputBox({
      prompt: 'Ask the coding assistant a question',
      placeHolder: 'Explain this function',
    });

    if (!prompt) {
      return;
    }

    try {
      const configured = dependencies ?? (await configuredDependencies(context));
      const response = await executeChat(prompt, configured.provider, editorContext);
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
