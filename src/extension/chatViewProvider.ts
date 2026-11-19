import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { collectEditorContext } from '../context';
import type { ModelProvider } from '../models';
import { createChatSession, streamChatTurn } from '../services';
import type { ChatMessage } from '../types';
import { parseChatViewMessage } from './chatViewProtocol';

export const CHAT_VIEW_ID = 'vscCodingAssistant.chatView';

type ChatViewResponse =
  | { type: 'history'; messages: ChatMessage[] }
  | { type: 'user-message'; content: string }
  | { type: 'assistant-start' }
  | { type: 'assistant-chunk'; content: string }
  | { type: 'assistant-complete' }
  | { type: 'assistant-discard' }
  | { type: 'assistant-error'; content: string }
  | { type: 'loading'; value: boolean };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private readonly session = createChatSession('sidebar-chat');
  private view: vscode.WebviewView | undefined;
  private isGenerating = false;
  private currentStreamText: string | undefined;

  public constructor(private readonly getProvider: () => Promise<ModelProvider>) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getChatHtml();

    const messageListener = view.webview.onDidReceiveMessage((value: unknown) =>
      this.handleMessage(value)
    );

    view.onDidDispose(() => {
      messageListener.dispose();
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private async handleMessage(value: unknown): Promise<void> {
    const message = parseChatViewMessage(value);
    if (!message) {
      return;
    }

    if (message.type === 'ready') {
      await this.postMessage({
        type: 'history',
        messages: this.session.messages,
      });
      if (this.currentStreamText !== undefined) {
        await this.postMessage({ type: 'assistant-start' });
        if (this.currentStreamText) {
          await this.postMessage({ type: 'assistant-chunk', content: this.currentStreamText });
        }
      }
      await this.postMessage({ type: 'loading', value: this.isGenerating });
      return;
    }

    const prompt = message.content.trim();
    if (!prompt || this.isGenerating) {
      return;
    }

    this.isGenerating = true;
    await this.postMessage({ type: 'loading', value: true });

    try {
      const provider = await this.getProvider();
      const editorContext = collectEditorContext(vscode.window.activeTextEditor);
      this.currentStreamText = '';
      await this.postMessage({ type: 'user-message', content: prompt });
      await this.postMessage({ type: 'assistant-start' });

      for await (const chunk of streamChatTurn(this.session, prompt, provider, editorContext)) {
        this.currentStreamText += chunk;
        await this.postMessage({ type: 'assistant-chunk', content: chunk });
      }

      this.currentStreamText = undefined;
      await this.postMessage({ type: 'assistant-complete' });
    } catch (error) {
      this.currentStreamText = undefined;
      await this.postMessage({ type: 'assistant-discard' });
      const content = error instanceof Error ? error.message : 'The chat request failed.';
      await this.postMessage({ type: 'assistant-error', content });
    } finally {
      this.isGenerating = false;
      await this.postMessage({ type: 'loading', value: false });
    }
  }

  private async postMessage(message: ChatViewResponse): Promise<void> {
    await this.view?.webview.postMessage(message);
  }
}

function getChatHtml(): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Coding Assistant</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    body { margin: 0; padding: 12px; }
    #messages { display: flex; flex-direction: column; gap: 10px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px 10px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); }
    .message[data-role="user"] { background: var(--vscode-inputOption-activeBackground); }
    .message[data-role="error"] { color: var(--vscode-errorForeground); }
    .label { display: block; font-size: 0.8em; opacity: 0.75; margin-bottom: 4px; }
    #empty { opacity: 0.75; text-align: center; padding: 20px 8px; }
    #status { min-height: 1.4em; margin: 8px 0; font-size: 0.9em; }
    form { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    textarea { resize: vertical; min-height: 64px; max-height: 200px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    button { align-self: flex-end; padding: 6px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    button:disabled, textarea:disabled { opacity: 0.65; cursor: wait; }
  </style>
</head>
<body>
  <div id="messages" role="log" aria-live="polite"></div>
  <div id="empty">Ask a question to start a conversation.</div>
  <div id="status" role="status" aria-live="polite"></div>
  <form id="chat-form">
    <textarea id="prompt" maxlength="20000" aria-label="Message" placeholder="Ask about your code…"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const empty = document.getElementById('empty');
    const status = document.getElementById('status');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    let currentAssistant = null;

    function updateEmptyState() {
      empty.hidden = messages.childElementCount > 0;
    }

    function addMessage(role, content) {
      const article = document.createElement('article');
      article.className = 'message';
      article.dataset.role = role;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = role === 'error' ? 'Error' : role === 'user' ? 'You' : 'Assistant';
      const body = document.createElement('div');
      body.className = 'content';
      body.textContent = content;
      article.append(label, body);
      messages.append(article);
      updateEmptyState();
      return body;
    }

    function setLoading(value) {
      prompt.disabled = value;
      send.disabled = value;
      status.textContent = value ? 'Assistant is responding…' : '';
    }

    document.getElementById('chat-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const content = prompt.value.trim();
      if (!content || content.length > 20000 || send.disabled) return;
      prompt.value = '';
      setLoading(true);
      vscode.postMessage({ type: 'send', content });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'history' && Array.isArray(message.messages)) {
        messages.replaceChildren();
        for (const item of message.messages) {
          if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') {
            addMessage(item.role, item.content);
          }
        }
        updateEmptyState();
      } else if (message.type === 'user-message' && typeof message.content === 'string') {
        addMessage('user', message.content);
      } else if (message.type === 'assistant-start') {
        currentAssistant = addMessage('assistant', '');
      } else if (message.type === 'assistant-chunk' && typeof message.content === 'string' && currentAssistant) {
        currentAssistant.textContent += message.content;
      } else if (message.type === 'assistant-complete') {
        currentAssistant = null;
      } else if (message.type === 'assistant-discard') {
        currentAssistant?.closest('.message').remove();
        currentAssistant = null;
        updateEmptyState();
      } else if (message.type === 'assistant-error' && typeof message.content === 'string') {
        currentAssistant = null;
        addMessage('error', message.content);
      } else if (message.type === 'loading' && typeof message.value === 'boolean') {
        setLoading(message.value);
      }
    });

    updateEmptyState();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}
