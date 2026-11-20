export const MAX_CHAT_INPUT_LENGTH = 20_000;

export type ChatViewMessage =
  | { type: 'ready' }
  | { type: 'send'; content: string }
  | { type: 'attach-files' }
  | { type: 'remove-attachment'; filePath: string }
  | { type: 'approve-edit' | 'reject-edit'; proposalId: string };

export function parseChatViewMessage(value: unknown): ChatViewMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return { type: 'ready' };
  }

  if (message.type === 'attach-files') {
    return { type: 'attach-files' };
  }
  if (
    message.type === 'remove-attachment' &&
    typeof message.filePath === 'string' &&
    message.filePath.length > 0
  ) {
    return { type: 'remove-attachment', filePath: message.filePath };
  }
  if (
    (message.type === 'approve-edit' || message.type === 'reject-edit') &&
    Object.keys(message).length === 2 &&
    typeof message.proposalId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(message.proposalId)
  ) {
    return { type: message.type, proposalId: message.proposalId };
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
