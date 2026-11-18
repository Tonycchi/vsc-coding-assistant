import type { EditorContext } from '../context';
import type { ChatMessage, ChatSession } from '../types';

export const CODING_ASSISTANT_SYSTEM_PROMPT =
  'You are a practical coding assistant. Give clear, concise, technically accurate help.';

export function buildChatPrompt(
  session: ChatSession,
  editorContext?: EditorContext
): ChatMessage[] {
  const sessionMessages = session.messages.filter(({ role }) => role !== 'system');
  const contextMessages: ChatMessage[] = editorContext
    ? [
        {
          role: 'user',
          content: `Current editor context (JSON):\n${JSON.stringify(editorContext)}`,
        },
      ]
    : [];

  return [
    { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
    ...contextMessages,
    ...sessionMessages.map(({ role, content }) => ({ role, content })),
  ];
}
