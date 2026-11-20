import type { ModelProvider } from './ModelProvider';
import {
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS_PER_BATCH,
  type ModelToolCall,
  type ModelToolEvent,
  type ModelToolMessage,
  type ModelToolRequest,
} from './toolTypes';
import type { ModelRequest, ModelResponse } from './types';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_REASONING_BYTES = 128_000;
const MAX_REASONING_BLOCKS = 4_096;

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

interface OpenRouterStreamChoice {
  delta?: { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown };
  finish_reason?: unknown;
}

interface OpenRouterStreamResponse {
  choices?: OpenRouterStreamChoice[];
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

function parseStreamEvent(event: string): { done: boolean; choice?: OpenRouterStreamChoice } {
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

  const choice = payload?.choices?.[0];
  return choice ? { done: false, choice } : { done: false };
}

async function* readStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<OpenRouterStreamChoice> {
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
        if (parsed.choice) {
          yield parsed.choice;
        }
      }

      if (result.done) {
        if (buffer.trim()) {
          const parsed = parseStreamEvent(buffer);
          if (parsed.choice) {
            yield parsed.choice;
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

function toWireToolCall(call: ModelToolCall) {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

function toWireToolMessage(message: ModelToolMessage) {
  if (message.role === 'tool') {
    return { role: message.role, content: message.content, tool_call_id: message.toolCallId };
  }
  if ('toolCalls' in message) {
    return {
      role: message.role,
      content: message.content || null,
      tool_calls: message.toolCalls.map(toWireToolCall),
      ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}),
    };
  }
  return message;
}

interface OpenRouterToolDelta {
  index?: number;
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function appendToolDeltas(calls: Map<number, ModelToolCall>, deltas: unknown): void {
  if (!Array.isArray(deltas) || deltas.length > MAX_TOOL_CALLS_PER_BATCH) {
    throw new Error('OpenRouter returned an invalid tool call batch.');
  }
  for (const rawDelta of deltas as Array<OpenRouterToolDelta | null>) {
    const index = rawDelta?.index;
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= MAX_TOOL_CALLS_PER_BATCH ||
      (rawDelta?.type !== undefined && rawDelta.type !== 'function')
    ) {
      throw new Error('OpenRouter returned an invalid tool call delta.');
    }

    const previous = calls.get(index) ?? { id: '', name: '', arguments: '' };
    const id = rawDelta?.id ?? previous.id;
    const namePart = rawDelta?.function?.name ?? '';
    const argumentsPart = rawDelta?.function?.arguments ?? '';
    if (
      typeof id !== 'string' ||
      id.length > 256 ||
      (previous.id && id !== previous.id) ||
      typeof namePart !== 'string' ||
      typeof argumentsPart !== 'string'
    ) {
      throw new Error('OpenRouter returned an invalid tool call delta.');
    }
    const name = previous.name + namePart;
    const args = previous.arguments + argumentsPart;
    if (name.length > 64 || Buffer.byteLength(args) > MAX_TOOL_ARGUMENT_BYTES) {
      throw new Error('OpenRouter returned an oversized tool call.');
    }
    calls.set(index, { id, name, arguments: args });
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
    for await (const choice of this.streamChoices(request)) {
      const content = choice.delta?.content;
      if (typeof content === 'string' && content) {
        yield content;
      }
    }
  }

  public async *streamWithTools(request: ModelToolRequest): AsyncIterable<ModelToolEvent> {
    const calls = new Map<number, ModelToolCall>();
    let finishedToolCalls = false;
    let reasoningDetails: unknown[] = [];
    let reasoningBytes = 0;
    let invalidReasoning = false;

    for await (const choice of this.streamChoices({
      messages: request.messages.map(toWireToolMessage),
      tools: request.tools.map((definition) => ({ type: 'function', function: definition })),
      tool_choice: request.allowToolCalls ? 'auto' : 'none',
    })) {
      const content = choice.delta?.content;
      if (typeof content === 'string' && content) {
        yield { type: 'text', content };
      }

      const reasoning = choice.delta?.reasoning_details;
      if (request.allowToolCalls && !invalidReasoning && reasoning != null) {
        if (
          !Array.isArray(reasoning) ||
          reasoning.length + reasoningDetails.length > MAX_REASONING_BLOCKS
        ) {
          invalidReasoning = true;
        } else {
          reasoningBytes += Buffer.byteLength(JSON.stringify(reasoning));
          if (reasoningBytes > MAX_REASONING_BYTES) {
            invalidReasoning = true;
          } else {
            reasoningDetails.push(...reasoning);
          }
        }
        if (invalidReasoning) {
          reasoningDetails = [];
        }
      }
      const deltas = choice.delta?.tool_calls;
      if (deltas !== undefined && deltas !== null) {
        if (finishedToolCalls || !request.allowToolCalls) {
          throw new Error('OpenRouter returned unexpected tool calls.');
        }
        appendToolDeltas(calls, deltas);
      }
      if (choice.finish_reason === 'tool_calls') {
        finishedToolCalls = true;
      }
    }

    if (calls.size > 0 || finishedToolCalls) {
      const ordered = [...calls.entries()].sort(([first], [second]) => first - second);
      if (
        !finishedToolCalls ||
        ordered.length === 0 ||
        ordered.some(
          ([index, call], position) =>
            index !== position || !call.id || !/^[a-z0-9_-]{1,64}$/i.test(call.name)
        )
      ) {
        throw new Error('OpenRouter returned incomplete tool calls.');
      }
      if (invalidReasoning) {
        throw new Error('OpenRouter returned invalid or oversized reasoning for tool calls.');
      }
      yield {
        type: 'tool-calls',
        calls: ordered.map(([, call]) => call),
        ...(reasoningDetails.length > 0 ? { reasoningDetails } : {}),
      };
    }
  }

  private async *streamChoices(request: {
    messages: readonly object[];
    tools?: readonly object[];
    tool_choice?: 'auto' | 'none';
  }): AsyncIterable<OpenRouterStreamChoice> {
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
            ...request,
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
