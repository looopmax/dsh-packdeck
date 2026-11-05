// Installed-size fill-in for items that have a local package directory but no ARP record.
//
// The list column needs a number for as many rows as possible, but a per-row `directorySize`
// walk is far too expensive inside `snapshot` (an editor's extension host, a 2.8 GB app and a
// 30 kB shim all live in the same table). Three rules keep this honest and fast:
//
//   1. Only items that already carry a `path` are measured 鈥?the manager adapters resolved it,
//      nothing is guessed here.
//   2. Every walk shares ONE global entry budget per snapshot pass, and results are cached for
//      the same TTL as the snapshot itself. A directory that could not be finished inside the
//      budget stays `null` (the UI renders "鈥?) instead of reporting a partial, wrong number.
//   3. Sizes are measured concurrently (bounded pool) and small kinds are served first, so a
//      whole-program tree can never starve the extension directories.
//
// MEASURED COST (this machine, 201 items): 200k-entry budget -> +13 s cold, 25k -> ~+1 s,
// 0 -> baseline. A cold snapshot that already takes 4 s must not grow into 18 s for a column
// of numbers, so the budget stays small and most coverage arrives on later snapshots as the
// per-path cache fills in.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cacheGet, cacheSet, TTL } from './cache.js';

/** Total directory entries a single snapshot may walk across all items (~+0.3 s measured). */
const PASS_BUDGET = 12_000;
/** A single package is capped so one huge tree cannot starve the rest. */
const ITEM_BUDGET = 6_000;
/** Concurrent directory walks. */
const POOL = 8;

const CACHE_KEY = 'sizes:dir';

function cacheMap() {
  const cached = cacheGet(CACHE_KEY);
  return cached instanceof Map ? cached : new Map();
}

/**
 * Size of one directory tree, bounded.
 *
 * `stat` calls are batched per directory: a serial await per file is what made the first version
 * of this walk cost seconds on a tree with a few thousand files.
 *
 * @param {string} rootDir absolute directory
 * @param {number} budget max directory entries to visit
 * @returns {Promise<{sizeBytes: number, complete: boolean, visited: number}>}
 */
async function boundedSize(rootDir, budget) {
  let total = 0;
  let visited = 0;
  let complete = true;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let list;
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: contribute nothing rather than fail the pass
    }

    const files = [];
    for (const entry of list) {
      if (visited >= budget) return { sizeBytes: total, complete: false, visited };
      visited += 1;
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
      // Symlinks are skipped on purpose: a global package that links to a shared store
      // (pnpm's content-addressable store) would otherwise report the whole store as its size.
    }

    if (files.length === 0) continue;
    const sizes = await Promise.all(
      files.map((file) =>
        fs.stat(file).then(
          (info) => info.size,
          () => 0, // unreadable file: contribute nothing
        ),
      ),
    );
    for (const size of sizes) total += size;
  }
  return { sizeBytes: total, complete, visited };
}

/**
 * Fill `sizeBytes` on items that carry a `path` and still have no size.
 *
 * Mutates the items in place. Never throws: any failure leaves `sizeBytes` untouched.
 *
 * @param {object[]} items snapshot items (already ARP-decorated)
 * @param {{budget?: number}} [options]
 * @returns {Promise<{measured: number, visited: number, exhausted: boolean}>}
 */
export async function fillDirectorySizes(items, options = {}) {
  const stats = { measured: 0, visited: 0, exhausted: false };
  if (!Array.isArray(items) || items.length === 0) return stats;

  const candidates = items.filter(
    (item) => item && typeof item.path === 'string' && item.path && (item.sizeBytes === null || item.sizeBytes === undefined),
  );
  if (candidates.length === 0) return stats;

  const map = cacheMap();

  // Cached paths first: a warm snapshot is a pure Map hit and costs no budget.
  const pending = [];
  for (const item of candidates) {
    const hit = map.get(item.path);
    if (typeof hit === 'number') item.sizeBytes = hit;
    else pending.push(item);
  }
  if (pending.length === 0) return stats;

  // Small, bounded kinds first: an editor extension or a global package must never lose the
  // budget race to a multi-gigabyte application install root.
  const KIND_RANK = { ext: 0, pkg: 1, tool: 2, app: 3 };
  pending.sort((left, right) => (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9));

  let remaining = Number.isFinite(options.budget) ? options.budget : PASS_BUDGET;
  const queue = pending.slice();
  const flush = () => {
    if (stats.measured > 0) cacheSet(CACHE_KEY, map, TTL.checkUpdates);
  };

  async function worker() {
    for (;;) {
      if (remaining <= 0) {
        stats.exhausted = true;
        return;
      }
      const item = queue.shift();
      if (!item) return;
      const allowance = Math.min(ITEM_BUDGET, remaining);
      let result;
      try {
        result = await boundedSize(item.path, allowance);
      } catch {
        continue;
      }
      remaining -= result.visited;
      stats.visited += result.visited;
      if (result.complete && result.sizeBytes > 0) {
        item.sizeBytes = result.sizeBytes;
        map.set(item.path, result.sizeBytes);
        stats.measured += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
  flush();
  return stats;
}

/**
 * Drop one path from the size cache, so the next snapshot re-measures it.
 * Called after a mutating action touched a package directory.
 *
 * @param {string|null|undefined} packagePath
 */
export function invalidateSize(packagePath) {
  if (typeof packagePath !== 'string' || !packagePath) return;
  const map = cacheMap();
  if (map.delete(packagePath)) cacheSet(CACHE_KEY, map, TTL.checkUpdates);
}

/**
 * Record an exact size that was measured elsewhere (the `detail` action walks the real tree),
 * so the list column can reuse it without its own bounded walk.
 *
 * @param {string} dirPath absolute package directory
 * @param {number} sizeBytes exact byte size
 */
export function rememberDirectorySize(dirPath, sizeBytes) {
  if (typeof dirPath !== 'string' || !dirPath) return;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return;
  const map = cacheMap();
  map.set(dirPath, sizeBytes);
  cacheSet(CACHE_KEY, map, TTL.checkUpdates);
}

/** Drop every cached directory size (a manager-wide update changed many paths at once). */
export function invalidateAllSizes() {
  cacheSet(CACHE_KEY, new Map(), TTL.checkUpdates);
}
