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

  it('includes editor context as a separate JSON user message', () => {
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

  it('limits serialized editor context while preserving the selection first', () => {
    const session = {
      id: 'session-1',
      messages: [{ role: 'user' as const, content: 'Explain this selection.' }],
    };
    const originalMessages = session.messages;
    const editorContext = {
      filePath: '/workspace/src/example.ts',
      fileContent: 'source\n'.repeat(4_000),
      selectedText: 'selected code',
    };

    const prompt = buildChatPrompt(session, editorContext);
    const serializedContext = prompt[1]?.content.replace('Current editor context (JSON):\n', '');
    const limitedContext = JSON.parse(serializedContext ?? '') as typeof editorContext & {
      truncated: boolean;
    };

    expect(limitedContext.filePath).toBe(editorContext.filePath);
    expect(limitedContext.selectedText).toBe(editorContext.selectedText);
    expect(limitedContext.fileContent.length).toBeLessThan(editorContext.fileContent.length);
    expect(limitedContext.truncated).toBe(true);
    expect(prompt[1]?.content.length).toBeLessThanOrEqual(20_000);
    expect(prompt[2]).toEqual({ role: 'user', content: 'Explain this selection.' });
    expect(session.messages).toBe(originalMessages);
    expect(session.messages).toEqual([{ role: 'user', content: 'Explain this selection.' }]);
  });

  it('prioritizes selected text over file content when both exceed the limit', () => {
    const editorContext = {
      filePath: '/workspace/src/example.ts',
      fileContent: 'file content '.repeat(2_000),
      selectedText: 'selected '.repeat(3_000),
    };

    const prompt = buildChatPrompt({ id: 'session-1', messages: [] }, editorContext);
    const serializedContext = prompt[1]?.content.replace('Current editor context (JSON):\n', '');
    const limitedContext = JSON.parse(serializedContext ?? '') as typeof editorContext & {
      truncated: boolean;
    };

    expect(limitedContext.filePath).toBe(editorContext.filePath);
    expect(limitedContext.selectedText.length).toBeGreaterThan(0);
    expect(editorContext.selectedText.startsWith(limitedContext.selectedText)).toBe(true);
    expect(limitedContext.fileContent).toBe('');
    expect(limitedContext.truncated).toBe(true);
    expect(prompt[1]?.content.length).toBeLessThanOrEqual(20_000);
  });

  it('keeps attached file content inside the shared editor context limit', () => {
    const attachment = {
      filePath: '/workspace/src/large.ts',
      fileName: 'large.ts',
      fileContent: 'attached source '.repeat(2_000),
      sizeBytes: 32_000,
    };
    const prompt = buildChatPrompt(
      { id: 'session-1', messages: [{ role: 'user', content: 'Review this file.' }] },
      {
        filePath: '/workspace/src/current.ts',
        fileContent: 'editor context',
        selectedText: 'selection',
      },
      [attachment]
    );
    const serializedContext = prompt[1]?.content.replace('Current editor context (JSON):\n', '');
    const limitedContext = JSON.parse(serializedContext ?? '') as {
      attachments: Array<typeof attachment>;
      truncated: boolean;
    };

    expect(limitedContext.attachments[0]?.filePath).toBe(attachment.filePath);
    expect(limitedContext.attachments[0]?.fileContent.length).toBeGreaterThan(0);
    expect(limitedContext.attachments[0]?.fileContent.length).toBeLessThan(
      attachment.fileContent.length
    );
    expect(limitedContext.truncated).toBe(true);
    expect(prompt[1]?.content.length).toBeLessThanOrEqual(20_000);
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
