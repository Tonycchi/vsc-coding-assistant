import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/models';

describe('ModelProvider', () => {
  it('can be supplied as a test double', async () => {
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const response: ModelResponse = { content: 'Hi there.' };
    const provider: ModelProvider = {
      complete: jest.fn().mockResolvedValue(response),
      stream: jest.fn(async function* () {
        yield response.content;
      }),
    };

    await expect(provider.complete(request)).resolves.toEqual(response);
    expect(provider.complete).toHaveBeenCalledWith(request);
    const chunks: string[] = [];
    for await (const chunk of provider.stream(request)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Hi there.']);
  });
});
