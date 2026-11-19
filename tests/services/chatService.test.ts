import {
  createChatSession,
  executeChat,
  executeChatTurn,
  streamChatTurn,
  toModelMessages,
} from '../../src/services';

describe('toModelMessages', () => {
  it('maps domain chat messages to provider messages at the boundary', () => {
    const messages = [
      { role: 'system' as const, content: 'System' },
      { role: 'user' as const, content: 'Hello' },
    ];

    expect(toModelMessages(messages)).toEqual(messages);
    expect(toModelMessages(messages)).not.toBe(messages);
  });
});

describe('executeChat', () => {
  it('builds a prompt and returns the provider response', async () => {
    const provider = {
      complete: jest.fn().mockResolvedValue({ content: 'Answer' }),
      stream: jest.fn(),
    };

    await expect(executeChat('Hello', provider)).resolves.toBe('Answer');
    expect(provider.complete).toHaveBeenCalledWith({
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'Hello' },
      ],
    });
  });

  it('passes editor context through to the model prompt', async () => {
    const provider = {
      complete: jest.fn().mockResolvedValue({ content: 'Answer' }),
      stream: jest.fn(),
    };
    const editorContext = {
      filePath: '/workspace/src/example.ts',
      fileContent: 'const value = 1;',
      selectedText: 'value',
    };

    await executeChat('Explain this.', provider, editorContext);

    expect(provider.complete).toHaveBeenCalledWith({
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        {
          role: 'user',
          content: `Current editor context (JSON):\n${JSON.stringify(editorContext)}`,
        },
        { role: 'user', content: 'Explain this.' },
      ],
    });
  });
});

describe('createChatSession', () => {
  it('creates an empty session with the supplied id', () => {
    expect(createChatSession('session-1')).toEqual({ id: 'session-1', messages: [] });
  });
});

describe('executeChatTurn', () => {
  it('sends session history and appends each turn in order', async () => {
    const session = createChatSession('session-1');
    const provider = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({ content: 'First answer' })
        .mockResolvedValueOnce({ content: 'Second answer' }),
      stream: jest.fn(),
    };

    await expect(executeChatTurn(session, 'First question', provider)).resolves.toBe(
      'First answer'
    );
    await expect(executeChatTurn(session, 'Follow-up', provider)).resolves.toBe('Second answer');

    expect(session.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'Second answer' },
    ]);
    expect(provider.complete).toHaveBeenNthCalledWith(2, {
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up' },
      ],
    });
  });

  it('keeps the user message in history when the provider fails', async () => {
    const session = createChatSession('session-1');
    const provider = {
      complete: jest.fn().mockRejectedValue(new Error('Unavailable')),
      stream: jest.fn(),
    };

    await expect(executeChatTurn(session, 'Question', provider)).rejects.toThrow('Unavailable');
    expect(session.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });

  it('streams a turn incrementally and stores the complete response in history', async () => {
    const session = createChatSession('session-1');
    const provider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Partial ';
        yield 'response';
      }),
    };
    const chunks: string[] = [];

    for await (const chunk of streamChatTurn(session, 'Question', provider)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Partial ', 'response']);
    expect(session.messages).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Partial response' },
    ]);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(provider.stream).toHaveBeenCalledWith({
      messages: [
        {
          role: 'system',
          content:
            'You are a practical coding assistant. Give clear, concise, technically accurate help.',
        },
        { role: 'user', content: 'Question' },
      ],
    });
  });

  it('keeps the user message when a streaming turn fails', async () => {
    const session = createChatSession('session-1');
    const provider = {
      complete: jest.fn(),
      stream: jest.fn(async function* () {
        yield 'Partial response';
        throw new Error('Stream failed');
      }),
    };

    await expect(collectChunks(streamChatTurn(session, 'Question', provider))).rejects.toThrow(
      'Stream failed'
    );
    expect(session.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });
});

async function collectChunks(chunks: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}
