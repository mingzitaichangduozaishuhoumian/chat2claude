export function createId(prefix: string): string {
  const random = crypto.randomUUID().replaceAll('-', '');
  return `${prefix}_${random}`;
}
export function createMessageId(): string { return createId('msg'); }
export function createRequestId(): string { return createId('req'); }
