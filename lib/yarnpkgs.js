// yarn 1.x global packages (CONTRACT §7.4).
//
// `yarn global dir` prints the global install directory; packages live under its
// `node_modules` (flat, plus one `@scope/` level). The directory itself is scanned and
// each package.json is read, exactly like pnpm's global root — no per-item subprocess.
// `yarn global dir` is cached briefly and invalidated after any yarn mutation.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './run.js';
import { cacheGet, cacheSet, TTL } from './cache.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { detailAtRoot } from './detail.js';
import { unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const ROOT_TIMEOUT_MS = 30_000;
const MAX_PACKAGES = 800;

/** First non-empty line of normalised output (yarn prints progress noise on stderr). */
function firstLine(text) {
  return (
    normalizeOutput(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/** Global `node_modules` root, cached for 60 s (dropped by invalidateManager after mutations). */
export async function globalRoot(def, opts = {}) {
  const cacheKey = 'root:yarn';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const bin = binaryFor(def.id);
  if (!bin) throw unavailable('yarn 未检测到');
  const result = await run(bin, ['global', 'dir'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
  const dir = result.code === 0 && !result.timedOut ? firstLine(result.stdout) : '';
  if (!dir) {
    throw unavailable(
      `无法确定 yarn 全局目录：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }
  const root = path.join(dir, 'node_modules');
  if (!opts.dryRun) cacheSet(cacheKey, root, TTL.root);
  return root;
}

async function readPackageJson(dir) {
  try {
    return JSON.parse((await fs.readFile(path.join(dir, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Two-level scan (`name` and `@scope/name`), capped, tolerant of a missing root. */
async function scanRoot(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw unavailable(`无法读取 yarn 全局目录：${error.message}`, String(root));
  }

  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (name.startsWith('@')) {
      let children = [];
      try {
        children = await fs.readdir(path.join(root, name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        if (child.name.startsWith('.')) continue;
        names.push(`${name}/${child.name}`);
      }
    } else {
      names.push(name);
    }
    if (names.length >= MAX_PACKAGES) break;
  }

  const packages = [];
  for (const name of names) {
    const packageDir = path.join(root, ...name.split('/'));
    const pkg = await readPackageJson(packageDir);
    if (!pkg) continue;
    packages.push({ name: pkg.name || name, version: pkg.version || '', dir: packageDir, description: pkg.description || null });
  }
  return packages;
}

/**
 * @param {object} def catalog descriptor
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{items: object[], root: string|null}>}
 */
export async function list(def, opts = {}) {
  if (opts.dryRun) return { items: [], root: null };
  const root = await globalRoot(def, opts);
  const packages = await scanRoot(root);
  const items = packages.map((pkg) =>
    makeItem(def, {
      name: pkg.name,
      packageId: pkg.name,
      version: pkg.version,
      path: pkg.dir,
      description: pkg.description,
    }),
  );
  return { items, root };
}

/**
 * Detail for a yarn global package: same package.json + directory-size logic as npm/pnpm.
 *
 * @param {object} def catalog descriptor
 * @param {string} packageId package name (may be `@scope/name`)
 * @param {{dryRun?: boolean}} [opts]
 */
export async function detail(def, packageId, opts = {}) {
  const root = await globalRoot(def, opts);
  return detailAtRoot(def.id, root, packageId);
}
