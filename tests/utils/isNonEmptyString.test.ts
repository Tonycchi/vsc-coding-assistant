import { isNonEmptyString } from '../../src/utils/isNonEmptyString';

describe('isNonEmptyString', () => {
  it('returns true for strings with visible characters', () => {
    expect(isNonEmptyString('codex')).toBe(true);
  });

  it('returns false for empty or whitespace-only strings', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });
});
