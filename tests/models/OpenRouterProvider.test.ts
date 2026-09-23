import { OpenRouterProvider } from '../../src/models';

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
});
