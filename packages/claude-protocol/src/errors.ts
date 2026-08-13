export class ClaudeApiError extends Error {
  constructor(message: string, public readonly status = 400, public readonly type = 'invalid_request_error') { super(message); }
  toResponseBody() { return { type: 'error', error: { type: this.type, message: this.message } }; }
}
