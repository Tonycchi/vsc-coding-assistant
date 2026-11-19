export const MAX_CHAT_INPUT_LENGTH = 20_000;

export type ChatViewMessage = { type: 'ready' } | { type: 'send'; content: string };

export function parseChatViewMessage(value: unknown): ChatViewMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return { type: 'ready' };
  }

  if (
    message.type === 'send' &&
    typeof message.content === 'string' &&
    message.content.length <= MAX_CHAT_INPUT_LENGTH
  ) {
    return { type: 'send', content: message.content };
  }

  return undefined;
}
