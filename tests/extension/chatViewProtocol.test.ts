import { MAX_CHAT_INPUT_LENGTH, parseChatViewMessage } from '../../src/extension/chatViewProtocol';

describe('parseChatViewMessage', () => {
  it('accepts ready, attachment, and bounded send message shapes', () => {
    expect(parseChatViewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseChatViewMessage({ type: 'attach-files' })).toEqual({ type: 'attach-files' });
    expect(parseChatViewMessage({ type: 'send', content: 'Hello' })).toEqual({
      type: 'send',
      content: 'Hello',
    });
    expect(
      parseChatViewMessage({ type: 'send', content: 'x'.repeat(MAX_CHAT_INPUT_LENGTH + 1) })
    ).toBeUndefined();
    expect(parseChatViewMessage({ type: 'send', content: 42 })).toBeUndefined();
    expect(parseChatViewMessage({ type: 'unknown' })).toBeUndefined();
    expect(parseChatViewMessage(null)).toBeUndefined();
    expect(parseChatViewMessage([])).toBeUndefined();
  });

  it('accepts a removal path and rejects malformed removal messages', () => {
    const filePath = '/workspace/folder/example.ts';
    expect(parseChatViewMessage({ type: 'remove-attachment', filePath })).toEqual({
      type: 'remove-attachment',
      filePath,
    });
    expect(parseChatViewMessage({ type: 'remove-attachment' })).toBeUndefined();
    expect(parseChatViewMessage({ type: 'remove-attachment', filePath: '' })).toBeUndefined();
    expect(parseChatViewMessage({ type: 'remove-attachment', filePath: 42 })).toBeUndefined();
  });
});
