// Language-ecosystem registries for the non-Node managers (CONTRACT §7.4).
//
// Latest-version sources:
//   cargo  -> https://crates.io/api/v1/crates/<name>      (crate.max_stable_version || max_version)
//   uv/pip -> https://pypi.org/pypi/<name>/json           (info.version)
//   gem    -> https://rubygems.org/api/v1/gems/<name>.json (version)
//   dotnet -> https://api.nuget.org/v3-flatcontainer/<id>/index.json (last non-preview)
//
// Search uses crates.io / rubygems / nuget's search endpoints; PyPI and Go expose no
// search API, so those managers keep `capabilities.search = false`.
//
// All requests carry UA `packdeck/1.0` per the contract, are limited to 8 in flight with a
// 4 s per-endpoint timeout, and never fail the whole action: unreachable endpoints land in
// `failed`.

import { mapLimit } from './registry.js';
import { commandFailed } from './errors.js';
import { oneLine } from './text.js';
import { hasUpdate } from './version.js';

const USER_AGENT = 'packdeck/1.0';
const LATEST_TIMEOUT_MS = 4_000;
const SEARCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const MAX_CHECK_ITEMS = 300;

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return response.json();
}

function encode(name) {
  return encodeURIComponent(String(name));
}

/* ------------------------------------------------------------ latest versions */

async function latestCargo(name) {
  const data = await fetchJson(`https://crates.io/api/v1/crates/${encode(name)}`, LATEST_TIMEOUT_MS);
  const crate = data && data.crate;
  if (!crate) return '';
  return String(crate.max_stable_version || crate.max_version || '');
}

async function latestPypi(name) {
  const data = await fetchJson(`https://pypi.org/pypi/${encode(name)}/json`, LATEST_TIMEOUT_MS);
  return data && data.info && typeof data.info.version === 'string' ? data.info.version : '';
}

async function latestGem(name) {
  const data = await fetchJson(`https://rubygems.org/api/v1/gems/${encode(name)}.json`, LATEST_TIMEOUT_MS);
  return data && typeof data.version === 'string' ? data.version : '';
}

async function latestNuget(name) {
  const id = String(name).toLowerCase();
  const data = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${encode(id)}/index.json`, LATEST_TIMEOUT_MS);
  const versions = Array.isArray(data && data.versions) ? data.versions.filter((value) => typeof value === 'string') : [];
  if (versions.length === 0) return '';
  const stable = versions.filter((value) => !value.includes('-'));
  return stable.length > 0 ? stable[stable.length - 1] : versions[versions.length - 1];
}

const LATEST_LOOKUPS = {
  cargo: latestCargo,
  uv: latestPypi,
  pip: latestPypi,
  gem: latestGem,
  dotnet: latestNuget,
};

/* --------------------------------------------------------------------- search */

async function searchCargo(query) {
  const data = await fetchJson(
    `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=30`,
    SEARCH_TIMEOUT_MS,
  );
  const crates = Array.isArray(data && data.crates) ? data.crates : [];
  return crates
    .filter((crate) => crate && typeof crate.name === 'string')
    .map((crate) => ({
      packageId: crate.name,
      name: crate.name,
      version: String(crate.max_stable_version || crate.max_version || ''),
      source: 'cargo',
      description: typeof crate.description === 'string' && crate.description ? crate.description : null,
    }));
}

async function searchGem(query) {
  const data = await fetchJson(
    `https://rubygems.org/api/v1/search.json?query=${encodeURIComponent(query)}`,
    SEARCH_TIMEOUT_MS,
  );
  const gems = Array.isArray(data) ? data : [];
  return gems
    .filter((gem) => gem && typeof gem.name === 'string')
    .map((gem) => ({
      packageId: gem.name,
      name: gem.name,
      version: typeof gem.version === 'string' ? gem.version : '',
      source: 'gem',
      description: typeof gem.info === 'string' && gem.info ? gem.info : null,
    }));
}

async function searchNuget(query) {
  const data = await fetchJson(
    `https://azuresearch-usnc.nuget.org/query?q=${encodeURIComponent(query)}&take=30`,
    SEARCH_TIMEOUT_MS,
  );
  const results = Array.isArray(data && data.data) ? data.data : [];
  return results
    .filter((pkg) => pkg && typeof pkg.id === 'string')
    .map((pkg) => ({
      packageId: pkg.id,
      name: pkg.id,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      source: 'dotnet',
      description: typeof pkg.description === 'string' && pkg.description ? pkg.description : null,
    }));
}

const SEARCHERS = {
  cargo: searchCargo,
  gem: searchGem,
  dotnet: searchNuget,
};

/* ---------------------------------------------------------------- check-updates */

/**
 * check-updates for cargo / uv / pip / gem / dotnet: registry lookups, 8 concurrent,
 * 4 s per endpoint. Failures land in `failed`, not in the action result.
 *
 * @param {string} manager manager id
 * @param {Array<{id:string, packageId:string, version:string}>} items snapshot items
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{updates: Array<{id:string,packageId:string,version:string,latest:string}>,
 *   failed: Array<{packageId:string,message:string}>}>}
 */
export async function checkUpdates(manager, items, opts = {}) {
  if (opts.dryRun) return { updates: [], failed: [], dryRunCommands: [] };
  if (!Array.isArray(items) || items.length === 0) return { updates: [], failed: [] };

  const lookup = LATEST_LOOKUPS[manager];
  if (!lookup) throw commandFailed(`${manager} 没有可用的最新版本来源`);

  const updates = [];
  const failed = [];
  await mapLimit(items.slice(0, MAX_CHECK_ITEMS), CONCURRENCY, async (item) => {
    try {
      const latest = await lookup(item.packageId);
      if (latest && hasUpdate(latest, item.version)) {
        updates.push({ id: item.id, packageId: item.packageId, version: item.version || '', latest });
      }
    } catch (error) {
      const message = error && error.name === 'TimeoutError' ? '请求超时' : oneLine(error && error.message, 160);
      failed.push({ packageId: item.packageId, message: message || '请求失败' });
    }
  });
  updates.sort((left, right) => left.packageId.localeCompare(right.packageId));
  failed.sort((left, right) => left.packageId.localeCompare(right.packageId));
  return { updates, failed };
}

/**
 * Search one ecosystem.
 *
 * @param {string} manager manager id
 * @param {string} query search text
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{results: Array<object>}>}
 */
export async function search(manager, query, opts = {}) {
  if (opts.dryRun) return { results: [], dryRunCommands: [] };
  const searcher = SEARCHERS[manager];
  if (!searcher) throw commandFailed(`${manager} 不支持搜索`);
  const results = await searcher(query);
  return { results };
}
