import { describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, adminPageI18nSource, formatAdminDate, formatAdminDuration, formatAdminNumber, localizeAdminMarkup, normalizeAdminLocale, serializeAdminData, translate, translateAdminText } from './routes/admin-page-i18n.js';
import { adminPageLocaleSource } from './routes/admin-page-locale.js';

describe('Admin localization primitives', () => {
  it('localizes both setup paths and clipboard feedback', () => {
    for (const key of ['直接接入 Claude Code（推荐）', '通过 CC Switch 接入（可选）', '复制 Claude Code 配置', '复制 CC Switch 配置', '配置已复制；请安全保存，并替换尚未填写的 Runtime Key 占位符。', '复制失败，请手动选中配置并复制。']) {
      expect(translateAdminText(key, 'en')).not.toMatch(/\p{Script=Han}/u);
      expect(translateAdminText(key, 'zh-CN')).toBe(key);
    }
  });
  it('localizes the external Admin Access guidance without hiding its authorization caveat', () => {
    const keys = [
      '优先使用本机 HttpOnly 管理会话。Admin API Key 仅用于服务已由操作者自行连通后的外部管理。',
      '高级：外部管理访问（Admin API Key）',
      '优先在本机浏览器使用 HttpOnly 会话。只有操作者自行通过 LAN、VPN/mesh VPN、SSH 隧道、反向隧道/NAT 穿透或反向代理使服务可达后，才从其他浏览器、设备或自动化使用此 Key；本项目不创建隧道、不配置 NAT、也不发布服务。',
      'Admin API Key 授予完整管理权限，不要作为普通用户、Claude 或 API 凭据分享；普通客户端应使用 Runtime API Key。当前受保护 Admin API 仍接受有效 Runtime/API_KEYS，因此这是签发/使用区分，不是硬权限边界。Key 默认只保留在当前页面，勾选后才明确保存到此浏览器（localStorage）。',
    ];
    for (const key of keys) {
      expect(translateAdminText(key, 'en')).not.toMatch(/\p{Script=Han}/u);
      expect(translateAdminText(key, 'zh-CN')).toBe(key);
    }
    expect(translateAdminText('高级：外部管理访问（Admin API Key）', 'en')).toBe('Advanced: external management access (Admin API Key)');
    expect(translateAdminText(keys[3], 'en')).toContain('not a hard privilege boundary');
  });

  it('defaults to zh-CN and only accepts the supported English locale', () => {
    for (const value of [undefined, null, 'fr', 'EN', '__proto__', 'zh-CN']) expect(normalizeAdminLocale(value)).toBe('zh-CN');
    expect(normalizeAdminLocale('en')).toBe('en');
    expect(translate('概览')).toBe('概览');
    expect(translate('概览', 'en')).toBe('Overview');
    expect(translate('missing.key', 'en')).toBe('missing.key');
    expect(translate('__proto__', 'en')).toBe('__proto__');
  });

  it('provides English for every dictionary key with the same interpolation slots', () => {
    for (const [key, english] of Object.entries(ADMIN_MESSAGES)) {
      expect(english.trim(), key).not.toBe('');
      expect(english, key).not.toMatch(/\p{Script=Han}/u);
      expect(english.match(/\{\d+\}/g) ?? [], key).toEqual(key.match(/\{\d+\}/g) ?? []);
    }
  });

  it('translates complete authored messages without rewriting arbitrary provider data', () => {
    expect(translate('成功 {0}', 'en', [12])).toBe('Succeeded 12');
    expect(translateAdminText('  成功 12  ', 'en')).toBe('  Succeeded 12  ');
    expect(translateAdminText('已发现 8 个账号级模型', 'en')).toBe('Discovered 8 account models');
    expect(translateAdminText('用量未知 · 5 小时', 'en')).toBe('Unknown usage · 5 hours');
    expect(translateAdminText('customer-supplied 健康 model', 'en')).toBe('customer-supplied 健康 model');
    expect(translateAdminText('已用 25% · 剩余 75%', 'en')).toBe('Used 25% · Remaining 75%');
    expect(translateAdminText('成功 12345', 'en')).toBe('Succeeded 12,345');
    expect(translateAdminText('成功 12345', 'zh-CN')).toBe('成功 12,345');
    expect(translateAdminText('Alias 12345 是否启用', 'en')).toBe('Enable alias 12345');
  });

  it('formats dates, numbers and duration with explicit locale and sensible fallback', () => {
    const date = '2026-09-01T13:24:00.000Z';
    for (const locale of ['zh-CN', 'en'] as const) {
      expect(formatAdminDate(date, locale)).toBe(new Date(date).toLocaleString(locale, { hour12: false }));
      expect(formatAdminNumber(1234.5, locale)).toBe(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(1234.5));
    }
    expect(formatAdminDate(undefined, 'en')).toBe('Unavailable');
    expect(formatAdminDate('invalid', 'en')).toBe('invalid');
    expect(formatAdminDuration(18000)).toBe('5 小时');
    expect(formatAdminDuration(18000, 'en')).toBe('5 hours');
    expect(formatAdminDuration(0, 'en')).toBe('0 seconds');
  });

  it.each([[604800, '周', 'week'], [86400, '天', 'day'], [3600, '小时', 'hour'], [60, '分钟', 'minute'], [1, '秒', 'second']] as const)('localizes singular and plural duration unit %s in server and browser', (seconds, chinese, english) => {
    const browser = new Function(`${adminPageI18nSource()}; return { formatAdminDuration, translateAdminText, localizeAdminMarkup };`)();
    for (const api of [{ formatAdminDuration, translateAdminText, localizeAdminMarkup }, browser]) {
      for (const count of [1, 2]) {
        const expected = `${count} ${english}${count === 1 ? '' : 's'}`;
        expect(api.formatAdminDuration(seconds * count, 'en')).toBe(expected);
        expect(api.formatAdminDuration(seconds * count, 'zh-CN')).toBe(`${count} ${chinese}`);
        expect(api.translateAdminText(`用量未知 · ${count} ${chinese}`, 'en')).toBe(`Unknown usage · ${expected}`);
        expect(api.localizeAdminMarkup(`<p>${count} ${chinese}</p><code>1 weeks</code><span data-i18n-ignore>1 周</span>`, 'en'))
          .toBe(`<p>${expected}</p><code>1 weeks</code><span data-i18n-ignore>1 周</span>`);
      }
    }
    expect(translateAdminText('provider 1 weeks', 'en')).toBe('provider 1 weeks');
    expect(translateAdminText(`1.5 ${chinese}`, 'en')).toBe(`1.5 ${english}s`);
  });

  it('serializes script termination and Unicode separators safely, without losing values', () => {
    const value = { text: '</script><script>alert("x")</script>&  ' };
    const serialized = serializeAdminData(value);
    expect(serialized).not.toMatch(/[<>&]/);
    expect(serialized).not.toContain(String.fromCharCode(0x2028));
    expect(serialized).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(serialized)).toEqual(value);
    expect(adminPageI18nSource()).not.toMatch(/<\/script/i);
    const browser = new Function(`${adminPageI18nSource()}; return { translate, formatAdminDate, localizeAdminMarkup };`)();
    expect(browser.translate('概览', 'en')).toBe('Overview');
    expect(browser.formatAdminDate(undefined, 'en')).toBe('Unavailable');
    expect(browser.localizeAdminMarkup('<p>概览</p>', 'en')).toBe('<p>Overview</p>');
  });

  it('keeps raw identities, protocol values, secrets and escaped input untouched', () => {
    const html = '<h3 data-i18n-ignore>健康</h3><code>概览</code><p>健康</p><input placeholder="显示名称（可选）" value="概览"><p>&lt;script&gt;bad&lt;/script&gt;</p>';
    const result = localizeAdminMarkup(html, 'en');
    expect(result).toContain('<h3 data-i18n-ignore>健康</h3>');
    expect(result).toContain('<code>概览</code>');
    expect(result).toContain('<p>Healthy</p>');
    expect(result).toContain('placeholder="Display name (optional)" value="概览"');
    expect(result).toContain('&lt;script&gt;bad&lt;/script&gt;');
  });

  it('updates existing text nodes while preserving controls and stores only the explicit locale preference', () => {
    const nodes = [
      { nodeValue: '概览', parentElement: { closest: () => false } },
      { nodeValue: 'raw-runtime-key', parentElement: { closest: () => true } },
    ];
    const inputs = { value: 'unsaved-token', checked: true, disabled: true };
    const localeButtons = new Map(['zh-CN', 'en'].map((locale) => ['locale-' + locale, { setAttribute: vi.fn(), addEventListener: vi.fn() }]));
    const document = {
      documentElement: { lang: 'zh-CN' },
      createTreeWalker: () => { let index = 0; return { nextNode: () => nodes[index++] }; },
      querySelectorAll: () => [],
      getElementById: (id: string) => localeButtons.get(id),
    };
    const storage = { getItem: vi.fn(() => 'en'), setItem: vi.fn() };
    const observer = class { disconnect = vi.fn(); observe = vi.fn(); };
    const controls = new Function('document', 'NodeFilter', 'MutationObserver', 'localStorage', `${adminPageI18nSource()}\n${adminPageLocaleSource()}\nreturn { setAdminLocale, applyAdminTranslations };`)(document, { SHOW_TEXT: 4 }, observer, storage);
    expect(document.documentElement.lang).toBe('en');
    expect(nodes[0].nodeValue).toBe('Overview');
    expect(storage.setItem).not.toHaveBeenCalled();
    const node = nodes[0];
    controls.setAdminLocale('zh-CN');
    expect(nodes[0]).toBe(node);
    expect(node.nodeValue).toBe('概览');
    expect(nodes[1].nodeValue).toBe('raw-runtime-key');
    expect(inputs).toEqual({ value: 'unsaved-token', checked: true, disabled: true });
    expect(storage.setItem).toHaveBeenCalledWith('adminLocale', 'zh-CN');
    node.nodeValue = '数据陈旧';
    controls.setAdminLocale('en');
    expect(node.nodeValue).toBe('Stale data');
    controls.setAdminLocale('zh-CN');
    expect(node.nodeValue).toBe('数据陈旧');
  });

  it('still switches language when browser storage is blocked', () => {
    const document = {
      documentElement: { lang: '' }, createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [],
      getElementById: () => ({ setAttribute: vi.fn(), addEventListener: vi.fn() }),
    };
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const observer = class { disconnect() {} observe() {} };
    const setLocale = new Function('document', 'NodeFilter', 'MutationObserver', 'localStorage', `${adminPageI18nSource()}\n${adminPageLocaleSource()}\nreturn setAdminLocale;`)(document, { SHOW_TEXT: 4 }, observer, storage);
    expect(document.documentElement.lang).toBe('zh-CN');
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
