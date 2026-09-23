import type { ModelMessage, ModelProvider } from '../models';
import type { ChatMessage } from '../types';
import { buildChatPrompt } from './chatPrompt';

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

export async function executeChat(prompt: string, provider: ModelProvider): Promise<string> {
  const response = await provider.complete({
    messages: toModelMessages(
      buildChatPrompt({
        id: 'interactive-chat',
        messages: [{ role: 'user', content: prompt }],
      })
    ),
  });

  return response.content;
}
