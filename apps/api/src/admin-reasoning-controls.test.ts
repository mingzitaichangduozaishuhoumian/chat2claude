import { describe, expect, it } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { adminPageViewSource } from './routes/admin-page-view.js';
import { localizeAdminMarkup } from './routes/admin-page-i18n.js';

const script = adminPageClientScript();
const helpers = script.slice(script.indexOf('function controlSelectsHtml('), script.indexOf("document.getElementById('create-model-form')"));
const renderControls = new Function(`${adminPageViewSource()}\n${helpers}\nreturn controlSelectsHtml;`)();
const renderCapabilityState = new Function(`${adminPageViewSource()}\n${helpers}\nreturn capabilityStateHtml;`)();

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
    expect(options).not.toContain('主动协作');
  });

  it('keeps selected Ultra separate from its base reasoning effort', () => {
    const options = reasoningOptions(['xhigh', 'max', 'ultra'], 'ultra');
    expect(selectedValues(options)).toEqual(['ultra']);
    expect(options).toMatch(/value="ultra"[^>]*selected>Ultra（主动协作）<\/option>/);
  });

  it.each(['xhigh', 'max', 'Future_Deep'])('shows the advertised Ultra base effort %s and client execution boundary in both locales', (effort) => {
    const html = renderCapabilityState({ capabilities: {
      ultra_execution: { reasoning_effort: effort, delegation: 'caller_tools' },
      metadata_status: { reasoning: 'known' },
    } }) as string;
    expect(html).toContain('Ultra 基础推理：' + effort);
    expect(html).toContain('主动协作依赖客户端提供并执行委托工具；没有委托工具时直接完成任务。');
    expect(html).toContain('本服务不创建子代理；子代理执行、并行数和轮数由客户端控制。');
    const english = localizeAdminMarkup(html, 'en');
    expect(english).toContain('Ultra base reasoning effort: ' + effort);
    expect(english).toContain('delegation tools supplied and executed by the client');
    expect(english).toContain('the client controls subagent execution, concurrency, and turns');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });

  it('does not invent an Ultra base effort when execution metadata is absent', () => {
    const html = renderCapabilityState({ capabilities: { ultra_lossy: false } }) as string;
    expect(html).not.toContain('Ultra 基础推理');
    expect(html).not.toContain('xhigh');
    expect(html).not.toContain('max');
  });

  it.each([undefined, 'xhigh'])('shows account-dependent execution instead of a single effort (%s)', (effort) => {
    const html = renderCapabilityState({ capabilities: {
      ultra_execution: { delegation: 'caller_tools', account_dependent: true, reasoning_effort: effort },
    } }) as string;
    expect(html).toContain('实际基础推理按所选账号的模型目录确定');
    expect(html).toContain('主动协作依赖客户端提供并执行委托工具');
    expect(html).not.toContain('Ultra 基础推理：');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('xhigh');
    const english = localizeAdminMarkup(html, 'en');
    expect(english).toContain('The actual base reasoning effort is resolved from the selected account&#39;s model catalog');
    expect(english).not.toContain('Ultra base reasoning effort:');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });
});
