import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, type ChatGptModelDiscoveryDiagnostic } from './index.js';

describe('ChatGptBackendError discovery metadata', () => {
  it('copies and freezes allowlisted diagnostic primitives, dropping arbitrary provider fields', () => {
    const raw = { eventType: 'DIAGNOSTIC_CANARY', responseStatus: 'DIAGNOSTIC_CANARY', responseErrorCode: 'DIAGNOSTIC_CANARY', incompleteReason: 'DIAGNOSTIC_CANARY', failurePhase: 'response_event', httpStatus: 200,
      message: 'DIAGNOSTIC_CANARY', param: 'DIAGNOSTIC_CANARY', detail: 'DIAGNOSTIC_CANARY', details: { explanation: 'DIAGNOSTIC_CANARY' }, raw: 'DIAGNOSTIC_CANARY' };
    const error = new ChatGptBackendError('Failed', 'upstream_error', { safeDiagnostic: raw as never });
    raw.failurePhase = 'DIAGNOSTIC_CANARY';
    expect(error.safeDiagnostic).toEqual({ eventType: 'unknown', responseStatus: 'unknown', responseErrorCode: 'unknown', incompleteReason: 'unknown', failurePhase: 'response_event', httpStatus: 200 });
    expect(Object.isFrozen(error.safeDiagnostic)).toBe(true);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('DIAGNOSTIC_CANARY');
  });

  it('defensively copies and freezes HTTP error code/type/parameter enums', () => {
    const raw = { responseErrorCode: 'unsupported_parameter', responseErrorType: 'invalid_request_error', responseErrorParam: 'max_output_tokens' };
    const error = new ChatGptBackendError('Failed', 'upstream_error', { safeDiagnostic: raw as never });
    raw.responseErrorCode = raw.responseErrorType = raw.responseErrorParam = 'HTTP_CANARY';
    expect(error.safeDiagnostic).toEqual({ responseErrorCode: 'unsupported_parameter', responseErrorType: 'invalid_request_error', responseErrorParam: 'max_output_tokens' });
    expect(Object.isFrozen(error.safeDiagnostic)).toBe(true);
    const unknown = new ChatGptBackendError('Failed', 'upstream_error', { safeDiagnostic: raw as never });
    expect(unknown.safeDiagnostic).toEqual({ responseErrorCode: 'unknown', responseErrorType: 'unknown', responseErrorParam: 'unknown' });
    expect(JSON.stringify([error, unknown])).not.toContain('HTTP_CANARY');
  });

  it.each([NaN, Infinity, -1, 200.5, 600, '200'])('discards invalid initial HTTP status %s', (httpStatus) => {
    expect(new ChatGptBackendError('Failed', 'upstream_error', { safeDiagnostic: { httpStatus, failurePhase: 'DIAGNOSTIC_CANARY' } as never }).safeDiagnostic).toEqual({});
  });

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
