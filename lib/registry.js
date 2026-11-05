// npm registry access: latest-version lookups for check-updates, package search, and the
// registry URL itself (from `npm config get registry`, defaulting to registry.npmjs.org).

import { run } from './run.js';
import { cacheGet, cacheSet, TTL } from './cache.js';
import { commandFailed } from './errors.js';
import { oneLine } from './text.js';
import { hasUpdate } from './version.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const USER_AGENT = 'packdeck/1.0';
const LATEST_TIMEOUT_MS = 4_000;
const SEARCH_TIMEOUT_MS = 15_000;
const CHECK_CONCURRENCY = 8;

const NODE_NAME_RE = /^[@A-Za-z0-9][A-Za-z0-9@/._~-]{0,213}$/;

function withTrailingSlash(value) {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_REGISTRY;
  return text.endsWith('/') ? text : `${text}/`;
}

/** Registry URL, cached for 10 minutes. Never fails: falls back to registry.npmjs.org. */
export async function getRegistry(opts = {}) {
  const cached = cacheGet('registry:npm');
  if (cached) return cached;
  if (opts.dryRun) return DEFAULT_REGISTRY;
  try {
    const result = await run('npm', ['config', 'get', 'registry'], { timeoutMs: 10_000 });
    if (result.code === 0 && !result.timedOut) {
      const value = withTrailingSlash(result.stdout);
      if (/^https?:\/\//i.test(value)) return cacheSet('registry:npm', value, TTL.registry);
    }
  } catch {
    /* fall through to the public registry */
  }
  return cacheSet('registry:npm', DEFAULT_REGISTRY, TTL.registry);
}

/** `@scope/name` -> `@scope%2Fname`, `name` -> `name`. */
export function encodePackageName(name) {
  const value = String(name || '');
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    if (slash > 1) return `${value.slice(0, slash)}%2F${encodeURIComponent(value.slice(slash + 1))}`;
  }
  return encodeURIComponent(value);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return response.json();
}

/** Run `worker` over `items` with at most `limit` in flight; never rejects. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = [];
  const count = Math.min(Math.max(1, limit), items.length);
  for (let i = 0; i < count; i += 1) {
    runners.push(
      (async () => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Latest version of one package (4 s timeout each).
 * @returns {Promise<string>} empty string when the registry has no `version`
 */
export async function fetchLatest(packageId, registry) {
  const data = await fetchJson(`${registry}${encodePackageName(packageId)}/latest`, LATEST_TIMEOUT_MS);
  return data && typeof data.version === 'string' ? data.version : '';
}

/**
 * check-updates for npm / pnpm / bun: 8 concurrent registry lookups.
 * A failing endpoint lands in `failed`, it never fails the whole action.
 *
 * @param {string} manager
 * @param {Array<{id:string, packageId:string, version:string}>} items
 * @param {{dryRun?: boolean}} [opts]
 */
export async function checkUpdates(manager, items, opts = {}) {
  if (opts.dryRun) return { updates: [], failed: [], dryRunCommands: [] };
  if (!Array.isArray(items) || items.length === 0) return { updates: [], failed: [] };

  const registry = await getRegistry(opts);
  const updates = [];
  const failed = [];

  await mapLimit(items, CHECK_CONCURRENCY, async (item) => {
    try {
      const latest = await fetchLatest(item.packageId, registry);
      if (latest && hasUpdate(latest, item.version)) {
        updates.push({ id: item.id, packageId: item.packageId, version: item.version || '', latest });
      }
    } catch (error) {
      const message = error && error.name === 'TimeoutError' ? '请求超时' : oneLine(error && error.message, 160);
      failed.push({ packageId: item.packageId, message: message || '请求失败' });
    }
  });

  updates.sort((a, b) => a.packageId.localeCompare(b.packageId));
  return { updates, failed };
}

/** Last-resort search for npm when the registry `-/v1/search` endpoint is unusable. */
async function npmViewFallback(query) {
  if (!NODE_NAME_RE.test(query)) return null;
  try {
    const result = await run('npm', ['view', query, 'version', '--json'], { timeoutMs: 30_000 });
    if (result.code !== 0 || result.timedOut) return null;
    const text = String(result.stdout || '').trim();
    if (!text) return null;
    let version = '';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') version = parsed;
      else if (Array.isArray(parsed) && parsed.length) version = String(parsed[parsed.length - 1]);
      else if (parsed && typeof parsed === 'object') version = String(Object.keys(parsed).pop() || '');
    } catch {
      version = text.split('\n').pop().trim();
    }
    return [{ packageId: query, name: query, version, source: 'npm', description: null }];
  } catch {
    return null;
  }
}

/**
 * Search the registry (`GET {registry}-/v1/search`).
 * @returns {Promise<{results: Array<{packageId:string,name:string,version:string,source:string,description:string|null}>}>}
 */
export async function search(manager, query, opts = {}) {
  if (opts.dryRun) return { results: [], dryRunCommands: [] };
  const registry = await getRegistry(opts);
  const url = `${registry}-/v1/search?text=${encodeURIComponent(query)}&size=30`;
  try {
    const data = await fetchJson(url, SEARCH_TIMEOUT_MS);
    const objects = Array.isArray(data && data.objects) ? data.objects : [];
    const results = [];
    for (const entry of objects) {
      const pkg = entry && entry.package;
      if (!pkg || typeof pkg.name !== 'string') continue;
      results.push({
        packageId: pkg.name,
        name: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : '',
        source: manager,
        description: typeof pkg.description === 'string' && pkg.description ? pkg.description : null,
      });
    }
    if (results.length > 0) return { results };
  } catch (error) {
    if (manager !== 'npm') {
      throw commandFailed(`registry 搜索失败：${oneLine(error && error.message)}`, null);
    }
    const fallback = await npmViewFallback(query);
    if (fallback) return { results: fallback };
    throw commandFailed(`registry 搜索失败：${oneLine(error && error.message)}`, null);
  }

  if (manager === 'npm') {
    const fallback = await npmViewFallback(query);
    if (fallback) return { results: fallback };
  }
  return { results: [] };
}
