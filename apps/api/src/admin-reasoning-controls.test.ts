import { describe, expect, it } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { adminPageViewSource } from './routes/admin-page-view.js';

const script = adminPageClientScript();
const helpers = script.slice(script.indexOf('function controlSelectsHtml('), script.indexOf("document.getElementById('create-model-form')"));
const renderControls = new Function(`${adminPageViewSource()}\n${helpers}\nreturn controlSelectsHtml;`)();

function reasoningOptions(efforts: string[], current: string): string {
  const html = renderControls(
    { capabilities: { reasoning_effort_options: efforts.map((effort) => ({ effort })) } },
    { reasoning_effort: current, speed: 'standard' },
    'sonnet',
  ) as string;
  return html.match(/<select data-field="reasoning_effort"[^>]*>([\s\S]*?)<\/select>/)![1];
}

function selectedValues(options: string): string[] {
  return [...options.matchAll(/<option value="([^"]+)"[^>]*\sselected(?:\s|>)/g)].map((match) => match[1]);
}

describe('Admin reasoning controls preserve provider values', () => {
  it.each(['Future_Deep', 'future_deep'])('selects only the exact case-sensitive effort %s', (current) => {
    const options = reasoningOptions(['Future_Deep', 'future_deep', 'low'], current);
    expect(selectedValues(options)).toEqual([current]);
    expect(options).not.toContain('配置不受目标支持');
  });

  it('does not treat an unadvertised case variant as a supported provider effort', () => {
    const options = reasoningOptions(['Future_Deep', 'future_deep'], 'FUTURE_DEEP');
    expect(selectedValues(options)).toEqual(['FUTURE_DEEP']);
    expect(options).toContain('FUTURE_DEEP（配置不受目标支持）');
  });

  it.each(['Light', 'LOW', 'Ultra'])('prefers exact native %s over a known alias fallback', (current) => {
    const options = reasoningOptions(['low', 'ultra', current], current);
    expect(selectedValues(options)).toEqual([current]);
    expect(options).toMatch(new RegExp('value="' + current + '"[^>]*selected>' + current + '</option>'));
  });

  it.each([
    ['Light', 'low'],
    ['off', 'none'],
    ['extra_high', 'xhigh'],
    ['ULTRA', 'ultra'],
  ])('uses the known %s compatibility spelling only when %s is advertised', (current, advertised) => {
    const options = reasoningOptions([advertised], current);
    expect(selectedValues(options)).toEqual([advertised]);
    expect(options).not.toContain('配置不受目标支持');
  });

  it('keeps native mixed-case labels and underscores unchanged', () => {
    const options = reasoningOptions(['LOW', 'Ultra', 'Future_Deep'], 'Future_Deep');
    expect(options).toMatch(/value="LOW"[^>]*>LOW<\/option>/);
    expect(options).toMatch(/value="Ultra"[^>]*>Ultra<\/option>/);
    expect(options).toMatch(/value="Future_Deep"[^>]*>Future_Deep<\/option>/);
    expect(options).not.toContain('官方 low');
    expect(options).not.toContain('上游 ultra');
  });
});
