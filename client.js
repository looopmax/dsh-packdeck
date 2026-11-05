/*
 * Packdeck — client half (DSH Web plugin).
 *
 * Registers two slots:
 *   sidebar.panellist / id "packdeck"  -> rail icon ({ size, active })
 *   main            / key "packdeck"   -> full Packdeck page
 *
 * Plain browser ES2020, no JSX/TS/bundler/imports. React comes from the module
 * table; every visible string lives in T; every colour is a DSH theme token
 * (plus the single --pk-amber accent pair) or lives inside artwork SVGs.
 */
window.__ModuleLoader__.load({
  id: 'dsh-packdeck',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;

    const API_PATH = '/packdeck/api';
    const SNAPSHOT_TIMEOUT = 20000;
    const MUTATION_TIMEOUT = 16 * 60 * 1000;
    const CHECK_TIMEOUT = 95000;
    const SEARCH_TIMEOUT = 95000;
    const DETAIL_TIMEOUT = 95000;
    const REVEAL_TIMEOUT = 20000;
    const DETECT_TIMEOUT = 30000;
    const TOAST_MS = 3200;
    const REFRESH_MS = 60000;
    /* v3 process polling: one `processes` call every 3 s while the panel is
     * visible, silent until 3 failures in a row. Detail is fetched on demand. */
    const PROC_POLL_MS = 3000;
    const PROC_TIMEOUT = 8000;
    const PROC_DETAIL_TIMEOUT = 20000;
    const PROC_KILL_TIMEOUT = 20000;
    const LAUNCH_TIMEOUT = 20000;
    const RUNNING_SCOPE = 'running';
    const PROC_FAILURES_BEFORE_HINT = 3;
    const EMPTY_RUNNING = Object.create(null);
    const EMPTY_PROC_DETAIL = { state: 'idle', data: null, error: null };
    /* v3 additions to the capability set. `processes` covers process
     * visibility; `launch` is the reverse of `reveal`. Absent = true for v1/v2
     * hosts, which simply report no running items. */
    const OPTIONAL_CAPABILITY_DEFAULTS = { processes: true, launch: true };

    const TONES = ['amber', 'brand', 'success', 'idle'];
    const IDLE_ROW = { state: 'idle' };

    /* Every manager capability the UI may branch on. Absent flags default to
     * true so that a v1 host (no capabilities at all) keeps every control. */
    const DEFAULT_CAPABILITIES = {
      list: true, checkUpdates: true, search: true, install: true,
      update: true, uninstall: true, detail: true, reveal: true,
    };
    const CAPABILITY_KEYS = Object.keys(DEFAULT_CAPABILITIES);

    /* ================================================================== */
    /* CSS                                                                */
    /* ================================================================== */

    const CSS = `
.pk-root {
  --pk-bg: var(--dsw-alias-bg-base, #0c0e10); --pk-panel: var(--dsw-alias-bg-layer-1, #121518);
  --pk-panel-2: var(--dsw-alias-bg-layer-2, #161a1e); --pk-raise: var(--dsw-alias-bg-overlay, #1b2025);
  --pk-line: var(--dsw-alias-border-l1, #23282e); --pk-line-2: var(--dsw-alias-border-l2, #2d343b);
  --pk-ink: var(--dsw-alias-label-primary, #e8ebee); --pk-dim: var(--dsw-alias-label-secondary, #a3adb6);
  --pk-faint: color-mix(in srgb, var(--dsw-alias-label-secondary, #a3adb6) 72%, transparent);
  --pk-brand: var(--dsw-alias-brand-primary, #7aa7ec); --pk-success: var(--dsw-alias-state-success-primary, #5fcf8f);
  --pk-error: var(--dsw-alias-state-error-primary, #ef7676); --pk-warn: var(--dsw-alias-state-warn-primary, #f2a541);
  --pk-idle: var(--dsw-alias-state-idle-primary, #828c96);
  --pk-amber: #f2a541; --pk-amber-ink: #191207;
  --pk-amber-soft: color-mix(in srgb, var(--pk-amber) 14%, transparent);
  --pk-font-ui: "Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif;
  --pk-font-display: "Bahnschrift", "Segoe UI Variable Display", "Microsoft YaHei UI", system-ui, sans-serif;
  --pk-font-mono: "Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", monospace;
  --pk-cols: 36px minmax(0, 1.7fr) 84px 96px 160px 86px 88px 28px;
  --pk-cols-narrow: 36px minmax(0, 1.9fr) 96px 156px 82px 84px 28px;
  position: relative; height: 100%; min-height: 0; padding-top: var(--dsh-frame-top-clearance, 0px);
  display: grid; grid-template-columns: 196px minmax(0, 1fr); overflow: hidden;
  background: var(--pk-bg); color: var(--pk-ink); font-family: var(--pk-font-ui);
  font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased;
}
.pk-root, .pk-root *, .pk-root *::before, .pk-root *::after { box-sizing: border-box; }
.pk-root h1, .pk-root h2, .pk-root h3, .pk-root p, .pk-root ul, .pk-root pre { margin: 0; }
.pk-root button, .pk-root input, .pk-root select { font: inherit; color: inherit; }
.pk-root button { cursor: pointer; }
.pk-root :focus-visible { outline: 2px solid var(--pk-amber); outline-offset: 2px; border-radius: 4px; }
.pk-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.pk-mono { font-family: var(--pk-font-mono); font-variant-numeric: tabular-nums; }
.pk-muted { font-size: 11.5px; color: var(--pk-faint); }

.pk-rail { display: flex; flex-direction: column; gap: 16px; min-width: 0; padding: 18px 12px 14px; background: var(--pk-panel); border-right: 1px solid var(--pk-line); overflow-y: auto; overscroll-behavior: contain; }
.pk-brand { display: flex; align-items: center; gap: 9px; padding: 0 5px; }
.pk-brand-mark { width: 28px; height: 28px; flex: none; border-radius: 7px; background: var(--pk-amber); color: var(--pk-amber-ink); display: grid; place-items: center; }
.pk-brand-text { display: grid; gap: 1px; min-width: 0; }
.pk-brand-text strong { font-family: var(--pk-font-display); font-size: 12px; letter-spacing: .15em; font-weight: 600; }
.pk-brand-text small { font-size: 10px; color: var(--pk-faint); letter-spacing: .02em; }
.pk-nav { display: flex; flex-direction: column; gap: 2px; }
.pk-nav-item { position: relative; display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 9px; background: none; border: 0; border-radius: 6px; color: var(--pk-dim); text-align: left; transition: background-color .16s ease, color .16s ease; }
.pk-nav-item:hover { background: var(--pk-raise); color: var(--pk-ink); }
.pk-nav-item[aria-current="true"] { background: var(--pk-raise); color: var(--pk-ink); }
.pk-nav-item[aria-current="true"]::before { content: ""; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 2px; background: var(--pk-amber); }
.pk-nav-icon { flex: none; display: grid; place-items: center; color: var(--pk-faint); }
.pk-nav-item[aria-current="true"] .pk-nav-icon { color: var(--pk-amber); }
.pk-nav-label { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-nav-badge { font-family: var(--pk-font-mono); font-size: 10px; color: var(--pk-faint); min-width: 20px; text-align: right; font-variant-numeric: tabular-nums; }
.pk-nav-item[aria-current="true"] .pk-nav-badge { color: var(--pk-amber); }
.pk-nav-group { display: grid; gap: 2px; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--pk-line); }
.pk-nav-group-t { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 9px 4px; font-family: var(--pk-font-mono); font-size: 9.5px; letter-spacing: .08em; color: var(--pk-faint); text-transform: uppercase; }
.pk-nav-group-t .pk-n { color: var(--pk-dim); letter-spacing: 0; }
.pk-nav-manager { height: 30px; padding-left: 10px; }
.pk-nav-manager .pk-nav-label { font-size: 11.5px; }
.pk-nav-logo { width: 14px; height: 14px; flex: none; display: block; }
.pk-nav-item.is-off { opacity: .45; }
.pk-nav-avail { flex: none; font-size: 9.5px; color: var(--pk-faint); }
.pk-side-foot { margin-top: auto; display: grid; gap: 12px; padding: 0 5px; }
.pk-disk { display: grid; gap: 5px; }
.pk-disk-top { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; color: var(--pk-dim); }
.pk-disk-bar { height: 4px; border-radius: 2px; background: var(--pk-line-2); overflow: hidden; }
.pk-disk-bar i { display: block; height: 100%; background: var(--pk-amber); opacity: .8; }
.pk-disk-sub { font-size: 10px; color: var(--pk-faint); }
.pk-side-note { font-size: 10px; color: var(--pk-faint); line-height: 1.6; }
button.pk-nav-group-t { width: 100%; background: none; border: 0; border-radius: 5px; text-align: left; color: var(--pk-faint); font-family: var(--pk-font-mono); font-size: 9.5px; font-weight: 400; line-height: 1.4; transition: background-color .15s ease, color .15s ease; }
button.pk-nav-group-t:hover { background: var(--pk-raise); color: var(--pk-dim); }
button.pk-nav-group-t[aria-current="true"] { color: var(--pk-amber); }
button.pk-nav-group-t[aria-current="true"] .pk-n { color: var(--pk-amber); }
.pk-nav-item:disabled { cursor: not-allowed; }
.pk-nav-item:disabled:hover { background: none; color: var(--pk-dim); }
.pk-ud { display: grid; gap: 2px; margin-top: 3px; padding-top: 8px; border-top: 1px solid var(--pk-line); }
.pk-ud-head { display: flex; align-items: center; gap: 2px; }
button.pk-ud-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 3px 8px; background: none; border: 0; border-radius: 5px; color: var(--pk-faint); font-family: var(--pk-font-mono); font-size: 9.5px; font-weight: 400; line-height: 1.4; letter-spacing: .05em; text-align: left; transition: background-color .15s ease, color .15s ease; }
button.pk-ud-toggle:hover { background: var(--pk-raise); color: var(--pk-dim); }
button.pk-ud-toggle svg { transition: transform .16s ease; }
button.pk-ud-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
button.pk-ud-refresh { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; background: none; border: 0; border-radius: 5px; color: var(--pk-faint); font-size: 9.5px; line-height: 1.4; white-space: nowrap; }
button.pk-ud-refresh:hover:not(:disabled) { background: var(--pk-raise); color: var(--pk-amber); }
button.pk-ud-refresh:disabled { opacity: .5; cursor: default; }
.pk-ud-list { display: grid; gap: 1px; padding: 2px 0 4px; }
.pk-ud-row { display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 9px 0 16px; border-radius: 5px; color: var(--pk-faint); font-size: 11px; opacity: .45; cursor: not-allowed; overflow: hidden; }
.pk-ud-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.pk-main { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; background: var(--pk-bg); }
.pk-topbar { display: flex; align-items: center; gap: 14px; padding: 15px 22px 13px; border-bottom: 1px solid var(--pk-line); background: var(--pk-panel); min-width: 0; }
.pk-tb-title { min-width: 0; }
.pk-tb-title h1 { font-family: var(--pk-font-display); font-size: 19px; font-weight: 600; letter-spacing: .01em; line-height: 1.2; }
.pk-tb-sub { margin-top: 3px; font-size: 11px; color: var(--pk-dim); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-tb-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pk-search { position: relative; display: flex; align-items: center; }
.pk-search svg { position: absolute; left: 10px; color: var(--pk-faint); pointer-events: none; }
.pk-search input { width: 262px; height: 34px; padding: 0 11px 0 31px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 6px; font-size: 12px; color: var(--pk-ink); transition: border-color .16s ease, box-shadow .16s ease; }
.pk-search input::placeholder { color: var(--pk-faint); }
.pk-search input:focus { outline: none; border-color: var(--pk-amber); box-shadow: 0 0 0 3px var(--pk-amber-soft); }
.pk-sort select { height: 34px; padding: 0 26px 0 10px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 6px; font-size: 11.5px; color: var(--pk-dim); appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--pk-faint) 50%), linear-gradient(135deg, var(--pk-faint) 50%, transparent 50%); background-position: calc(100% - 13px) 14px, calc(100% - 8px) 14px; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.pk-sort select:hover { color: var(--pk-ink); border-color: var(--pk-dim); }
.pk-btn-primary { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 13px; background: var(--pk-amber); color: var(--pk-amber-ink); border: 1px solid transparent; border-radius: 6px; font-size: 12px; font-weight: 700; white-space: nowrap; transition: filter .16s ease; }
.pk-btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
.pk-btn-primary:disabled { background: var(--pk-panel-2); color: var(--pk-faint); border-color: var(--pk-line-2); cursor: not-allowed; filter: none; }
.pk-btn-count { font-family: var(--pk-font-mono); font-size: 10px; font-weight: 600; background: color-mix(in srgb, var(--pk-amber-ink) 16%, transparent); border-radius: 3px; padding: 1px 4px; }
.pk-btn-primary:disabled .pk-btn-count { background: color-mix(in srgb, var(--pk-faint) 18%, transparent); color: var(--pk-faint); }
.pk-btn-ghost { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 12px; background: transparent; color: var(--pk-ink); border: 1px solid var(--pk-line-2); border-radius: 6px; font-size: 12px; white-space: nowrap; transition: background-color .16s ease, border-color .16s ease; }
.pk-btn-ghost:hover:not(:disabled) { background: var(--pk-raise); border-color: var(--pk-dim); }
.pk-btn-ghost:disabled { opacity: .5; cursor: not-allowed; }
.pk-btn-danger { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; background: transparent; color: var(--pk-error); border: 1px solid color-mix(in srgb, var(--pk-error) 42%, transparent); border-radius: 6px; font-size: 12px; white-space: nowrap; }
.pk-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--pk-error) 12%, transparent); }
.pk-btn-danger:disabled { opacity: .5; cursor: not-allowed; }
.pk-icon-btn { width: 28px; height: 28px; flex: none; display: grid; place-items: center; background: none; border: 1px solid transparent; border-radius: 6px; color: var(--pk-faint); transition: background-color .15s ease, color .15s ease, border-color .15s ease; }
.pk-icon-btn:hover:not(:disabled) { background: var(--pk-raise); color: var(--pk-ink); border-color: var(--pk-line-2); }
.pk-icon-btn:disabled { opacity: .45; cursor: not-allowed; }
.pk-icon-btn.pk-scan-btn { width: 34px; height: 34px; background: var(--pk-panel-2); border-color: var(--pk-line-2); color: var(--pk-dim); }
.pk-icon-btn.pk-scan-btn:hover:not(:disabled) { background: var(--pk-raise); border-color: var(--pk-dim); color: var(--pk-ink); }

.pk-scroll { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
.pk-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 16px 22px 4px; }
.pk-stat { min-width: 0; padding: 12px 14px 11px; background: var(--pk-panel); border: 1px solid var(--pk-line); border-radius: 8px; }
.pk-stat-k { font-family: var(--pk-font-mono); font-size: 10px; letter-spacing: .07em; color: var(--pk-faint); text-transform: uppercase; }
.pk-stat-v { display: flex; align-items: baseline; gap: 5px; margin-top: 6px; font-family: var(--pk-font-display); font-size: 24px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; }
.pk-stat-v .pk-u { font-family: var(--pk-font-mono); font-size: 10.5px; font-weight: 400; color: var(--pk-dim); }
.pk-stat-d { margin-top: 7px; font-size: 10.5px; color: var(--pk-dim); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-error-bar { display: flex; align-items: center; gap: 10px; margin: 12px 22px 0; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--pk-error) 42%, transparent); background: color-mix(in srgb, var(--pk-error) 10%, transparent); border-radius: 7px; font-size: 12px; color: var(--pk-ink); }
.pk-error-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.pk-listhead { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: var(--pk-cols); gap: 8px; align-items: center; margin: 12px 22px 0; padding: 10px 0 8px; background: var(--pk-bg); border-bottom: 1px solid var(--pk-line); font-family: var(--pk-font-mono); font-size: 10px; letter-spacing: .06em; color: var(--pk-faint); }
.pk-rows { margin: 0 22px; }
.pk-row { display: grid; grid-template-columns: var(--pk-cols); gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--pk-line); transition: background-color .15s ease; }
.pk-row:hover { background: var(--pk-panel-2); }
.pk-cell-logo { display: flex; }
.pk-logo { width: 32px; height: 32px; flex: none; display: grid; place-items: center; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 8px; overflow: hidden; }
.pk-logo-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.pk-logo-lg { width: 36px; height: 36px; border-radius: 9px; }
.pk-mark { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--pk-dim); background: var(--pk-panel-2); }
.pk-mark[data-tone="amber"] { color: var(--pk-amber); background: color-mix(in srgb, var(--pk-amber) 15%, transparent); }
.pk-mark[data-tone="brand"] { color: var(--pk-brand); background: color-mix(in srgb, var(--pk-brand) 14%, transparent); }
.pk-mark[data-tone="success"] { color: var(--pk-success); background: color-mix(in srgb, var(--pk-success) 13%, transparent); }
.pk-mark[data-tone="idle"] { color: var(--pk-dim); background: color-mix(in srgb, var(--pk-dim) 11%, transparent); }
.pk-cell-name { display: grid; gap: 2px; min-width: 0; padding: 2px 0; background: none; border: 0; border-radius: 4px; text-align: left; color: inherit; }
.pk-nm { font-size: 13.5px; font-weight: 600; line-height: 1.3; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-nm-sub { font-size: 10.5px; color: var(--pk-faint); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-tag { display: inline-block; max-width: 100%; padding: 2px 6px; border: 1px solid var(--pk-line-2); border-radius: 4px; background: var(--pk-panel-2); font-family: var(--pk-font-mono); font-size: 10px; color: var(--pk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pk-cell-ver { font-size: 12px; color: var(--pk-dim); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-cell-latest { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.pk-ver-new { font-size: 12px; color: var(--pk-amber); }
.pk-btn-mini { height: 22px; padding: 0 8px; background: var(--pk-amber-soft); color: var(--pk-amber); border: 1px solid color-mix(in srgb, var(--pk-amber) 38%, transparent); border-radius: 4px; font-size: 10.5px; font-weight: 600; flex: none; transition: background-color .15s ease, color .15s ease; }
.pk-btn-mini:hover:not(:disabled) { background: var(--pk-amber); color: var(--pk-amber-ink); }
.pk-btn-mini:disabled { opacity: .55; cursor: not-allowed; }
.pk-btn-mini.is-plain { background: transparent; color: var(--pk-dim); border-color: var(--pk-line-2); }
.pk-btn-mini.is-plain:hover:not(:disabled) { background: var(--pk-raise); color: var(--pk-ink); }
.pk-is-latest { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--pk-faint); white-space: nowrap; }
.pk-is-latest svg { color: var(--pk-success); }
/* 体积 sits between 最新版本 and 状态 (design draft order); bytes come from the
 * snapshot and unknown sizes stay "—" — a value is never invented. */
.pk-cell-size { font-size: 12px; color: var(--pk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pk-cell-size.is-unknown { color: var(--pk-faint); }

.pk-cell-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--pk-faint); white-space: nowrap; }
.pk-cell-status.is-warn { color: var(--pk-warn); }
.pk-cell-status.is-ok { color: var(--pk-success); }
.pk-cell-status.is-error { color: var(--pk-error); }
.pk-cell-status.is-muted { color: var(--pk-faint); }
.pk-cell-more { width: 28px; height: 28px; display: grid; place-items: center; background: none; border: 0; border-radius: 5px; color: var(--pk-faint); transition: color .15s ease, background-color .15s ease; }
.pk-cell-more:hover { color: var(--pk-ink); background: var(--pk-raise); }
.pk-spin { display: inline-block; width: 11px; height: 11px; flex: none; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: pk-spin .7s linear infinite; }
@keyframes pk-spin { to { transform: rotate(360deg); } }
.pk-busy-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--pk-dim); }
.pk-empty { padding: 52px 20px; text-align: center; display: grid; justify-items: center; gap: 9px; }
.pk-empty svg { color: var(--pk-dim); opacity: .55; }
.pk-e-title { font-size: 14px; color: var(--pk-ink); }
.pk-e-desc { font-size: 12px; color: var(--pk-dim); max-width: 320px; line-height: 1.6; }
.pk-foot-note { padding: 16px 22px 22px; font-size: 10.5px; color: var(--pk-faint); }
.pk-skeleton { margin: 12px 22px 0; display: grid; gap: 4px; }
.pk-sk-row { display: grid; grid-template-columns: var(--pk-cols); gap: 8px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--pk-line); }
.pk-sk-bar { display: block; height: 11px; border-radius: 4px; background: var(--pk-panel-2); animation: pk-shimmer 1.4s ease-in-out infinite; }
@keyframes pk-shimmer { 0%, 100% { opacity: .45; } 50% { opacity: .9; } }

.pk-scrim { position: absolute; inset: 0; z-index: 40; background: var(--pk-bg); animation: pk-fade .2s ease both; }
@keyframes pk-fade { from { opacity: 0; } to { opacity: .72; } }
.pk-drawer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 41; width: min(396px, 100%); display: flex; flex-direction: column; min-height: 0; background: var(--pk-panel); border-left: 1px solid var(--pk-line-2); animation: pk-slide .22s cubic-bezier(.22, .7, .3, 1) both; }
@keyframes pk-slide { from { transform: translateX(100%); } to { transform: none; } }
.pk-drawer-head { display: flex; gap: 11px; align-items: flex-start; padding: 16px 18px 12px; border-bottom: 1px solid var(--pk-line); }
.pk-dh-text { min-width: 0; flex: 1; }
.pk-dh-text h2 { font-family: var(--pk-font-display); font-size: 16px; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
.pk-dh-sub { margin-top: 2px; font-size: 11px; color: var(--pk-dim); overflow-wrap: anywhere; }
.pk-drawer-actions { display: flex; flex-wrap: wrap; gap: 7px; padding: 12px 18px; border-bottom: 1px solid var(--pk-line); }
.pk-drawer-actions .pk-btn-primary, .pk-drawer-actions .pk-btn-ghost, .pk-drawer-actions .pk-btn-danger { height: 32px; }
.pk-confirm { display: grid; gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--pk-line); background: color-mix(in srgb, var(--pk-error) 8%, transparent); }
.pk-confirm p { font-size: 11.5px; color: var(--pk-ink); line-height: 1.6; }
.pk-confirm-actions { display: flex; gap: 7px; }
.pk-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--pk-line); }
.pk-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 9px 8px; font-size: 12px; color: var(--pk-dim); transition: color .15s ease, border-color .15s ease; }
.pk-tab:hover { color: var(--pk-ink); }
.pk-tab[aria-selected="true"] { color: var(--pk-ink); border-bottom-color: var(--pk-amber); }
.pk-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px 26px; }
.pk-desc-t { font-size: 13px; line-height: 1.7; color: var(--pk-dim); overflow-wrap: anywhere; }
.pk-sec-t { display: flex; align-items: center; gap: 8px; margin: 18px 0 7px; font-family: var(--pk-font-mono); font-size: 10px; font-weight: 400; letter-spacing: .07em; color: var(--pk-faint); text-transform: uppercase; }
.pk-sec-t:first-child { margin-top: 0; }
.pk-sec-n { font-size: 10px; color: var(--pk-dim); letter-spacing: 0; }
.pk-kv { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 9px; padding: 8px 0; border-bottom: 1px solid var(--pk-line); font-size: 11.5px; }
.pk-kv > span:first-child { color: var(--pk-faint); }
.pk-kv > span:last-child { color: var(--pk-ink); overflow-wrap: anywhere; }
.pk-kv .pk-path { font-size: 11px; color: var(--pk-dim); line-height: 1.6; }
.pk-dep-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--pk-line); font-size: 11.5px; }
.pk-dep-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--pk-ink); }
.pk-dep-ver { font-family: var(--pk-font-mono); font-size: 11px; color: var(--pk-dim); }
.pk-pre { margin: 0; padding: 12px; border: 1px solid var(--pk-line); border-radius: 6px; background: var(--pk-bg); font-family: var(--pk-font-mono); font-size: 11px; line-height: 1.65; color: var(--pk-dim); white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; }
.pk-inline-error { display: flex; align-items: center; gap: 9px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--pk-error) 40%, transparent); background: color-mix(in srgb, var(--pk-error) 9%, transparent); border-radius: 6px; font-size: 11.5px; color: var(--pk-ink); }
.pk-detail-loading { display: grid; gap: 8px; padding: 4px 0; }

.pk-status { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 6px 22px; border-top: 1px solid var(--pk-line-2); background: var(--pk-panel-2); font-size: 11.5px; color: var(--pk-dim); }
.pk-status-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--pk-idle); }
.pk-status[data-tone="busy"] .pk-status-dot { background: var(--pk-amber); animation: pk-pulse 1.1s ease-in-out infinite; }
.pk-status[data-tone="ok"] .pk-status-dot { background: var(--pk-success); }
.pk-status[data-tone="warn"] .pk-status-dot { background: var(--pk-warn); }
.pk-status[data-tone="error"] .pk-status-dot { background: var(--pk-error); }
@keyframes pk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.pk-status-text { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-status-link { flex: none; padding: 2px 4px; border: 0; border-radius: 4px; background: none; color: var(--pk-amber); font-size: 11.5px; }
.pk-status-link:hover:not(:disabled) { text-decoration: underline; }
.pk-status-link:disabled { color: var(--pk-faint); cursor: not-allowed; }
.pk-toast { position: absolute; right: 16px; bottom: 46px; z-index: 60; display: flex; align-items: center; gap: 8px; padding: 9px 13px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 6px; color: var(--pk-ink); font-size: 12px; max-width: min(420px, calc(100% - 32px)); animation: pk-toast-in .2s ease both; }
@keyframes pk-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.pk-toast .pk-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pk-success); flex: none; }
.pk-toast[data-tone="error"] .pk-dot { background: var(--pk-error); }
.pk-toast[data-tone="warn"] .pk-dot { background: var(--pk-warn); }

dialog.pk-dialog { width: min(520px, calc(100% - 32px)); max-height: min(640px, calc(100% - 48px)); padding: 0; border: 1px solid var(--pk-line-2); border-radius: 10px; background: var(--pk-panel); color: var(--pk-ink); overflow: hidden; font-family: var(--pk-font-ui); font-size: 14px; line-height: 1.55; }
dialog.pk-dialog::backdrop { background: var(--dsw-alias-bg-base, #0c0e10); opacity: .62; }
.pk-dlg-head { display: flex; align-items: flex-start; gap: 11px; padding: 16px 18px 12px; border-bottom: 1px solid var(--pk-line); }
.pk-dlg-head h2 { font-family: var(--pk-font-display); font-size: 15px; font-weight: 600; }
.pk-dlg-sub { margin-top: 3px; font-size: 11px; color: var(--pk-dim); }
.pk-dlg-head .pk-icon-btn { margin-left: auto; }
.pk-dlg-list { max-height: 280px; overflow-y: auto; padding: 5px 18px; }
.pk-batch-row { display: grid; grid-template-columns: 15px minmax(0, 1fr) auto; grid-template-areas: "cb name ver" "cb name src"; gap: 0 9px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--pk-line); cursor: pointer; }
.pk-batch-row input { grid-area: cb; width: 14px; height: 14px; accent-color: var(--pk-amber); margin: 0; }
.pk-br-name { grid-area: name; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-br-ver { grid-area: ver; font-family: var(--pk-font-mono); font-size: 10.5px; color: var(--pk-dim); text-align: right; white-space: nowrap; }
.pk-br-src { grid-area: src; font-family: var(--pk-font-mono); font-size: 9.5px; color: var(--pk-faint); text-align: right; }
.pk-dlg-progress { padding: 4px 18px 12px; display: grid; gap: 6px; }
.pk-bar { height: 5px; border-radius: 3px; background: var(--pk-line-2); overflow: hidden; }
.pk-bar i { display: block; height: 100%; background: var(--pk-amber); transition: width .3s ease; }
.pk-dlg-status { font-size: 11px; color: var(--pk-dim); }
.pk-dlg-foot { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--pk-line); background: var(--pk-panel-2); }
.pk-dlg-sum { font-size: 11px; color: var(--pk-dim); }
.pk-dlg-actions { margin-left: auto; display: flex; gap: 7px; }
.pk-seg { display: flex; flex-wrap: wrap; gap: 4px; padding: 12px 18px 0; }
.pk-seg-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 6px; font-size: 11.5px; color: var(--pk-dim); transition: background-color .15s ease, color .15s ease, border-color .15s ease; }
.pk-seg-btn[aria-pressed="true"] { background: var(--pk-amber-soft); border-color: color-mix(in srgb, var(--pk-amber) 42%, transparent); color: var(--pk-amber); }
.pk-seg-btn:disabled { opacity: .42; cursor: not-allowed; }
.pk-seg-t { display: inline-flex; align-items: center; padding: 0 1px; font-family: var(--pk-font-mono); font-size: 9.5px; letter-spacing: .06em; color: var(--pk-faint); text-transform: uppercase; }
.pk-field-hint { padding: 5px 18px 0; font-size: 10px; color: var(--pk-faint); }
.pk-field { display: flex; gap: 7px; padding: 10px 18px 0; }
.pk-input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 6px; font-size: 12px; color: var(--pk-ink); }
.pk-input::placeholder { color: var(--pk-faint); }
.pk-input:focus { outline: none; border-color: var(--pk-amber); box-shadow: 0 0 0 3px var(--pk-amber-soft); }
.pk-dlg-body { padding: 10px 18px 14px; min-height: 96px; }
.pk-results { display: grid; gap: 0; max-height: 286px; overflow-y: auto; }
.pk-result { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--pk-line); }
.pk-res-body { flex: 1; min-width: 0; display: grid; gap: 1px; }
.pk-res-name { font-size: 12.5px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-res-id { font-family: var(--pk-font-mono); font-size: 10.5px; color: var(--pk-faint); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-res-meta { display: flex; gap: 8px; align-items: center; font-size: 10px; color: var(--pk-faint); }
.pk-dlg-note { padding: 26px 10px; text-align: center; font-size: 12px; color: var(--pk-faint); }
.pk-dlg-error { margin: 10px 18px 0; }

/* ---- v3: 运行中 scope + 进程 tab ---------------------------------- */
.pk-cell-status.is-live { display: inline-flex; align-items: baseline; gap: 5px; color: var(--pk-success); }
.pk-live-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; align-self: center; background: var(--pk-success); animation: pk-pulse 2.4s ease-in-out infinite; }
.pk-live-n { font-family: var(--pk-font-mono); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--pk-success); }
.pk-live-t { font-size: 11px; color: var(--pk-success); }

.pk-process { display: grid; gap: 4px; }
.pk-process-empty { display: grid; justify-items: center; gap: 9px; padding: 38px 14px; border: 1px dashed var(--pk-line-2); border-radius: 8px; text-align: center; }
.pk-process-empty svg { color: var(--pk-dim); opacity: .55; }
.pk-chart-note { font-size: 10.5px; color: var(--pk-faint); margin: 0 0 4px; }
.pk-ps-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 4px 0 12px; }
.pk-ps { min-width: 0; padding: 9px 11px; background: var(--pk-panel-2); border: 1px solid var(--pk-line); border-radius: 6px; }
.pk-ps-k { display: block; font-family: var(--pk-font-mono); font-size: 9.5px; letter-spacing: .05em; color: var(--pk-faint); }
.pk-ps-v { display: flex; align-items: baseline; gap: 2px; margin-top: 4px; font-size: 17px; font-weight: 600; line-height: 1.1; color: var(--pk-ink); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-ps-v i { font-style: normal; font-family: var(--pk-font-mono); font-size: 10px; font-weight: 400; color: var(--pk-dim); }
.pk-procs { display: grid; }
.pk-proc { border-bottom: 1px solid var(--pk-line); }
.pk-prow { display: grid; grid-template-columns: 62px minmax(0, 1fr) 50px 66px 62px; gap: 8px; align-items: center; width: 100%; padding: 8px 0; background: none; border: 0; text-align: left; color: var(--pk-ink); font-size: 11.5px; }
.pk-prow:hover { background: var(--pk-panel-2); }
.pk-prow .pk-pid { color: var(--pk-dim); font-size: 11px; }
.pk-prow .pk-pname { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-prow .pk-num { text-align: right; font-family: var(--pk-font-mono); font-size: 11px; color: var(--pk-dim); font-variant-numeric: tabular-nums; }
.pk-prow.pk-phead { padding: 4px 0 6px; background: none; border-bottom: 1px solid var(--pk-line); font-family: var(--pk-font-mono); font-size: 9.5px; letter-spacing: .05em; color: var(--pk-faint); }
.pk-prow.pk-phead .pk-num { color: var(--pk-faint); }
.pk-proc-body { display: grid; gap: 0; padding: 2px 0 12px; }
.pk-proc-body .pk-kv { grid-template-columns: 74px minmax(0, 1fr); }
.pk-cmd { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.pk-cmd-text { flex: 1; min-width: 0; margin: 0; padding: 7px 9px; background: var(--pk-bg); border: 1px solid var(--pk-line); border-radius: 5px; font-family: var(--pk-font-mono); font-size: 10.5px; line-height: 1.6; color: var(--pk-dim); white-space: pre-wrap; overflow-wrap: anywhere; }
.pk-cwd { flex: 1; min-width: 0; font-size: 10.5px; line-height: 1.6; color: var(--pk-dim); overflow-wrap: anywhere; }
.pk-copy { flex: none; height: 22px; padding: 0 7px; background: transparent; border: 1px solid var(--pk-line-2); border-radius: 4px; color: var(--pk-faint); font-family: var(--pk-font-mono); font-size: 9.5px; line-height: 1; white-space: nowrap; }
.pk-copy:hover { background: var(--pk-raise); color: var(--pk-ink); }
.pk-copy.is-done { color: var(--pk-success); border-color: color-mix(in srgb, var(--pk-success) 40%, transparent); }
.pk-proc-env { margin-top: 9px; }
.pk-env-toggle { display: flex; align-items: center; gap: 5px; width: 100%; padding: 3px 0; background: none; border: 0; color: var(--pk-faint); font-family: var(--pk-font-mono); font-size: 9.5px; letter-spacing: .06em; text-align: left; }
.pk-env-toggle:hover { color: var(--pk-dim); }
.pk-env-toggle svg { transition: transform .16s ease; }
.pk-env-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
.pk-env-head { display: flex; align-items: center; gap: 8px; }
.pk-env-head .pk-env-toggle { flex: 1; min-width: 0; }
.pk-env-filter { width: 132px; height: 24px; flex: none; padding: 0 7px; background: var(--pk-panel-2); border: 1px solid var(--pk-line-2); border-radius: 4px; font-size: 10.5px; color: var(--pk-ink); }
.pk-env-filter::placeholder { color: var(--pk-faint); }
.pk-env-filter:focus { outline: none; border-color: var(--pk-amber); }
.pk-env-table { display: grid; margin-top: 5px; border: 1px solid var(--pk-line); border-radius: 5px; overflow: hidden; }
.pk-env-row { display: grid; grid-template-columns: minmax(0, 40%) minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 3px 7px; border-bottom: 1px solid var(--pk-line); font-size: 10px; }
.pk-env-row:last-child { border-bottom: 0; }
.pk-env-row:nth-child(odd) { background: color-mix(in srgb, var(--pk-panel-2) 60%, transparent); }
.pk-env-k { color: var(--pk-dim); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-env-v { color: var(--pk-ink); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pk-env-act { display: flex; justify-content: flex-end; }
.pk-env-more { margin-top: 4px; font-size: 10px; color: var(--pk-faint); }
.pk-env-error { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--pk-warn) 38%, transparent); background: color-mix(in srgb, var(--pk-warn) 9%, transparent); border-radius: 5px; font-size: 11px; color: var(--pk-ink); }
.pk-env-error > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pk-env-hint { margin-top: 4px; font-size: 10px; color: var(--pk-faint); line-height: 1.55; }
.pk-env-limited { display: block; padding: 3px 0; font-size: 10.5px; color: var(--pk-faint); line-height: 1.55; }
.pk-kill-line { display: flex; justify-content: flex-end; margin-top: 8px; }
.pk-kill-confirm { display: grid; gap: 7px; margin-top: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--pk-error) 38%, transparent); background: color-mix(in srgb, var(--pk-error) 8%, transparent); border-radius: 6px; }
.pk-kill-ask { font-size: 11px; color: var(--pk-ink); }
.pk-kill-actions { display: flex; gap: 6px; justify-content: flex-end; }
.pk-kill-actions .pk-btn-danger, .pk-kill-actions .pk-btn-ghost, .pk-kill-line .pk-btn-danger { height: 28px; font-size: 11px; }

/* The panel lives beside the 300px+ app sidebar, so the table needs the narrower layout far
 * earlier than a full-page table would. Column order follows the design draft:
 * 图标 / 项目 / 来源 / 当前版本 / 最新版本 / 体积 / 状态 / 操作. 体积 drops first
 * (least critical), then 来源; 状态 and the name column always survive. */
@media (max-width: 1500px) {
  .pk-root { --pk-cols: var(--pk-cols-narrow); }
  .pk-h-source, .pk-cell-source { display: none; }
}
@media (max-width: 1180px) {
  .pk-root { --pk-cols: 34px minmax(0, 1.9fr) 92px 148px 84px 26px; }
  .pk-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pk-search input { width: 200px; }
  .pk-h-size, .pk-cell-size { display: none; }
}
@media (max-width: 1024px) {
  .pk-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pk-search input { width: 168px; }
}
@media (max-width: 980px) {
  .pk-root { grid-template-columns: 60px minmax(0, 1fr); }
  .pk-rail { padding: 16px 8px; align-items: center; }
  .pk-brand { padding: 0; }
  .pk-brand-text, .pk-nav-label, .pk-nav-badge, .pk-nav-avail, .pk-side-foot, .pk-nav-group-t { display: none; }
  .pk-nav, .pk-nav-group { width: 100%; }
  .pk-nav-item { justify-content: center; padding: 0; }
  .pk-nav-item[aria-current="true"]::before { left: -8px; }
}
/* Narrow drawer: drop the start-time column, then the CPU column, keeping
 * PID / name / memory readable. */
@media (max-width: 460px) {
  .pk-prow { grid-template-columns: 54px minmax(0, 1fr) 44px 58px; }
  .pk-prow .pk-ptime, .pk-prow.pk-phead .pk-ptime { display: none; }
  .pk-ps-grid { gap: 6px; }
  .pk-ps-v { font-size: 15px; }
}
@media (max-width: 360px) {
  .pk-prow { grid-template-columns: 50px minmax(0, 1fr) 58px; }
  .pk-prow > .pk-num:nth-child(3) { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pk-root *, .pk-root *::before, .pk-root *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

    /* ================================================================== */
    /* Copy                                                               */
    /* ================================================================== */

    const T = {
      appName: 'PACKDECK',
      appTagline: '本地程序管理',
      navOverview: '概览',
      navUpdates: '可更新',
      navGroup: '包管理器',
      pageAll: '概览',
      pageUpdates: '可更新',
      updatesAll: '更新全部',
      install: '安装',
      search: '搜索',
      sort: '排序',
      sortDefault: '待更新优先',
      sortName: '名称 A–Z',
      sortVersion: '版本',
      sortSource: '来源',
      statTotal: '当前项目',
      statUpdates: '待更新',
      statSources: '可用来源',
      statDisk: '磁盘可用',
      unitItem: '个',
      unitUpdate: '项',
      unitSource: '个',
      upToDate: '已是最新',
      update: '更新',
      check: '检查',
      checking: '检查中…',
      checkUpdates: '检查更新',
      detect: '重新检测',
      detecting: '检测中…',
      detectingSources: '正在检测本地来源…',
      detectTimeout: '检测来源超时',
      detectedSources: function (n) { return '已检测到 ' + n + ' 个来源'; },
      undetected: function (n) { return '未检测到（' + n + '）'; },
      undetectedReason: '本机未找到该来源的可执行文件',
      extKind: '扩展',
      extId: '扩展 ID',
      updateTo: '更新至',
      updating: '更新中…',
      unchecked: '未检查',
      updatable: '可更新',
      failed: '失败',
      unavailable: '不可用',
      readingIndex: '正在读取本地索引…',
      indexFailed: '无法读取本地索引',
      retry: '重试',
      uninstall: '卸载',
      reveal: '在文件夹中显示',
      tabOverview: '概览',
      tabProcess: '进程',
      tabCommand: '命令',
      navRunning: '运行中',
      pageRunning: '运行中',
      runningRowAria: function (n) { return '正在运行，' + n + ' 个进程'; },
      runningPids: function (pids) { return 'PID：' + pids.join('、'); },
      processSumCpu: 'CPU 合计',
      processSumMem: '内存合计',
      processSumCount: '进程数',
      unitPercent: '%',
      unitProcess: '个',
      processUnit: '进程',
      processColPid: 'PID',
      processColName: '进程',
      processColCpu: 'CPU',
      processColMem: '内存',
      processColStarted: '启动时间',
      processCmd: '启动命令',
      processCwd: '工作目录',
      processPpid: '父进程 PID',
      processUser: '用户',
      processThreads: '线程数',
      processState: '状态',
      processChildren: '子进程',
      processEnv: '环境变量',
      processEnvFilter: '过滤变量名或值',
      processEnvEmpty: '没有匹配的环境变量',
      processKill: '结束进程',
      processKillAsk: function (pid) { return '结束 PID ' + pid + '？此操作不可撤销。'; },
      processKillConfirm: '确认结束',
      processKilled: function (pid) { return '已结束 PID ' + pid; },
      processKillFailed: '结束进程失败',
      processEmptyTitle: '当前没有运行中的进程',
      processEmptyDesc: '该项目当前未启动。启动后这里会显示启动命令、工作目录与环境变量。',
      processNotRunning: function (name) { return name + ' 当前未运行，详情不可用。'; },
      processUnsupported: '当前来源不支持进程信息',
      processLoading: '正在读取进程详情…',
      processFailed: '无法读取进程详情',
      processNoPsutil: '需要 psutil 以读取环境变量',
      processInstallPsutil: '安装 psutil',
      processInstallingPsutil: '正在安装 psutil…',
      processPsutilInstalled: 'psutil 已安装，正在重新读取进程详情…',
      processPsutilHint: '将在本机 Python 环境中真实安装 pip 包 psutil（会修改本机环境）。',
      processEnvTruncated: function (n) { return '共 ' + n + ' 个变量，仅显示前 300 个'; },
      /* env is only fetched for the first N PIDs; the rest are a budget cap. */
      processEnvLimited: function (envPids, total) {
        return total === null
          ? '只显示前 ' + envPids + ' 个进程的环境变量'
          : '只显示前 ' + envPids + ' 个进程的环境变量（共 ' + total + ' 个）';
      },
      processEnvNotRead: '该进程的环境变量未读取',
      processPollFailed: '进程状态刷新失败',
      processPollFailedHint: function (n) { return '进程状态已连续 ' + n + ' 次刷新失败，仍会继续重试'; },
      launchApp: '启动程序',
      launching: '启动中…',
      launched: function (name) { return '已启动 ' + name; },
      processUpdatedAt: function (rel) { return '进程状态 · ' + rel; },
      copy: '复制',
      copied: '已复制',
      detailTabs: '详情分类',
      dependencies: '依赖',
      basicInfo: '基本信息',
      version: '版本',
      size: '体积',
      sizeUnknown: '未统计体积',
      license: '许可证',
      installedAt: '安装时间',
      path: '路径',
      noDeps: '暂无依赖',
      installTitle: '安装包',
      installSub: '从本机包管理器搜索并全局安装',
      searchRegistry: '搜索 registry',
      installPlaceholder: '输入包名，例如 typescript',
      installByIdExt: '输入扩展 ID（如 ms-python.python）',
      installById: '输入包名或 ID（如 typescript）',
      installDirectHint: '可直接按 ID 安装，支持「包名@版本」后缀。',
      installByHint: '该来源不支持搜索，输入完整 ID 后可直接安装。',
      idRequired: '请输入要安装的 ID',
      installing: '安装中…',
      installed: '已安装',
      uninstalled: '已卸载',
      updatedTo: '已更新至',
      reinstalled: '已重新安装',
      ready: '就绪',
      justNow: '刚刚',
      footnote: '数据来自本机包管理器 · 操作会真实修改系统',
      noMatchTitle: '没有匹配的项目',
      noMatchDesc: '换个关键词，或清除当前分类与搜索条件。',
      clearFilter: '清除筛选',
      viewOutput: '查看输出',
      outputTitle: '命令输出',
      close: '关闭',
      closeDetail: '关闭详情',
      batchTitle: '更新所选项目',
      batchSub: '将依次执行所选项目的更新。',
      batchRunningSub: '正在依次执行，请勿关闭面板。',
      batchUnit: function (n) { return n + ' 项'; },
      cancel: '取消',
      startUpdate: '开始更新',
      batchProgress: function (name, i, n) { return '正在更新 ' + name + '（' + i + ' / ' + n + '）'; },
      batchDone: function (n) { return n + ' 项更新完成'; },
      batchDonePartial: function (n, f) { return n + ' 项完成 · ' + f + ' 项失败'; },
      noResults: '没有匹配的包',
      noSearchYet: '选择来源并搜索要安装的包。',
      queryRequired: '请输入搜索关键词',
      searchFailed: '搜索失败',
      detailLoading: '正在读取详情…',
      detailFailed: '无法读取详情',
      noOutput: '暂无命令输出',
      searchAllPlaceholder: '搜索程序、包或命令',
      searchUpdatesPlaceholder: '搜索待更新项',
      searchManagerPlaceholder: function (label) { return '搜索 ' + label + ' 包'; },
      subtitle: function (total, updates, rel) { return total + ' 个包 · ' + updates + ' 项可更新 · 检查于 ' + rel; },
      subtitleRunning: function (total, running, rel) { return total + ' 个项目在运行 · ' + running + ' 个绑定进程组 · 刷新于 ' + rel; },
      scopeRunningDesc: function () { return '当前没有检测到运行中的程序或包。'; },
      subtitleManager: function (label, total, updates, rel) { return label + ' · ' + total + ' 个包 · ' + updates + ' 项可更新 · 检查于 ' + rel; },
      subtitleGroup: function (label, total, updates, rel) { return label + ' · ' + total + ' 个项目 · ' + updates + ' 项可更新 · 检查于 ' + rel; },
      searchGroupPlaceholder: function (label) { return '在 ' + label + ' 中搜索'; },
      groupNoItems: function (label) { return label + ' 分组下暂无已安装的项目。'; },
      checkUnsupported: function (label) { return label + ' 不支持检查更新'; },
      noCheckableManager: '当前范围内没有可检查更新的来源',
      reinstallHint: '重新安装为最新版本',
      statTotalDesc: function (apps, pkgs, exts) {
        const parts = [];
        if (apps) parts.push(apps + ' 个应用');
        if (pkgs) parts.push(pkgs + ' 个全局包');
        if (exts) parts.push(exts + ' 个扩展');
        return parts.length ? parts.join(' · ') : '暂无项目';
      },
      statUpdatesDesc: function (n, managers) { return n ? managers + ' 个来源有待更新' : '全部为最新版本'; },
      diskTop: function (mount) { return '本地磁盘 ' + mount; },
      diskSub: function (free, total) { return free + ' 可用 · 共 ' + total; },
      indexLine: function (rel) { return '本地索引 · ' + rel; },
      scopeUpdatesDesc: function () { return '仅显示可更新项'; },
      managerUnavailable: function (label, reason) { return label + ' 不可用：' + (reason || '未知原因'); },
      managerNoItems: function (label) { return '本机未检测到 ' + label + ' 的全局包。'; },
      statDiskDesc: function (total, mount) { return '共 ' + total + (mount ? ' · ' + mount : ''); },
      confirmUninstall: function (name) { return '确定要卸载 ' + name + ' 吗？此操作会真实修改本机环境。'; },
      confirmUninstallBtn: '确认卸载',
      revealed: '已在资源管理器中打开',
      openDetail: function (name) { return '查看 ' + name + ' 详情'; },
      checkManagerDone: function (label, n) { return label + ' 检查完成，' + n + ' 项可更新'; },
      checkManagerPartial: function (label, n, f) { return label + '：' + n + ' 项可更新 · ' + f + ' 个包检查失败'; },
      checkAllDone: function (n) { return '检查完成，共 ' + n + ' 项可更新'; },
      checkAllFailed: function (f) { return f + ' 个包检查失败，其余为最新'; },
      noAvailableManager: '没有可用的包管理器',
      managerCheckStart: function (label) { return '正在检查 ' + label + ' 更新…'; },
      cancelled: '请求已取消',
      timeout: '操作超时，请稍后重试',
      snapshotTimeout: '读取本地索引超时',
      mutationTimeout: '命令执行超时，请稍后在输出中确认结果',
      checkTimeout: '检查更新超时',
      searchTimeout: '搜索超时',
      detailTimeout: '读取详情超时',
      revealTimeout: '打开文件夹超时',
      networkError: '网络请求失败，无法连接本地服务',
      badResponse: '服务返回了无法解析的响应',
      httpError: function (s) { return '服务返回 HTTP ' + s; },
      statsLabel: '概览指标',
      navAria: '程序分类',
      managersAvailable: function (available, total) { return available + ' / ' + total + ' 个来源可用'; },
      colProject: '项目',
      colSource: '来源',
      colCurrent: '当前版本',
      colLatest: '最新版本',
      colSize: '体积',
      colStatus: '状态',
    };

    const SORTS = [
      { value: 'default', label: T.sortDefault },
      { value: 'name', label: T.sortName },
      { value: 'version', label: T.sortVersion },
      { value: 'source', label: T.sortSource },
    ];

    const HEADERS = [
      { label: '' },
      { label: T.colProject },
      { label: T.colSource, className: 'pk-h-source' },
      { label: T.colCurrent },
      { label: T.colLatest },
      { label: T.colSize, className: 'pk-h-size' },
      { label: T.colStatus },
      { label: '' },
    ];

    /* ================================================================== */
    /* Formatting helpers                                                 */
    /* ================================================================== */

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    function fmtSize(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return Math.round(bytes) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function splitSize(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return { v: '—', u: '' };
      if (bytes >= 1024 * 1024 * 1024) return { v: (bytes / (1024 * 1024 * 1024)).toFixed(1), u: 'GB' };
      if (bytes >= 1024 * 1024) return { v: Math.round(bytes / (1024 * 1024)), u: 'MB' };
      return { v: Math.round(bytes / 1024), u: 'KB' };
    }

    function fmtRelative(ts) {
      const value = Number(ts);
      if (!ts || !isFinite(value)) return T.justNow;
      const diff = Date.now() - value;
      if (!isFinite(diff) || diff < 30000) return T.justNow;
      const sec = Math.floor(diff / 1000);
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
      if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
      return Math.floor(sec / 86400) + ' 天前';
    }

    function fmtDate(value) {
      if (value === null || value === undefined || value === '') return '—';
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (isNaN(date.getTime())) return String(value);
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function fmtClock(ts) {
      const value = Number(ts);
      if (!ts || !isFinite(value)) return '—';
      const date = new Date(value);
      if (isNaN(date.getTime())) return '—';
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function fmtDuration(ms) {
      const value = Number(ms);
      if (!isFinite(value) || value < 0) return '—';
      const sec = Math.floor(value / 1000);
      if (sec < 60) return sec + ' 秒';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
      if (sec < 86400) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
      return Math.floor(sec / 86400) + ' 天';
    }

    function fmtCpu(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—';
      return value.toFixed(1);
    }

    /* ---- processes (v3) ------------------------------------------------
     * The `processes` action is polled every 3 s. Its payload is flattened
     * into `running`: a plain id -> {procCount,rssBytes,cpuPercent} map so a
     * row is a single property read and a tick only replaces the entries that
     * actually changed (see applyRunning). */

    function numOrNull(value) {
      const n = typeof value === 'number' ? value : Number(value);
      return isFinite(n) ? n : null;
    }

    function normalizeRunning(data) {
      const source = data && typeof data === 'object' ? data : {};
      const list = Array.isArray(source.items) ? source.items : [];
      const map = Object.create(null);
      list.forEach(function (entry) {
        if (!entry || !entry.id) return;
        const id = String(entry.id);
        const count = numOrNull(entry.procCount);
        if (!count || count <= 0) return;
        map[id] = {
          procCount: Math.round(count),
          rssBytes: numOrNull(entry.rssBytes),
          cpuPercent: numOrNull(entry.cpuPercent),
          /* Optional: the host may attach the bound PID list so the row
           * tooltip can name them without a second request. */
          pids: Array.isArray(entry.pids)
            ? entry.pids.map(function (pid) { return numOrNull(pid); }).filter(function (pid) { return pid !== null; })
            : null,
        };
      });
      return {
        map: map,
        totals: source.totals && typeof source.totals === 'object' ? source.totals : null,
        at: numOrNull(source.at) === null ? Date.now() : Number(source.at),
      };
    }

    /* Two running entries are interchangeable when count/memory/CPU agree.
     * The map is rebuilt rather than mutated so React sees a new reference
     * while every unchanged id keeps identity. */
    function sameRunning(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      if (a.procCount !== b.procCount || a.rssBytes !== b.rssBytes || a.cpuPercent !== b.cpuPercent) return false;
      const pa = a.pids;
      const pb = b.pids;
      if (pa === pb) return true;
      if (!pa || !pb || pa.length !== pb.length) return false;
      for (let i = 0; i < pa.length; i += 1) {
        if (pa[i] !== pb[i]) return false;
      }
      return true;
    }

    function runningOf(running, id) {
      const entry = running && running[id];
      return entry && entry.procCount > 0 ? entry : null;
    }

    function runningCount(running) {
      return Object.keys(running || EMPTY_RUNNING).length;
    }

    /* `running` scope: membership only depends on the running map. */
    function filterRunningScope(items, running) {
      return items.filter(function (item) { return !!runningOf(running, item.id); });
    }

    function canLaunch(item, manager) {
      if (!item || item.kind !== 'app' || !item.path) return false;
      return isUsable(manager) && can(manager, 'launch');
    }

    function normalizeProcess(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const cmdline = Array.isArray(source.cmdline)
        ? source.cmdline.map(function (part) { return String(part); })
        : (typeof source.cmdline === 'string' && source.cmdline ? [source.cmdline] : []);
      const children = Array.isArray(source.children) ? source.children.map(function (pid) { return numOrNull(pid); }).filter(function (pid) { return pid !== null; }) : [];
      const env = source.env && typeof source.env === 'object' && !Array.isArray(source.env) ? source.env : null;
      return {
        pid: numOrNull(source.pid),
        ppid: numOrNull(source.ppid),
        name: source.name ? String(source.name) : '—',
        exe: source.exe ? String(source.exe) : null,
        cmdline: cmdline,
        cmdlineText: cmdline.length ? cmdline.join(' ') : '',
        cwd: source.cwd ? String(source.cwd) : null,
        startedAt: numOrNull(source.startedAt),
        rssBytes: numOrNull(source.rssBytes),
        cpuPercent: numOrNull(source.cpuPercent),
        user: source.user ? String(source.user) : null,
        threads: numOrNull(source.threads),
        status: source.status ? String(source.status) : null,
        env: env,
        envCount: numOrNull(source.envCount),
        envError: source.envError ? String(source.envError) : null,
        /* The host only reads env for the first N PIDs; the rest come back as
         * `env:null, envCode:'limited'`. That is a budget, not a failure, so it
         * must never be rendered as the psutil-missing state. */
        envCode: source.envCode ? String(source.envCode) : null,
        children: children,
      };
    }

    function normalizeProcessDetail(data) {
      const source = data && typeof data === 'object' ? data : {};
      const list = Array.isArray(source.processes) ? source.processes : [];
      const hint = source.installHint && typeof source.installHint === 'object' ? source.installHint : null;
      const trunc = source.truncated && typeof source.truncated === 'object' ? source.truncated : null;
      return {
        id: source.id ? String(source.id) : '',
        at: numOrNull(source.at),
        processes: list.map(normalizeProcess).filter(function (entry) { return entry.pid !== null; }),
        installHint: hint && hint.manager && hint.packageId
          ? { manager: String(hint.manager), packageId: String(hint.packageId), reason: hint.reason ? String(hint.reason) : null }
          : null,
        truncated: trunc
          ? {
              envPids: numOrNull(trunc.envPids),
              total: numOrNull(trunc.total),
              limited: numOrNull(trunc.limited),
            }
          : null,
      };
    }

    function versionParts(value) {
      return String(value).split(/[.+-]/).map(function (part) {
        const match = /^(\d+)/.exec(part);
        return match ? parseInt(match[1], 10) : part;
      });
    }

    function cmpVersion(a, b) {
      if (!a && !b) return 0;
      if (!a) return -1;
      if (!b) return 1;
      const pa = versionParts(a);
      const pb = versionParts(b);
      const len = Math.max(pa.length, pb.length);
      for (let i = 0; i < len; i += 1) {
        const x = pa[i];
        const y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === 'number' && typeof y === 'number') {
          if (x !== y) return x - y;
          continue;
        }
        const sx = String(x);
        const sy = String(y);
        if (sx !== sy) return sx < sy ? -1 : 1;
      }
      return 0;
    }

    function toneFor(item) {
      const key = String(item.manager || '') + ':' + String(item.packageId || item.name || '');
      let hash = 0;
      for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 9973;
      return TONES[hash % TONES.length];
    }

    /* ---- capabilities --------------------------------------------------
     * The UI never branches on a manager id. Everything that differs per
     * manager is expressed by `capabilities`; a missing object means "v1 host"
     * and therefore every capability is on. */

    function normalizeCapabilities(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const out = {};
      CAPABILITY_KEYS.forEach(function (key) {
        const value = source[key];
        out[key] = value === undefined || value === null ? DEFAULT_CAPABILITIES[key] : value !== false;
      });
      /* v3 flags are additive: keep anything the host sent beyond the v1/v2
       * set, and default the two we know how to use. */
      Object.keys(source).forEach(function (key) {
        if (out[key] === undefined) out[key] = source[key] !== false;
      });
      Object.keys(OPTIONAL_CAPABILITY_DEFAULTS).forEach(function (key) {
        if (out[key] === undefined) out[key] = OPTIONAL_CAPABILITY_DEFAULTS[key];
      });
      return out;
    }

    function capsOf(manager) {
      return manager && manager.capabilities ? manager.capabilities : DEFAULT_CAPABILITIES;
    }

    function can(manager, key) {
      return capsOf(manager)[key] !== false;
    }

    function isDetected(manager) {
      return !!manager && manager.detected !== false;
    }

    function isUsable(manager) {
      return isDetected(manager) && manager.available !== false;
    }

    /* ---- managers / groups -------------------------------------------- */

    function managerOf(managers, id) {
      for (let i = 0; i < managers.length; i += 1) {
        if (managers[i] && managers[i].id === id) return managers[i];
      }
      return {
        id: id, label: id, vendor: null, kind: null, groupId: null, groupLabel: null,
        scopeLabel: null, available: true, detected: true, version: null, root: null,
        error: null, reason: null, itemCount: null,
        capabilities: normalizeCapabilities(null),
      };
    }

    function groupOf(groups, id) {
      for (let i = 0; i < groups.length; i += 1) {
        if (groups[i] && groups[i].id === id) return groups[i];
      }
      return null;
    }

    function managersInGroup(group, managers) {
      const out = [];
      const seen = Object.create(null);
      const declared = group && Array.isArray(group.managerIds) ? group.managerIds : [];
      declared.forEach(function (id) {
        const found = managers.filter(function (entry) { return entry.id === id; })[0];
        if (found && !seen[found.id]) {
          seen[found.id] = true;
          out.push(found);
        }
      });
      managers.forEach(function (manager) {
        if (group && manager.groupId === group.id && !seen[manager.id]) {
          seen[manager.id] = true;
          out.push(manager);
        }
      });
      return out;
    }

    function sortManagers(managers, groups) {
      const groupIndex = Object.create(null);
      const inner = Object.create(null);
      (groups || []).forEach(function (group, index) {
        if (!group || !group.id || groupIndex[group.id] !== undefined) return;
        groupIndex[group.id] = index;
        (Array.isArray(group.managerIds) ? group.managerIds : []).forEach(function (id, position) {
          if (inner[id] === undefined) inner[id] = position;
        });
      });
      return managers.slice().sort(function (a, b) {
        const ga = groupIndex[a.groupId] === undefined ? 9999 : groupIndex[a.groupId];
        const gb = groupIndex[b.groupId] === undefined ? 9999 : groupIndex[b.groupId];
        if (ga !== gb) return ga - gb;
        const ia = inner[a.id] === undefined ? 9999 : inner[a.id];
        const ib = inner[b.id] === undefined ? 9999 : inner[b.id];
        if (ia !== ib) return ia - ib;
        return String(a.label || a.id).localeCompare(String(b.label || b.id), 'zh-Hans-CN');
      });
    }

    function managerRankMap(managers) {
      const map = Object.create(null);
      (managers || []).forEach(function (manager, index) { map[manager.id] = index; });
      return map;
    }

    /* ---- scope ---------------------------------------------------------
     * scope stays v1-compatible (`all` / `updates` / `mgr:<id>`) and gains
     * `grp:<groupId>`; a group resolves to every manager the host put in it. */

    function managerIdsForScope(scope, managers, groups) {
      if (!scope || scope === 'all' || scope === 'updates') return null;
      if (scope.indexOf('mgr:') === 0) return [scope.slice(4)];
      if (scope.indexOf('grp:') === 0) {
        const id = scope.slice(4);
        const group = groupOf(groups || [], id);
        const out = [];
        const seen = Object.create(null);
        function push(managerId) {
          if (!managerId || seen[managerId]) return;
          seen[managerId] = true;
          out.push(managerId);
        }
        if (group) (group.managerIds || []).forEach(push);
        (managers || []).forEach(function (manager) {
          if (manager.groupId === id) push(manager.id);
        });
        return out;
      }
      return null;
    }

    function filterScope(items, scope, managers, groups) {
      const list = managers || [];
      if (!scope || scope === 'all') return items;
      if (scope === 'updates') {
        /* A manager that cannot check updates never produces one; without this
         * exclusion 「可更新」 would keep listing extensions forever. */
        return items.filter(function (item) {
          if (!item.hasUpdate) return false;
          return can(managerOf(list, item.manager), 'checkUpdates');
        });
      }
      const ids = managerIdsForScope(scope, list, groups || []);
      if (!ids) return items;
      const keep = Object.create(null);
      ids.forEach(function (id) { keep[id] = true; });
      return items.filter(function (item) { return !!keep[item.manager]; });
    }

    function matchesQuery(item, query) {
      if (!query) return true;
      const hay = [
        item.name, item.packageId, item.manager, item.source, item.scope,
        item.version, item.latest, item.description,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(query) !== -1;
    }

    function sortItems(items, sort, rank) {
      const order = rank || Object.create(null);
      function rankOf(id) { return order[id] === undefined ? 9999 : order[id]; }
      const list = items.slice();
      if (sort === 'name') {
        list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });
      } else if (sort === 'version') {
        list.sort(function (a, b) {
          return cmpVersion(b.version, a.version) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
        });
      } else if (sort === 'source') {
        list.sort(function (a, b) {
          return (rankOf(a.manager) - rankOf(b.manager)) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
        });
      } else {
        list.sort(function (a, b) {
          const ua = a.hasUpdate ? 1 : 0;
          const ub = b.hasUpdate ? 1 : 0;
          return (ub - ua) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
        });
      }
      return list;
    }

    function normalizeItem(raw) {
      const manager = raw.manager ? String(raw.manager) : '';
      const packageId = raw.packageId ? String(raw.packageId) : '';
      const rawKind = raw.kind ? String(raw.kind) : 'pkg';
      return {
        id: String(raw.id || (manager + ':' + packageId)),
        manager: manager,
        groupId: raw.groupId ? String(raw.groupId) : null,
        name: raw.name ? String(raw.name) : (packageId || '—'),
        packageId: packageId,
        source: raw.source ? String(raw.source) : manager,
        kind: rawKind === 'app' || rawKind === 'ext' ? rawKind : 'pkg',
        scope: raw.scope ? String(raw.scope) : null,
        cwd: raw.cwd ? String(raw.cwd) : null,
        path: raw.path ? String(raw.path) : null,
        version: raw.version === null || raw.version === undefined ? '' : String(raw.version),
        latest: raw.latest === null || raw.latest === undefined ? null : String(raw.latest),
        hasUpdate: !!raw.hasUpdate,
        description: raw.description ? String(raw.description) : null,
        sizeBytes: typeof raw.sizeBytes === 'number' && isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
        installedAt: raw.installedAt === undefined ? null : raw.installedAt,
        managerVersion: raw.managerVersion ? String(raw.managerVersion) : null,
        /* Host-supplied, same-origin absolute path only; never built here. */
        logoUrl: raw.logoUrl && String(raw.logoUrl).charAt(0) === '/' ? String(raw.logoUrl) : null,
      };
    }

    function shortExtName(item) {
      const name = item.name || item.packageId || '—';
      if (item.kind !== 'ext') return name;
      const full = item.packageId || item.name || '';
      if (!full || name !== full) return name;
      /* Trim the `publisher.` prefix for display only; the full id stays in the
       * row title and in the drawer. */
      const dot = full.indexOf('.');
      if (dot > 0 && dot < full.length - 1) return full.slice(dot + 1);
      return name;
    }

    function normalizeManager(raw, groupOfManager, groupLabels) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const id = source.id ? String(source.id) : 'unknown';
      let groupId = source.groupId ? String(source.groupId) : null;
      if (!groupId && groupOfManager && groupOfManager[id] !== undefined) groupId = groupOfManager[id];
      let groupLabel = source.groupLabel ? String(source.groupLabel) : null;
      if (!groupLabel && groupId && groupLabels && groupLabels[groupId]) groupLabel = groupLabels[groupId];
      return {
        id: id,
        label: source.label ? String(source.label) : id,
        vendor: source.vendor ? String(source.vendor) : null,
        kind: source.kind ? String(source.kind) : null,
        groupId: groupId,
        groupLabel: groupLabel,
        scopeLabel: source.scopeLabel ? String(source.scopeLabel) : null,
        available: source.available !== false,
        detected: source.detected !== false,
        version: source.version ? String(source.version) : null,
        root: source.root ? String(source.root) : null,
        error: source.error ? String(source.error) : null,
        reason: source.reason ? String(source.reason) : null,
        itemCount: typeof source.itemCount === 'number' && isFinite(source.itemCount) ? source.itemCount : null,
        capabilities: normalizeCapabilities(source.capabilities),
      };
    }

    function countDetected(managers, stats) {
      if (stats && typeof stats.managersDetected === 'number' && isFinite(stats.managersDetected)) {
        return stats.managersDetected;
      }
      return (managers || []).filter(isDetected).length;
    }

    function normalizeSnapshot(data) {
      const source = data && typeof data === 'object' ? data : {};
      const rawGroups = Array.isArray(source.groups) ? source.groups : [];
      const rawManagers = Array.isArray(source.managers) ? source.managers : [];
      const rawItems = Array.isArray(source.items) ? source.items : [];

      let groups = rawGroups.filter(function (raw) { return raw && raw.id; }).map(function (raw, index) {
        return {
          id: String(raw.id),
          label: raw.label ? String(raw.label) : String(raw.id),
          kind: raw.kind ? String(raw.kind) : null,
          order: typeof raw.order === 'number' && isFinite(raw.order) ? raw.order : index * 10,
          managerIds: Array.isArray(raw.managerIds) ? raw.managerIds.map(String) : [],
        };
      });
      groups.sort(function (a, b) {
        return (a.order - b.order) || String(a.id).localeCompare(String(b.id));
      });

      const groupOfManager = Object.create(null);
      const groupLabels = Object.create(null);
      groups.forEach(function (group) {
        groupLabels[group.id] = group.label;
        group.managerIds.forEach(function (managerId) {
          if (groupOfManager[managerId] === undefined) groupOfManager[managerId] = group.id;
        });
      });

      const managers = sortManagers(rawManagers.map(function (raw) {
        return normalizeManager(raw, groupOfManager, groupLabels);
      }), groups);

      /* Older hosts (or the very first paint) may omit groups entirely: build
       * one implicit group from managers[] so the rail is never empty. */
      if (!groups.length && managers.length) {
        groups = [{
          id: 'all-managers',
          label: T.navGroup,
          kind: null,
          order: 0,
          managerIds: managers.map(function (manager) { return manager.id; }),
        }];
      }

      const managerGroup = Object.create(null);
      managers.forEach(function (manager) { managerGroup[manager.id] = manager.groupId; });

      const items = rawItems.map(function (raw) {
        const item = normalizeItem(raw || {});
        if (!item.groupId && managerGroup[item.manager]) item.groupId = managerGroup[item.manager];
        return item;
      });

      return {
        managers: managers,
        groups: groups,
        items: items,
        stats: source.stats && typeof source.stats === 'object' ? source.stats : null,
        at: typeof source.at === 'number' ? source.at : Date.now(),
        platform: source.platform ? String(source.platform) : null,
        detection: source.detection && typeof source.detection === 'object' ? source.detection : null,
      };
    }

    function splitItemId(id) {
      const text = String(id || '');
      const at = text.indexOf(':');
      if (at === -1) return { manager: '', packageId: text };
      return { manager: text.slice(0, at), packageId: text.slice(at + 1) };
    }

    /* ================================================================== */
    /* Transport                                                          */
    /* ================================================================== */

    class ApiError extends Error {
      constructor(message, code, log) {
        super(message);
        this.name = 'ApiError';
        this.code = code || 'internal';
        this.log = log || '';
      }
    }

    function createNet() {
      const net = { disposed: false, controllers: new Map() };
      net.abortAll = function () {
        net.disposed = true;
        net.abortByKind(null);
      };
      net.abortByKind = function (kinds) {
        net.controllers.forEach(function (kind, controller) {
          if (kinds && kinds.indexOf(kind) === -1) return;
          try { controller.abort(); } catch (err) { /* ignore */ }
        });
      };
      return net;
    }

    async function request(net, action, payload, options) {
      const opts = options || {};
      const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : MUTATION_TIMEOUT;
      const timeoutMessage = opts.timeoutMessage || T.timeout;
      const controller = new AbortController();
      net.controllers.set(controller, opts.kind || 'other');
      let timedOut = false;
      const timer = setTimeout(function () {
        timedOut = true;
        try { controller.abort(); } catch (err) { /* ignore */ }
      }, timeoutMs);

      try {
        let response;
        try {
          response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, payload || {})),
            cache: 'no-store',
            signal: controller.signal,
          });
        } catch (err) {
          if (timedOut) throw new ApiError(timeoutMessage, 'timeout');
          if (net.disposed || controller.signal.aborted) throw new ApiError(T.cancelled, 'aborted');
          throw new ApiError(T.networkError, 'network');
        }

        const contentType = response.headers && response.headers.get ? String(response.headers.get('content-type') || '') : '';
        if (!response.ok && contentType.indexOf('json') === -1) {
          throw new ApiError(T.httpError(response.status), 'http-' + response.status);
        }

        let body = null;
        let parseError = null;
        try {
          body = await response.json();
        } catch (err) {
          parseError = err;
        }
        if (timedOut) throw new ApiError(timeoutMessage, 'timeout');
        if (net.disposed || controller.signal.aborted) throw new ApiError(T.cancelled, 'aborted');
        if (parseError) throw new ApiError(T.badResponse, 'parse-failed');
        if (!body || typeof body !== 'object') throw new ApiError(T.badResponse, 'parse-failed');

        if (body.ok !== true) {
          const info = body.error && typeof body.error === 'object' ? body.error : {};
          throw new ApiError(
            info.message ? String(info.message) : T.httpError(response.status),
            info.code ? String(info.code) : 'internal',
            info.log ? String(info.log) : ''
          );
        }
        return body.data;
      } finally {
        clearTimeout(timer);
        net.controllers.delete(controller);
      }
    }

    /* ================================================================== */
    /* Store                                                              */
    /* ================================================================== */

    function createStore() {
      const net = createNet();
      const listeners = new Set();
      const inflightDetail = Object.create(null);
      const inflightProcess = Object.create(null);
      let toastTimer = null;
      let toastSeq = 0;
      let snapshotInflight = false;
      let mutatingCount = 0;
      let processesInflight = false;
      let processesSeq = 0;
      let processesFailures = 0;
      let processesTimer = null;
      let visibilityHandler = null;
      let drawerOpen = false;
      let drawerId = null;

      let state = {
        phase: 'idle',
        error: null,
        snapshot: null,
        at: 0,
        managers: [],
        groups: [],
        items: [],
        stats: null,
        scope: 'all',
        query: '',
        sort: 'default',
        rowState: Object.create(null),
        checking: null,
        detecting: false,
        batchRunning: false,
        mutating: 0,
        details: Object.create(null),
        logs: Object.create(null),
        lastLog: null,
        lastOp: { tone: 'idle', text: T.ready },
        toast: null,
        /* ---- v3 process slice: independent of the 60 s snapshot ---- */
        running: EMPTY_RUNNING,
        runningAt: 0,
        runningTotals: null,
        processError: null,
        processFailures: 0,
        processActive: false,
        processListAt: 0,
        processDetail: Object.create(null),
      };

      function get() {
        return state;
      }

      function patch(next) {
        state = Object.assign({}, state, next);
        listeners.forEach(function (listener) { listener(); });
      }

      function subscribe(listener) {
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      }

      function showToast(text, tone) {
        if (!text) return;
        if (toastTimer) clearTimeout(toastTimer);
        toastSeq += 1;
        const token = toastSeq;
        patch({ toast: { id: token, text: text, tone: tone || 'ok' } });
        toastTimer = setTimeout(function () {
          toastTimer = null;
          if (state.toast && state.toast.id === token) patch({ toast: null });
        }, TOAST_MS);
      }

      function setRow(id, value) {
        const next = Object.assign({}, state.rowState);
        if (value) next[id] = value;
        else delete next[id];
        patch({ rowState: next });
      }

      function bumpMutating(delta) {
        mutatingCount += delta;
        if (mutatingCount < 0) mutatingCount = 0;
        patch({ mutating: mutatingCount });
      }

      function setLogEntry(id, entry) {
        if (id) {
          const logs = Object.assign({}, state.logs);
          logs[id] = entry;
          patch({ logs: logs, lastLog: entry });
        } else {
          patch({ lastLog: entry });
        }
      }

      function failedMessage(err) {
        return err && err.message ? err.message : T.badResponse;
      }

      async function loadSnapshot(options) {
        const opts = options || {};
        if (snapshotInflight && !opts.force) return;
        const firstLoad = !state.snapshot;
        if (firstLoad && !opts.silent) patch({ phase: 'loading', error: null });
        snapshotInflight = true;
        try {
          const data = await request(net, 'snapshot', {}, {
            kind: 'snapshot',
            timeoutMs: SNAPSHOT_TIMEOUT,
            timeoutMessage: T.snapshotTimeout,
          });
          const view = normalizeSnapshot(data || {});
          const next = {
            phase: 'ready',
            error: null,
            snapshot: data,
            at: view.at,
            managers: view.managers,
            groups: view.groups,
            items: view.items,
            stats: view.stats,
          };
          if (!opts.silent) next.lastOp = { tone: 'idle', text: T.ready };
          patch(next);
        } catch (err) {
          if (err && err.code === 'aborted') return;
          if (state.snapshot) {
            patch({ lastOp: { tone: 'error', text: failedMessage(err) } });
            if (!opts.silent) showToast(failedMessage(err), 'error');
          } else {
            patch({
              phase: 'error',
              error: failedMessage(err),
              lastOp: { tone: 'error', text: failedMessage(err) },
            });
          }
        } finally {
          snapshotInflight = false;
        }
      }

      /* Explicit re-detection: the host re-probes the whole catalog and answers
       * with a snapshot-shaped payload whose `items` may be empty, so only the
       * catalog is applied here and a full snapshot follows. */
      async function detect() {
        if (state.detecting) return;
        patch({ detecting: true, lastOp: { tone: 'busy', text: T.detectingSources } });
        try {
          const data = await request(net, 'detect', {}, {
            kind: 'detect',
            timeoutMs: DETECT_TIMEOUT,
            timeoutMessage: T.detectTimeout,
          });
          const view = normalizeSnapshot(data || {});
          patch({
            managers: view.managers,
            groups: view.groups,
            stats: view.stats || state.stats,
            at: view.at,
            error: null,
          });
          await loadSnapshot({ silent: true, force: true });
          const found = countDetected(state.managers, state.stats);
          const message = T.detectedSources(found);
          patch({ lastOp: { tone: 'ok', text: message } });
          showToast(message, 'ok');
        } catch (err) {
          if (err && err.code === 'aborted') return;
          patch({ lastOp: { tone: 'error', text: failedMessage(err) } });
          showToast(failedMessage(err), 'error');
        } finally {
          patch({ detecting: false });
        }
      }

      function mergeUpdates(managerId, data) {
        const updates = Array.isArray(data && data.updates) ? data.updates : [];
        const failed = Array.isArray(data && data.failed) ? data.failed : [];
        const byId = Object.create(null);
        const failedIds = Object.create(null);
        updates.forEach(function (entry) {
          if (!entry) return;
          const id = entry.id ? String(entry.id) : (managerId + ':' + String(entry.packageId || ''));
          byId[id] = entry.latest === null || entry.latest === undefined ? null : String(entry.latest);
        });
        failed.forEach(function (entry) {
          if (!entry) return;
          if (entry.packageId) failedIds[managerId + ':' + String(entry.packageId)] = true;
        });
        const items = state.items.map(function (item) {
          if (item.manager !== managerId) return item;
          if (Object.prototype.hasOwnProperty.call(failedIds, item.id)) return item;
          if (Object.prototype.hasOwnProperty.call(byId, item.id)) {
            const latest = byId[item.id];
            return Object.assign({}, item, { latest: latest, hasUpdate: !!latest && latest !== item.version });
          }
          return Object.assign({}, item, {
            latest: item.version ? item.version : null,
            hasUpdate: false,
          });
        });
        patch({ items: items });
      }

      async function runCheck(managerId) {
        const manager = managerOf(state.managers, managerId);
        const label = manager.label || managerId;
        patch({ checking: managerId, lastOp: { tone: 'busy', text: T.managerCheckStart(label) } });
        try {
          const data = await request(net, 'check-updates', { manager: managerId }, {
            kind: 'check',
            timeoutMs: CHECK_TIMEOUT,
            timeoutMessage: T.checkTimeout,
          });
          if (data && data.unsupported === true) {
            /* The host says this manager has no version source (editor
             * extensions); nothing to merge, nothing failed. */
            patch({ lastOp: { tone: 'idle', text: T.checkUnsupported(label) } });
            return { ok: true, unsupported: true, updated: 0, failed: 0 };
          }
          mergeUpdates(managerId, data || {});
          const updates = Array.isArray(data && data.updates) ? data.updates.length : 0;
          const failures = Array.isArray(data && data.failed) ? data.failed.length : 0;
          const message = failures
            ? T.checkManagerPartial(label, updates, failures)
            : T.checkManagerDone(label, updates);
          patch({
            lastOp: { tone: failures ? 'warn' : 'ok', text: message },
          });
          return { ok: true, updated: updates, failed: failures };
        } catch (err) {
          if (err && err.code === 'aborted') return { aborted: true, updated: 0, failed: 0 };
          patch({ lastOp: { tone: 'error', text: err.message } });
          showToast(err.message, 'error');
          return { ok: false, updated: 0, failed: 1, error: err.message };
        } finally {
          patch({ checking: null });
        }
      }

      async function checkManager(managerId) {
        const manager = managerOf(state.managers, managerId);
        if (!isUsable(manager)) {
          showToast(T.managerUnavailable(manager.label || managerId, manager.error || manager.reason), 'warn');
          return;
        }
        if (!can(manager, 'checkUpdates')) {
          showToast(T.checkUnsupported(manager.label || managerId), 'warn');
          return;
        }
        const result = await runCheck(managerId);
        if (!result || result.aborted) return;
        if (result.ok) {
          if (result.unsupported) return;
          if (result.failed) showToast(T.checkManagerPartial(manager.label || managerId, result.updated, result.failed), 'warn');
          else showToast(T.checkManagerDone(manager.label || managerId, result.updated), 'ok');
        }
      }

      /* Managers that can check updates and are usable inside the current
       * scope. Group scopes resolve through the host's groups[].managerIds. */
      function checkTargets() {
        const ids = managerIdsForScope(state.scope, state.managers, state.groups);
        const scoped = ids === null
          ? state.managers.slice()
          : ids.map(function (id) { return managerOf(state.managers, id); });
        return scoped
          .filter(function (manager) { return isUsable(manager) && can(manager, 'checkUpdates'); })
          .map(function (manager) { return manager.id; });
      }

      async function checkScope() {
        if (state.checking) return;
        const targets = checkTargets();
        if (!targets.length) {
          const scopeManager = state.scope.indexOf('mgr:') === 0 ? managerOf(state.managers, state.scope.slice(4)) : null;
          if (scopeManager && !can(scopeManager, 'checkUpdates')) {
            showToast(T.checkUnsupported(scopeManager.label || scopeManager.id), 'warn');
          } else {
            showToast(T.noCheckableManager, 'warn');
          }
          return;
        }
        let updated = 0;
        let failed = 0;
        for (let i = 0; i < targets.length; i += 1) {
          const result = await runCheck(targets[i]);
          if (!result || result.aborted) return;
          updated += result.updated || 0;
          failed += result.failed || 0;
        }
        patch({ lastOp: { tone: failed ? 'warn' : 'ok', text: failed ? T.checkAllFailed(failed) : T.checkAllDone(updated) } });
        showToast(failed ? T.checkAllFailed(failed) : T.checkAllDone(updated), failed ? 'warn' : 'ok');
      }

      function applyVersion(id, version) {
        const items = state.items.map(function (item) {
          if (item.id !== id) return item;
          return Object.assign({}, item, {
            version: version ? String(version) : item.version,
            latest: null,
            hasUpdate: false,
          });
        });
        patch({ items: items });
      }

      function removeItem(id) {
        patch({ items: state.items.filter(function (item) { return item.id !== id; }) });
      }

      async function mutate(item, action, payload, options) {
        const opts = options || {};
        const runSnapshot = opts.snapshot !== false;
        const verb = action === 'uninstall' ? T.uninstall : T.update;
        bumpMutating(1);
        setRow(item.id, { state: 'running' });
        patch({ lastOp: { tone: 'busy', text: verb + ' ' + item.name + '…' } });
        try {
          const data = await request(net, action, payload, {
            kind: 'mutation',
            timeoutMs: MUTATION_TIMEOUT,
            timeoutMessage: T.mutationTimeout,
          });
          setLogEntry(item.id, {
            title: item.name,
            action: action,
            log: data && data.log ? String(data.log) : '',
            at: Date.now(),
          });
          if (action === 'uninstall') {
            removeItem(item.id);
            patch({ lastOp: { tone: 'ok', text: item.name + ' ' + T.uninstalled } });
            showToast(item.name + ' ' + T.uninstalled, 'ok');
          } else {
            const nextVersion = payload && payload.version ? String(payload.version) : item.latest;
            applyVersion(item.id, nextVersion);
            /* No version source (editor extensions): `update` means "reinstall
             * as latest", so there is no target version to report. */
            const doneText = nextVersion
              ? item.name + ' ' + T.updatedTo + ' ' + nextVersion
              : item.name + ' ' + T.reinstalled;
            patch({ lastOp: { tone: 'ok', text: doneText } });
            showToast(doneText, 'ok');
          }
          if (runSnapshot) await loadSnapshot({ silent: true });
          setRow(item.id, { state: 'done' });
          return { ok: true, data: data };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true };
          if (err && err.log) {
            setLogEntry(item.id, { title: item.name, action: action, log: String(err.log), at: Date.now() });
          }
          setRow(item.id, { state: 'failed', message: err.message });
          patch({ lastOp: { tone: 'error', text: err.message } });
          showToast(err.message, 'error');
          return { ok: false, error: err.message };
        } finally {
          bumpMutating(-1);
        }
      }

      function updateOne(item) {
        return mutate(item, 'update', {
          manager: item.manager,
          packageId: item.packageId,
          version: item.latest || null,
        }, { snapshot: true });
      }

      function batchUpdateOne(item) {
        return mutate(item, 'update', {
          manager: item.manager,
          packageId: item.packageId,
          version: item.latest || null,
        }, { snapshot: false });
      }

      function uninstallOne(item) {
        return mutate(item, 'uninstall', {
          manager: item.manager,
          packageId: item.packageId,
        }, { snapshot: true });
      }

      async function installPkg(managerId, pkg) {
        const name = pkg.name || pkg.packageId;
        bumpMutating(1);
        patch({ lastOp: { tone: 'busy', text: T.installing + ' ' + name } });
        try {
          const data = await request(net, 'install', {
            manager: managerId,
            packageId: pkg.packageId,
            name: pkg.name || null,
            version: pkg.version || null,
          }, { timeoutMs: MUTATION_TIMEOUT, timeoutMessage: T.mutationTimeout });
          setLogEntry(null, {
            title: name,
            action: 'install',
            log: data && data.log ? String(data.log) : '',
            at: Date.now(),
          });
          patch({ lastOp: { tone: 'ok', text: name + ' ' + T.installed } });
          showToast(name + ' ' + T.installed, 'ok');
          await loadSnapshot({ silent: true });
          return { ok: true, data: data };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true };
          if (err && err.log) {
            setLogEntry(null, { title: name, action: 'install', log: String(err.log), at: Date.now() });
          }
          patch({ lastOp: { tone: 'error', text: err.message } });
          return { ok: false, error: err.message };
        } finally {
          bumpMutating(-1);
        }
      }

      async function ensureDetail(id, force) {
        const cached = state.details[id];
        if (!force && cached && cached.state !== 'error') return;
        if (inflightDetail[id] && !force) return;
        inflightDetail[id] = true;
        const next = Object.assign({}, state.details);
        next[id] = { state: 'loading', data: cached && cached.data ? cached.data : null, error: null };
        patch({ details: next });
        const parts = splitItemId(id);
        try {
          const data = await request(net, 'detail', { manager: parts.manager, packageId: parts.packageId }, {
            timeoutMs: DETAIL_TIMEOUT,
            timeoutMessage: T.detailTimeout,
          });
          const ready = Object.assign({}, state.details);
          ready[id] = { state: 'ready', data: data || {}, error: null };
          patch({ details: ready });
        } catch (err) {
          if (err && err.code === 'aborted') return;
          const failed = Object.assign({}, state.details);
          failed[id] = { state: 'error', data: null, error: err.message };
          patch({ details: failed });
        } finally {
          inflightDetail[id] = false;
        }
      }

      async function revealItem(item, detailData) {
        const path = detailData && detailData.path ? detailData.path : (item.path || null);
        try {
          await request(net, 'reveal', {
            manager: item.manager,
            packageId: item.packageId,
            path: path,
          }, { timeoutMs: REVEAL_TIMEOUT, timeoutMessage: T.revealTimeout });
          showToast(T.revealed, 'ok');
        } catch (err) {
          if (err && err.code === 'aborted') return;
          showToast(err.message, 'error');
        }
      }

      /* ---- v3: process visibility -------------------------------------
       * `refreshProcesses` is the only writer of the running slice. The
       * Page's 3 s timer (and kill/launch) call it; the 60 s snapshot never
       * does. Both requests travel on api() and abort together on dispose. */
      /* Per-entry merge: an entry whose numbers did not change keeps its
       * previous object, so rows subscribe to their own entry and only the
       * rows that actually changed re-render on a tick. */
      function mergeRunning(prev, next) {
        const prevKeys = Object.keys(prev || EMPTY_RUNNING);
        const nextKeys = Object.keys(next);
        let changed = prevKeys.length !== nextKeys.length;
        const out = Object.create(null);
        for (let i = 0; i < nextKeys.length; i += 1) {
          const id = nextKeys[i];
          const candidate = next[id];
          const existing = prev ? prev[id] : undefined;
          if (existing && sameRunning(existing, candidate)) {
            out[id] = existing;
          } else {
            out[id] = candidate;
            changed = true;
          }
        }
        return { map: changed ? out : prev, changed: changed };
      }

      function applyRunning(data) {
        const view = normalizeRunning(data);
        const merged = mergeRunning(state.running, view.map);
        const base = { runningAt: view.at, runningTotals: view.totals, processError: null, processFailures: 0 };
        if (merged.changed) base.running = merged.map;
        patch(base);
      }

      function noteProcessFailure(message) {
        processesFailures += 1;
        const next = { processError: message, processFailures: processesFailures };
        /* Silent until the third failure in a row; then a non-blocking
         * status-bar hint. Rows keep their last known state. */
        if (processesFailures >= PROC_FAILURES_BEFORE_HINT) {
          next.lastOp = { tone: 'warn', text: T.processPollFailedHint(processesFailures) };
        }
        patch(next);
      }

      async function refreshProcesses() {
        if (net.disposed || processesInflight) return null;
        processesInflight = true;
        const seq = ++processesSeq;
        try {
          const data = await request(net, 'processes', {}, {
            kind: 'processes',
            timeoutMs: PROC_TIMEOUT,
            timeoutMessage: T.processPollFailed,
          });
          /* A later request or a teardown superseded this answer. */
          if (seq !== processesSeq || net.disposed) return null;
          applyRunning(data);
          return data;
        } catch (err) {
          if (err && err.code === 'aborted') return null;
          if (seq === processesSeq) noteProcessFailure(failedMessage(err));
          return null;
        } finally {
          processesInflight = false;
        }
      }

      function setProcessActive(active) {
        const next = !!active;
        if (state.processActive === next) return;
        patch({ processActive: next });
        /* Visible again: one immediate tick rather than waiting up to 3 s. */
        if (next) refreshProcesses();
      }

      function setDrawer(id) {
        drawerOpen = !!id;
        drawerId = id ? String(id) : null;
      }

      function isDrawerOpen(id) {
        return drawerOpen && drawerId === id;
      }

      function processEntry(id) {
        return (id && state.processDetail[id]) || EMPTY_PROC_DETAIL;
      }

      /* PIDs for a row tooltip: the bound list from `processes` when the host
       * sent it, else the PIDs of an already-cached process-detail. Never
       * triggers a request (rows must stay cheap). */
      function pidsFor(id) {
        const entry = runningOf(state.running, id);
        if (!entry) return [];
        if (entry.pids && entry.pids.length) return entry.pids;
        const cached = state.processDetail[id];
        if (cached && cached.data && cached.data.processes && cached.data.processes.length) {
          return cached.data.processes.map(function (proc) { return proc.pid; });
        }
        return [];
      }

      async function fetchProcessDetail(id, opts) {
        const options = opts || {};
        const key = String(id || '');
        if (!key) return { ok: false, error: T.processUnsupported };
        if (inflightProcess[key]) return { ok: false, busy: true };
        inflightProcess[key] = true;
        const previous = state.processDetail[key];
        const next = Object.assign({}, state.processDetail);
        next[key] = {
          state: 'loading',
          data: options.keep && previous ? previous.data : null,
          error: null,
          errorCode: null,
        };
        patch({ processDetail: next });
        try {
          const data = await request(net, 'process-detail', { id: key }, {
            kind: 'process-detail',
            timeoutMs: PROC_DETAIL_TIMEOUT,
            timeoutMessage: T.processFailed,
          });
          const ready = Object.assign({}, state.processDetail);
          ready[key] = { state: 'ready', data: normalizeProcessDetail(data), error: null, errorCode: null };
          patch({ processDetail: ready });
          return { ok: true, data: ready[key].data };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true };
          const failed = Object.assign({}, state.processDetail);
          failed[key] = {
            state: 'error',
            data: previous && previous.data ? previous.data : null,
            error: failedMessage(err),
            errorCode: err && err.code ? err.code : null,
          };
          patch({ processDetail: failed });
          return { ok: false, error: failedMessage(err), code: err && err.code };
        } finally {
          inflightProcess[key] = false;
        }
      }

      /* Opening the 进程 tab: fetch once per opening unless the last attempt
       * errored (then the drawer offers 重试). */
      function ensureProcessDetail(id) {
        const entry = state.processDetail[id];
        if (entry && (entry.state === 'loading' || entry.state === 'ready')) return null;
        return fetchProcessDetail(id, { keep: false });
      }

      async function killProcess(pid) {
        try {
          const data = await request(net, 'process-kill', { pid: pid }, {
            kind: 'process-kill',
            timeoutMs: PROC_KILL_TIMEOUT,
            timeoutMessage: T.processPollFailed,
          });
          if (!data || data.killed === false) {
            showToast(T.processKillFailed, 'error');
            patch({ lastOp: { tone: 'error', text: T.processKillFailed } });
            return { ok: false };
          }
          showToast(T.processKilled(pid), 'ok');
          patch({ lastOp: { tone: 'ok', text: T.processKilled(pid) } });
          /* Refresh the running slice now instead of waiting for the next
           * tick, then the open drawer's detail so the row disappears. */
          await refreshProcesses();
          if (drawerOpen && drawerId) await fetchProcessDetail(drawerId, { keep: true });
          return { ok: true };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true };
          showToast(failedMessage(err), 'error');
          patch({ lastOp: { tone: 'error', text: failedMessage(err) } });
          return { ok: false, error: failedMessage(err) };
        }
      }

      async function launchItem(item) {
        if (!item) return { ok: false };
        patch({ lastOp: { tone: 'busy', text: T.launching } });
        try {
          await request(net, 'launch', { id: item.id }, {
            kind: 'launch',
            timeoutMs: LAUNCH_TIMEOUT,
            timeoutMessage: T.launching,
          });
          showToast(T.launched(item.name), 'ok');
          patch({ lastOp: { tone: 'ok', text: T.launched(item.name) } });
          await refreshProcesses();
          return { ok: true };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true };
          showToast(failedMessage(err), 'error');
          patch({ lastOp: { tone: 'error', text: failedMessage(err) } });
          return { ok: false, error: failedMessage(err) };
        }
      }

      /* 「安装 psutil」: a real install into the local Python environment
       * through the existing install path, then the detail action is retried. */
      async function installPsutil(hint) {
        const target = hint && hint.manager ? hint : { manager: 'pip', packageId: 'psutil' };
        patch({ lastOp: { tone: 'busy', text: T.processInstallingPsutil } });
        const result = await installPkg(target.manager, {
          packageId: target.packageId,
          name: target.packageId,
          version: null,
        });
        if (!result || !result.ok) return result || { ok: false };
        if (drawerOpen && drawerId) await fetchProcessDetail(drawerId, { keep: true });
        return { ok: true };
      }

      async function searchPkgs(managerId, query) {
        try {
          const data = await request(net, 'search', { manager: managerId, query: query }, {
            timeoutMs: SEARCH_TIMEOUT,
            timeoutMessage: T.searchTimeout,
          });
          const results = Array.isArray(data && data.results) ? data.results.map(function (entry) {
            return {
              packageId: entry && entry.packageId ? String(entry.packageId) : '',
              name: entry && entry.name ? String(entry.name) : '',
              version: entry && entry.version ? String(entry.version) : '',
              source: entry && entry.source ? String(entry.source) : managerId,
              description: entry && entry.description ? String(entry.description) : null,
            };
          }) : [];
          return { ok: true, results: results };
        } catch (err) {
          if (err && err.code === 'aborted') return { ok: false, aborted: true, error: T.cancelled };
          return { ok: false, error: err.message };
        }
      }

      function setScope(scope) {
        patch({ scope: scope });
      }

      function setQuery(query) {
        patch({ query: query });
      }

      function setSort(sort) {
        patch({ sort: sort });
      }

      function resetFilters() {
        patch({ scope: 'all', query: '', sort: 'default' });
      }

      function setBatchRunning(value) {
        patch({ batchRunning: !!value });
      }

      /* ---- polling lifecycle -------------------------------------------
       * One interval owns the 3 s cadence; `visibilitychange` flips
       * processActive and an immediate tick covers the resume. Both the
       * timer and the listener are torn down here (and in dispose). */
      function startProcessPolling() {
        stopProcessPolling();
        if (typeof window === 'undefined' || typeof document === 'undefined') return stopProcessPolling;
        function onVisibility() {
          setProcessActive(document.visibilityState !== 'hidden');
        }
        visibilityHandler = onVisibility;
        document.addEventListener('visibilitychange', onVisibility);
        setProcessActive(document.visibilityState !== 'hidden');
        processesTimer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          if (!state.processActive || processesInflight) return;
          refreshProcesses();
        }, PROC_POLL_MS);
        return stopProcessPolling;
      }

      function stopProcessPolling() {
        if (processesTimer) clearInterval(processesTimer);
        processesTimer = null;
        if (visibilityHandler && typeof document !== 'undefined' && document.removeEventListener) {
          document.removeEventListener('visibilitychange', visibilityHandler);
        }
        visibilityHandler = null;
        net.abortByKind(['processes']);
        if (state.processActive) patch({ processActive: false });
      }

      function dispose() {
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
        stopProcessPolling();
        net.abortAll();
        listeners.clear();
      }

      return {
        get: get,
        subscribe: subscribe,
        loadSnapshot: loadSnapshot,
        detect: detect,
        checkManager: checkManager,
        checkScope: checkScope,
        updateOne: updateOne,
        batchUpdateOne: batchUpdateOne,
        uninstallOne: uninstallOne,
        installPkg: installPkg,
        ensureDetail: ensureDetail,
        revealItem: revealItem,
        searchPkgs: searchPkgs,
        setScope: setScope,
        setQuery: setQuery,
        setSort: setSort,
        resetFilters: resetFilters,
        setBatchRunning: setBatchRunning,
        showToast: showToast,
        dispose: dispose,
        /* v3 */
        startProcessPolling: startProcessPolling,
        stopProcessPolling: stopProcessPolling,
        refreshProcesses: refreshProcesses,
        setDrawer: setDrawer,
        isDrawerOpen: isDrawerOpen,
        processEntry: processEntry,
        ensureProcessDetail: ensureProcessDetail,
        fetchProcessDetail: fetchProcessDetail,
        pidsFor: pidsFor,
        killProcess: killProcess,
        launchItem: launchItem,
        installPsutil: installPsutil,
      };
    }

    /* ================================================================== */
    /* Icons (artwork colours allowed inside SVG)                         */
    /* ================================================================== */

    function svgBox(size, extra) {
      return Object.assign({
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, extra || {});
    }

    function icon(paths, size) {
      return h('svg', svgBox(size), paths.map(function (d) { return h('path', { key: d, d: d }); }));
    }

    function CubeIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      const stroke = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h('svg', svgBox(size, { stroke: stroke }),
        h('path', { d: 'm12 2.8 7.6 4.3v8.6L12 19.9 4.4 15.7V7.1L12 2.8Z' }),
        h('path', { d: 'm4.9 7.4 7.1 4 7.1-4' }),
        h('path', { d: 'M12 12.6v5.2' }),
        h('path', { d: 'm9.8 15.6 2.2 2.2 2.2-2.2' }));
    }

    function GridIcon(props) {
      const size = (props && props.size) || 17;
      return h('svg', svgBox(size),
        h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.4 }));
    }

    function UpdatesIcon(props) { return icon(['M12 3v12', 'm7 10 5 5 5-5', 'M4 18.5h16'], (props && props.size) || 17); }
    function ActivityIcon(props) { return icon(['M3 12h4l2.5-6 5 12L17 12h4'], (props && props.size) || 17); }
    function CheckIcon(props) { return icon(['M20 6 9 17l-5-5'], (props && props.size) || 12); }
    function ChevronIcon(props) { return icon(['m9 6 6 6-6 6'], (props && props.size) || 15); }
    function XIcon(props) { return icon(['M6 6l12 12M18 6 6 18'], (props && props.size) || 15); }
    function FolderIcon(props) { return icon(['M3 7a2 2 0 0 1 2-2h4l2 2.4h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'], (props && props.size) || 14); }
    function DownloadIcon(props) { return icon(['M12 4v10', 'm8 10 4 4 4-4', 'M5 19h14'], (props && props.size) || 14); }
    function RefreshIcon(props) { return icon(['M20 5v5h-5', 'M4 19v-5h5', 'M19.4 10a7.6 7.6 0 0 0-13-3.3L4 9', 'M4.6 14a7.6 7.6 0 0 0 13 3.3L20 15'], (props && props.size) || 14); }

    function ScanIcon(props) {
      return h('svg', svgBox((props && props.size) || 15),
        h('path', { d: 'M4 8.6V6.2A2.2 2.2 0 0 1 6.2 4h2.4' }),
        h('path', { d: 'M15.4 4h2.4A2.2 2.2 0 0 1 20 6.2v2.4' }),
        h('path', { d: 'M20 15.4v2.4a2.2 2.2 0 0 1-2.2 2.2h-2.4' }),
        h('path', { d: 'M8.6 20H6.2A2.2 2.2 0 0 1 4 17.8v-2.4' }),
        h('circle', { cx: 12, cy: 12, r: 3.1 }));
    }

    function SearchIcon(props) {
      return h('svg', svgBox((props && props.size) || 15),
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'm20 20-3.4-3.4' }));
    }

    function EmptyIcon(props) {
      return h('svg', svgBox((props && props.size) || 28),
        h('path', { d: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z' }),
        h('path', { d: 'm4.2 7.7 7.8 4.4 7.8-4.4' }),
        h('path', { d: 'M12 12.1V21' }));
    }

    function ManagerLogo(props) {
      const id = props && props.id ? props.id : '';
      const size = props && typeof props.size === 'number' ? props.size : 14;
      const mono = !!(props && props.mono);
      const box = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      };

      if (id === 'winget') {
        return h('svg', Object.assign({}, box, { fill: mono ? 'currentColor' : '#1b9df0' }),
          h('path', { d: 'M3 5.4 10.4 4.3v7.1H3zM11.5 4.1 21 2.8v8.6h-9.5zM3 12.7h7.4v7L3 18.6zM11.5 12.7H21v8.5l-9.5-1.3z' })
        );
      }
      if (mono) {
        const glyph = id === 'npm'
          ? h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'square' },
              h('path', { d: 'M6 17.5V7h4.2v10.5' }),
              h('path', { d: 'M10.2 7v10.5' }))
          : id === 'pnpm'
            ? h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'square' },
                h('path', { d: 'M8 20.5V7h4.2v6.4H8' }))
            : id === 'bun'
              ? h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'square' },
                  h('path', { d: 'M8.5 4.5v15h4.2V10H8.5' }))
              : h('path', { d: 'm12 4 7 4v8l-7 4-7-4V8Z' });
        return h('svg', Object.assign({}, box, { fill: 'none' }), glyph);
      }
      if (id === 'npm') {
        return h('svg', box,
          h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 4.4, fill: '#cb3837' }),
          h('g', { fill: 'none', stroke: '#ffffff', strokeWidth: 2.4, strokeLinecap: 'square' },
            h('path', { d: 'M6.4 17V8.2h3.8V17' }),
            h('path', { d: 'M10.2 8.2V17' }))
        );
      }
      if (id === 'pnpm') {
        return h('svg', box,
          h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 4.4, fill: '#f9ad00' }),
          h('g', { fill: 'none', stroke: '#ffffff', strokeWidth: 2.4, strokeLinecap: 'square' },
            h('path', { d: 'M8.2 20V8.2h4V14h-4' }))
        );
      }
      if (id === 'bun') {
        return h('svg', box,
          h('circle', { cx: 12, cy: 12, r: 10, fill: '#fbf0df' }),
          h('g', { fill: 'none', stroke: '#14151a', strokeWidth: 2.4, strokeLinecap: 'square' },
            h('path', { d: 'M9 5.6v12.8h3.8V9.6H9' }))
        );
      }
      return h('svg', Object.assign({}, box, { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
        h('path', { d: 'm12 4 7 4v8l-7 4-7-4V8Z' })
      );
    }

    /* Real logo when the host supplied one; onError (or no URL) falls back to
     * the inline artwork so a broken image never shows up. */
    function LogoImage(props) {
      const [failed, setFailed] = useState(false);
      if (!props.src || failed) return props.fallback;
      return h('img', {
        className: 'pk-logo-img',
        src: props.src,
        alt: '',
        width: props.size,
        height: props.size,
        loading: 'lazy',
        decoding: 'async',
        draggable: 'false',
        'aria-hidden': 'true',
        onError: function () { setFailed(true); },
      });
    }

    function RowMark(props) {
      const item = props.item;
      const glyph = item.kind === 'app'
        ? h(ManagerLogo, { id: item.manager || 'winget', size: 20 })
        : h(ManagerLogo, { id: item.manager, size: 14, mono: true });
      if (item.kind === 'app' || item.logoUrl) {
        return h('span', { className: 'pk-logo' },
          h(LogoImage, { src: item.logoUrl, size: 20, fallback: glyph }));
      }
      return h('span', { className: 'pk-mark', 'data-tone': toneFor(item) }, glyph);
    }

    function DrawerMark(props) {
      const item = props.item;
      const glyph = item.kind === 'app'
        ? h(ManagerLogo, { id: item.manager || 'winget', size: 24 })
        : h(ManagerLogo, { id: item.manager, size: 24 });
      return h(LogoImage, { src: item.logoUrl, size: 24, fallback: glyph });
    }

    /* ================================================================== */
    /* Hooks                                                              */
    /* ================================================================== */

    function useStore(store) {
      const [snap, setSnap] = useState(function () { return store.get(); });
      useEffect(function () {
        function onChange() { setSnap(store.get()); }
        const off = store.subscribe(onChange);
        onChange();
        return off;
      }, [store]);
      return snap;
    }

    /* Row-level subscription: a row listens to the one running entry it owns
     * and only re-renders when that entry is replaced. The 3 s tick rebuilds
     * the map but keeps the identity of every unchanged id, so an idle table
     * sees zero row updates. */
    function useRunningEntry(store, id) {
      const [entry, setEntry] = useState(function () { return runningOf(store.get().running, id); });
      useEffect(function () {
        function onChange() {
          const next = runningOf(store.get().running, id);
          setEntry(function (prev) { return sameRunning(prev, next) ? prev : next; });
        }
        const off = store.subscribe(onChange);
        onChange();
        return off;
      }, [store, id]);
      return entry;
    }

    /* Keeps the panel readable while the poll is live: the drawer re-renders
     * with the page, only the expanded process row keeps its local state. */

    /* ================================================================== */
    /* Small components                                                   */
    /* ================================================================== */

    function Rail(props) {
      const s = props.state;
      const managers = s.managers || [];
      const groups = s.groups || [];
      const [showUndetected, setShowUndetected] = useState(false);
      const undetected = managers.filter(function (manager) { return !isDetected(manager); });
      const totalItems = s.items.length;
      const updatable = s.items.filter(function (item) {
        return item.hasUpdate && can(managerOf(managers, item.manager), 'checkUpdates');
      }).length;
      const availableCount = managers.filter(isUsable).length;
      const disk = s.stats && s.stats.disk ? s.stats.disk : null;
      const diskPct = disk && typeof disk.totalBytes === 'number' && disk.totalBytes > 0 && typeof disk.freeBytes === 'number'
        ? Math.max(0, Math.min(100, Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)))
        : null;

      function navButton(scope, label, count, icon) {
        const current = s.scope === scope;
        return h('button', {
          type: 'button',
          className: 'pk-nav-item',
          'aria-current': current ? 'true' : undefined,
          onClick: function () { props.onScope(scope); },
          'aria-label': label,
        },
          h('span', { className: 'pk-nav-icon' }, icon),
          h('span', { className: 'pk-nav-label' }, label),
          h('span', { className: 'pk-nav-badge' }, String(count))
        );
      }

      function managerRow(manager) {
        const scope = 'mgr:' + manager.id;
        const current = s.scope === scope;
        const count = s.items.filter(function (item) { return item.manager === manager.id; }).length;
        const off = manager.available === false;
        const label = manager.label || manager.id;
        const hint = off ? T.managerUnavailable(label, manager.error || manager.reason) : label;
        return h('button', {
          key: manager.id,
          type: 'button',
          className: 'pk-nav-item pk-nav-manager' + (off ? ' is-off' : ''),
          'aria-current': current ? 'true' : undefined,
          title: hint,
          onClick: function () { props.onScope(scope); },
          'aria-label': hint,
        },
          h('span', { className: 'pk-nav-logo' }, h(ManagerLogo, { id: manager.id, size: 14 })),
          h('span', { className: 'pk-nav-label' }, label),
          off
            ? h('span', { className: 'pk-nav-avail' }, T.unavailable)
            : h('span', { className: 'pk-nav-badge' }, String(count))
        );
      }

      /* One section per host group, in the order the host sent. The group
       * header is a real button: clicking it scopes the list to grp:<id>. */
      const sections = groups.map(function (group) {
        const members = managersInGroup(group, managers);
        if (!members.length) return null;
        const usable = members.filter(isUsable).length;
        const current = s.scope === 'grp:' + group.id;
        return h('div', { className: 'pk-nav-group', key: 'group-' + group.id },
          h('button', {
            type: 'button',
            className: 'pk-nav-group-t',
            'aria-current': current ? 'true' : undefined,
            title: group.label,
            onClick: function () { props.onScope('grp:' + group.id); },
          },
            h('span', null, group.label),
            h('span', { className: 'pk-n pk-mono' }, usable + '/' + members.length)),
          members.filter(isDetected).map(managerRow));
      }).filter(Boolean);

      const undetectedBlock = undetected.length
        ? h('div', { className: 'pk-ud' },
            h('div', { className: 'pk-ud-head' },
              h('button', {
                type: 'button',
                className: 'pk-ud-toggle',
                'aria-expanded': showUndetected ? 'true' : 'false',
                'aria-controls': 'pk-undetected-list',
                onClick: function () { setShowUndetected(function (value) { return !value; }); },
              },
                h(ChevronIcon, { size: 12 }),
                h('span', null, T.undetected(undetected.length))),
              h('button', {
                type: 'button',
                className: 'pk-ud-refresh',
                disabled: !!props.detecting,
                title: T.detect,
                'aria-label': T.detect,
                onClick: props.onDetect,
              },
                props.detecting ? h('span', { className: 'pk-spin' }) : h(ScanIcon, { size: 11 }),
                props.detecting ? T.detecting : T.detect)),
            showUndetected
              ? h('div', { className: 'pk-ud-list', id: 'pk-undetected-list' }, undetected.map(function (manager) {
                  const label = manager.label || manager.id;
                  return h('div', {
                    key: manager.id,
                    className: 'pk-ud-row',
                    title: manager.reason || T.undetectedReason,
                    'aria-disabled': 'true',
                  },
                    h('span', { className: 'pk-nav-logo' }, h(ManagerLogo, { id: manager.id, size: 14, mono: true })),
                    h('span', { className: 'pk-ud-name' }, label));
                }))
              : null)
        : null;

      return h('aside', { className: 'pk-rail', 'aria-label': T.appName },
        h('div', { className: 'pk-brand' },
          h('span', { className: 'pk-brand-mark', 'aria-hidden': 'true' }, h(CubeIcon, { size: 17 })),
          h('span', { className: 'pk-brand-text' },
            h('strong', null, T.appName),
            h('small', null, T.appTagline))),
        h('nav', { className: 'pk-nav', 'aria-label': T.navAria },
          navButton('all', T.navOverview, totalItems, h(GridIcon)),
          navButton(RUNNING_SCOPE, T.navRunning, runningCount(s.running), h(ActivityIcon)),
          navButton('updates', T.navUpdates, updatable, h(UpdatesIcon)),
          sections,
          undetectedBlock),
        h('div', { className: 'pk-side-foot' },
          disk ? h('div', { className: 'pk-disk' },
            h('div', { className: 'pk-disk-top' },
              h('span', null, T.diskTop(disk.mount || 'C:')),
              h('span', { className: 'pk-mono' }, (diskPct === null ? '—' : diskPct + '%'))),
            h('div', { className: 'pk-disk-bar' },
              h('i', { style: { width: (diskPct === null ? 0 : diskPct) + '%' } })),
            h('p', { className: 'pk-disk-sub' }, T.diskSub(fmtSize(disk.freeBytes), fmtSize(disk.totalBytes)))
          ) : null,
          h('p', { className: 'pk-side-note' }, T.indexLine(fmtRelative(s.at))),
          h('p', { className: 'pk-side-note' }, T.managersAvailable(availableCount, managers.length))
        ));
    }

    function Topbar(props) {
      return h('header', { className: 'pk-topbar' },
        h('div', { className: 'pk-tb-title' },
          h('h1', null, props.title),
          h('p', { className: 'pk-tb-sub' }, props.subtitle)),
        h('div', { className: 'pk-tb-tools' },
          h('div', { className: 'pk-search' },
            h(SearchIcon),
            h('input', {
              ref: props.searchRef,
              type: 'search',
              value: props.query,
              placeholder: props.placeholder,
              'aria-label': props.placeholder,
              autoComplete: 'off',
              onChange: function (event) { props.onQuery(event.target.value); },
            })),
          h('label', { className: 'pk-sort' },
            h('span', { className: 'pk-sr' }, T.sort),
            h('select', {
              value: props.sort,
              'aria-label': T.sort,
              onChange: function (event) { props.onSort(event.target.value); },
            }, SORTS.map(function (option) {
              return h('option', { key: option.value, value: option.value }, option.label);
            }))),
          h('button', {
            type: 'button',
            className: 'pk-icon-btn pk-scan-btn',
            title: T.detect,
            'aria-label': T.detect,
            disabled: !!props.detecting || props.batchRunning,
            onClick: props.onDetect,
          }, props.detecting ? h('span', { className: 'pk-spin' }) : h(ScanIcon)),
          props.showCheck ? h('button', {
            type: 'button',
            className: 'pk-btn-ghost',
            disabled: !!props.checking || props.batchRunning || !!props.detecting,
            onClick: props.onCheck,
          },
            props.checking ? h('span', { className: 'pk-spin' }) : h(RefreshIcon),
            props.checking ? T.checking : T.checkUpdates) : null,
          h('button', {
            type: 'button',
            className: 'pk-btn-primary',
            disabled: props.pending === 0 || props.batchRunning,
            onClick: props.onBatch,
          },
            T.updatesAll,
            h('span', { className: 'pk-btn-count' }, String(props.pending))),
          h('button', {
            type: 'button',
            className: 'pk-btn-ghost',
            disabled: props.batchRunning || props.mutating > 0,
            onClick: props.onInstall,
          },
            h(DownloadIcon),
            T.install)));
    }

    function Stats(props) {
      return h('section', { className: 'pk-stats', 'aria-label': T.statsLabel },
        props.cards.map(function (card, index) {
          return h('div', { className: 'pk-stat', key: 'stat-' + index },
            h('div', { className: 'pk-stat-k' }, card.k),
            h('div', { className: 'pk-stat-v' },
              card.v,
              card.u ? h('span', { className: 'pk-u' }, card.u) : null),
            h('div', { className: 'pk-stat-d', title: card.d }, card.d));
        }));
    }

    function ListHead() {
      return h('div', { className: 'pk-listhead', 'aria-hidden': 'true' },
        HEADERS.map(function (head, index) {
          return h('span', { key: 'head-' + index, className: head.className || undefined }, head.label);
        }));
    }

    /* A single row. Its Live/Act status slot is the only part that depends on
     * the polled running slice, and it subscribes to its own entry, so a 3 s
     * tick re-renders at most the rows whose {procCount,rss,cpu} changed. */
    function Row(props) {
      const runningEntry = useRunningEntry(props.store, props.id);
      return h(RowBase, Object.assign({}, props, { runningEntry: runningEntry }));
    }

    function RowBase(props) {
      const item = props.item;
      const runningEntry = props.runningEntry || null;
      const rowState = props.row || IDLE_ROW;
      const running = rowState.state === 'running';
      const failed = rowState.state === 'failed';
      const manager = props.manager || managerOf([], item.manager);
      const unavailable = !isUsable(manager);
      const caps = capsOf(manager);
      const canCheck = caps.checkUpdates !== false;
      const canUpdate = caps.update !== false;
      const latest = item.latest;
      const hasLatest = latest !== null && latest !== undefined && latest !== '';
      /* Editor extensions have no version source: `update` means "reinstall as
       * latest". Derived from capabilities only, never from a manager id. */
      const reinstallOnly = !hasLatest && !canCheck && canUpdate;
      const checkingThis = props.checking === item.manager;
      const lockRow = running || props.batchRunning;

      const displayName = shortExtName(item);
      const fullName = item.kind === 'ext' ? (item.packageId || item.name) : item.name;
      let nameSub;
      if (item.kind === 'ext') {
        nameSub = T.extKind + ' · ' + (manager.label || item.manager || '—');
      } else if (item.kind === 'app') {
        nameSub = [item.source || item.manager, manager.vendor].filter(Boolean).join(' · ') || '—';
      } else {
        nameSub = [item.manager, item.scope].filter(Boolean).join(' · ') || '—';
      }
      const tagText = item.kind === 'app' ? (item.source || item.manager || '—') : (item.scope || '—');

      let statusClass = 'pk-cell-status';
      let statusText = T.upToDate;
      /* Live process state wins while the item is running; every other state
       * (including a mutating row) keeps its existing copy. */
      const liveRunning = runningEntry && runningEntry.procCount > 0 ? runningEntry : null;
      if (liveRunning) {
        statusClass += ' is-live';
        statusText = null;
      } else if (failed) {
        statusClass += ' is-error';
        statusText = T.failed;
      } else if (running) {
        statusClass += ' is-warn';
        statusText = T.updating;
      } else if (unavailable) {
        statusClass += ' is-muted';
        statusText = T.unavailable;
      } else if (item.hasUpdate) {
        statusClass += ' is-warn';
        statusText = T.updatable;
      } else if (reinstallOnly) {
        statusClass += ' is-ok';
        statusText = T.installed;
      } else if (!canCheck) {
        statusClass += ' is-muted';
        statusText = '—';
      } else if (!hasLatest) {
        statusClass += ' is-muted';
        statusText = T.unchecked;
      } else {
        statusClass += ' is-ok';
      }
      const statusCell = liveRunning
        ? h('div', {
            className: statusClass,
            title: T.runningPids(props.pidsFor ? props.pidsFor(item.id) : []),
            'aria-label': T.runningRowAria(liveRunning.procCount),
          },
            h('span', { className: 'pk-live-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'pk-live-n pk-mono' }, String(liveRunning.procCount)),
            h('span', { className: 'pk-live-t' }, ' ' + T.processUnit))
        : h('div', { className: statusClass, title: failed ? rowState.message : undefined },
            running ? h('span', { className: 'pk-spin' }) : null,
            statusText);

      let latestCell;
      if (running) {
        latestCell = [
          h('span', { key: 'v', className: 'pk-ver-new pk-mono' }, hasLatest ? latest : '…'),
          h('span', { key: 'b', className: 'pk-busy-tag' }, h('span', { className: 'pk-spin' }), T.updating),
        ];
      } else if (item.hasUpdate && hasLatest) {
        latestCell = [
          h('span', { key: 'v', className: 'pk-ver-new pk-mono' }, latest),
          canUpdate ? h('button', {
            key: 'b',
            type: 'button',
            className: 'pk-btn-mini',
            disabled: lockRow,
            onClick: function () { props.onUpdate(item); },
          }, T.update) : null,
        ];
      } else if (reinstallOnly) {
        latestCell = [
          h('span', { key: 'd', className: 'pk-muted' }, '—'),
          h('button', {
            key: 'b',
            type: 'button',
            className: 'pk-btn-mini',
            title: T.reinstallHint,
            disabled: lockRow,
            onClick: function () { props.onUpdate(item); },
          }, T.update),
        ];
      } else if (hasLatest) {
        latestCell = h('span', { className: 'pk-is-latest' },
          h(CheckIcon, { size: 12 }),
          T.upToDate);
      } else {
        latestCell = [
          h('span', { key: 'd', className: 'pk-muted' }, '—'),
          canCheck ? h('button', {
            key: 'c',
            type: 'button',
            className: 'pk-btn-mini is-plain',
            disabled: checkingThis || lockRow,
            onClick: function () { props.onCheck(item); },
          }, checkingThis ? h('span', { className: 'pk-spin' }) : T.check) : null,
        ];
      }

      /* Size is only ever what the host measured (bytes). The host never emits 0 — both sources
       * require a positive value (`estimatedSizeKb > 0`, the directory walk only records > 0) — so
       * a non-positive number here means "not measured", and an em dash is the honest answer. */
      const sized = typeof item.sizeBytes === 'number' && isFinite(item.sizeBytes) && item.sizeBytes > 0;
      const sizeCell = h('div', {
        className: 'pk-cell-size pk-mono' + (sized ? '' : ' is-unknown'),
        title: sized ? fmtSize(item.sizeBytes) : T.sizeUnknown,
      }, sized ? fmtSize(item.sizeBytes) : '—');

      return h('div', { className: 'pk-row', 'data-id': item.id },
        h('div', { className: 'pk-cell-logo' }, h(RowMark, { item: item })),
        h('button', {
          type: 'button',
          className: 'pk-cell-name',
          title: fullName || displayName,
          onClick: function (event) { props.onOpen(item, event.currentTarget); },
          'aria-label': T.openDetail(displayName),
        },
          h('span', { className: 'pk-nm', title: fullName || displayName }, displayName),
          h('span', { className: 'pk-nm-sub', title: nameSub }, nameSub)),
        h('div', { className: 'pk-cell-source' }, h('span', { className: 'pk-tag', title: tagText }, tagText)),
        h('div', { className: 'pk-cell-ver pk-mono', title: item.version || '—' }, item.version || '—'),
        h('div', { className: 'pk-cell-latest' }, latestCell),
        sizeCell,
        statusCell,
        h('button', {
          type: 'button',
          className: 'pk-cell-more',
          onClick: function (event) { props.onOpen(item, event.currentTarget); },
          'aria-label': T.openDetail(displayName),
        }, h(ChevronIcon))
      );
    }

    function Skeleton() {
      const widths = ['70%', '48%', '60%'];
      return h('div', { className: 'pk-skeleton', 'aria-hidden': 'true' },
        widths.map(function (width, index) {
          return h('div', { className: 'pk-sk-row', key: 'sk-' + index },
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar', style: { width: width } }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }),
            h('span', { className: 'pk-sk-bar' }));
        }));
    }

    function EmptyState(props) {
      return h('div', { className: 'pk-empty' },
        h(EmptyIcon, { size: 28 }),
        h('p', { className: 'pk-e-title' }, props.title),
        h('p', { className: 'pk-e-desc' }, props.desc),
        h('button', { type: 'button', className: 'pk-btn-ghost', onClick: props.onAction }, props.actionLabel));
    }

    function ErrorBar(props) {
      return h('div', { className: 'pk-error-bar', role: 'alert' },
        h('span', { className: 'pk-error-text' }, props.message),
        h('button', { type: 'button', className: 'pk-btn-ghost', onClick: props.onRetry }, T.retry));
    }

    function StatusBar(props) {
      return h('footer', { className: 'pk-status', 'data-tone': props.tone || 'idle' },
        h('span', { className: 'pk-status-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'pk-status-text', 'aria-live': 'polite' }, props.text),
        props.onOutput ? h('button', {
          type: 'button',
          className: 'pk-status-link',
          onClick: props.onOutput,
          disabled: !props.hasOutput,
        }, T.viewOutput) : null);
    }

    function Toast(props) {
      if (!props.toast) return null;
      return h('div', {
        className: 'pk-toast',
        role: 'status',
        'aria-live': 'polite',
        'data-tone': props.toast.tone || 'ok',
      },
        h('span', { className: 'pk-dot', 'aria-hidden': 'true' }),
        h('span', null, props.toast.text));
    }

    /* ================================================================== */
    /* Process tab (drawer)                                               */
    /* ================================================================== */

    const ENV_ROW_LIMIT = 300;

    function CopyButton(props) {
      const [copied, setCopied] = useState(false);
      const timerRef = useRef(null);
      useEffect(function () {
        return function () { if (timerRef.current) clearTimeout(timerRef.current); };
      }, []);
      function copy() {
        const text = props.text === null || props.text === undefined ? '' : String(props.text);
        const done = function () {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(function () { setCopied(false); }, 1400);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { done(); });
          } else {
            done();
          }
        } catch (err) {
          done();
        }
        if (props.onCopy) props.onCopy(text);
      }
      return h('button', {
        type: 'button',
        className: 'pk-copy' + (copied ? ' is-done' : ''),
        title: props.title || T.copy,
        'aria-label': props.title || T.copy,
        onClick: copy,
      }, copied ? T.copied : (props.label || T.copy));
    }

    function ProcessSummary(props) {
      const tiles = [
        { k: T.processSumCpu, v: fmtCpu(props.cpu), u: T.unitPercent },
        { k: T.processSumMem, v: props.mem, u: '' },
        { k: T.processSumCount, v: String(props.count), u: T.unitProcess },
      ];
      return h('div', { className: 'pk-ps-grid' }, tiles.map(function (tile, index) {
        return h('div', { className: 'pk-ps', key: 'ps-' + index },
          h('span', { className: 'pk-ps-k' }, tile.k),
          h('span', { className: 'pk-ps-v pk-mono' },
            tile.v,
            tile.u ? h('i', null, tile.u) : null));
      }));
    }

    function EnvTable(props) {
      const env = props.env || {};
      const [open, setOpen] = useState(false);
      const [filter, setFilter] = useState('');
      const rows = useMemo(function () {
        const keys = Object.keys(env).sort(function (a, b) { return a.localeCompare(b); });
        const needle = filter.trim().toLowerCase();
        const matched = needle
          ? keys.filter(function (key) {
              return key.toLowerCase().indexOf(needle) !== -1
                || String(env[key]).toLowerCase().indexOf(needle) !== -1;
            })
          : keys;
        return matched.slice(0, ENV_ROW_LIMIT);
      }, [env, filter]);
      const total = Object.keys(env).length;
      return h('div', { className: 'pk-env' },
        h('div', { className: 'pk-env-head' },
          h('button', {
            type: 'button',
            className: 'pk-env-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function () { setOpen(function (value) { return !value; }); },
          },
            h(ChevronIcon, { size: 12 }),
            h('span', null, T.processEnv),
            h('span', { className: 'pk-sec-n pk-mono' }, String(total))),
          open
            ? h('input', {
                type: 'search',
                className: 'pk-env-filter',
                value: filter,
                placeholder: T.processEnvFilter,
                'aria-label': T.processEnvFilter,
                onChange: function (event) { setFilter(event.target.value); },
              })
            : null),
        open
          ? (rows.length
              ? h('div', { className: 'pk-env-table', role: 'table' }, rows.map(function (key) {
                  return h('div', { className: 'pk-env-row', role: 'row', key: key },
                    h('span', { className: 'pk-env-k pk-mono', role: 'cell', title: key }, key),
                    h('span', { className: 'pk-env-v pk-mono', role: 'cell', title: String(env[key]) }, String(env[key])),
                    h('span', { className: 'pk-env-act' }, h(CopyButton, { text: env[key], title: T.copy + ' ' + key })));
                }))
              : h('p', { className: 'pk-muted' }, T.processEnvEmpty))
          : null,
        open && total > ENV_ROW_LIMIT && !filter.trim()
          ? h('p', { className: 'pk-env-more' }, T.processEnvTruncated(total))
          : null);
    }

    function ProcessRow(props) {
      const proc = props.proc;
      const expanded = props.expanded;
      const [confirming, setConfirming] = useState(false);
      const [killing, setKilling] = useState(false);
      const [envOpen, setEnvOpen] = useState(false);

      function askKill(event) {
        event.stopPropagation();
        setConfirming(true);
      }

      async function doKill(event) {
        event.stopPropagation();
        if (killing) return;
        setKilling(true);
        await props.onKill(proc.pid);
        setKilling(false);
        setConfirming(false);
      }

      function cancelKill(event) {
        event.stopPropagation();
        setConfirming(false);
      }

      const head = h('button', {
        type: 'button',
        className: 'pk-prow' + (expanded ? ' is-open' : ''),
        'aria-expanded': expanded ? 'true' : 'false',
        onClick: function () { props.onToggle(proc.pid); },
      },
        h('span', { className: 'pk-pid pk-mono' }, String(proc.pid)),
        h('span', { className: 'pk-pname', title: proc.exe || proc.name }, proc.name),
        h('span', { className: 'pk-num pk-mono' }, fmtCpu(proc.cpuPercent)),
        h('span', { className: 'pk-num pk-mono' }, fmtSize(proc.rssBytes)),
        h('span', {
          className: 'pk-num pk-ptime pk-mono',
          title: proc.startedAt ? T.processColStarted + ' ' + fmtClock(proc.startedAt) : undefined,
        }, proc.startedAt ? fmtDuration(Date.now() - proc.startedAt) : '—'));

      if (!expanded) return h('div', { className: 'pk-proc' }, head);

      const cmd = proc.cmdlineText || proc.exe || '—';
      const rows = [
        { k: T.processCmd, body: h('div', { className: 'pk-cmd' },
          h('pre', { className: 'pk-cmd-text' }, cmd),
          h(CopyButton, { text: cmd, label: T.copy })) },
        { k: T.processCwd, body: h('div', { className: 'pk-cmd' },
          h('span', { className: 'pk-cwd pk-mono' }, proc.cwd || '—'),
          proc.cwd ? h(CopyButton, { text: proc.cwd }) : null) },
        { k: T.processPpid, body: h('span', { className: 'pk-mono' }, proc.ppid === null ? '—' : String(proc.ppid)) },
        { k: T.processUser, body: h('span', null, proc.user || '—') },
        { k: T.processThreads, body: h('span', { className: 'pk-mono' }, proc.threads === null ? '—' : String(proc.threads)) },
        { k: T.processState, body: h('span', null, proc.status || '—') },
        proc.children.length
          ? { k: T.processChildren, body: h('span', { className: 'pk-mono' }, proc.children.join(', ')) }
          : null,
      ];

      let envBlock;
      if (proc.env) {
        envBlock = h('div', { className: 'pk-proc-env' },
          h('button', {
            type: 'button',
            className: 'pk-env-toggle',
            'aria-expanded': envOpen ? 'true' : 'false',
            onClick: function () { setEnvOpen(function (value) { return !value; }); },
          },
            h(ChevronIcon, { size: 12 }),
            h('span', null, T.processEnv),
            h('span', { className: 'pk-sec-n pk-mono' }, String(proc.envCount === null ? Object.keys(proc.env).length : proc.envCount))),
          envOpen ? h(EnvTable, { env: proc.env }) : null);
      } else if (proc.envCode === 'limited') {
        /* Budget cap, not a failure: env for this PID was deliberately not
         * read. Muted single line, and never the 安装 psutil affordance. */
        const trunc = props.truncated || null;
        envBlock = h('div', { className: 'pk-proc-env' },
          h('p', { className: 'pk-env-limited' },
            trunc && trunc.envPids !== null
              ? T.processEnvLimited(String(trunc.envPids), trunc.total)
              : T.processEnvNotRead));
      } else {
        envBlock = h('div', { className: 'pk-proc-env' },
          h('div', { className: 'pk-env-error' },
            h('span', null, proc.envError || T.processNoPsutil),
            props.installHint
              ? h('button', {
                  type: 'button',
                  className: 'pk-btn-mini is-plain',
                  disabled: !!props.installing,
                  title: T.processPsutilHint,
                  onClick: function () { props.onInstallPsutil(props.installHint); },
                }, props.installing
                  ? [h('span', { key: 's', className: 'pk-spin' }), T.processInstallingPsutil]
                  : T.processInstallPsutil)
              : null),
          props.installHint ? h('p', { className: 'pk-env-hint' }, T.processPsutilHint) : null);
      }

      return h('div', { className: 'pk-proc is-open' },
        head,
        h('div', { className: 'pk-proc-body' },
          rows.filter(Boolean).map(function (row, index) {
            return h('div', { className: 'pk-kv', key: 'kv-' + index },
              h('span', null, row.k),
              h('span', null, row.body));
          }),
          envBlock,
          confirming
            ? h('div', { className: 'pk-kill-confirm' },
                h('span', { className: 'pk-kill-ask' }, T.processKillAsk(proc.pid)),
                h('div', { className: 'pk-kill-actions' },
                  h('button', {
                    type: 'button',
                    className: 'pk-btn-danger',
                    disabled: killing,
                    onClick: doKill,
                  }, killing ? h('span', { className: 'pk-spin' }) : T.processKillConfirm),
                  h('button', {
                    type: 'button',
                    className: 'pk-btn-ghost',
                    disabled: killing,
                    onClick: cancelKill,
                  }, T.cancel)))
            : h('div', { className: 'pk-kill-line' },
                h('button', {
                  type: 'button',
                  className: 'pk-btn-danger',
                  disabled: !!props.killing,
                  onClick: askKill,
                }, T.processKill))));
    }

    function ProcessTab(props) {
      const item = props.item;
      const manager = props.manager;
      const live = props.live;
      const entry = props.entry;
      const detail = entry && entry.state === 'ready' && entry.data ? entry.data : null;

      if (!can(manager, 'processes')) {
        return h('div', { className: 'pk-process-empty' },
          h(EmptyIcon, { size: 26 }),
          h('p', { className: 'pk-e-title' }, T.processUnsupported),
          h('p', { className: 'pk-e-desc' }, T.processNotRunning(item.name)));
      }

      if (!live && detail === null) {
        return h('div', { className: 'pk-process-empty' },
          h(EmptyIcon, { size: 26 }),
          h('p', { className: 'pk-e-title' }, T.processEmptyTitle),
          h('p', { className: 'pk-e-desc' }, T.processEmptyDesc),
          canLaunch(item, manager)
            ? h('button', {
                type: 'button',
                className: 'pk-btn-primary',
                disabled: !!props.launching,
                onClick: function () { props.onLaunch(item); },
              }, props.launching ? [h('span', { key: 's', className: 'pk-spin' }), T.launching] : T.launchApp)
            : null);
      }

      let content;
      if (entry && entry.state === 'loading' && !detail) {
        content = h('div', { className: 'pk-detail-loading', 'aria-busy': 'true' },
          h('span', { className: 'pk-sk-bar' }),
          h('span', { className: 'pk-sk-bar', style: { width: '74%' } }),
          h('p', { className: 'pk-muted' }, T.processLoading));
      } else if (entry && entry.state === 'error' && !detail) {
        content = h('div', { className: 'pk-inline-error' },
          h('span', { className: 'pk-error-text' }, T.processFailed + '：' + (entry.error || '—')),
          h('button', { type: 'button', className: 'pk-btn-ghost', onClick: props.onRetry }, T.retry));
      } else if (detail) {
        const procs = detail.processes.slice().sort(function (a, b) { return (b.rssBytes || 0) - (a.rssBytes || 0); });
        const cpu = procs.reduce(function (sum, proc) { return sum + (proc.cpuPercent || 0); }, 0);
        const mem = procs.reduce(function (sum, proc) { return sum + (proc.rssBytes || 0); }, 0);
        content = [
          h('p', { className: 'pk-chart-note', key: 'note' },
            T.processUpdatedAt(fmtRelative(detail.at || Date.now()))),
          h(ProcessSummary, { key: 'sum', cpu: cpu, mem: fmtSize(mem), count: procs.length }),
          h('div', { className: 'pk-prow pk-phead', key: 'head', 'aria-hidden': 'true' },
            h('span', null, T.processColPid),
            h('span', null, T.processColName),
            h('span', { className: 'pk-num' }, T.processColCpu),
            h('span', { className: 'pk-num' }, T.processColMem),
            h('span', { className: 'pk-num pk-ptime' }, T.processColStarted)),
          h('div', { className: 'pk-procs', key: 'rows' }, procs.map(function (proc) {
            return h(ProcessRow, {
              key: 'proc-' + proc.pid,
              proc: proc,
              expanded: props.expanded === proc.pid,
              installHint: detail.installHint,
              truncated: detail.truncated,
              installing: !!props.installingPsutil,
              killing: !!props.killing,
              onToggle: props.onToggleProc,
              onKill: props.onKill,
              onInstallPsutil: props.onInstallPsutil,
            });
          })),
          procs.length === 0 ? h('p', { className: 'pk-muted', key: 'none' }, T.processEmptyTitle) : null,
        ];
      } else {
        content = h('p', { className: 'pk-muted' }, T.processNotRunning(item.name));
      }

      return h('div', { className: 'pk-process' }, content);
    }

    /* ================================================================== */
    /* Drawer                                                             */
    /* ================================================================== */

    function Drawer(props) {
      const item = props.item;
      const detail = props.detail;
      const rowState = props.row || IDLE_ROW;
      const running = rowState.state === 'running';
      const latest = item.latest;
      const hasLatest = latest !== null && latest !== undefined && latest !== '';
      const manager = props.manager || managerOf([], item.manager);
      const caps = capsOf(manager);
      const canUpdate = !!item.hasUpdate && hasLatest && caps.update !== false;
      /* Same capability rule as the row: no version source + update support
       * means the only action is "reinstall as latest". */
      const reinstallOnly = !hasLatest && caps.checkUpdates === false && caps.update !== false;

      function tabButton(id, label) {
        const selected = props.tab === id;
        return h('button', {
          type: 'button',
          className: 'pk-tab',
          role: 'tab',
          id: 'pk-tab-' + id,
          'aria-selected': selected ? 'true' : 'false',
          'aria-controls': 'pk-drawer-panel',
          onClick: function () { props.onTab(id); },
        }, label);
      }

      let actions;
      if (props.confirm) {
        actions = h('div', { className: 'pk-confirm' },
          h('p', null, T.confirmUninstall(item.name)),
          h('div', { className: 'pk-confirm-actions' },
            h('button', {
              type: 'button',
              className: 'pk-btn-danger',
              disabled: running,
              onClick: props.onConfirmUninstall,
            }, T.confirmUninstallBtn),
            h('button', {
              type: 'button',
              className: 'pk-btn-ghost',
              disabled: running,
              onClick: props.onCancelUninstall,
            }, T.cancel)));
      } else {
        let primary;
        if (canUpdate) {
          primary = h('button', {
            type: 'button',
            className: 'pk-btn-primary',
            disabled: running || props.batchRunning,
            onClick: props.onUpdate,
          }, running ? [h('span', { key: 's', className: 'pk-spin' }), T.updating] : T.updateTo + ' ' + latest);
        } else if (reinstallOnly) {
          primary = h('button', {
            type: 'button',
            className: 'pk-btn-primary',
            title: T.reinstallHint,
            disabled: running || props.batchRunning,
            onClick: props.onUpdate,
          }, running ? [h('span', { key: 's', className: 'pk-spin' }), T.updating] : T.update);
        } else {
          primary = h('button', { type: 'button', className: 'pk-btn-primary', disabled: true }, T.upToDate);
        }
        actions = h('div', { className: 'pk-drawer-actions' },
          primary,
          caps.uninstall !== false ? h('button', {
            type: 'button',
            className: 'pk-btn-danger',
            disabled: running || props.batchRunning,
            onClick: props.onAskUninstall,
          }, T.uninstall) : null,
          caps.reveal !== false ? h('button', {
            type: 'button',
            className: 'pk-btn-ghost',
            disabled: running,
            onClick: props.onReveal,
          }, h(FolderIcon), T.reveal) : null);
      }

      let body;
      if (props.tab === 'process') {
        body = h(ProcessTab, {
          item: item,
          manager: manager,
          live: props.live,
          entry: props.processEntry,
          expanded: props.expandedProc,
          launching: props.launching,
          killing: props.killing,
          installingPsutil: props.installingPsutil,
          onLaunch: props.onLaunch,
          onToggleProc: props.onToggleProc,
          onKill: props.onKillProc,
          onInstallPsutil: props.onInstallPsutil,
          onRetry: props.onRetryProcess,
        });
      } else if (props.tab === 'command') {
        const log = props.log;
        body = log && log.log
          ? h('pre', { className: 'pk-pre' }, log.log)
          : h('p', { className: 'pk-muted' }, T.noOutput);
      } else if (detail && detail.state === 'loading' && !detail.data) {
        body = h('div', { className: 'pk-detail-loading', 'aria-busy': 'true' },
          h('span', { className: 'pk-sk-bar' }),
          h('span', { className: 'pk-sk-bar', style: { width: '72%' } }),
          h('span', { className: 'pk-sk-bar', style: { width: '86%' } }),
          h('p', { className: 'pk-muted' }, T.detailLoading));
      } else if (detail && detail.state === 'error') {
        body = h('div', { className: 'pk-detail-loading' },
          h('div', { className: 'pk-inline-error' },
            h('span', { className: 'pk-error-text' }, T.detailFailed + '：' + detail.error),
            h('button', { type: 'button', className: 'pk-btn-ghost', onClick: props.onRetryDetail }, T.retry)));
      } else {
        const data = (detail && detail.data) || {};
        const dependencies = Array.isArray(data.dependencies) ? data.dependencies : [];
        const description = data.description || item.description || '';
        const sizeBytes = typeof data.sizeBytes === 'number' ? data.sizeBytes : item.sizeBytes;
        const license = data.license || null;
        const installedAt = data.installedAt === undefined || data.installedAt === null ? item.installedAt : data.installedAt;
        const path = data.path || item.path || '';
        body = [
          description
            ? h('p', { className: 'pk-desc-t', key: 'desc' }, description)
            : h('p', { className: 'pk-muted', key: 'desc' }, '—'),
          h('h3', { className: 'pk-sec-t', key: 'sec-basic' }, T.basicInfo),
          h('div', { className: 'pk-kv', key: 'kv-version' },
            h('span', null, T.version),
            h('span', { className: 'pk-mono' }, item.version || '—')),
          item.kind === 'ext' ? h('div', { className: 'pk-kv', key: 'kv-extid' },
            h('span', null, T.extId),
            h('span', { className: 'pk-mono' }, item.packageId || '—')) : null,
          h('div', { className: 'pk-kv', key: 'kv-size' },
            h('span', null, T.size),
            h('span', { className: 'pk-mono' }, fmtSize(sizeBytes))),
          h('div', { className: 'pk-kv', key: 'kv-license' },
            h('span', null, T.license),
            h('span', null, license || '—')),
          h('div', { className: 'pk-kv', key: 'kv-installed' },
            h('span', null, T.installedAt),
            h('span', { className: 'pk-mono' }, fmtDate(installedAt))),
          h('div', { className: 'pk-kv', key: 'kv-path' },
            h('span', null, T.path),
            h('span', { className: 'pk-path pk-mono' }, path || '—')),
          h('h3', { className: 'pk-sec-t', key: 'sec-deps' },
            T.dependencies,
            h('span', { className: 'pk-sec-n pk-mono' }, String(dependencies.length))),
          dependencies.length
            ? h('div', { key: 'dep-list' }, dependencies.map(function (dep, index) {
                const name = dep && dep.name ? String(dep.name) : '—';
                const version = dep && dep.version ? String(dep.version) : '';
                return h('div', { className: 'pk-dep-item', key: 'dep-' + index + '-' + name },
                  h('span', { className: 'pk-dep-name', title: name }, name),
                  h('span', { className: 'pk-dep-ver' }, version || '—'));
              }))
            : h('p', { className: 'pk-muted', key: 'dep-empty' }, T.noDeps),
        ];
      }

      return [
        h('div', {
          key: 'scrim',
          className: 'pk-scrim',
          onClick: props.onClose,
          'aria-hidden': 'true',
        }),
        h('aside', {
          key: 'panel',
          className: 'pk-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'pk-drawer-title',
        },
          h('div', { className: 'pk-drawer-head' },
            h('span', { className: 'pk-logo pk-logo-lg' }, h(DrawerMark, { item: item })),
            h('div', { className: 'pk-dh-text' },
              h('h2', { id: 'pk-drawer-title' }, item.name),
              h('p', { className: 'pk-dh-sub' }, [item.manager, item.scope, item.version ? 'v' + item.version : null].filter(Boolean).join(' · ') || '—')),
            h('button', {
              ref: props.closeRef,
              type: 'button',
              className: 'pk-icon-btn',
              'aria-label': T.closeDetail,
              onClick: props.onClose,
            }, h(XIcon))),
          actions,
          h('div', { className: 'pk-tabs', role: 'tablist', 'aria-label': T.detailTabs },
            tabButton('overview', T.tabOverview),
            tabButton('process', T.tabProcess),
            tabButton('command', T.tabCommand)),
          h('div', {
            className: 'pk-drawer-body',
            id: 'pk-drawer-panel',
            role: 'tabpanel',
            'aria-labelledby': 'pk-tab-' + props.tab,
          }, body)),
      ];
    }

    /* ================================================================== */
    /* Dialogs                                                            */
    /* ================================================================== */

    function BatchDialog(props) {
      const pendingRows = props.rows;
      const selectedCount = pendingRows.filter(function (item) { return !!props.selected[item.id]; }).length;
      const percent = props.total > 0 ? Math.round((props.index / props.total) * 100) : 0;

      return h('dialog', { ref: props.dialogRef, className: 'pk-dialog', 'aria-labelledby': 'pk-batch-title' },
        h('div', { className: 'pk-dlg-head' },
          h('div', null,
            h('h2', { id: 'pk-batch-title' }, T.batchTitle),
            h('p', { className: 'pk-dlg-sub' }, props.running ? T.batchRunningSub : T.batchSub)),
          h('button', {
            type: 'button',
            className: 'pk-icon-btn',
            'aria-label': T.close,
            disabled: props.running,
            onClick: props.onCancel,
          }, h(XIcon))),
        h('div', { className: 'pk-dlg-list' },
          pendingRows.map(function (item) {
            return h('label', { className: 'pk-batch-row', key: item.id },
              h('input', {
                type: 'checkbox',
                checked: !!props.selected[item.id],
                disabled: props.running,
                onChange: function () { props.onToggle(item.id); },
              }),
              h('span', { className: 'pk-br-name', title: item.name }, item.name),
              h('span', { className: 'pk-br-ver' }, (item.version || '—') + ' → ' + (item.latest || '—')),
              h('span', { className: 'pk-br-src' }, item.manager));
          })),
        props.running || props.index > 0
          ? h('div', { className: 'pk-dlg-progress' },
              h('div', { className: 'pk-bar' }, h('i', { style: { width: percent + '%' } })),
              h('p', { className: 'pk-dlg-status' }, props.statusText || T.batchRunningSub))
          : null,
        h('div', { className: 'pk-dlg-foot' },
          h('div', { className: 'pk-dlg-sum' }, T.batchUnit(selectedCount)),
          h('div', { className: 'pk-dlg-actions' },
            h('button', {
              type: 'button',
              className: 'pk-btn-ghost',
              disabled: props.running,
              onClick: props.onCancel,
            }, T.cancel),
            h('button', {
              type: 'button',
              className: 'pk-btn-primary',
              disabled: props.running || selectedCount === 0,
              onClick: props.onStart,
            }, props.running ? T.updating : T.startUpdate))));
    }

    function InstallDialog(props) {
      const s = props.state;
      const managers = props.managers || [];
      const groups = props.groups || [];
      const activeManager = managers.filter(function (manager) { return manager.id === s.manager; })[0] || null;
      const managerBlocked = !activeManager || !isUsable(activeManager);
      const canSearch = !managerBlocked && can(activeManager, 'search');
      const editorLike = !!(activeManager && activeManager.kind === 'editor');
      const idPlaceholder = editorLike ? T.installByIdExt : T.installById;
      const busy = !!s.installing || !!s.searching;

      /* Managers grouped by the host's groups[]; undetected ones are left out
       * because the host refuses every action for them anyway. */
      const listed = managers.filter(isDetected);
      const buckets = [];
      const grouped = Object.create(null);
      groups.forEach(function (group) {
        const members = listed.filter(function (manager) { return manager.groupId === group.id; });
        if (!members.length) return;
        const bucket = { id: group.id, label: group.label, members: members };
        grouped[group.id] = bucket;
        buckets.push(bucket);
      });
      const loose = listed.filter(function (manager) {
        return !manager.groupId || !grouped[manager.groupId];
      });
      if (loose.length) buckets.push({ id: '__loose', label: null, members: loose });

      function segment(manager) {
        const label = manager.label || manager.id;
        const selected = s.manager === manager.id;
        const usable = isUsable(manager);
        return h('button', {
          key: manager.id,
          type: 'button',
          className: 'pk-seg-btn',
          'aria-pressed': selected ? 'true' : 'false',
          disabled: !usable || busy,
          title: usable ? label : T.managerUnavailable(label, manager.error || manager.reason),
          onClick: function () { props.onManager(manager.id); },
        },
          h(ManagerLogo, { id: manager.id, size: 14 }),
          label);
      }

      const segments = [];
      buckets.forEach(function (bucket) {
        if (bucket.label) segments.push(h('span', { key: 'seg-t-' + bucket.id, className: 'pk-seg-t' }, bucket.label));
        bucket.members.forEach(function (manager) { segments.push(segment(manager)); });
      });

      let field;
      if (canSearch) {
        field = h('div', { className: 'pk-field' },
          h('input', {
            ref: props.inputRef,
            className: 'pk-input',
            type: 'search',
            value: s.query,
            placeholder: T.installPlaceholder,
            'aria-label': T.searchRegistry,
            autoComplete: 'off',
            disabled: busy,
            onChange: function (event) { props.onQuery(event.target.value); },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault();
                props.onSearch();
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'pk-btn-primary',
            disabled: busy || managerBlocked,
            onClick: props.onSearch,
          }, s.searching ? [h('span', { key: 's', className: 'pk-spin' }), T.search] : T.search));
      } else {
        /* No search endpoint for this manager: install straight from an ID,
         * optionally carrying `@version`. */
        field = h('div', null,
          h('div', { className: 'pk-field' },
            h('input', {
              ref: props.inputRef,
              className: 'pk-input',
              type: 'text',
              value: s.idValue,
              placeholder: idPlaceholder,
              'aria-label': idPlaceholder,
              autoComplete: 'off',
              spellCheck: 'false',
              disabled: busy || managerBlocked,
              onChange: function (event) { props.onIdValue(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  props.onDirectInstall();
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'pk-btn-primary',
              disabled: busy || managerBlocked,
              onClick: props.onDirectInstall,
            }, s.installing ? [h('span', { key: 's', className: 'pk-spin' }), T.installing] : T.install)),
          h('p', { className: 'pk-field-hint' }, T.installDirectHint));
      }

      let body;
      if (!buckets.length) {
        body = h('p', { className: 'pk-dlg-note' }, T.noAvailableManager);
      } else if (!canSearch) {
        body = h('p', { className: 'pk-dlg-note' }, T.installByHint);
      } else if (s.searching) {
        body = h('div', { className: 'pk-detail-loading', 'aria-busy': 'true' },
          h('span', { className: 'pk-sk-bar' }),
          h('span', { className: 'pk-sk-bar', style: { width: '64%' } }));
      } else if (s.results === null) {
        body = h('p', { className: 'pk-dlg-note' }, T.noSearchYet);
      } else if (s.results.length === 0) {
        body = h('p', { className: 'pk-dlg-note' }, T.noResults);
      } else {
        body = h('div', { className: 'pk-results' }, s.results.map(function (result, index) {
          const key = result.packageId || ('res-' + index);
          const installing = s.installing === key;
          return h('div', { className: 'pk-result', key: key },
            h('div', { className: 'pk-res-body' },
              h('span', { className: 'pk-res-name', title: result.name || result.packageId }, result.name || result.packageId),
              h('span', { className: 'pk-res-id' }, result.packageId),
              h('span', { className: 'pk-res-meta' },
                h('span', null, result.version || '—'),
                h('span', null, result.source || s.manager))),
            h('button', {
              type: 'button',
              className: 'pk-btn-mini',
              disabled: !!s.installing || managerBlocked,
              onClick: function () { props.onInstall(result, key); },
            }, installing ? T.installing : T.install));
        }));
      }

      return h('dialog', { ref: props.dialogRef, className: 'pk-dialog', 'aria-labelledby': 'pk-install-title' },
        h('div', { className: 'pk-dlg-head' },
          h('div', null,
            h('h2', { id: 'pk-install-title' }, T.installTitle),
            h('p', { className: 'pk-dlg-sub' }, T.installSub)),
          h('button', {
            type: 'button',
            className: 'pk-icon-btn',
            'aria-label': T.close,
            disabled: !!s.installing,
            onClick: props.onClose,
          }, h(XIcon))),
        segments.length
          ? h('div', { className: 'pk-seg', role: 'group', 'aria-label': T.navGroup }, segments)
          : null,
        field,
        s.error ? h('div', { className: 'pk-inline-error pk-dlg-error' },
          h('span', { className: 'pk-error-text' }, s.error)) : null,
        h('div', { className: 'pk-dlg-body' }, body),
        h('div', { className: 'pk-dlg-foot' },
          h('div', { className: 'pk-dlg-sum' }, T.installTitle),
          h('div', { className: 'pk-dlg-actions' },
            h('button', {
              type: 'button',
              className: 'pk-btn-ghost',
              disabled: !!s.installing,
              onClick: props.onClose,
            }, T.close))));
    }

    function OutputDialog(props) {
      const log = props.log;
      return h('dialog', { ref: props.dialogRef, className: 'pk-dialog', 'aria-labelledby': 'pk-output-title' },
        h('div', { className: 'pk-dlg-head' },
          h('div', null,
            h('h2', { id: 'pk-output-title' }, T.outputTitle),
            h('p', { className: 'pk-dlg-sub' }, log && log.title ? log.title : '—')),
          h('button', {
            type: 'button',
            className: 'pk-icon-btn',
            'aria-label': T.close,
            onClick: props.onClose,
          }, h(XIcon))),
        h('div', { className: 'pk-dlg-body' },
          h('pre', { className: 'pk-pre' }, log && log.log ? log.log : T.noOutput)),
        h('div', { className: 'pk-dlg-foot' },
          h('div', { className: 'pk-dlg-sum' }, log && log.at ? fmtRelative(log.at) : '—'),
          h('div', { className: 'pk-dlg-actions' },
            h('button', { type: 'button', className: 'pk-btn-ghost', onClick: props.onClose }, T.close))));
    }

    /* ================================================================== */
    /* Page                                                               */
    /* ================================================================== */

    function makePage(store) {
      function Page() {
        const s = useStore(store);

        const [drawer, setDrawer] = useState(null);
        const [batch, setBatch] = useState(null);
        const [installOpen, setInstallOpen] = useState(false);
        const [outputOpen, setOutputOpen] = useState(false);
        /* v3 process tab: which process row is expanded, plus the busy flags
         * of the three async actions. Kept out of the store so a 3 s tick
         * never touches it; they reset whenever the drawer changes target. */
        const [procUi, setProcUi] = useState({ id: null, expanded: null, launching: false, killing: false, installing: false });
        const procUiRef = useRef(procUi);
        procUiRef.current = procUi;
        const [installState, setInstallState] = useState({
          manager: '',
          query: '',
          idValue: '',
          results: null,
          searching: false,
          error: null,
          installing: null,
        });

        const triggerRef = useRef(null);
        const searchRef = useRef(null);
        const installInputRef = useRef(null);
        const drawerCloseRef = useRef(null);
        const batchDialogRef = useRef(null);
        const installDialogRef = useRef(null);
        const outputDialogRef = useRef(null);
        const batchRunningRef = useRef(false);
        const uiRef = useRef({ batchOpen: false, installOpen: false, outputOpen: false });

        useEffect(function () {
          uiRef.current = {
            batchOpen: batch !== null,
            installOpen: installOpen,
            outputOpen: outputOpen,
          };
          batchRunningRef.current = !!(batch && batch.running);
        });

        useEffect(function () {
          store.loadSnapshot();
          const timer = setInterval(function () {
            const snapshot = store.get();
            if (snapshot.phase !== 'ready') return;
            if (snapshot.mutating > 0 || snapshot.batchRunning) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            store.loadSnapshot({ silent: true });
          }, REFRESH_MS);
          return function () { clearInterval(timer); };
        }, []);

        /* v3: the 3 s process poll lives entirely in the store; this effect
         * only owns its lifetime (unmount tears the interval and the
         * visibilitychange listener down again). */
        useEffect(function () {
          return store.startProcessPolling();
        }, []);

        useEffect(function () {
          if (!drawer) return undefined;
          function onKeyDown(event) {
            if (event.key !== 'Escape') return;
            if (uiRef.current.batchOpen || uiRef.current.installOpen || uiRef.current.outputOpen) return;
            event.preventDefault();
            closeDrawer();
          }
          window.addEventListener('keydown', onKeyDown);
          const focusTimer = setTimeout(function () {
            if (drawerCloseRef.current) drawerCloseRef.current.focus();
          }, 40);
          return function () {
            window.removeEventListener('keydown', onKeyDown);
            clearTimeout(focusTimer);
          };
        }, [drawer && drawer.id]);

        /* The store needs to know whether a drawer is open so a kill can
         * refresh its detail; the Esc handler above is untouched. */
        useEffect(function () {
          store.setDrawer(drawer ? drawer.id : null);
          return function () { store.setDrawer(null); };
        }, [drawer && drawer.id]);

        useEffect(function () {
          if (drawer) store.ensureDetail(drawer.id);
        }, [drawer && drawer.id]);

        useEffect(function () {
          const dialog = batchDialogRef.current;
          if (!dialog) return;
          if (batch && !dialog.open) {
            try { dialog.showModal(); } catch (err) { /* already open */ }
          }
          if (!batch && dialog.open) dialog.close();
        }, [batch ? 1 : 0]);

        useEffect(function () {
          const dialog = installDialogRef.current;
          if (!dialog) return;
          if (installOpen && !dialog.open) {
            try { dialog.showModal(); } catch (err) { /* already open */ }
            const focusTimer = setTimeout(function () {
              if (installInputRef.current) installInputRef.current.focus();
            }, 40);
            return function () { clearTimeout(focusTimer); };
          }
          if (!installOpen && dialog.open) dialog.close();
          return undefined;
        }, [installOpen]);

        useEffect(function () {
          const dialog = outputDialogRef.current;
          if (!dialog) return;
          if (outputOpen && !dialog.open) {
            try { dialog.showModal(); } catch (err) { /* already open */ }
          }
          if (!outputOpen && dialog.open) dialog.close();
        }, [outputOpen]);

        useEffect(function () {
          const batchEl = batchDialogRef.current;
          const installEl = installDialogRef.current;
          const outputEl = outputDialogRef.current;
          function onBatchCancel(event) {
            if (batchRunningRef.current) event.preventDefault();
          }
          function onBatchClose() {
            if (!batchRunningRef.current) setBatch(null);
          }
          function onInstallClose() { setInstallOpen(false); }
          function onOutputClose() { setOutputOpen(false); }
          if (batchEl) {
            batchEl.addEventListener('cancel', onBatchCancel);
            batchEl.addEventListener('close', onBatchClose);
          }
          if (installEl) installEl.addEventListener('close', onInstallClose);
          if (outputEl) outputEl.addEventListener('close', onOutputClose);
          return function () {
            if (batchEl) {
              batchEl.removeEventListener('cancel', onBatchCancel);
              batchEl.removeEventListener('close', onBatchClose);
            }
            if (installEl) installEl.removeEventListener('close', onInstallClose);
            if (outputEl) outputEl.removeEventListener('close', onOutputClose);
          };
        }, []);

        function findItem(id) {
          for (let i = 0; i < s.items.length; i += 1) {
            if (s.items[i].id === id) return s.items[i];
          }
          return null;
        }

        function openDrawer(item, element) {
          triggerRef.current = element || null;
          setProcUi({ id: item.id, expanded: null, launching: false, killing: false, installing: false });
          setDrawer({ id: item.id, tab: 'overview', confirm: false });
        }

        function closeDrawer() {
          const element = triggerRef.current;
          triggerRef.current = null;
          setDrawer(null);
          setProcUi({ id: null, expanded: null, launching: false, killing: false, installing: false });
          if (element && element.isConnected && typeof element.focus === 'function') {
            element.focus();
          } else if (searchRef.current) {
            searchRef.current.focus();
          }
        }

        /* Switching tab: opening 进程 requests the detail when the item is
         * running (or if a previous attempt never produced data). */
        function switchTab(tab) {
          const current = store.get();
          const id = drawer ? drawer.id : null;
          setDrawer(function (prev) {
            if (!prev) return prev;
            return Object.assign({}, prev, { tab: tab, confirm: false });
          });
          setProcUi(function (prev) {
            return Object.assign({}, prev, { expanded: null, killing: false });
          });
          if (tab !== 'process' || !id) return;
          if (!runningOf(current.running, id)) return;
          store.ensureProcessDetail(id);
        }

        function toggleProc(pid) {
          setProcUi(function (prev) {
            return Object.assign({}, prev, { expanded: prev.expanded === pid ? null : pid });
          });
        }

        async function handleKill(payload) {
          setProcUi(function (prev) { return Object.assign({}, prev, { killing: true }); });
          const result = await store.killProcess(payload);
          setProcUi(function (prev) {
            return Object.assign({}, prev, { killing: false, expanded: null });
          });
          return result;
        }

        async function handleLaunch(item) {
          if (!item) return;
          setProcUi(function (prev) { return Object.assign({}, prev, { launching: true }); });
          await store.launchItem(item);
          setProcUi(function (prev) { return Object.assign({}, prev, { launching: false }); });
        }

        async function handleInstallPsutil(hint) {
          setProcUi(function (prev) { return Object.assign({}, prev, { installing: true }); });
          const result = await store.installPsutil(hint);
          setProcUi(function (prev) { return Object.assign({}, prev, { installing: false }); });
          if (result && result.ok) store.showToast(T.processPsutilInstalled, 'ok');
        }

        /* Items the batch dialog may offer: real updates only. Managers without
         * a version source (editor extensions) never enter this list. */
        function batchable(item) {
          if (!item.hasUpdate) return false;
          const manager = managerOf(s.managers, item.manager);
          return isUsable(manager) && can(manager, 'update');
        }

        function openBatch() {
          const pending = filterScope(s.items, s.scope, s.managers, s.groups).filter(batchable);
          if (!pending.length) return;
          const selected = Object.create(null);
          pending.forEach(function (item) { selected[item.id] = true; });
          setBatch({
            ids: pending.map(function (item) { return item.id; }),
            selected: selected,
            running: false,
            index: 0,
            total: pending.length,
            currentName: '',
            statusText: '',
          });
        }

        async function runBatch() {
          if (!batch || batch.running) return;
          const ids = batch.ids.filter(function (id) { return !!batch.selected[id]; });
          if (!ids.length) return;
          store.setBatchRunning(true);
          setBatch(function (prev) {
            if (!prev) return prev;
            return Object.assign({}, prev, { running: true, index: 0, total: ids.length, statusText: T.batchProgress(nameFor(ids[0]), 1, ids.length) });
          });
          let failures = 0;
          let completed = 0;
          for (let i = 0; i < ids.length; i += 1) {
            const item = store.get().items.filter(function (entry) { return entry.id === ids[i]; })[0] || null;
            if (!item || !item.hasUpdate) {
              completed += 1;
              continue;
            }
            setBatch(function (prev) {
              if (!prev) return prev;
              return Object.assign({}, prev, {
                index: i,
                currentName: item.name,
                statusText: T.batchProgress(item.name, i + 1, ids.length),
              });
            });
            const result = await store.batchUpdateOne(item);
            if (result && result.aborted) {
              store.setBatchRunning(false);
              return;
            }
            if (!result || !result.ok) failures += 1;
            completed += 1;
          }
          setBatch(function (prev) {
            if (!prev) return prev;
            return Object.assign({}, prev, { index: ids.length, statusText: T.batchDone(completed) });
          });
          store.setBatchRunning(false);
          await store.loadSnapshot({ silent: true });
          if (failures) store.showToast(T.batchDonePartial(completed - failures, failures), 'warn');
          else store.showToast(T.batchDone(completed), 'ok');
          setBatch(null);
        }

        function nameFor(id) {
          const item = findItem(id);
          return item ? item.name : '—';
        }

        async function handleUpdate(item) {
          const snapshot = store.get();
          if (snapshot.batchRunning) return;
          if (snapshot.rowState[item.id] && snapshot.rowState[item.id].state === 'running') return;
          await store.updateOne(item);
        }

        async function handleCheck(item) {
          await store.checkManager(item.manager);
        }

        async function handleUninstall(item) {
          const result = await store.uninstallOne(item);
          if (result && result.ok) closeDrawer();
        }

        async function searchInstall() {
          const query = installState.query.trim();
          if (query.length < 1) {
            setInstallState(function (prev) {
              return Object.assign({}, prev, { error: T.queryRequired, results: null });
            });
            return;
          }
          setInstallState(function (prev) {
            return Object.assign({}, prev, { searching: true, error: null, results: null });
          });
          const result = await store.searchPkgs(installState.manager, query);
          if (result && result.aborted) return;
          setInstallState(function (prev) {
            return Object.assign({}, prev, {
              searching: false,
              error: result && result.ok ? null : (result && result.error) || T.searchFailed,
              results: result && result.ok ? result.results : null,
            });
          });
          if (result && !result.ok) store.showToast(result.error || T.searchFailed, 'error');
        }

        async function installResult(result, key) {
          setInstallState(function (prev) {
            return Object.assign({}, prev, { installing: key, error: null });
          });
          const outcome = await store.installPkg(installState.manager, result);
          if (outcome && outcome.aborted) return;
          if (outcome && outcome.ok) {
            setInstallState(function (prev) {
              return Object.assign({}, prev, { installing: null });
            });
            setInstallOpen(false);
            return;
          }
          setInstallState(function (prev) {
            return Object.assign({}, prev, {
              installing: null,
              error: (outcome && outcome.error) || T.searchFailed,
            });
          });
        }

        function parsePackageSpec(raw) {
          const text = String(raw || '').trim();
          if (!text) return { packageId: '', version: null };
          const at = text.lastIndexOf('@');
          /* `@scope/name` starts with '@'; only a later '@' carries a version. */
          if (at > 0) return { packageId: text.slice(0, at), version: text.slice(at + 1) || null };
          return { packageId: text, version: null };
        }

        async function installDirect() {
          const spec = parsePackageSpec(installState.idValue);
          if (!spec.packageId) {
            setInstallState(function (prev) {
              return Object.assign({}, prev, { error: T.idRequired });
            });
            return;
          }
          setInstallState(function (prev) {
            return Object.assign({}, prev, { installing: spec.packageId, error: null });
          });
          const outcome = await store.installPkg(installState.manager, {
            packageId: spec.packageId,
            name: spec.packageId,
            version: spec.version,
          });
          if (outcome && outcome.aborted) return;
          if (outcome && outcome.ok) {
            setInstallState(function (prev) { return Object.assign({}, prev, { installing: null }); });
            setInstallOpen(false);
            return;
          }
          setInstallState(function (prev) {
            return Object.assign({}, prev, {
              installing: null,
              error: (outcome && outcome.error) || T.searchFailed,
            });
          });
        }

        function openInstall() {
          const candidates = s.managers.filter(function (manager) {
            return isUsable(manager) && can(manager, 'install');
          });
          const preferred = candidates.filter(function (manager) { return manager.id === installState.manager; })[0];
          const fallback = candidates[0] || null;
          setInstallState({
            manager: preferred ? preferred.id : (fallback ? fallback.id : ''),
            query: '',
            idValue: '',
            results: null,
            searching: false,
            error: null,
            installing: null,
          });
          setInstallOpen(true);
        }

        const groups = s.groups || [];
        const managerRank = useMemo(function () { return managerRankMap(s.managers); }, [s.managers]);

        const scopeIsManager = s.scope.indexOf('mgr:') === 0;
        const scopeIsGroup = s.scope.indexOf('grp:') === 0;
        const scopeManager = scopeIsManager ? managerOf(s.managers, s.scope.slice(4)) : null;
        const scopeGroup = scopeIsGroup ? groupOf(groups, s.scope.slice(4)) : null;
        const scopeLabel = scopeIsManager
          ? (scopeManager ? (scopeManager.label || scopeManager.id) : s.scope.slice(4))
          : scopeIsGroup
            ? (scopeGroup ? scopeGroup.label : s.scope.slice(4))
            : (s.scope === 'updates' ? T.pageUpdates : (s.scope === RUNNING_SCOPE ? T.pageRunning : T.pageAll));

        const scoped = s.scope === RUNNING_SCOPE
          ? filterRunningScope(s.items, s.running)
          : filterScope(s.items, s.scope, s.managers, groups);
        const scopedUpdates = scoped.filter(batchable);

        const visible = useMemo(function () {
          const query = s.query.trim().toLowerCase();
          const filtered = scoped.filter(function (item) { return matchesQuery(item, query); });
          return sortItems(filtered, s.sort, managerRank);
        }, [s.items, s.scope, s.query, s.sort, managerRank]);

        /* 「检查更新」 is only offered when some manager in scope can actually
         * report versions; capabilities decide, never the manager id. */
        const scopeManagerIds = managerIdsForScope(s.scope, s.managers, groups);
        const checkCandidates = (scopeManagerIds === null ? s.managers : scopeManagerIds.map(function (id) {
          return managerOf(s.managers, id);
        })).filter(function (manager) {
          return isUsable(manager) && can(manager, 'checkUpdates');
        });
        const showCheck = checkCandidates.length > 0;

        const cards = useMemo(function () {
          const detected = s.managers.filter(isDetected);
          const detectedGroups = s.groups.filter(function (group) {
            return managersInGroup(group, s.managers).some(isDetected);
          });
          const disk = s.stats && s.stats.disk ? s.stats.disk : null;
          const diskValue = disk ? splitSize(disk.freeBytes) : { v: '—', u: '' };
          return [
            {
              k: T.statTotal,
              v: scoped.length,
              u: T.unitItem,
              d: scopeIsManager
                ? (scopeManager && scopeManager.scopeLabel ? scopeManager.scopeLabel : T.unitItem)
                : T.statTotalDesc(
                    scoped.filter(function (item) { return item.kind === 'app'; }).length,
                    scoped.filter(function (item) { return item.kind === 'pkg'; }).length,
                    scoped.filter(function (item) { return item.kind === 'ext'; }).length),
            },
            {
              k: T.statUpdates,
              v: scopedUpdates.length,
              u: T.unitUpdate,
              d: T.statUpdatesDesc(scopedUpdates.length, new Set(scopedUpdates.map(function (item) { return item.manager; })).size),
            },
            {
              k: T.statSources,
              v: detected.length + '/' + s.managers.length,
              u: '',
              d: detectedGroups.map(function (group) { return group.label; }).join(' · ') || '—',
            },
            {
              k: T.statDisk,
              v: diskValue.v,
              u: diskValue.u,
              d: disk ? T.statDiskDesc(fmtSize(disk.totalBytes), disk.mount) : '—',
            },
          ];
        }, [s.items, s.scope, s.managers, s.groups, s.stats]);

        const pendingCount = scopedUpdates.length;

        const drawerItem = drawer ? findItem(drawer.id) : null;
        const detailEntry = drawer && drawerItem ? (s.details[drawer.id] || null) : null;
        const drawerLog = drawer && drawerItem ? (s.logs[drawerItem.id] || null) : null;
        const drawerManager = drawerItem ? managerOf(s.managers, drawerItem.manager) : null;
        const drawerLive = drawerItem ? runningOf(s.running, drawerItem.id) : null;
        const drawerProcess = drawer && drawerItem ? (s.processDetail[drawerItem.id] || EMPTY_PROC_DETAIL) : EMPTY_PROC_DETAIL;
        const launchable = drawerItem ? canLaunch(drawerItem, drawerManager) : false;

        const batchRows = batch
          ? batch.ids.map(function (id) { return findItem(id); }).filter(Boolean)
          : [];

        const placeholder = scopeIsManager
          ? T.searchManagerPlaceholder(scopeLabel)
          : scopeIsGroup
            ? T.searchGroupPlaceholder(scopeLabel)
            : (s.scope === 'updates' ? T.searchUpdatesPlaceholder : T.searchAllPlaceholder);

        const subtitle = scopeIsManager
          ? T.subtitleManager(scopeLabel, scoped.length, scopedUpdates.length, fmtRelative(s.at))
          : scopeIsGroup
            ? T.subtitleGroup(scopeLabel, scoped.length, scopedUpdates.length, fmtRelative(s.at))
            : s.scope === RUNNING_SCOPE
              ? T.subtitleRunning(scoped.length, runningCount(s.running), s.runningAt ? fmtRelative(s.runningAt) : T.justNow)
              : T.subtitle(scoped.length, scopedUpdates.length, fmtRelative(s.at));

        const firstLoad = s.phase === 'loading' && s.items.length === 0;

        let emptyBlock = null;
        if (!firstLoad && s.phase !== 'error' && visible.length === 0) {
          let title = T.noMatchTitle;
          let desc = T.noMatchDesc;
          if (scopeIsManager && scopeManager && !isUsable(scopeManager)) {
            title = T.managerUnavailable(scopeLabel, scopeManager.error || scopeManager.reason);
          } else if (scopeIsManager && scoped.length === 0) {
            desc = T.managerNoItems(scopeLabel);
          } else if (scopeIsGroup && scoped.length === 0) {
            desc = T.groupNoItems(scopeLabel);
          } else if (s.scope === 'updates' && scopedUpdates.length === 0) {
            desc = T.scopeUpdatesDesc();
          } else if (s.scope === RUNNING_SCOPE) {
            title = T.processEmptyTitle;
            desc = T.scopeRunningDesc();
          }
          emptyBlock = h(EmptyState, {
            key: 'empty',
            title: title,
            desc: desc,
            actionLabel: T.clearFilter,
            onAction: function () { store.resetFilters(); },
          });
        }

        return h('div', { className: 'pk-root', 'data-packdeck': 'root' },
          h('style', null, CSS),
          h(Rail, {
            state: s,
            detecting: s.detecting,
            onDetect: function () { store.detect(); },
            onScope: function (scope) {
              store.setScope(scope);
              store.setQuery('');
            },
          }),
          h('div', { className: 'pk-main' },
            h(Topbar, {
              title: scopeLabel,
              subtitle: subtitle,
              query: s.query,
              sort: s.sort,
              placeholder: placeholder,
              pending: pendingCount,
              checking: s.checking,
              detecting: s.detecting,
              showCheck: showCheck,
              batchRunning: s.batchRunning,
              mutating: s.mutating,
              searchRef: searchRef,
              onQuery: function (value) { store.setQuery(value); },
              onSort: function (value) { store.setSort(value); },
              onDetect: function () { store.detect(); },
              onCheck: function () { store.checkScope(); },
              onBatch: openBatch,
              onInstall: openInstall,
            }),
            h('div', { className: 'pk-scroll' },
              s.phase === 'error'
                ? h(ErrorBar, {
                    message: T.indexFailed + '：' + (s.error || '—'),
                    onRetry: function () { store.loadSnapshot({ silent: false }); },
                  })
                : null,
              firstLoad
                ? h(Skeleton)
                : [
                    h(Stats, { cards: cards, key: 'stats' }),
                    h(ListHead, { key: 'head' }),
                    visible.length
                      ? h('div', { className: 'pk-rows', key: 'rows' }, visible.map(function (item) {
                          return h(Row, {
                            key: item.id,
                            store: store,
                            id: item.id,
                            item: item,
                            row: s.rowState[item.id] || IDLE_ROW,
                            manager: managerOf(s.managers, item.manager),
                            checking: s.checking,
                            batchRunning: s.batchRunning,
                            pidsFor: store.pidsFor,
                            onOpen: openDrawer,
                            onUpdate: handleUpdate,
                            onCheck: handleCheck,
                          });
                        }))
                      : emptyBlock,
                    h('p', { className: 'pk-foot-note', key: 'foot' }, T.footnote),
                  ]),
            h(StatusBar, {
              tone: s.lastOp.tone,
              text: firstLoad ? T.readingIndex : s.lastOp.text,
              onOutput: function () { setOutputOpen(true); },
              hasOutput: !!s.lastLog,
            })),
          drawerItem
            ? h(Drawer, {
                item: drawerItem,
                manager: drawerManager,
                row: s.rowState[drawerItem.id] || IDLE_ROW,
                detail: detailEntry,
                log: drawerLog,
                tab: drawer.tab,
                confirm: drawer.confirm,
                batchRunning: s.batchRunning,
                closeRef: drawerCloseRef,
                live: !!drawerLive,
                processEntry: drawerProcess,
                expandedProc: procUi.id === drawerItem.id ? procUi.expanded : null,
                launching: procUi.launching,
                killing: procUi.killing,
                installingPsutil: procUi.installing,
                canLaunch: launchable,
                onClose: closeDrawer,
                onTab: switchTab,
                onUpdate: function () { handleUpdate(drawerItem); },
                onAskUninstall: function () { setDrawer(function (prev) { return prev ? Object.assign({}, prev, { confirm: true }) : prev; }); },
                onCancelUninstall: function () { setDrawer(function (prev) { return prev ? Object.assign({}, prev, { confirm: false }) : prev; }); },
                onConfirmUninstall: function () { handleUninstall(drawerItem); },
                onReveal: function () { store.revealItem(drawerItem, detailEntry && detailEntry.data); },
                onRetryDetail: function () { store.ensureDetail(drawerItem.id, true); },
                onLaunch: function () { handleLaunch(drawerItem); },
                onToggleProc: toggleProc,
                onKillProc: handleKill,
                onInstallPsutil: handleInstallPsutil,
                onRetryProcess: function () { store.fetchProcessDetail(drawerItem.id, { keep: true }); },
              })
            : null,
          h(BatchDialog, {
            dialogRef: batchDialogRef,
            rows: batchRows,
            selected: batch ? batch.selected : {},
            running: !!(batch && batch.running),
            index: batch ? batch.index : 0,
            total: batch ? batch.total : 0,
            statusText: batch ? batch.statusText : '',
            onToggle: function (id) {
              setBatch(function (prev) {
                if (!prev) return prev;
                const selected = Object.assign({}, prev.selected);
                if (selected[id]) delete selected[id];
                else selected[id] = true;
                return Object.assign({}, prev, { selected: selected });
              });
            },
            onCancel: function () {
              if (batchRunningRef.current) return;
              setBatch(null);
            },
            onStart: function () { runBatch(); },
          }),
          h(InstallDialog, {
            dialogRef: installDialogRef,
            inputRef: installInputRef,
            managers: s.managers,
            groups: groups,
            state: installState,
            onManager: function (managerId) {
              setInstallState(function (prev) {
                return Object.assign({}, prev, { manager: managerId, results: null, idValue: '', error: null });
              });
            },
            onQuery: function (value) {
              setInstallState(function (prev) { return Object.assign({}, prev, { query: value }); });
            },
            onIdValue: function (value) {
              setInstallState(function (prev) { return Object.assign({}, prev, { idValue: value }); });
            },
            onSearch: searchInstall,
            onDirectInstall: installDirect,
            onInstall: installResult,
            onClose: function () {
              if (installState.installing) return;
              setInstallOpen(false);
            },
          }),
          h(OutputDialog, {
            dialogRef: outputDialogRef,
            log: s.lastLog,
            onClose: function () { setOutputOpen(false); },
          }),
          h(Toast, { toast: s.toast }));
      }

      return Page;
    }

    /* ================================================================== */
    /* Plugin factory                                                     */
    /* ================================================================== */

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore();
        const Page = makePage(store);

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'packdeck',
            order: 30,
            label: function () { return 'Packdeck'; },
          }, CubeIcon);
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'packdeck' }, Page);
        });

        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () { store.dispose(); };
          });
        }
      },
    };
  },
});
