import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors';
import { parseServerEnv } from './env';

describe('parseServerEnv', () => {
  it('applies development defaults when nothing is set', () => {
    const env = parseServerEnv({});
    expect(env.MODEL_PROVIDER).toBe('ollama');
    expect(env.MODEL_NAME).toBe('gemma3:4b');
    expect(env.MODEL_BASE_URL).toBe('http://localhost:11434');
    expect(env.MODEL_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.isProduction).toBe(false);
  });

  it('treats blank values as unset so empty placeholders fall back to defaults', () => {
    const env = parseServerEnv({ MODEL_NAME: '   ', MONGODB_URI: '' });
    expect(env.MODEL_NAME).toBe('gemma3:4b');
    expect(env.MONGODB_URI).toBeUndefined();
  });

  it('coerces numeric strings', () => {
    const env = parseServerEnv({ MODEL_MAX_RETRIES: '4', MODEL_TEMPERATURE: '0.2' });
    expect(env.MODEL_MAX_RETRIES).toBe(4);
    expect(env.MODEL_TEMPERATURE).toBe(0.2);
  });

  it('rejects an unknown model provider', () => {
    expect(() => parseServerEnv({ MODEL_PROVIDER: 'anthropic' })).toThrow(ConfigurationError);
  });

  it('rejects a malformed model base url', () => {
    expect(() => parseServerEnv({ MODEL_BASE_URL: 'localhost:11434' })).toThrow(ConfigurationError);
  });

  it('rejects an out-of-range temperature', () => {
    expect(() => parseServerEnv({ MODEL_TEMPERATURE: '5' })).toThrow(ConfigurationError);
  });

  it('names the offending variable in the message', () => {
    expect(() => parseServerEnv({ MODEL_MAX_RETRIES: '99' })).toThrow(/MODEL_MAX_RETRIES/);
  });

  it('marks production', () => {
    expect(parseServerEnv({ NODE_ENV: 'production' }).isProduction).toBe(true);
  });
});
