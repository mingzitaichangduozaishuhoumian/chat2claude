import { randomBytes, timingSafeEqual } from 'node:crypto';

export const LOCAL_ADMIN_SESSION_COOKIE = 'chat2claude_admin_session';

export class LocalAdminSession {
  readonly enabled: boolean;
  private readonly token = randomBytes(32).toString('base64url');

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  issueCookie(requestHost: string | undefined, requestUrl: string): string | undefined {
    if (!this.enabled || !isTrustedLocalRequestHost(requestHost, requestUrl)) return undefined;
    const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
    return `${LOCAL_ADMIN_SESSION_COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/admin${secure}`;
  }

  matches(cookieHeader: string | undefined, requestHost: string | undefined, requestUrl: string): boolean {
    if (!this.enabled || !isTrustedLocalRequestHost(requestHost, requestUrl)) return false;
    const token = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${LOCAL_ADMIN_SESSION_COOKIE}=`))?.slice(LOCAL_ADMIN_SESSION_COOKIE.length + 1);
    if (!token) return false;
    const received = Buffer.from(token);
    const expected = Buffer.from(this.token);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
}

export function isTrustedLocalRequestHost(host: string | undefined, requestUrl: string): boolean {
  if (!isTrustedLocalHost(host)) return false;
  try {
    return new URL(`http://${host}`).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

export function isTrustedLocalHost(host: string | undefined): boolean {
  if (!host) return false;

  const match = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::(\d+))?$/i.exec(host);
  if (!match || (match[2] !== undefined && !isValidPort(match[2]))) return false;

  if (match[1].startsWith('127.')) {
    return match[1].split('.').every((octet) => Number(octet) <= 255);
  }
  return true;
}

function isValidPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535;
}
