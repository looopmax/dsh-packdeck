// Manager dispatch: catalog-driven metadata, detection-gated dispatch and the per-manager
// snapshot cache.
//
// Every adapter exposes the same shape (`list` -> {items, root}); this module is the only
// place that knows which adapter belongs to which manager descriptor. Snapshot results are
// cached per manager for 60 s; the aggregates (groups / detection / itemCount / stats) are
// recomputed on every request from those cached per-manager results by lib/api.js.

import { cacheGet, cacheSet, TTL } from './cache.js';
import { GROUPS, MANAGER_DEFS, MANAGER_IDS, getManager, groupKindOf, groupLabelOf } from './catalog.js';
import { detectAll } from './detect.js';
import {
  snapshot as wingetSnapshot,
  search as wingetSearch,
  checkUpdates as wingetCheckUpdates,
  detail as wingetDetail,
} from './winget.js';
import { snapshot as nodeSnapshot } from './nodepkgs.js';
import * as yarnpkgs from './yarnpkgs.js';
import * as cargo from './cargo.js';
import * as uv from './uv.js';
import * as pip from './pip.js';
import * as gopkgs from './gopkgs.js';
import * as gem from './gem.js';
import * as dotnet from './dotnet.js';
import * as editors from './editors.js';
import * as remotes from './remotes.js';
import { checkUpdates as registryCheckUpdates, search as registrySearch } from './registry.js';
import { nodeDetail } from './detail.js';
import { makeDetail } from './items.js';
import { badRequest, unavailable } from './errors.js';
import { oneLine } from './text.js';

// Kept for callers that used the v1 exports; both are now catalog-derived.
export { MANAGER_DEFS, MANAGER_IDS };

function requireDef(id) {
  const def = getManager(id);
  if (!def) throw unavailable(`未知的包管理器 ${id}`);
  return def;
}

/* -------------------------------------------------------------- manager entry */

/**
 * Contract `managers[]` entry for one manager (v1 fields + §7.3 deltas).
 *
 * @param {string} id manager id
 * @param {object|null} probe detection entry
 * @param {number} [itemCount] items cached for this manager
 * @returns {object}
 */
export function managerEntry(id, probe, itemCount = 0) {
  const def = requireDef(id);
  const detected = Boolean(probe && probe.detected);
  const reason = probe && probe.reason ? probe.reason : null;
  return {
    id: def.id,
    label: def.label,
    vendor: def.vendor,
    kind: groupKindOf(def.groupId),
    itemKind: def.itemKind,
    groupId: def.groupId,
    groupLabel: groupLabelOf(def.groupId),
    scopeLabel: def.scopeLabel,
    available: detected,
    detected,
    version: (probe && probe.version) || null,
    root: (probe && probe.root) || null,
    error: detected ? null : reason,
    reason,
    itemCount,
    capabilities: { ...def.capabilities },
  };
}

/**
 * Availability + version for one manager (v1-compatible shape).
 *
 * @param {string} id manager id
 * @param {{dryRun?: boolean}} [opts]
 */
export async function probeManager(id, opts = {}) {
  requireDef(id);
  const detection = await detectAll(opts);
  const probe = detection.entries.get(id) || null;
  return {
    available: Boolean(probe && probe.detected),
    version: (probe && probe.version) || null,
    root: (probe && probe.root) || null,
    error: probe ? probe.reason : null,
  };
}

/* ------------------------------------------------------------------- listing */

function normalizeItem(def, item, managerVersion) {
  return {
    ...item,
    id: item.id || `${def.id}:${item.packageId}`,
    manager: def.id,
    groupId: def.groupId,
    kind: item.kind || def.itemKind,
    scope: item.scope || def.scopeLabel,
    source: item.source || def.id,
    latest: item.latest === undefined ? null : item.latest,
    hasUpdate: item.hasUpdate === true,
    managerVersion: item.managerVersion || managerVersion || null,
  };
}

async function listWinget(probe, opts) {
  const result = await wingetSnapshot({ ...opts, managerVersion: probe.version });
  return { items: result.items, root: (result.manager && result.manager.root) || probe.root };
}

async function listNode(id, probe, opts) {
  const result = await nodeSnapshot(id, probe.version, opts);
  return { items: result.items, root: (result.manager && result.manager.root) || probe.root };
}

/**
 * Installed items for one manager. Detection must have succeeded before this is called.
 *
 * @param {string} id manager id
 * @param {object} probe detection entry (carries version + resolved binary)
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{items: object[], root: string|null}>}
 */
export async function listManager(id, probe, opts = {}) {
  const def = requireDef(id);
  if (!def.capabilities.list) throw unavailable(`${def.label} 不支持列出已安装项`);

  let result;
  switch (def.adapter) {
    case 'winget':
      result = await listWinget(probe, opts);
      break;
    case 'node':
      result = await listNode(id, probe, opts);
      break;
    case 'yarn':
      result = await yarnpkgs.list(def, opts);
      break;
    case 'cargo':
      result = await cargo.list(def, opts);
      break;
    case 'uv':
      result = await uv.list(def, opts);
      break;
    case 'pip':
      result = await pip.list(def, opts);
      break;
    case 'go':
      result = await gopkgs.list(def, opts);
      break;
    case 'gem':
      result = await gem.list(def, opts);
      break;
    case 'dotnet':
      result = await dotnet.list(def, opts);
      break;
    case 'editor':
      result = await editors.list(def, opts);
      break;
    default:
      throw unavailable(`未知的包管理器 ${id}`);
  }

  const items = (result.items || []).map((item) => normalizeItem(def, item, probe.version));
  return { items, root: result.root || null };
}

function sortItems(items) {
  return items.sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || ''), 'zh-Hans-CN', { numeric: true }),
  );
}

/**
 * One manager's snapshot, cached for 60 s. Never throws: a detection miss or a failed list
 * only marks this manager, so one broken tool can never fail the whole `snapshot`.
 *
 * @param {string} id manager id
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{manager: object, items: object[], detected: boolean}>}
 */
export async function managerSnapshot(id, opts = {}) {
  requireDef(id);
  const detection = await detectAll(opts);
  const probe = detection.entries.get(id) || null;

  if (!probe || !probe.detected) {
    return { manager: managerEntry(id, probe, 0), items: [], detected: false };
  }

  const cacheKey = `snapshot:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let value;
  try {
    const { items, root } = await listManager(id, probe, opts);
    sortItems(items);
    value = {
      manager: managerEntry(id, { ...probe, root: root || probe.root }, items.length),
      items,
      detected: true,
    };
  } catch (error) {
    value = {
      manager: { ...managerEntry(id, probe, 0), error: oneLine(error && error.message, 240) },
      items: [],
      detected: true,
    };
  }

  // Only cache healthy snapshots so a temporary failure retries on the next request.
  if (!value.manager.error && !opts.dryRun) cacheSet(cacheKey, value, TTL.snapshot);
  return value;
}

/* -------------------------------------------------------------- check-updates */

/**
 * check-updates for one manager. `items` is empty for winget (it runs `winget upgrade`);
 * other managers get their cached snapshot rows.
 */
export async function checkUpdatesManager(id, items, opts = {}) {
  const def = requireDef(id);
  if (!def.capabilities.checkUpdates) throw unavailable(`${def.label} 不支持检查更新`);
  switch (def.adapter) {
    case 'winget':
      return wingetCheckUpdates(opts);
    case 'node':
    case 'yarn':
      return registryCheckUpdates(id, items, opts);
    case 'cargo':
    case 'uv':
    case 'pip':
    case 'gem':
    case 'dotnet':
      return remotes.checkUpdates(id, items, opts);
    default:
      throw unavailable(`${def.label} 不支持检查更新`);
  }
}

/* -------------------------------------------------------------------- search */

export async function searchManager(id, query, opts = {}) {
  const def = requireDef(id);
  if (!def.capabilities.search) throw unavailable(`${def.label} 不支持搜索`);
  switch (def.adapter) {
    case 'winget':
      return wingetSearch(query, opts);
    case 'node':
    case 'yarn':
      return registrySearch(id, query, opts);
    case 'cargo':
    case 'gem':
    case 'dotnet':
      return remotes.search(id, query, opts);
    default:
      throw unavailable(`${def.label} 不支持搜索`);
  }
}

/* -------------------------------------------------------------------- detail */

/**
 * Detail for one installed item. winget / node-family / yarn inspect the machine; every
 * other manager returns the honest minimum from its cached snapshot row.
 *
 * @param {string} id manager id
 * @param {string} packageId package id
 * @param {string|null} source winget source (msstore vs winget)
 * @param {{dryRun?: boolean}} [opts]
 */
export async function detailManager(id, packageId, source, opts = {}) {
  const def = requireDef(id);
  if (!def.capabilities.detail) throw unavailable(`${def.label} 不支持查看详情`);
  switch (def.adapter) {
    case 'winget':
      return wingetDetail(packageId, source, opts);
    case 'node':
      return { detail: await nodeDetail(id, packageId, opts) };
    case 'yarn':
      return { detail: await yarnpkgs.detail(def, packageId, opts) };
    default: {
      const snapshot = await managerSnapshot(id, opts);
      const item = snapshot.items.find((entry) => entry.packageId === packageId);
      if (!item) throw badRequest(`未找到已安装的 ${packageId}`);
      return { detail: makeDetail(def, item) };
    }
  }
}

/* -------------------------------------------------------------------- groups */
/** Catalog groups with the detected subset (used by lib/api.js on every request). */
export function groupEntries(detection) {
  return GROUPS.map((group) => {
    const ids = MANAGER_IDS.filter((id) => {
      const def = getManager(id);
      return Boolean(def && def.groupId === group.id);
    });
    const availableIds = ids.filter((id) => {
      const entry = detection && detection.entries ? detection.entries.get(id) : null;
      return Boolean(entry && entry.detected);
    });
    return {
      id: group.id,
      label: group.label,
      kind: group.kind,
      order: group.order,
      managerIds: ids,
      availableIds,
      detected: availableIds.length,
      total: ids.length,
    };
  });
}
