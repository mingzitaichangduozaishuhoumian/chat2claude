/** In-place localization: no form rebuilding, network calls or credential storage. */
export function adminPageLocaleSource(): string {
  return String.raw`
const adminTextSources = new WeakMap();
const adminAttributeSources = new WeakMap();
const adminIgnoredText = 'script, style, code, pre, [data-i18n-ignore]';
let adminTranslationObserver;

function originalAdminText(value, previous) {
  if (previous && value === previous.rendered) return previous.source;
  // Pending actions can restore a label captured in the previous locale.
  const known = Object.entries(ADMIN_MESSAGES).find((entry) => entry[1] === value);
  return known ? known[0] : value;
}
function applyAdminTranslations() {
  if (adminTranslationObserver) adminTranslationObserver.disconnect();
  try {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || node.parentElement.closest(adminIgnoredText)) continue;
      const source = originalAdminText(node.nodeValue, adminTextSources.get(node));
      const rendered = translateAdminText(source, adminLocale);
      adminTextSources.set(node, { source, rendered });
      if (node.nodeValue !== rendered) node.nodeValue = rendered;
    }
    document.querySelectorAll('[aria-label], [aria-valuetext], [placeholder], [title]').forEach((element) => {
      if (element.closest('[data-i18n-ignore]')) return;
      const sources = adminAttributeSources.get(element) || {};
      ['aria-label', 'aria-valuetext', 'placeholder', 'title'].forEach((name) => {
        if (!element.hasAttribute(name)) return;
        const source = originalAdminText(element.getAttribute(name), sources[name]);
        const rendered = translateAdminText(source, adminLocale);
        sources[name] = { source, rendered };
        if (element.getAttribute(name) !== rendered) element.setAttribute(name, rendered);
      });
      adminAttributeSources.set(element, sources);
    });
    document.querySelectorAll('table').forEach((table) => {
      table.setAttribute('role', 'table');
      const headings = Array.from(table.querySelectorAll('thead th'));
      headings.forEach((heading) => { heading.setAttribute('scope', 'col'); heading.setAttribute('role', 'columnheader'); });
      table.querySelectorAll('tr').forEach((row) => row.setAttribute('role', 'row'));
      table.querySelectorAll('tbody tr').forEach((row) => {
        Array.from(row.children).forEach((cell, index) => {
          cell.setAttribute('role', 'cell');
          cell.setAttribute('data-label', headings[index]?.textContent || '');
        });
      });
    });
    document.querySelectorAll('[data-admin-date]').forEach((element) => {
      const text = formatAdminDate(element.dataset.adminDate, adminLocale);
      if (element.textContent !== text) element.textContent = text;
    });
    document.querySelectorAll('[data-admin-number]').forEach((element) => {
      const text = formatAdminNumber(Number(element.dataset.adminNumber), adminLocale);
      if (element.textContent !== text) element.textContent = text;
    });
  } finally {
    if (adminTranslationObserver) adminTranslationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-valuetext', 'placeholder', 'title'] });
  }
}
function setAdminLocale(locale, remember = true) {
  adminLocale = normalizeAdminLocale(locale);
  if (remember) {
    try { localStorage.setItem('adminLocale', adminLocale); } catch { /* Storage may be blocked; the page still works. */ }
  }
  document.documentElement.lang = adminLocale;
  ['zh-CN', 'en'].forEach((name) => document.getElementById('locale-' + name).setAttribute('aria-pressed', String(name === adminLocale)));
  applyAdminTranslations();
}
['zh-CN', 'en'].forEach((locale) => document.getElementById('locale-' + locale).addEventListener('click', () => setAdminLocale(locale)));
adminTranslationObserver = new MutationObserver(applyAdminTranslations);
let savedAdminLocale;
try { savedAdminLocale = localStorage.getItem('adminLocale'); } catch { /* Use the SSR default. */ }
setAdminLocale(savedAdminLocale, false);
`;
}
