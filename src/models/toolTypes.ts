import type { ModelMessage } from './types';

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ModelToolMessage =
  | ModelMessage
  | { role: 'assistant'; content: string; toolCalls: ModelToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ModelToolRequest {
  messages: ModelToolMessage[];
  tools: ModelToolDefinition[];
  allowToolCalls: boolean;
}

export type ModelToolEvent =
  | { type: 'text'; content: string }
  | { type: 'tool-calls'; calls: ModelToolCall[] };

export const MAX_TOOL_CALLS_PER_BATCH = 6;
export const MAX_TOOL_ARGUMENT_BYTES = 8_192;
