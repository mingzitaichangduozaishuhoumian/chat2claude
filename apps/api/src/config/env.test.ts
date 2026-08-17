import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('defaults host to localhost only', () => {
    expect(loadEnv({}).host).toBe('127.0.0.1');
  });

  it('allows explicit host override', () => {
    expect(loadEnv({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});
