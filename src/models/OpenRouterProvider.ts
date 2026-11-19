import type { ModelProvider } from './ModelProvider';
import type { ModelRequest, ModelResponse } from './types';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

interface OpenRouterStreamResponse {
  choices?: Array<{ delta?: { content?: unknown } }>;
  error?: { message?: unknown };
}

async function readRequestError(response: Response): Promise<Error> {
  let payload: OpenRouterResponse;
  try {
    payload = (await response.json()) as OpenRouterResponse;
  } catch {
    return new Error(
      `OpenRouter request failed (${response.status}): The provider returned an invalid error response.`
    );
  }

  const message =
    typeof payload?.error?.message === 'string'
      ? payload.error.message
      : 'The provider rejected the request.';
  return new Error(`OpenRouter request failed (${response.status}): ${message}`);
}

function parseStreamEvent(event: string): { done: boolean; content?: string } {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim();

  if (!data) {
    return { done: false };
  }

  if (data === '[DONE]') {
    return { done: true };
  }

  let payload: OpenRouterStreamResponse;
  try {
    payload = JSON.parse(data) as OpenRouterStreamResponse;
  } catch {
    throw new Error('OpenRouter stream returned invalid JSON.');
  }

  if (payload?.error) {
    const message =
      typeof payload.error.message === 'string'
        ? payload.error.message
        : 'The provider returned a streaming error.';
    throw new Error(`OpenRouter stream failed: ${message}`);
  }

  const content = payload?.choices?.[0]?.delta?.content;
  return typeof content === 'string' ? { done: false, content } : { done: false };
}

async function* readStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The stream could not be read.';
        throw new Error(`OpenRouter stream failed: ${message}`);
      }

      buffer += decoder.decode(result.value, { stream: !result.done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        const parsed = parseStreamEvent(event);
        if (parsed.done) {
          completed = true;
          return;
        }
        if (parsed.content) {
          yield parsed.content;
        }
      }

      if (result.done) {
        if (buffer.trim()) {
          const parsed = parseStreamEvent(buffer);
          if (parsed.content) {
            yield parsed.content;
          }
        }
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export class OpenRouterProvider implements ModelProvider {
  private readonly fetch: Fetch;

  public constructor(
    private readonly config: OpenRouterConfig,
    fetchImplementation: Fetch = globalThis.fetch
  ) {
    this.fetch = fetchImplementation;
  }

  public async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetch(
      `${this.config.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
        }),
      }
    );

    if (!response.ok) {
      throw await readRequestError(response);
    }

    let payload: OpenRouterResponse;
    try {
      payload = (await response.json()) as OpenRouterResponse;
    } catch {
      throw new Error('OpenRouter response was not valid JSON.');
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenRouter response did not contain assistant content.');
    }

    return { content };
  }

  public async *stream(request: ModelRequest): AsyncIterable<string> {
    let response: Response;
    try {
      response = await this.fetch(
        `${this.config.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: request.messages,
            stream: true,
          }),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be sent.';
      throw new Error(`OpenRouter streaming request failed: ${message}`);
    }

    if (!response.ok) {
      throw await readRequestError(response);
    }

    if (!response.body) {
      throw new Error('OpenRouter streaming response did not include a body.');
    }

    yield* readStream(response.body);
  }
}
