import {
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS_PER_BATCH,
  type ModelMessage,
  type ModelProvider,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolMessage,
  type ModelToolRequest,
} from '../models';

const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_BYTES = 128_000;
const MAX_TOTAL_TOOL_RESULT_BYTES = 256_000;

export interface RepositoryTool {
  definition: ModelToolDefinition;
  run(args: Record<string, unknown>): Promise<unknown>;
}

async function runTool(
  call: ModelToolCall,
  registry: ReadonlyMap<string, RepositoryTool>,
  availableBytes: number
): Promise<string> {
  const tool = registry.get(call.name);
  if (!tool) {
    return JSON.stringify({ error: 'Unknown repository tool.' });
  }

  if (Buffer.byteLength(call.arguments) > MAX_TOOL_ARGUMENT_BYTES) {
    return JSON.stringify({ error: 'Tool arguments exceeded the size limit.' });
  }

  let args: unknown;
  try {
    args = JSON.parse(call.arguments) as unknown;
  } catch {
    return JSON.stringify({ error: 'Tool arguments must be a JSON object.' });
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return JSON.stringify({ error: 'Tool arguments must be a JSON object.' });
  }

  try {
    const content = JSON.stringify(await tool.run(args as Record<string, unknown>));
    if (content === undefined || Buffer.byteLength(content) > availableBytes) {
      return JSON.stringify({ error: 'The tool result exceeded the available size limit.' });
    }
    return content;
  } catch {
    return JSON.stringify({ error: 'The tool could not complete the request.' });
  }
}

export async function* streamRepositoryTools(
  provider: ModelProvider,
  initialMessages: ModelMessage[],
  tools: readonly RepositoryTool[]
): AsyncIterable<string> {
  if (!provider.streamWithTools || tools.length === 0) {
    yield* provider.stream({ messages: initialMessages });
    return;
  }

  const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = [...registry.values()].map(({ definition }) => definition);
  let messages: ModelToolMessage[] = initialMessages;
  let remainingCalls = MAX_TOOL_CALLS_PER_BATCH;
  // Error replies are short and bounded by the maximum batch size and number of rounds.
  let remainingBytes = MAX_TOTAL_TOOL_RESULT_BYTES - 2_048;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const request: ModelToolRequest = {
      messages,
      tools: definitions,
      allowToolCalls: round < MAX_TOOL_ROUNDS && remainingCalls > 0 && remainingBytes > 0,
    };
    let text = '';
    let calls: ModelToolCall[] | undefined;

    for await (const event of provider.streamWithTools(request)) {
      if (event.type === 'text') {
        text += event.content;
        yield event.content;
      } else {
        if (calls) {
          throw new Error('The model returned more than one tool call batch.');
        }
        calls = event.calls;
      }
    }

    if (!calls?.length) {
      return;
    }
    if (!request.allowToolCalls || calls.length > MAX_TOOL_CALLS_PER_BATCH) {
      throw new Error('The model exceeded the repository tool call limit.');
    }
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.id || ids.has(call.id)) {
        throw new Error('The model returned invalid repository tool call IDs.');
      }
      ids.add(call.id);
    }

    const results: ModelToolMessage[] = [];
    for (const call of calls) {
      let content = JSON.stringify({ error: 'The repository tool call budget was reached.' });
      if (remainingCalls > 0) {
        remainingCalls--;
        const availableBytes = Math.min(MAX_TOOL_RESULT_BYTES, remainingBytes);
        content =
          availableBytes > 0
            ? await runTool(call, registry, availableBytes)
            : JSON.stringify({ error: 'The repository tool result budget was reached.' });
      }
      remainingBytes -= Buffer.byteLength(content);
      results.push({ role: 'tool', toolCallId: call.id, content });
    }

    messages = [...messages, { role: 'assistant', content: text, toolCalls: calls }, ...results];
  }
}
