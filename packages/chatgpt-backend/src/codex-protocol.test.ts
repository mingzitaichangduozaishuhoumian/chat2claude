import { describe, expect, it } from 'vitest';
import { CODEX_ORIGINATOR, DEFAULT_CODEX_CLIENT_VERSION, codexUserAgent, normalizeCodexClientVersion } from './codex-protocol.js';

describe('Codex protocol identity', () => {
  it('pins an official client release independently of the package version', () => {
    expect(DEFAULT_CODEX_CLIENT_VERSION).toBe('0.153.4');
    expect(normalizeCodexClientVersion(undefined)).toBe(DEFAULT_CODEX_CLIENT_VERSION);
    expect(CODEX_ORIGINATOR).toBe('codex_cli_rs');
  });

  it('generates a bounded platform-aware official-style User-Agent', () => {
    const agent = codexUserAgent('1.2.3-alpha.1');
    expect(agent).toMatch(/^codex_cli_rs\/1\.2\.3-alpha\.1 \([A-Za-z0-9._-]+ [A-Za-z0-9._-]+; [A-Za-z0-9._-]+\)$/);
    expect(agent.length).toBeLessThan(512);
  });

  it('preserves intentional safe account overrides', () => {
    expect(codexUserAgent('1.2.3', 'stored-client/7 (test)')).toBe('stored-client/7 (test)');
  });

  it.each(['', ' ', 'bad\r\nheader: value', `bad${String.fromCharCode(0)}agent`, 'non-ascii-☃', 'a'.repeat(513)])('falls back for an unsafe stored User-Agent (%j)', (agent) => {
    expect(codexUserAgent('1.2.3', agent)).toBe(codexUserAgent('1.2.3'));
  });

  it.each(['1.2.3\n', '1.2.3\r\nheader: value', '1.2.3-01', '01.2.3', '', 'secret-version'])('rejects invalid versions before building headers (%j)', (version) => {
    expect(() => codexUserAgent(version, 'stored-safe')).toThrow('CODEX_CLIENT_VERSION must be a valid SemVer version');
  });
});
