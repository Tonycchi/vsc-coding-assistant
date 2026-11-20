import { OpenRouterProvider } from '../../src/models';

function streamResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, { status });
}

async function collectChunks(chunks: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}

describe('OpenRouterProvider', () => {
  it('normalizes a successful chat completion', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Assistant response' } }],
        }),
        { status: 200 }
      )
    );
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).resolves.toEqual({ content: 'Assistant response' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })
    );
  });

  it('returns an actionable error for a failed request', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
      );
    const provider = new OpenRouterProvider({ apiKey: 'bad-key', model: 'test-model' }, fetchMock);

    await expect(provider.complete({ messages: [] })).rejects.toThrow(
      'OpenRouter request failed (401): Invalid API key'
    );
  });

  it('returns an actionable error when a failed request is not JSON', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(provider.complete({ messages: [] })).rejects.toThrow(
      'OpenRouter request failed (502): The provider returned an invalid error response.'
    );
  });

  it('streams partial content from fragmented server-sent events', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\r\n\r\n',
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: [DONE]\n\n',
          'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
        ])
      );
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);
    const request = { messages: [{ role: 'user' as const, content: 'Hello' }] };

    await expect(collectChunks(provider.stream(request))).resolves.toEqual(['Hello', ' world']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'test-model', messages: request.messages, stream: true }),
      })
    );
  });

  it('returns an actionable error for a failed streaming request', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
      );
    const provider = new OpenRouterProvider({ apiKey: 'bad-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter request failed (401): Invalid API key'
    );
  });

  it('returns a deterministic error for malformed streaming events', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse(['data: not-json\n\n']));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter stream returned invalid JSON.'
    );
  });

  it('returns the provider error sent in a streaming event', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse(['data: {"error":{"message":"Model unavailable"}}\n\n']));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter stream failed: Model unavailable'
    );
  });

  it('returns a deterministic error when a successful response has no body', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter streaming response did not include a body.'
    );
  });

  it('wraps stream reader errors with a deterministic provider error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter stream failed: connection reset'
    );
  });

  it('wraps streaming request errors with a deterministic provider error', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable'));
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);

    await expect(collectChunks(provider.stream({ messages: [] }))).rejects.toThrow(
      'OpenRouter streaming request failed: network unavailable'
    );
  });
});

function event(choice: object): string {
  return 'data: ' + JSON.stringify({ choices: [choice] }) + '\n\n';
}

describe('OpenRouter repository tool streaming', () => {
  it('assembles indexed deltas after completion and serializes structured tool messages', async () => {
    const response = streamResponse([
      event({ delta: { content: 'Checking. ' } }),
      event({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"pa' },
            },
          ],
        },
      }),
      event({
        delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/index.ts"}' } }] },
      }),
      event({ delta: {}, finish_reason: 'tool_calls' }),
      'data: [DONE]\n\n',
    ]);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);
    const earlierCall = { id: 'previous', name: 'read_file', arguments: '{"path":"README.md"}' };
    const definition = { name: 'read_file', description: 'Read', parameters: { type: 'object' } };
    const output = [];

    for await (const item of provider.streamWithTools({
      messages: [
        { role: 'assistant', content: '', toolCalls: [earlierCall] },
        { role: 'tool', toolCallId: 'previous', content: '{"content":"text"}' },
      ],
      tools: [definition],
      allowToolCalls: true,
    }))
      output.push(item);

    expect(output).toEqual([
      { type: 'text', content: 'Checking. ' },
      {
        type: 'tool-calls',
        calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/index.ts"}' }],
      },
    ]);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'test-model',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'previous',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'previous', content: '{"content":"text"}' },
      ],
      tools: [{ type: 'function', function: definition }],
      tool_choice: 'auto',
      stream: true,
    });
  });

  it('rejects incomplete tool calls on stream close', async () => {
    const response = streamResponse([
      event({
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
      }),
    ]);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' }, fetchMock);
    const output = provider.streamWithTools({ messages: [], tools: [], allowToolCalls: true });

    await expect(output[Symbol.asyncIterator]().next()).rejects.toThrow('incomplete tool calls');
  });
});
