export const ADMIN_PAGE_STYLES = String.raw`
:root {
  color-scheme: light;
  --canvas: rgb(236 235 230);
  --surface: rgb(248 247 242);
  --surface-raised: rgb(255 254 249);
  --surface-muted: rgb(228 227 221);
  --ink: rgb(31 34 32);
  --ink-soft: rgb(80 84 80);
  --ink-faint: rgb(96 100 95);
  --line: rgb(194 195 188);
  --line-strong: rgb(143 147 141);
  --accent: rgb(35 89 81);
  --accent-soft: rgb(218 232 227);
  --positive: rgb(37 105 73);
  --positive-soft: rgb(220 237 226);
  --warning: rgb(143 91 24);
  --warning-soft: rgb(244 232 210);
  --negative: rgb(145 55 43);
  --negative-soft: rgb(244 222 217);
  --focus: rgb(24 99 131);
  --shadow: 0 18px 50px rgb(38 41 38 / 0.09);
  --font-display: "IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", sans-serif;
  --font-body: "Source Sans 3", "Noto Sans SC", "Microsoft YaHei UI", sans-serif;
  --font-mono: "Iosevka Term", "Cascadia Code", "SFMono-Regular", monospace;
}
* { box-sizing: border-box; }
button, label, p, h1, h2, h3, h4, li, span { overflow-wrap: anywhere; }
input, select, button, .row > *, .panel-heading > * { min-width: 0; max-width: 100%; }
input[type="checkbox"] { width: 22px; min-height: 22px; accent-color: var(--accent); }
label:has(input[type="checkbox"]) { display: flex; gap: 10px; align-items: center; min-height: 44px; }
html { scroll-behavior: smooth; }
body { margin: 0; min-width: 0; min-height: 100vh; overflow-wrap: anywhere; color: var(--ink); background: var(--canvas); font-family: var(--font-body); line-height: 1.55; }
button, input, select { font: inherit; }
button, a, input, select, summary { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
button { min-height: 44px; border: 1px solid var(--ink); border-radius: 4px; padding: 9px 14px; color: var(--surface-raised); background: var(--ink); font-weight: 700; cursor: pointer; }
button:hover { background: rgb(52 56 53); }
button:disabled { opacity: 0.48; cursor: not-allowed; }
button.secondary { color: var(--ink); background: var(--surface-raised); border-color: var(--line-strong); }
button.secondary:hover { background: var(--surface-muted); }
button.danger-button { color: var(--negative); background: var(--surface-raised); border-color: var(--negative); }
button.danger-button:hover { background: var(--negative-soft); }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
input, select { width: 100%; min-height: 44px; border: 1px solid var(--line-strong); border-radius: 4px; padding: 9px 11px; color: var(--ink); background: var(--surface-raised); }
code, pre { font-family: var(--font-mono); }
code { overflow-wrap: anywhere; }
pre { margin: 0; max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 4px; padding: 14px; color: rgb(27 58 53); background: rgb(231 236 232); }
[hidden] { display: none !important; }
.wrap-anywhere { overflow-wrap: anywhere; word-break: break-word; min-width: 0; max-width: 100%; }
.muted { color: var(--ink-faint); }
.eyebrow { display: block; color: var(--ink-faint); font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.admin-shell { width: min(1680px, 100%); margin: 0 auto; padding: 16px 24px 32px; }
.topbar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; align-items: center; border-bottom: 2px solid var(--ink); padding: 12px 0 18px; }
.brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
.brand-mark { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 46px; background: var(--accent); color: var(--surface-raised); font-family: var(--font-mono); font-weight: 800; }
.console-controls { display: flex; flex-wrap: wrap; gap: 10px; }
.brand h1 { margin: 0; font-family: var(--font-display); font-size: 22px; line-height: 1.2; letter-spacing: -0.035em; }
.brand p { max-width: 820px; margin: 0; color: var(--ink-soft); }
.mode-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid var(--line); background: var(--surface-muted); }
.mode-toggle button { min-height: 44px; padding: 6px 10px; border-color: transparent; color: var(--ink-soft); background: transparent; }
.mode-toggle button[aria-pressed="true"] { color: var(--surface-raised); background: var(--accent); }
.workspace { display: grid; grid-template-columns: 218px minmax(0, 1fr); gap: 28px; margin-top: 24px; }
.module-nav { position: sticky; top: 20px; align-self: start; display: grid; gap: 4px; padding: 0 12px 16px 0; border-right: 1px solid var(--line); }
.nav-group { margin: 16px 10px 5px; font-size: 11px; color: var(--ink-faint); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
.nav-group:first-child { margin-top: 0; }
.module-nav button { display: grid; grid-template-columns: 30px 1fr; gap: 10px; align-items: center; text-align: left; color: var(--ink-soft); background: transparent; border-color: transparent; }
.module-nav button::before { content: attr(data-index); display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); font-family: var(--font-mono); font-size: 11px; }
.module-nav button[aria-selected="true"] { color: var(--surface-raised); background: var(--ink); }
.module-nav button[aria-selected="true"]::before { border-color: rgb(255 255 255 / 0.45); }
.modules { min-width: 0; }
.admin-module { display: grid; gap: 16px; }
.module-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: end; padding: 0 0 18px; border-bottom: 1px solid var(--line-strong); }
.module-header h2 { margin: 5px 0 8px; font-family: var(--font-display); font-size: clamp(26px, 3vw, 34px); letter-spacing: -0.035em; line-height: 1.2; }
.module-header p { max-width: 760px; margin: 0; color: var(--ink-soft); }
.panel { min-width: 0; border: 1px solid var(--line); padding: clamp(16px, 2.4vw, 24px); background: var(--surface); }
.setup-recommended { border-top: 3px solid var(--accent); }
.panel h3, .panel h2 { margin: 0 0 6px; font-family: var(--font-display); }
.panel-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 14px; }
.row, .card-actions, .form-actions, .stat-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.stack { display: grid; gap: 12px; }
.session-strip { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; margin: 14px 0; border-left: 4px solid var(--positive); padding: 12px 14px; background: var(--positive-soft); }
.session-strip.warn { border-left-color: var(--warning); background: var(--warning-soft); }
.session-strip strong, .session-strip span { display: block; }
.one-time-key { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; margin: 0 0 14px; border-left: 4px solid var(--accent); padding: 14px; background: var(--accent-soft); }
.one-time-key strong, .one-time-key code { display: block; }
.one-time-key code { margin-top: 6px; color: var(--ink); }
.one-time-key .secret-value { margin-top: 8px; width: 100%; min-height: 92px; resize: vertical; color: var(--ink); background: var(--surface-raised); font-family: var(--font-mono); overflow-wrap: anywhere; word-break: break-all; }
.one-time-key p { margin: 6px 0 0; }
.state-badge { display: inline-flex; align-items: center; width: fit-content; min-width: 0; max-width: 100%; min-height: 28px; border: 1px solid currentColor; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 800; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
.state-badge.positive { color: var(--positive); background: var(--positive-soft); }
.state-badge.warning { color: var(--warning); background: var(--warning-soft); }
.state-badge.negative { color: var(--negative); background: var(--negative-soft); }
.state-badge.neutral { color: var(--ink-soft); background: var(--surface-muted); }
.oauth-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 0.45fr); gap: 16px; }
.oauth-actions, .auth-link-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.auth-link-area { display: grid; gap: 8px; min-width: 0; margin-top: 12px; }
.auth-url-display { display:block;min-width:0;max-width:100%; border: 1px solid var(--line); padding: 10px; overflow-wrap:anywhere; word-break:break-word; white-space: normal; background: var(--surface-muted); }
.oauth-callback-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.steps { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; counter-reset: step; border-top: 1px solid var(--line); }
.steps li { counter-increment: step; display: grid; grid-template-columns: 38px 1fr; gap: 10px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.steps li::before { content: counter(step, decimal-leading-zero); font-family: var(--font-mono); font-weight: 800; color: var(--accent); }
.account-grid, .quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 14px; }
.account-card, .quota-card { min-width: 0; border: 1px solid var(--line-strong); padding: 16px; background: var(--surface-raised); }
.card-header { display: flex; justify-content: space-between; gap: 14px; align-items: start; padding-bottom: 13px; border-bottom: 1px solid var(--line); }
.identity { min-width: 0; }
.identity h3 { margin: 3px 0 2px; font-family: var(--font-display); font-size: 20px; line-height: 1.15; }
.identity p { margin: 0; color: var(--ink-soft); font-size: 13px; }
.account-summary, .technical-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; margin: 12px 0; border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.account-summary div, .technical-list div { min-width: 0; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 9px; }
dt { color: var(--ink-faint); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
dd { min-width: 0; margin: 2px 0 0; overflow-wrap: anywhere; }
.stat-line { margin-bottom: 12px; color: var(--ink-soft); font-family: var(--font-mono); font-size: 12px; }
.stat-line span { border-left: 2px solid var(--line-strong); padding-left: 7px; }
[data-admin-mode="simple"] [data-professional-only], [data-admin-mode="simple"] [id="admin-key-fallback"] { display: none !important; }
.professional-detail { margin: 12px 0; border-top: 1px dashed var(--line-strong); padding-top: 12px; }
.model-disclosure ul { display: grid; gap: 7px; margin: 10px 0 0; padding: 0; list-style: none; }
.model-disclosure li { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 7px; }
.account-settings { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 0.4fr); gap: 10px; margin-top: 12px; border-top: 1px dashed var(--line-strong); padding-top: 12px; }
.account-settings label { display: grid; gap: 5px; font-weight: 700; }
.account-settings .form-actions { grid-column: 1 / -1; }
.allowance-state { display: grid; gap: 3px; margin: 12px 0; border-left: 3px solid var(--accent); padding-left: 10px; }
.allowance-state span { color: var(--ink-faint); font-size: 12px; }
.window-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.meter-section { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
.section-heading { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.meter-section h4 { margin: 0 0 8px; font-family: var(--font-display); }
.meter-row { min-width: 0; border: 1px solid var(--line); padding: 11px; background: var(--surface); }
.meter-row + .meter-row { margin-top: 8px; }
.meter-copy { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.meter-copy span, .meter-row p { color: var(--ink-soft); font-size: 12px; }
.meter-row p { margin: 7px 0 0; }
.meter-track { height: 8px; margin-top: 9px; overflow: hidden; border: 1px solid var(--line-strong); background: var(--surface-muted); }
.meter-fill { display: block; height: 100%; min-width: 0; background: var(--accent); }
.meter-unknown { border-style: dashed; }
.unavailable { color: var(--ink-faint); }
.quota-identity-header { display: flex; flex-wrap: wrap; align-items: center; border-bottom: 2px solid var(--ink); padding-bottom: 18px; }
.quota-identity-header .identity { flex: 1 1 200px; }
.quota-identity-header .quota-account-identity { margin: 8px 0 6px; font-size: clamp(22px, 2vw, 28px); font-weight: 800; line-height: 1.2; }
.quota-plan-badge { display: grid; gap: 2px; min-width: 96px; max-width: 100%; padding: 10px 14px; border: 2px solid var(--ink); background: var(--surface-muted); color: var(--ink); }
.quota-plan-badge > span { font-size: 11px; font-weight: 700; }
.quota-plan-badge > strong { font-family: var(--font-mono); font-size: 21px; line-height: 1.2; }
.quota-observation { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; color: var(--ink-soft); font-size: 12px; }
.quota-reset-credits { margin-top: 14px; border: 1px solid var(--line); padding: 12px; background: var(--surface); }
.quota-credit-summary { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
.quota-credit-summary h4 { margin: 0; font-size: 14px; }
.quota-credit-summary > strong { color: var(--ink); font-family: var(--font-mono); font-size: 26px; font-variant-numeric: tabular-nums; }
.quota-reset-credits p, .quota-reset-credits li { margin: 8px 0 0; color: var(--ink-soft); font-size: 12px; }
.quota-reset-credits ul { padding-left: 18px; }
.quota-footer > div { min-width: 0; }
.quota-footer > div > span { display: block; }
.quota-footer .card-actions { grid-column: 1 / -1; }
.quota-footer { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: center; margin-top: 13px; border-top: 1px solid var(--line); padding-top: 12px; color: var(--ink-soft); font-size: 12px; }
.quota-request-error { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; margin-bottom: 12px; border-left: 4px solid var(--negative); padding: 12px 14px; color: var(--negative); background: var(--negative-soft); }
.quota-request-error span { grid-column: 1; color: var(--ink-soft); }
.quota-request-error button { grid-column: 2; grid-row: 1 / span 2; }
.empty-state, .empty { display: grid; gap: 3px; border: 1px dashed var(--line-strong); padding: 18px; color: var(--ink-soft); background: var(--surface-raised); }
details { border: 1px solid var(--line); padding: 12px; background: var(--surface-raised); }
summary { cursor: pointer; font-weight: 800; min-height: 44px; padding: 8px 0; }
.table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--line); overscroll-behavior-inline: contain; }
table { width: 100%; min-width: 780px; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
th { color: var(--ink-soft); background: var(--surface-muted); font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
[data-admin-mode="simple"] .model-mapping-panel table { min-width: 0; table-layout: fixed; }
[data-admin-mode="simple"] .model-mapping-panel th, [data-admin-mode="simple"] .model-mapping-panel td { padding: 8px 6px; overflow-wrap: anywhere; }
[data-admin-mode="simple"] .model-mapping-panel th:nth-child(1) { width: 24%; }
[data-admin-mode="simple"] .model-mapping-panel th:nth-child(4) { width: 48px; }
[data-admin-mode="simple"] .model-mapping-panel th:last-child { width: 64px; }
[data-admin-mode="simple"] .model-mapping-panel select { min-width: 0; max-width: 100%; padding: 8px 4px; }
[data-admin-mode="simple"] .model-mapping-panel input[type="checkbox"] { width: 18px; min-height: 18px; }
[data-admin-mode="simple"] .model-mapping-panel td button { padding: 8px; }
.utility-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
/* Summary cards use neutral values and explicit state labels, not categorical colors. */
.overview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.overview-tile { min-width: 0; border: 1px solid var(--line); border-top: 3px solid var(--accent); padding: 18px; background: var(--surface-raised); }
.overview-tile h3 { margin: 0; font-size: 13px; color: var(--ink-soft); }
.overview-value { display: block; margin: 14px 0 8px; font-family: var(--font-mono); font-size: 36px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.overview-tile p { margin: 4px 0 0; color: var(--ink-faint); font-size: 12px; }
.overview-status { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-bottom: 16px; }
.overview-status a { display: inline-flex; align-items: center; min-height: 44px; }
.activity-list { list-style: none; padding: 0; margin: 12px 0 0; }
.activity-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
.activity-list li > div { min-width: 0; }
.activity-list time { display: block; margin-top: 4px; font-size: 12px; color: var(--ink-faint); }
.request-inspector { border-top: 3px solid var(--accent); }
.request-inspector-table table { min-width: 0; table-layout: fixed; }
.request-inspector-table th:nth-child(1) { width: 34%; }
.request-inspector-table th:nth-child(2) { width: 30%; }
.request-inspector-table th:nth-child(3) { width: 14%; }
.request-inspector-table time { font-variant-numeric: tabular-nums; }
.result-dock { margin: 24px 0 0 246px; }
.result-dock .panel { padding: 14px 18px; }
.result-dock pre { max-height: 260px; }
.result-dock p:empty { display: none; }
@media(max-width:1200px) { .overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .oauth-layout { grid-template-columns: 1fr; } }
@media(max-width:1000px) { .workspace { grid-template-columns: 1fr; gap: 20px; } .module-nav { position: static; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 0; border: 0; gap: 8px; } .nav-group { display: none; } .module-nav button { border-color: var(--line); } .result-dock { margin-left: 0; } .account-grid, .quota-grid { grid-template-columns: 1fr; } }
@media(max-width:760px) { .admin-shell { padding: 12px; } .topbar { align-items: start; } .console-controls { width: 100%; } .module-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); } .module-header, .one-time-key, .overview-status, .oauth-layout, .utility-grid, .window-grid, .quota-footer, .oauth-callback-row { grid-template-columns: 1fr; } .quota-request-error { grid-template-columns: 1fr; } .quota-request-error button { grid-column: 1; grid-row: auto; } .panel-heading { flex-wrap: wrap; } .session-strip { grid-template-columns: 1fr; }
  .table-wrap table { min-width: 0; table-layout: fixed; }
  .table-wrap thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .table-wrap tbody, .table-wrap tr, .table-wrap td { display: block; width: 100%; }
  .table-wrap tr { padding: 10px; border-bottom: 2px solid var(--line-strong); }
  .table-wrap td { border: 0; padding: 6px; overflow-wrap: anywhere; }
  .table-wrap td::before { content: attr(data-label); display: block; margin-bottom: 4px; color: var(--ink-soft); font-size: 12px; font-weight: 700; }
}
@media(max-width:420px) { .overview-grid { grid-template-columns: 1fr; } .mode-toggle { display: flex; width: 100%; } .mode-toggle button { flex: 1; } .panel { padding: 13px; } .card-header, .panel-heading, .meter-copy { display: grid; } .account-summary, .technical-list, .account-settings { grid-template-columns: 1fr; } .account-settings .form-actions { grid-column: 1; } .card-actions button, .oauth-actions button, .oauth-callback-row button { width: 100%; } .module-nav button { grid-template-columns: 24px minmax(0, 1fr); padding: 10px 6px; gap: 6px; font-size: 13px; } .module-nav button::before { width: 24px; height: 24px; } }
@media (forced-colors: active) { .meter-fill { background: Highlight; } .module-nav button[aria-selected="true"], .mode-toggle button[aria-pressed="true"] { outline: 2px solid Highlight; } }
`;
