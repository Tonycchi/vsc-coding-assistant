import {
  getModelValidationError,
  getOpenRouterApiKeyValidationError,
} from '../../src/extension/providerConfiguration';

describe('getOpenRouterApiKeyValidationError', () => {
  it('requires a non-blank OpenRouter API key without exposing its value', () => {
    expect(getOpenRouterApiKeyValidationError('  ')).toBe('Enter your OpenRouter API key.');
    expect(getOpenRouterApiKeyValidationError('private-invalid-value')).toBe(
      'Enter a valid OpenRouter API key beginning with "sk-or-".'
    );
    expect(getOpenRouterApiKeyValidationError('sk-or-')).toBe(
      'Enter a valid OpenRouter API key beginning with "sk-or-".'
    );
  });

  it('accepts a trimmed OpenRouter key and rejects embedded whitespace', () => {
    expect(getOpenRouterApiKeyValidationError('  sk-or-v1-test-key  ')).toBeUndefined();
    expect(getOpenRouterApiKeyValidationError('sk-or-v1-test key')).toBe(
      'Enter a valid OpenRouter API key beginning with "sk-or-".'
    );
  });
});

describe('getModelValidationError', () => {
  it('requires a non-blank model identifier', () => {
    expect(getModelValidationError(undefined)).toBe(
      'Set vscCodingAssistant.model to a model identifier in provider/model format.'
    );
    expect(getModelValidationError('   ')).toBe(
      'Set vscCodingAssistant.model to a model identifier in provider/model format.'
    );
  });

  it('requires provider/model format without whitespace', () => {
    expect(getModelValidationError('gpt-4o')).toContain('provider/model identifier');
    expect(getModelValidationError('openai/ gpt-4o')).toContain('provider/model identifier');
    expect(getModelValidationError('  openai/gpt-4o  ')).toBeUndefined();
    expect(getModelValidationError('openai/gpt-4o:free')).toBeUndefined();
  });
});
