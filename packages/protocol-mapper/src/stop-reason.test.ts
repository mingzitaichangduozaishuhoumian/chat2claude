import { describe, expect, it } from 'vitest';
import { mapStopReason } from './stop-reason.js';
describe('mapStopReason', () => {
  it('maps stop to end_turn', () => { expect(mapStopReason('stop')).toBe('end_turn'); });
  it('maps length to max_tokens', () => { expect(mapStopReason('length')).toBe('max_tokens'); });
});
