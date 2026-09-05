import { arch, release, type } from 'node:os';

// Protocol baseline, not this package's version. Official release and identity:
// https://github.com/openai/codex/releases/tag/rust-v0.153.4
// https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/login/src/auth/default_client.rs
export const DEFAULT_CODEX_CLIENT_VERSION = '0.153.4';
export const CODEX_ORIGINATOR = 'codex_cli_rs';

/** Strict SemVer, including official prereleases; never echo an invalid value. */
export function normalizeCodexClientVersion(value: string | undefined): string {
  if (value === undefined) return DEFAULT_CODEX_CLIENT_VERSION;
  const numeric = '(?:0|[1-9][0-9]*)';
  const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (value.length > 128 || !semver.test(value) || /[^\x21-\x7e]/.test(value)) {
    throw new Error('CODEX_CLIENT_VERSION must be a valid SemVer version (maximum 128 ASCII characters).');
  }
  return value;
}

/** Omit terminal/environment details; only bounded, header-safe OS components. */
export function codexUserAgent(version: string, storedUserAgent?: string): string {
  const validatedVersion = normalizeCodexClientVersion(version);
  if (storedUserAgent && storedUserAgent.length <= 512 && /^[\x20-\x7e]+$/.test(storedUserAgent) && storedUserAgent.trim()) {
    return storedUserAgent;
  }
  const component = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  return `${CODEX_ORIGINATOR}/${validatedVersion} (${component(type())} ${component(release())}; ${component(arch())})`;
}
