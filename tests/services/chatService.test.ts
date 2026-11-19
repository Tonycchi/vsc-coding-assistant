import {
  createChatSession,
  executeChat,
  executeChatTurn,
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
    const provider = { complete: jest.fn().mockRejectedValue(new Error('Unavailable')) };

    await expect(executeChatTurn(session, 'Question', provider)).rejects.toThrow('Unavailable');
    expect(session.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });
});
