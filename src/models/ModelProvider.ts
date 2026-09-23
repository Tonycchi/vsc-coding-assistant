import type { ModelRequest, ModelResponse } from './types';

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
