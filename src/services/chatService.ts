import type { EditorContext, FileAttachment } from '../context';
import type { ModelMessage, ModelProvider } from '../models';
import type { ChatMessage, ChatSession } from '../types';
import { buildChatPrompt } from './chatPrompt';

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

export function createChatSession(id: string): ChatSession {
  return { id, messages: [] };
}

export async function executeChatTurn(
  session: ChatSession,
  prompt: string,
  provider: ModelProvider,
  editorContext?: EditorContext,
  attachments: readonly FileAttachment[] = []
): Promise<string> {
  session.messages.push({ role: 'user', content: prompt });

  const response = await provider.complete({
    messages: toModelMessages(buildChatPrompt(session, editorContext, attachments)),
  });

  session.messages.push({ role: 'assistant', content: response.content });

  return response.content;
}

export async function* streamChatTurn(
  session: ChatSession,
  prompt: string,
  provider: ModelProvider,
  editorContext?: EditorContext,
  attachments: readonly FileAttachment[] = []
): AsyncIterable<string> {
  session.messages.push({ role: 'user', content: prompt });

  let content = '';
  const request = {
    messages: toModelMessages(buildChatPrompt(session, editorContext, attachments)),
  };

  for await (const chunk of provider.stream(request)) {
    content += chunk;
    yield chunk;
  }

  session.messages.push({ role: 'assistant', content });
}

export async function executeChat(
  prompt: string,
  provider: ModelProvider,
  editorContext?: EditorContext,
  attachments: readonly FileAttachment[] = []
): Promise<string> {
  return executeChatTurn(
    createChatSession('interactive-chat'),
    prompt,
    provider,
    editorContext,
    attachments
  );
}
