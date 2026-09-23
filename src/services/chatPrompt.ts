import type { ChatMessage, ChatSession } from '../types';

export const CODING_ASSISTANT_SYSTEM_PROMPT =
  'You are a practical coding assistant. Give clear, concise, technically accurate help.';

export function buildChatPrompt(session: ChatSession): ChatMessage[] {
  const sessionMessages = session.messages.filter(({ role }) => role !== 'system');

  return [
    { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
    ...sessionMessages.map(({ role, content }) => ({ role, content })),
  ];
}
