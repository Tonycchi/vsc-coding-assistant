export type ModelMessageRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
}

export interface ModelResponse {
  content: string;
}
