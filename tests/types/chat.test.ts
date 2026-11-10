import type { ChatMessage, ChatSession } from '../../src/types';

describe('chat domain types', () => {
  it('supports user, assistant, and system messages in a session', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Explain this function.' },
      { role: 'assistant', content: 'It validates the input.' },
    ];
    const session: ChatSession = { id: 'session-1', messages };

    expect(session).toEqual({ id: 'session-1', messages });
  });
});
