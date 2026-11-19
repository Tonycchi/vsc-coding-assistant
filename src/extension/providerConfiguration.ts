const OPENROUTER_API_KEY_PREFIX = 'sk-or-';

export function getOpenRouterApiKeyValidationError(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Enter your OpenRouter API key.';
  }

  const apiKey = value.trim();
  if (
    !apiKey.startsWith(OPENROUTER_API_KEY_PREFIX) ||
    apiKey.length === OPENROUTER_API_KEY_PREFIX.length ||
    /\s/.test(apiKey)
  ) {
    return 'Enter a valid OpenRouter API key beginning with "sk-or-".';
  }

  return undefined;
}

export function getModelValidationError(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Set vscCodingAssistant.model to a model identifier in provider/model format.';
  }

  const model = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(model)) {
    return 'Set vscCodingAssistant.model to a valid provider/model identifier, for example "openai/gpt-4o".';
  }

  return undefined;
}
