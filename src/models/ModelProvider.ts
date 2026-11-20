import type { ModelToolEvent, ModelToolRequest } from './toolTypes';
import type { ModelRequest, ModelResponse } from './types';

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<string>;
  streamWithTools?(request: ModelToolRequest): AsyncIterable<ModelToolEvent>;
}
