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

    let payload: OpenRouterResponse = {};
    try {
      payload = (await response.json()) as OpenRouterResponse;
    } catch {
      if (!response.ok) {
        throw new Error(
          `OpenRouter request failed (${response.status}): The provider returned an invalid error response.`
        );
      }

      throw new Error('OpenRouter response was not valid JSON.');
    }

    if (!response.ok) {
      const message =
        typeof payload.error?.message === 'string'
          ? payload.error.message
          : 'The provider rejected the request.';
      throw new Error(`OpenRouter request failed (${response.status}): ${message}`);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenRouter response did not contain assistant content.');
    }

    return { content };
  }
}
