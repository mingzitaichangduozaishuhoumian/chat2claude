export class ChatGptBackendError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); }
}
