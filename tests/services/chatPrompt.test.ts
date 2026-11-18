import { buildChatPrompt, CODING_ASSISTANT_SYSTEM_PROMPT } from '../../src/services';

describe('buildChatPrompt', () => {
  it('preserves session message order and content after the system prompt', () => {
    const prompt = buildChatPrompt({
      id: 'session-1',
      messages: [
        { role: 'user', content: 'What does this do?' },
        { role: 'assistant', content: 'It checks the input.' },
      ],
    });

    expect(prompt).toEqual([
      { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
      { role: 'user', content: 'What does this do?' },
      { role: 'assistant', content: 'It checks the input.' },
    ]);
  });

  it('includes editor context as a separate JSON system message', () => {
    const editorContext = {
      filePath: '/workspace/src/example.ts',
      fileContent: 'const value = 1;',
      selectedText: 'value',
    };

    expect(
      buildChatPrompt(
        { id: 'session-1', messages: [{ role: 'user', content: 'Explain this.' }] },
        editorContext
      )
    ).toEqual([
      { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Current editor context (JSON):\n${JSON.stringify(editorContext)}`,
      },
      { role: 'user', content: 'Explain this.' },
    ]);
  });

  it('does not mutate the session messages', () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }];
    const session = { id: 'session-1', messages };

    buildChatPrompt(session);

    expect(session.messages).toBe(messages);
    expect(session.messages).toEqual(messages);
  });

  it('replaces session system messages with the canonical prompt', () => {
    const prompt = buildChatPrompt({
      id: 'session-1',
      messages: [
        { role: 'system', content: 'Conflicting instructions.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(prompt).toEqual([
      { role: 'system', content: CODING_ASSISTANT_SYSTEM_PROMPT },
      { role: 'user', content: 'Hello' },
    ]);
  });
});
