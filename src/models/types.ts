export type ModelMessageRole = 'system' | 'user' | 'assistant';

/** The provider-wire shape. Domain chat messages must be mapped to this shape at the service boundary. */
export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelRequest {
  /** Provider-ready messages; callers should not pass domain objects through implicitly. */
  messages: ModelMessage[];
}

export interface ModelResponse {
  content: string;
}
