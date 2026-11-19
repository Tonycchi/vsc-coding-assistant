import type { EditorContext } from '../context';
import type { ChatMessage, ChatSession } from '../types';

const MAX_EDITOR_CONTEXT_CHARACTERS = 20_000;
const EDITOR_CONTEXT_PREFIX = 'Current editor context (JSON):\n';

export const CODING_ASSISTANT_SYSTEM_PROMPT =
  'You are a practical coding assistant. Give clear, concise, technically accurate help.';

type LimitedEditorContext = EditorContext & { truncated: true };

function limitEditorContext(context: EditorContext): EditorContext | LimitedEditorContext {
  if (
    EDITOR_CONTEXT_PREFIX.length + JSON.stringify(context).length <=
    MAX_EDITOR_CONTEXT_CHARACTERS
  ) {
    return context;
  }

  const limited: LimitedEditorContext = {
    filePath: '',
    fileContent: '',
    selectedText: '',
    truncated: true,
  };

  for (const field of ['filePath', 'selectedText', 'fileContent'] as const) {
    const value = context[field];
    let low = 0;
    let high = value.length;

    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      const prefix = safePrefix(value, length);
      limited[field] = prefix;

      if (
        EDITOR_CONTEXT_PREFIX.length + JSON.stringify(limited).length <=
        MAX_EDITOR_CONTEXT_CHARACTERS
      ) {
        low = length;
      } else {
        high = length - 1;
      }
    }

    limited[field] = safePrefix(value, low);
  }

  return limited;
}

function safePrefix(value: string, length: number): string {
  const lastIncluded = value.charCodeAt(length - 1);
  const firstExcluded = value.charCodeAt(length);

  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  ) {
    return value.slice(0, length - 1);
  }

  return value.slice(0, length);
}

export function buildChatPrompt(
  session: ChatSession,
  editorContext?: EditorContext
): ChatMessage[] {
  const sessionMessages = session.messages.filter(({ role }) => role !== 'system');
  const contextMessages: ChatMessage[] = editorContext
    ? [
        {
          role: 'user',
          content: `${EDITOR_CONTEXT_PREFIX}${JSON.stringify(limitEditorContext(editorContext))}`,
        },
      ]
    : [];

  return [
    { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
    ...contextMessages,
    ...sessionMessages.map(({ role, content }) => ({ role, content })),
  ];
}
