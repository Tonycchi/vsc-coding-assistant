import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { collectEditorContext, collectFileAttachments, readWorkspaceFileSafely } from '../context';
import type { FileAttachment } from '../context';
import type { ModelProvider } from '../models';
import { createChatSession, streamChatTurn } from '../services';
import type { ChatMessage } from '../types';
import { parseChatViewMessage } from './chatViewProtocol';

export const CHAT_VIEW_ID = 'vscCodingAssistant.chatView';

type ChatViewResponse =
  | { type: 'history'; messages: ChatMessage[] }
  | {
      type: 'attachments';
      attachments: Array<Pick<FileAttachment, 'filePath' | 'fileName' | 'sizeBytes'>>;
    }
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
  private attachments: FileAttachment[] = [];

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
      await this.postAttachmentMetadata();
      if (this.currentStreamText !== undefined) {
        await this.postMessage({ type: 'assistant-start' });
        if (this.currentStreamText) {
          await this.postMessage({ type: 'assistant-chunk', content: this.currentStreamText });
        }
      }
      await this.postMessage({ type: 'loading', value: this.isGenerating });
      return;
    }

    if (message.type === 'attach-files') {
      if (!this.isGenerating) {
        await this.attachFiles();
      }
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

      for await (const chunk of streamChatTurn(
        this.session,
        prompt,
        provider,
        editorContext,
        this.attachments
      )) {
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

  private async attachFiles(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        throw new Error('Open a workspace before attaching files.');
      }

      const selectedUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        defaultUri: workspaceFolders[0]!.uri,
        openLabel: 'Attach files',
      });
      if (!selectedUris?.length) {
        return;
      }

      if (selectedUris.some((uri) => !vscode.workspace.getWorkspaceFolder(uri))) {
        throw new Error('Choose files inside an open workspace.');
      }

      for (const uri of selectedUris) {
        await this.rejectSymlinkPath(uri);
      }

      const newAttachments = await collectFileAttachments(selectedUris, {
        stat: (uri) => vscode.workspace.fs.stat(uri),
        readFile: (uri) => {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          if (!workspaceFolder) {
            throw new Error('Choose files inside an open workspace.');
          }
          return readWorkspaceFileSafely(uri, workspaceFolder);
        },
      });
      const byPath = new Map(
        this.attachments.map((attachment) => [attachment.filePath, attachment])
      );
      for (const attachment of newAttachments) {
        byPath.set(attachment.filePath, attachment);
      }
      this.attachments = [...byPath.values()];
      await this.postAttachmentMetadata();
    } catch (error) {
      const content =
        error instanceof Error ? error.message : 'Unable to attach the selected files.';
      await this.postMessage({ type: 'assistant-error', content });
    }
  }

  private async postAttachmentMetadata(): Promise<void> {
    await this.postMessage({
      type: 'attachments',
      attachments: this.attachments.map(({ filePath, fileName, sizeBytes }) => ({
        filePath,
        fileName,
        sizeBytes,
      })),
    });
  }

  private async rejectSymlinkPath(uri: vscode.Uri): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      throw new Error('Choose files inside an open workspace.');
    }

    const relativePath = uri.path.slice(workspaceFolder.uri.path.length);
    let currentUri = workspaceFolder.uri;
    for (const segment of relativePath.split('/').filter(Boolean)) {
      currentUri = vscode.Uri.joinPath(currentUri, segment);
      const stat = await vscode.workspace.fs.stat(currentUri);
      if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
        throw new Error(
          'Symbolic links cannot be attached. Choose a file stored directly in the workspace.'
        );
      }
    }
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
    #attachments { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .attachment { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.85em; }
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
  <div id="attachments" aria-label="Attached files"></div>
  <form id="chat-form">
    <button id="attach" type="button">Attach files</button>
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
    const attach = document.getElementById('attach');
    const attachments = document.getElementById('attachments');
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
      attach.disabled = value;
      status.textContent = value ? 'Assistant is responding…' : '';
    }

    function renderAttachments(items) {
      attachments.replaceChildren();
      for (const item of items) {
        if (!item || typeof item.fileName !== 'string' || typeof item.filePath !== 'string' || !Number.isInteger(item.sizeBytes)) continue;
        const metadata = document.createElement('span');
        metadata.className = 'attachment';
        metadata.textContent = item.fileName + ' (' + item.sizeBytes + ' B)';
        metadata.title = item.filePath;
        attachments.append(metadata);
      }
    }

    attach.addEventListener('click', () => {
      if (!attach.disabled) vscode.postMessage({ type: 'attach-files' });
    });

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
      } else if (message.type === 'attachments' && Array.isArray(message.attachments)) {
        renderAttachments(message.attachments);
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
