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
  provider: ModelProvider
): Promise<string> {
  session.messages.push({ role: 'user', content: prompt });

  const response = await provider.complete({
    messages: toModelMessages(buildChatPrompt(session)),
  });

  session.messages.push({ role: 'assistant', content: response.content });

  return response.content;
}

export async function executeChat(prompt: string, provider: ModelProvider): Promise<string> {
  return executeChatTurn(createChatSession('interactive-chat'), prompt, provider);
}
