import type {
  ModelProvider,
  ModelToolCall,
  ModelToolEvent,
  ModelToolRequest,
} from '../../src/models';
import { createChatSession, streamChatTurn } from '../../src/services';
import type { RepositoryTool } from '../../src/services/streamRepositoryTools';

function toolCall(id: string, name = 'read_file', args = '{"path":"src/index.ts"}'): ModelToolCall {
  return { id, name, arguments: args };
}

function scriptedProvider(responses: ModelToolEvent[][]) {
  const streamWithTools = jest.fn<(request: ModelToolRequest) => AsyncIterable<ModelToolEvent>>(
    async function* () {
      yield* responses.shift() ?? [];
    }
  );
  const provider: ModelProvider = { complete: jest.fn(), stream: jest.fn(), streamWithTools };
  return { provider, streamWithTools };
}

function readerTool(
  run = jest.fn().mockResolvedValue({ content: 'workspace text' })
): RepositoryTool {
  return { definition: { name: 'read_file', description: 'Read a file', parameters: {} }, run };
}

async function collect(items: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe('repository tools in chat', () => {
  it('streams a final response from tool results and keeps protocol messages off session history', async () => {
    const call = toolCall('call1');
    const reasoningDetails = [{ type: 'reasoning.summary', summary: 'opaque' }];
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'tool-calls', calls: [call], reasoningDetails }],
      [
        { type: 'text', content: 'Final ' },
        { type: 'text', content: 'answer' },
      ],
    ]);
    const tool = readerTool();
    const session = createChatSession('session');

    await expect(
      collect(streamChatTurn(session, 'question', provider, undefined, [], [tool]))
    ).resolves.toEqual(['Final ', 'answer']);
    expect(tool.run).toHaveBeenCalledWith({ path: 'src/index.ts' });
    expect(streamWithTools.mock.calls[1]?.[0].messages.slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [call], reasoningDetails },
      { role: 'tool', toolCallId: 'call1', content: '{"content":"workspace text"}' },
    ]);
    expect(session.messages).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  it('streams plain answers without a follow-up request when tools are enabled', async () => {
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'text', content: 'Normal answer' }],
    ]);
    const tool = readerTool();
    await expect(
      collect(streamChatTurn(createChatSession('id'), 'hi', provider, undefined, [], [tool]))
    ).resolves.toEqual(['Normal answer']);
    expect(streamWithTools).toHaveBeenCalledTimes(1);
    expect(tool.run).not.toHaveBeenCalled();
  });

  it('turns unknown, invalid, and failed requests into matching tool errors', async () => {
    const calls = [
      toolCall('unknown', 'nonexistent'),
      toolCall('malformed', 'read_file', 'not JSON'),
      toolCall('non-object', 'read_file', '[]'),
      toolCall('failed'),
    ];
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'tool-calls', calls }],
      [{ type: 'text', content: 'Handled errors' }],
    ]);
    const tool = readerTool(jest.fn().mockRejectedValue(new Error('Internal filesystem detail')));

    await collect(streamChatTurn(createChatSession('id'), 'hi', provider, undefined, [], [tool]));
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(streamWithTools.mock.calls[1]?.[0].messages.slice(-4)).toEqual([
      { role: 'tool', toolCallId: 'unknown', content: '{"error":"Unknown repository tool."}' },
      {
        role: 'tool',
        toolCallId: 'malformed',
        content: '{"error":"Tool arguments must be a JSON object."}',
      },
      {
        role: 'tool',
        toolCallId: 'non-object',
        content: '{"error":"Tool arguments must be a JSON object."}',
      },
      {
        role: 'tool',
        toolCallId: 'failed',
        content: '{"error":"The tool could not complete the request."}',
      },
    ]);
  });

  it('bounds tool iterations and replaces oversized results before calling the model', async () => {
    const tool = readerTool(jest.fn().mockResolvedValue({ content: 'x'.repeat(128_000) }));
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'tool-calls', calls: [toolCall('a')] }],
      [{ type: 'tool-calls', calls: [toolCall('b')] }],
      [{ type: 'tool-calls', calls: [toolCall('c')] }],
      [{ type: 'text', content: 'Finished' }],
    ]);

    await collect(streamChatTurn(createChatSession('id'), 'hi', provider, undefined, [], [tool]));
    expect(tool.run).toHaveBeenCalledTimes(3);
    expect(streamWithTools.mock.calls.map(([request]) => request.allowToolCalls)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(streamWithTools.mock.calls[1]?.[0].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: '{"error":"The tool result exceeded the available size limit."}',
    });
  });

  it('limits total executions even when the final accepted batch asks for more', async () => {
    const tool = readerTool();
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'tool-calls', calls: Array.from({ length: 5 }, (_, i) => toolCall('first-' + i)) }],
      [{ type: 'tool-calls', calls: [toolCall('last'), toolCall('surplus')] }],
      [{ type: 'text', content: 'Finished' }],
    ]);

    await collect(streamChatTurn(createChatSession('id'), 'hi', provider, undefined, [], [tool]));
    expect(tool.run).toHaveBeenCalledTimes(6);
    expect(streamWithTools.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ allowToolCalls: false })
    );
    expect(streamWithTools.mock.calls[2]?.[0].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'surplus',
      content: '{"error":"The repository tool call budget was reached."}',
    });
  });

  it('reserves room for errors and stops offering tools when result bytes are exhausted', async () => {
    const tool = readerTool(jest.fn().mockResolvedValue('x'.repeat(126_974)));
    const { provider, streamWithTools } = scriptedProvider([
      [{ type: 'tool-calls', calls: [toolCall('a'), toolCall('b'), toolCall('c')] }],
      [{ type: 'text', content: 'Finished' }],
    ]);

    await collect(streamChatTurn(createChatSession('id'), 'hi', provider, undefined, [], [tool]));
    expect(tool.run).toHaveBeenCalledTimes(2);
    expect(streamWithTools.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ allowToolCalls: false })
    );
    expect(streamWithTools.mock.calls[1]?.[0].messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'c',
      content: '{"error":"The repository tool result budget was reached."}',
    });
  });

  it('does not execute or persist an incomplete tool batch from a failed stream', async () => {
    const tool = readerTool();
    const provider: ModelProvider = {
      complete: jest.fn(),
      stream: jest.fn(),
      async *streamWithTools() {
        yield { type: 'tool-calls', calls: [toolCall('first')] };
        throw new Error('Provider disconnected');
      },
    };
    const session = createChatSession('id');
    await expect(
      collect(streamChatTurn(session, 'hi', provider, undefined, [], [tool]))
    ).rejects.toThrow('Provider disconnected');
    expect(tool.run).not.toHaveBeenCalled();
    expect(session.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
