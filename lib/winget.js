// winget adapter: version probe, snapshot (`list` + `upgrade`), search, detail.
// `winget upgrade --include-unknown` is the only source of truth for latest versions —
// the `Available` column of `winget list` is blank for up-to-date rows, so it cannot
// distinguish "no update" from "unknown".

import { run } from './run.js';
import { parseWingetTable, parseKeyValueOutput } from './table.js';
import { hasUpdate } from './version.js';
import { commandFailed, parseFailed, timedOut } from './errors.js';
import { tail, oneLine } from './text.js';
import { findInstallLocation } from './winpath.js';

export const WINGET_DEF = {
  id: 'winget',
  label: 'winget',
  vendor: 'Microsoft',
  scopeLabel: '系统应用',
  kind: 'app',
};

const LIST_ARGS = ['list', '--accept-source-agreements', '--disable-interactivity'];
const UPGRADE_ARGS = ['upgrade', '--include-unknown', '--accept-source-agreements', '--disable-interactivity'];
const PROBE_TIMEOUT_MS = 10_000;
// Snapshot must stay well inside the client's 20 s budget (contract target: < 6 s).
const LIST_TIMEOUT_MS = 25_000;
const UPGRADE_TIMEOUT_MS = 90_000;
const SHOW_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 90_000;

const UNKNOWN_VALUES = new Set(['', 'unknown', 'n/a', 'none']);

function firstLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line || '';
}

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

function describeFailure(result) {
  const detail = oneLine(result.stderr || result.stdout || result.spawnError || '');
  return detail || `退出码 ${result.code}`;
}

function isUnknown(value) {
  return UNKNOWN_VALUES.has(String(value ?? '').trim().toLowerCase());
}

/** Parse `winget upgrade` output into Map<packageId, latestVersion>. Tolerance: any failure
 *  only means "no update information", never a snapshot failure. */
export function parseUpgradeMap(output) {
  const latest = new Map();
  const parsed = parseWingetTable(output, { maxRows: 2000 });
  if (!parsed.found) return latest;
  for (const row of parsed.rows) {
    const available = String(row.available || '').trim();
    if (!row.id || isUnknown(available)) continue;
    latest.set(row.id, available);
  }
  return latest;
}

export async function probe(opts = {}) {
  const result = await run('winget', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, dryRun: opts.dryRun });
  const root = process.env.ProgramFiles || process.env['ProgramFiles(x86)'] || null;
  if (opts.dryRun) return { available: true, version: 'v?.?.?', root, error: null };
  if (result.timedOut) return { available: false, version: null, root, error: 'winget --version 超时（10 s）' };
  if (result.code !== 0 || !firstLine(result.stdout)) {
    return { available: false, version: null, root, error: `winget 不可用：${describeFailure(result)}` };
  }
  const printed = firstLine(result.stdout);
  // `winget --version` already prints a leading "v" (v1.29.380); keep exactly one.
  const version = /^v/i.test(printed) ? printed : `v${printed}`;
  return { available: true, version, root, error: null };
}

/**
 * @returns {Promise<{manager: object, items: object[]}>}
 */
export async function snapshot(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const [listResult, upgradeResult] = await Promise.all([
    run('winget', LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS, dryRun }),
    run('winget', UPGRADE_ARGS, { timeoutMs: UPGRADE_TIMEOUT_MS, dryRun }),
  ]);

  if (opts.dryRun) {
    return {
      manager: {
        id: WINGET_DEF.id,
        label: WINGET_DEF.label,
        vendor: WINGET_DEF.vendor,
        scopeLabel: WINGET_DEF.scopeLabel,
        available: true,
        version: opts.managerVersion || 'v?.?.?',
        root: process.env.ProgramFiles || null,
        error: null,
      },
      items: [],
      dryRunCommands: [listResult.command, upgradeResult.command],
    };
  }

  if (listResult.timedOut) throw timedOut('winget list 超时（25 s）', logOf(listResult));
  const parsed = parseWingetTable(listResult.stdout, { maxRows: 2000 });
  if (!parsed.found) {
    throw parseFailed(
      listResult.code === 0 ? '无法解析 winget list 输出' : `winget list 失败：${describeFailure(listResult)}`,
      logOf(listResult),
    );
  }

  // A slow/failed `upgrade` is not fatal: items still render, just without "latest" info.
  const latestById = upgradeResult.timedOut ? new Map() : parseUpgradeMap(upgradeResult.stdout);

  const seen = new Set();
  const items = [];
  for (const row of parsed.rows) {
    const packageId = row.id;
    if (!packageId || seen.has(packageId)) continue; // `winget list` may repeat an Id (x86/x64 ARP rows)
    seen.add(packageId);
    const version = String(row.version || '').trim();
    const latest = latestById.get(packageId) ?? null;
    items.push({
      id: `winget:${packageId}`,
      manager: 'winget',
      name: String(row.name || packageId).trim(),
      packageId,
      source: String(row.source || '').trim() || 'winget',
      kind: 'app',
      scope: WINGET_DEF.scopeLabel,
      cwd: null,
      path: null,
      version,
      latest,
      hasUpdate: hasUpdate(latest, version),
      description: null,
      sizeBytes: null,
      installedAt: null,
      managerVersion: opts.managerVersion || null,
    });
  }

  return {
    manager: {
      id: WINGET_DEF.id,
      label: WINGET_DEF.label,
      vendor: WINGET_DEF.vendor,
      scopeLabel: WINGET_DEF.scopeLabel,
      available: true,
      version: opts.managerVersion || null,
      root: process.env.ProgramFiles || null,
      error: null,
    },
    items,
  };
}

/**
 * `check-updates` for winget: one `winget upgrade --include-unknown` pass.
 * @returns {Promise<{updates: Array<{id:string,packageId:string,version:string,latest:string}>, failed: Array}>}
 */
export async function checkUpdates(opts = {}) {
  const result = await run('winget', UPGRADE_ARGS, { timeoutMs: UPGRADE_TIMEOUT_MS, dryRun: opts.dryRun });
  if (opts.dryRun) return { updates: [], failed: [], dryRunCommands: [result.command] };
  if (result.timedOut) throw timedOut('winget upgrade 超时（90 s）', logOf(result));

  const parsed = parseWingetTable(result.stdout, { maxRows: 2000 });
  if (!parsed.found) {
    if (result.code !== 0) throw commandFailed(`winget upgrade 失败：${describeFailure(result)}`, logOf(result));
    throw parseFailed('无法解析 winget upgrade 输出', logOf(result));
  }

  const updates = [];
  for (const row of parsed.rows) {
    const available = String(row.available || '').trim();
    if (!row.id || isUnknown(available)) continue;
    updates.push({
      id: `winget:${row.id}`,
      packageId: row.id,
      version: String(row.version || '').trim(),
      latest: available,
    });
  }
  return { updates, failed: [] };
}

/**
 * @returns {Promise<{results: Array<{packageId:string,name:string,version:string,source:string,description:null}>}>}
 */
export async function search(query, opts = {}) {
  const args = ['search', '--query', query, '--accept-source-agreements', '--disable-interactivity'];
  const result = await run('winget', args, { timeoutMs: SEARCH_TIMEOUT_MS, dryRun: opts.dryRun });
  if (opts.dryRun) return { results: [], dryRunCommands: [result.command] };
  if (result.timedOut) throw timedOut('winget search 超时（90 s）', logOf(result));

  const parsed = parseWingetTable(result.stdout, { maxRows: 40 });
  if (!parsed.found) {
    if (result.code === 0 && /no package/i.test(result.stdout)) return { results: [] };
    throw parseFailed(
      result.code === 0 ? '无法解析 winget search 输出' : `winget search 失败：${describeFailure(result)}`,
      logOf(result),
    );
  }

  const results = parsed.rows.slice(0, 40).map((row) => {
    const version = String(row.version || '').trim();
    return {
      packageId: row.id,
      name: String(row.name || row.id).trim(),
      version: isUnknown(version) ? '' : version,
      source: String(row.source || '').trim() || 'winget',
      description: null,
    };
  });
  return { results };
}

/**
 * winget detail: installed version from `list --id`, extra metadata from `show`.
 * `show` needs the source (network); failures degrade to nulls instead of failing detail.
 */
export async function detail(packageId, source, opts = {}) {
  const listArgs = ['list', '--id', packageId, '-e', '--accept-source-agreements', '--disable-interactivity'];
  const showArgs = ['show', '--id', packageId, '-e'];
  if (source) showArgs.push('--source', source);
  showArgs.push('--accept-source-agreements', '--disable-interactivity');

  const [listResult, showResult] = await Promise.all([
    run('winget', listArgs, { timeoutMs: LIST_TIMEOUT_MS, dryRun: opts.dryRun }),
    run('winget', showArgs, { timeoutMs: SHOW_TIMEOUT_MS, dryRun: opts.dryRun }),
  ]);
  if (opts.dryRun) return { detail: null, dryRunCommands: [listResult.command, showResult.command] };

  const listParsed = listResult.timedOut ? { rows: [] } : parseWingetTable(listResult.stdout, { maxRows: 20 });
  const row = listParsed.rows.find((entry) => entry.id.toLowerCase() === packageId.toLowerCase()) || listParsed.rows[0];
  const info = showResult.timedOut ? {} : parseKeyValueOutput(showResult.stdout);

  const name = row && row.name ? row.name : info.found || packageId;
  if (!row && Object.keys(info).length === 0) {
    throw commandFailed(
      `未找到 winget 程序 ${packageId}：${describeFailure(showResult)}`,
      logOf(showResult) || logOf(listResult),
    );
  }

  // winget reports no install directory; resolve it from the uninstall registry (best effort).
  const installPath = await findInstallLocation(name);

  return {
    detail: {
      id: `winget:${packageId}`,
      manager: 'winget',
      packageId,
      name,
      version: row ? String(row.version || '').trim() : '',
      source: (row && String(row.source || '').trim()) || source || 'winget',
      description: info.description || null,
      sizeBytes: null,
      path: installPath,
      license: info.license || null,
      homepage: info.homepage || null,
      repository: null,
      publisher: info.publisher || null,
      dependencies: [],
      dependents: [],
      installedAt: null,
      otherVersions: null,
    },
  };
}
