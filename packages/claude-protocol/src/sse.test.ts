import { describe, expect, it } from 'vitest';
import { encodeSseEvent } from './sse.js';

describe('encodeSseEvent', () => {
  it('encodes event name and json data', () => {
    expect(encodeSseEvent({ event: 'message_stop', data: { type: 'message_stop' } })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    );
  });
});
