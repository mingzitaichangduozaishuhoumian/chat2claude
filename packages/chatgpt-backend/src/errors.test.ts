import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, type ChatGptModelDiscoveryDiagnostic } from './index.js';

describe('ChatGptBackendError discovery metadata', () => {
  it('carries typed safe diagnostics without requiring a raw cause', () => {
    const diagnostic: ChatGptModelDiscoveryDiagnostic = {
      clientVersion: '1.2.3', httpStatus: 200, contentType: 'json', envelope: 'models',
      candidateCount: 1, acceptedCount: 0, rejectedCount: 1, duplicateCount: 0, reasons: ['invalid_model_id'],
    };
    const error = new ChatGptBackendError('Incompatible model response.', 'invalid_response', { status: 502, discoveryDiagnostic: diagnostic });
    expect(error).toMatchObject({ code: 'invalid_response', status: 502, discoveryDiagnostic: diagnostic, cause: undefined });
    expect(JSON.parse(JSON.stringify(error)).discoveryDiagnostic).toEqual(diagnostic);
  });

  it('preserves existing code and legacy cause constructor signatures', () => {
    const cause = new Error('local failure');
    expect(new ChatGptBackendError('Failed', cause, { code: 'network_error' })).toMatchObject({ code: 'network_error', cause });
    expect(new ChatGptBackendError('Failed', 'timeout', { status: 504, cause })).toMatchObject({ code: 'timeout', status: 504, cause });
    expect(new ChatGptBackendError('Failed').discoveryDiagnostic).toBeUndefined();
  });
});
