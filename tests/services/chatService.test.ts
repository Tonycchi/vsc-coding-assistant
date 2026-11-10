import { executeChat, toModelMessages } from '../../src/services';

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
});
