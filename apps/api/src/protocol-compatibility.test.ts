import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clientCompatibilitySmokeScenarios,
  protocolCompatibilityManifest,
  protocolCompatibilityStatuses,
} from './protocol-compatibility.js';

const docsRoot = resolve(import.meta.dirname, '../../../docs');

function readDoc(name: string): string {
  return readFileSync(resolve(docsRoot, name), 'utf8');
}

function documentedTableRows(markdown: string): Array<{ section: string; cells: string[] }> {
  let currentSection = '';
  const rows: Array<{ section: string; cells: string[] }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##+ (.+)$/.exec(line);
    if (heading) currentSection = heading[1];
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length > 0) rows.push({ section: currentSection, cells });
  }
  return rows;
}

function documentedManifestRows(markdown: string): Array<{ protocol: string; feature: string; status: string; notes: string }> {
  const rows: Array<{ protocol: string; feature: string; status: string; notes: string }> = [];
  for (const { section, cells } of documentedTableRows(markdown)) {
    if (cells.includes('Manifest feature')) continue;
    if (section === 'Claude Messages API' && cells.length >= 3) {
      rows.push({ protocol: 'claude_messages', feature: unquote(cells[0]), status: unquote(cells[1]), notes: cells[2] });
    }
    if (section === 'OpenAI compatibility routes' && cells.length >= 4) {
      const protocol = cells[0] === 'Chat Completions' ? 'openai_chat_completions' : cells[0] === 'Responses' ? 'openai_responses' : cells[0];
      rows.push({ protocol, feature: unquote(cells[1]), status: unquote(cells[2]), notes: cells[3] });
    }
    if (section === 'ChatGPT/Codex backend' && cells.length >= 3) {
      rows.push({ protocol: 'chatgpt_codex_backend', feature: unquote(cells[0]), status: unquote(cells[1]), notes: cells[2] });
    }
  }
  return rows;
}

function documentedSmokeRows(markdown: string): Array<{ client: string; baseUrl: string; endpoints: string[] }> {
  return documentedTableRows(markdown)
    .filter(({ section, cells }) => ['Real-client smoke scenarios', 'Real-client smoke matrix', '真实客户端 smoke 矩阵'].includes(section) && !cells.includes('Client'))
    .map(({ cells }) => ({ client: cells[0], baseUrl: unquote(cells[1]), endpoints: splitEndpoints(cells[2]) }));
}

function splitEndpoints(value: string): string[] {
  return value.split(',').map((endpoint) => unquote(endpoint.trim())).filter(Boolean);
}

function unquote(value: string): string {
  return value.replace(/^`|`$/g, '');
}

function normalizeMarkdownTableCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('protocol compatibility manifest', () => {
  it('uses only the documented conservative statuses and has a unique feature contract', () => {
    const allowed = new Set(protocolCompatibilityStatuses);
    expect(protocolCompatibilityStatuses).toEqual([
      'supported', 'partial', 'downgraded', 'estimated', 'unsupported', 'backend_dependent',
    ]);
    expect(protocolCompatibilityManifest.length).toBeGreaterThan(0);
    expect(new Set(protocolCompatibilityManifest.map((entry) => `${entry.protocol}:${entry.feature}`)).size)
      .toBe(protocolCompatibilityManifest.length);
    for (const entry of protocolCompatibilityManifest) {
      expect(allowed.has(entry.status)).toBe(true);
      expect(entry.note).toBeTruthy();
    }
  });

  it('keeps the markdown compatibility matrix synchronized with the manifest', () => {
    const markdown = readDoc('protocol-compatibility.md');
    for (const status of protocolCompatibilityStatuses) {
      expect(markdown).toContain(`- \`${status}\``);
    }

    const documented = documentedManifestRows(markdown);
    expect(documented).toHaveLength(protocolCompatibilityManifest.length);
    expect(new Set(documented.map((entry) => `${entry.protocol}:${entry.feature}`)).size)
      .toBe(documented.length);

    for (const entry of protocolCompatibilityManifest) {
      const matches = documented.filter((row) => row.protocol === entry.protocol && row.feature === entry.feature);
      expect(matches, `${entry.protocol}:${entry.feature}`).toHaveLength(1);
      expect(matches[0].status).toBe(entry.status);
      expect(normalizeMarkdownTableCell(matches[0].notes)).toBe(normalizeMarkdownTableCell(entry.note));
    }

    const manifestKeys = new Set(protocolCompatibilityManifest.map((entry) => `${entry.protocol}:${entry.feature}`));
    for (const row of documented) {
      expect(manifestKeys.has(`${row.protocol}:${row.feature}`), `${row.protocol}:${row.feature}`).toBe(true);
    }
  });

  it('documents each real-client smoke scenario and its base URL family', () => {
    const docs = [readDoc('protocol-compatibility.md'), readDoc('USAGE.en.md'), readDoc('USAGE.zh-CN.md')];
    for (const markdown of docs) {
      const rows = documentedSmokeRows(markdown);
      expect(rows, markdown.slice(0, 80)).toHaveLength(clientCompatibilitySmokeScenarios.length);
      for (const scenario of clientCompatibilitySmokeScenarios) {
        const matches = rows.filter((row) => row.client === scenario.client);
        expect(matches, scenario.client).toHaveLength(1);
        const expectedBase = scenario.baseUrl === 'root_origin' ? 'http://127.0.0.1:3000' : 'http://127.0.0.1:3000/v1';
        expect(matches[0].baseUrl).toBe(expectedBase);
        expect(matches[0].endpoints).toEqual(scenario.endpoints);
      }
    }
  });
});
