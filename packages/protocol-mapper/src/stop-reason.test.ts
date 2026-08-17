import { describe, expect, it } from 'vitest';
import { mapStopReason } from './stop-reason.js';
describe('mapStopReason', () => {
  it('maps stop to end_turn', () => { expect(mapStopReason('stop')).toBe('end_turn'); });
  it('maps length to max_tokens', () => { expect(mapStopReason('length')).toBe('max_tokens'); });
  it('maps tool call finishes to tool_use', () => { expect(mapStopReason('tool_calls')).toBe('tool_use'); });
  it('maps content filter to refusal', () => { expect(mapStopReason('content_filter')).toBe('refusal'); });
  it('maps pause to pause_turn', () => { expect(mapStopReason('pause_turn')).toBe('pause_turn'); });
  it('maps model context exhaustion distinctly', () => { expect(mapStopReason('model_context_window_exceeded')).toBe('model_context_window_exceeded'); });
  it('falls back unknown reasons to end_turn', () => { expect(mapStopReason('weird')).toBe('end_turn'); });
});
