import type { EditorContext, FileAttachment } from '../context';
import type { ChatMessage, ChatSession } from '../types';

const MAX_EDITOR_CONTEXT_CHARACTERS = 20_000;
const EDITOR_CONTEXT_PREFIX = 'Current editor context (JSON):\n';

export const CODING_ASSISTANT_SYSTEM_PROMPT =
  'You are a practical coding assistant. Give clear, concise, technically accurate help.';

type LimitedPromptContext = Partial<EditorContext> & {
  attachments?: FileAttachment[];
  truncated?: true;
};

function createPromptContext(
  editorContext: EditorContext | undefined,
  attachments: readonly FileAttachment[]
): LimitedPromptContext | EditorContext {
  if (!editorContext && attachments.length === 0) {
    return {};
  }

  const original: LimitedPromptContext = {
    ...(editorContext ?? {}),
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
  };
  if (serializedContextLength(original) <= MAX_EDITOR_CONTEXT_CHARACTERS) {
    return original;
  }

  const limited: LimitedPromptContext = {
    ...(editorContext ? { ...editorContext, fileContent: '' } : {}),
    ...(attachments.length > 0
      ? { attachments: attachments.map((attachment) => ({ ...attachment, fileContent: '' })) }
      : {}),
    truncated: true,
  };

  if (editorContext) {
    limitField(limited, 'selectedText', editorContext.selectedText);
    limitField(limited, 'filePath', editorContext.filePath);
  }

  if (serializedContextLength(limited) > MAX_EDITOR_CONTEXT_CHARACTERS) {
    throw new Error(
      'Attached file metadata exceeds the 20,000-character context limit. Remove some files or choose files with shorter paths.'
    );
  }

  for (let index = 0; index < attachments.length; index += 1) {
    limitAttachmentContent(limited, index, attachments[index]?.fileContent ?? '');
  }

  if (editorContext) {
    limitField(limited, 'fileContent', editorContext.fileContent);
  }

  return limited;
}

function limitField(
  context: LimitedPromptContext,
  field: keyof EditorContext,
  value: string
): void {
  let low = 0;
  let high = value.length;

  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    context[field] = safePrefix(value, length);

    if (serializedContextLength(context) <= MAX_EDITOR_CONTEXT_CHARACTERS) {
      low = length;
    } else {
      high = length - 1;
    }
  }

  context[field] = safePrefix(value, low);
}

function limitAttachmentContent(context: LimitedPromptContext, index: number, value: string): void {
  const attachment = context.attachments?.[index];
  if (!attachment) {
    return;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    attachment.fileContent = safePrefix(value, length);

    if (serializedContextLength(context) <= MAX_EDITOR_CONTEXT_CHARACTERS) {
      low = length;
    } else {
      high = length - 1;
    }
  }

  attachment.fileContent = safePrefix(value, low);
}

function serializedContextLength(context: LimitedPromptContext): number {
  return EDITOR_CONTEXT_PREFIX.length + JSON.stringify(context).length;
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
  editorContext?: EditorContext,
  attachments: readonly FileAttachment[] = []
): ChatMessage[] {
  const sessionMessages = session.messages.filter(({ role }) => role !== 'system');
  const promptContext = createPromptContext(editorContext, attachments);
  const contextMessages: ChatMessage[] =
    Object.keys(promptContext).length > 0
      ? [
          {
            role: 'user',
            content: `${EDITOR_CONTEXT_PREFIX}${JSON.stringify(promptContext)}`,
          },
        ]
      : [];

  return [
    { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
    ...contextMessages,
    ...sessionMessages.map(({ role, content }) => ({ role, content })),
  ];
}
