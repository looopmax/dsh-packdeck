// Action dispatcher for POST /packdeck/api (CONTRACT §1–§7).
// Each action returns the `data` payload of the contract envelope; failures are thrown as
// ApiError and turned into `{ok:false,error:{...}}` by lib/http.js.
//
// v2 additions: `groups[]` / `detection` / `itemCount` / `capabilities` aggregates computed
// on every request from the per-manager (cached) results, the `detect` action, and
// capability- and detection-gated dispatch for the language / editor managers.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError, badRequest, commandFailed, unavailable } from './errors.js';
import { cacheGet, cacheSet, invalidateManager, TTL } from './cache.js';
import { assertManager, assertPackageId, assertQuery, assertVersion, enqueueMutation, run } from './run.js';
import { buildMutationCommand } from './commands.js';
import { binaryFor, detectAll, detectionMeta } from './detect.js';
import { MANAGER_IDS, getManager } from './catalog.js';
import {
  checkUpdatesManager,
  detailManager,
  groupEntries,
  managerEntry,
  managerSnapshot,
  searchManager,
} from './managers.js';
import { addLogoUrls } from './icons.js';
import { launchPayload, processesPayload, processKillPayload, snapshotProcesses, warmUp } from './procs.js';
import { processDetailPayload } from './procdetail.js';
import { tail, oneLine } from './text.js';

const LOG_LIMIT_BYTES = 12 * 1024;
/** §11.2.6: how long `snapshot` may wait for process data before answering `null`. */
const SNAPSHOT_PROCESS_WAIT_MS = 600;

/**
 * Windows tools such as winget report HRESULT-style exit statuses above 0x7FFFFFFF, which
 * read as a 10-digit number. Show the hex form beside it instead of leaving one opaque number
 * in the UI and the tool result.
 * @param {unknown} code subprocess exit status
 * @returns {string} e.g. `退出码 2316632084 / 0x8A150014`
 */
function formatExit(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return `退出码 ${String(code)}`;
  if (value >= 0 && value <= 255) return `退出码 ${value}`;
  const hex = `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return `退出码 ${value} / ${hex}`;
}

/* ------------------------------------------------------------------ snapshot */

async function diskStats() {
  try {
    if (typeof fs.statfs !== 'function') return null;
    const mount = (path.parse(process.cwd()).root || 'C:\\').replace(/[\\/]+$/, '');
    const stats = await fs.statfs(`${mount}\\`);
    const blockSize = Number(stats.bsize) || 0;
    const freeBytes = (Number(stats.bavail) || 0) * blockSize;
    const totalBytes = (Number(stats.blocks) || 0) * blockSize;
    if (!totalBytes) return null;
    return { freeBytes, totalBytes, mount };
  } catch {
    return null;
  }
}

/** Aggregates are recomputed per request; only per-manager snapshots are cached. */
function summarize(managers, items, disk) {
  return {
    total: items.length,
    updatable: items.filter((item) => item.hasUpdate === true).length,
    managersAvailable: managers.filter((manager) => manager.available).length,
    managersDetected: managers.filter((manager) => manager.detected).length,
    disk,
  };
}

async function snapshotAction(opts) {
  const detection = await detectAll(opts);
  const results = await Promise.all(MANAGER_IDS.map((id) => managerSnapshot(id, opts)));
  const managers = results.map((result) => result.manager);
  // CONTRACT §8.2: decorate with `logoUrl` only from the cached ARP / extension scans, so a
  // warm snapshot stays an in-memory pass and no per-item subprocess runs.
  const items = await addLogoUrls(results.flatMap((result) => result.items));
  const disk = await diskStats();

  // CONTRACT §11 v3 follow-up: hand the freshly built items to the process layer so its binding
  // targets come from this snapshot instead of a second `managerSnapshot` sweep (that duplicate
  // sweep was the 19 s cold start). Fire and forget: the package response never waits for it.
  try {
    Promise.resolve(warmUp(items)).catch(() => {});
  } catch {
    /* warm-up is an optimisation, never a failure of the snapshot */
  }

  // CONTRACT §11.2.6: process data is additive. It is requested AFTER the package data is
  // settled (so the two caches never wait on each other) and only awaited for 600 ms; a miss
  // returns null and the client fetches `processes` on its own.
  let processes = null;
  if (!opts.noProcesses) {
    try {
      processes = await snapshotProcesses(SNAPSHOT_PROCESS_WAIT_MS);
    } catch {
      processes = null;
    }
  }

  return {
    at: Date.now(),
    platform: process.platform,
    groups: groupEntries(detection),
    managers,
    items,
    stats: summarize(managers, items, disk),
    detection: detectionMeta(detection),
    processes,
  };
}

/** `detect` re-probes the whole catalog, bypassing the 60 s detection cache. */
async function detectAction(opts) {
  const detection = await detectAll({ force: true, dryRun: opts.dryRun });

  const managers = MANAGER_IDS.map((id) => {
    const cached = cacheGet(`snapshot:${id}`);
    const count = cached && Array.isArray(cached.items) ? cached.items.length : 0;
    return managerEntry(id, detection.entries.get(id) || null, count);
  });
  const cachedItems = MANAGER_IDS.flatMap((id) => {
    const cached = cacheGet(`snapshot:${id}`);
    return cached && Array.isArray(cached.items) ? cached.items : [];
  });
  const disk = await diskStats();

  return {
    at: Date.now(),
    platform: process.platform,
    groups: groupEntries(detection),
    managers,
    // Contract §7.3: the detect payload may omit items to save bandwidth.
    items: [],
    stats: summarize(managers, cachedItems, disk),
    detection: detectionMeta(detection),
  };
}

/* -------------------------------------------------------------- check-updates */

async function checkUpdatesAction(body, opts) {
  const manager = assertManager(body.manager);
  const def = getManager(manager);

  // Editor extensions have no latest-version source: report the contract §7.3 shape.
  if (!def.capabilities.checkUpdates) {
    const detection = await detectAll(opts);
    if (!(detection.entries.get(manager) || {}).detected) throw unavailable(`${def.label} 未检测到`);
    return { manager, checkedAt: Date.now(), updates: [], failed: [], unsupported: true };
  }

  const cacheKey = `updates:${manager}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const detection = await detectAll(opts);
  const probe = detection.entries.get(manager);
  if (!probe || !probe.detected) {
    throw unavailable(`${def.label} 未检测到${probe && probe.reason ? `：${probe.reason}` : ''}`);
  }

  let items = [];
  if (def.adapter !== 'winget') {
    const snapshot = await managerSnapshot(manager, opts);
    if (snapshot.manager.error) throw unavailable(snapshot.manager.error);
    items = snapshot.items;
  }

  const result = await checkUpdatesManager(manager, items, opts);
  const payload = {
    manager,
    checkedAt: Date.now(),
    updates: Array.isArray(result.updates) ? result.updates : [],
    failed: Array.isArray(result.failed) ? result.failed : [],
  };
  if (!opts.dryRun) cacheSet(cacheKey, payload, TTL.checkUpdates);
  return payload;
}

/* ----------------------------------------------------------------- mutations */

const ACTION_LABELS = { install: '安装', update: '更新', uninstall: '卸载' };

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, LOG_LIMIT_BYTES);
}

async function mutationAction(action, body, opts) {
  const manager = assertManager(body.manager);
  const def = getManager(manager);

  if (!def.capabilities[action]) {
    throw unavailable(`${def.label} 不支持${ACTION_LABELS[action] || action}`);
  }

  const packageId = assertPackageId(body.packageId, manager);
  const version = action === 'uninstall' ? null : assertVersion(body.version, manager);
  const command = buildMutationCommand(manager, action, { packageId, version });
  const label = ACTION_LABELS[action] || action;

  // Probe-only dry-run: argv construction is verified without touching detection or the
  // machine, so not-installed managers (go / gem / dotnet) can still be inspected.
  if (opts.dryRun) {
    const dry = await run(command.bin, command.args, { timeoutMs: command.timeoutMs, dryRun: true });
    return {
      dryRun: true,
      manager,
      action,
      packageId,
      version,
      bin: command.bin,
      args: command.args,
      command: dry.command,
      timeoutMs: command.timeoutMs,
    };
  }

  // §7.4: an undetected manager is never spawned.
  const detection = await detectAll(opts);
  const probe = detection.entries.get(manager);
  if (!probe || !probe.detected) {
    throw unavailable(
      `${def.label} 未检测到，无法${label}${probe && probe.reason ? `：${probe.reason}` : ''}`,
      probe && probe.reason ? probe.reason : null,
    );
  }

  const bin = binaryFor(manager) || command.bin;

  return enqueueMutation(async () => {
    const result = await run(bin, command.args, { timeoutMs: command.timeoutMs });
    const log = logOf(result);
    if (result.timedOut) {
      throw new ApiError('timeout', `${manager} ${label}超时（${Math.round(command.timeoutMs / 60_000)} 分钟）`, log);
    }
    if (result.code !== 0) {
      throw commandFailed(`${manager} ${label}失败（${formatExit(result.code)}）`, log);
    }
    invalidateManager(manager);
    return {
      id: `${manager}:${packageId}`,
      manager,
      packageId,
      log,
      durationMs: result.durationMs,
      action,
    };
  });
}

/* -------------------------------------------------------------------- search */

async function searchAction(body, opts) {
  const manager = assertManager(body.manager);
  const def = getManager(manager);
  const query = assertQuery(body.query);
  if (!def.capabilities.search) throw unavailable(`${def.label} 不支持搜索`);

  const detection = await detectAll(opts);
  const probe = detection.entries.get(manager);
  if (!probe || !probe.detected) {
    throw unavailable(`${def.label} 未检测到${probe && probe.reason ? `：${probe.reason}` : ''}`);
  }

  const result = await searchManager(manager, query, opts);
  const results = Array.isArray(result.results) ? result.results.slice(0, 40) : [];
  return { manager, query, results };
}

/* -------------------------------------------------------------------- detail */

async function detailAction(body, opts) {
  const manager = assertManager(body.manager);
  const def = getManager(manager);
  const packageId = assertPackageId(body.packageId, manager);
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 40) : null;
  if (!def.capabilities.detail) throw unavailable(`${def.label} 不支持查看详情`);

  const detection = await detectAll(opts);
  const probe = detection.entries.get(manager);
  if (!probe || !probe.detected) {
    throw unavailable(`${def.label} 未检测到${probe && probe.reason ? `：${probe.reason}` : ''}`);
  }

  const result = await detailManager(manager, packageId, source, opts);
  if (!result || !result.detail) throw commandFailed('读取详情失败');
  return result.detail;
}

/* -------------------------------------------------------------------- reveal */

async function revealAction(body, opts) {
  if (process.platform !== 'win32') throw unavailable('「在文件夹中显示」仅支持 Windows');
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (!rawPath) throw badRequest('缺少路径，无法打开文件夹');
  if (rawPath.length > 400 || /[\u0000-\u001f\u007f]/.test(rawPath)) throw badRequest('路径含非法字符');

  const resolved = path.resolve(rawPath);
  let stat = null;
  try {
    stat = await fs.stat(resolved);
  } catch {
    stat = null;
  }
  if (!stat) throw badRequest(`路径不存在：${resolved}`);

  const target = stat.isDirectory() ? resolved : path.dirname(resolved);
  if (opts.dryRun) return { dryRun: true, command: `explorer.exe /select,${target}` };

  try {
    const child = spawn('explorer.exe', [`/select,${target}`], {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch (error) {
    throw commandFailed(`无法打开资源管理器：${oneLine(error.message)}`);
  }
  return { revealed: true };
}

/* ------------------------------------------------------------ v3 processes */

/** CONTRACT §11.2.3: which managed items are running right now. */
async function processesAction(opts) {
  return processesPayload({ force: Boolean(opts && opts.force) });
}

/** CONTRACT §11.2.4: cwd / env / children for every process bound to one item. */
async function processDetailAction(body) {
  return processDetailPayload(body && body.id, { pid: body && body.pid });
}

/** CONTRACT §11.2.5: kill a pid that belongs to a managed item. */
async function processKillAction(body, opts) {
  return processKillPayload({ pid: body && body.pid, id: body && body.id, dryRun: Boolean(opts && opts.dryRun) });
}

/** CONTRACT §11.2.5 / §11.3.5: start an application. */
async function launchAction(body, opts) {
  return launchPayload({ id: body && body.id, dryRun: Boolean(opts && opts.dryRun) });
}

/* -------------------------------------------------------------------- router */

/**
 * @param {object} body parsed JSON request body (`{action, ...}`)
 * @param {{dryRun?: boolean}} [opts] `dryRun` is only ever set by tools/probe.mjs
 * @returns {Promise<object>} the `data` payload
 */
export async function dispatchAction(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('请求体必须是 JSON 对象');
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!action) throw badRequest('缺少 action');

  switch (action) {
    case 'snapshot':
      return snapshotAction(opts);
    case 'detect':
      return detectAction(opts);
    case 'check-updates':
      return checkUpdatesAction(body, opts);
    case 'install':
      return mutationAction('install', body, opts);
    case 'update':
      return mutationAction('update', body, opts);
    case 'uninstall':
      return mutationAction('uninstall', body, opts);
    case 'search':
      return searchAction(body, opts);
    case 'detail':
      return detailAction(body, opts);
    case 'reveal':
      return revealAction(body, opts);
    case 'processes':
      return processesAction(opts);
    case 'process-detail':
      return processDetailAction(body);
    case 'process-kill':
      return processKillAction(body, opts);
    case 'launch':
      return launchAction(body, opts);
    default:
      throw new ApiError('unknown-action', `未知的操作：${action}`);
  }
}
