// `detail` for npm / pnpm / bun: read the installed package.json under the manager's
// global root and measure the package directory (skipping `.bin`, following a symlink once,
// stopping after 40 000 entries).

import fs from 'node:fs/promises';
import path from 'node:path';
import { getRoot } from './nodepkgs.js';
import { badRequest } from './errors.js';
import { rememberDirectorySize } from './sizes.js';

const MAX_ENTRIES = 40_000;

async function readJson(file) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function licenseOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.type === 'string') return value.type;
  return null;
}

function urlOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.url === 'string') return value.url;
    if (typeof value.web === 'string') return value.web;
  }
  return null;
}

function dependenciesOf(pkg) {
  const source = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  return Object.entries(source)
    .filter(([name, version]) => typeof name === 'string' && name.length > 0)
    .map(([name, version]) => ({ name, version: String(version ?? '') }));
}

/** Recursive directory size with a hard entry budget. */
export async function directorySize(rootDir) {
  let total = 0;
  let entries = 0;
  let truncated = false;
  const stack = [{ dir: rootDir, followLinks: true }];
  const visitedLinks = new Set();

  while (stack.length > 0) {
    if (entries >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    let list;
    try {
      list = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of list) {
      entries += 1;
      if (entries >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.name === '.bin') continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, followLinks: current.followLinks });
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (!current.followLinks) continue; // follow a symlink at most once
        try {
          const real = await fs.realpath(full);
          if (visitedLinks.has(real)) continue;
          visitedLinks.add(real);
          const stat = await fs.stat(full);
          if (stat.isDirectory()) stack.push({ dir: full, followLinks: false });
          else total += stat.size;
        } catch {
          /* dangling link */
        }
        continue;
      }
      if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          total += stat.size;
        } catch {
          /* unreadable file */
        }
      }
    }
  }

  return { sizeBytes: total, truncated };
}

/**
 * Detail for one package that lives under a node-style `node_modules` root.
 * Shared by npm / pnpm / bun (root from nodepkgs.getRoot) and yarn (root from
 * `yarn global dir`), so the package.json + directory-size logic exists only once.
 *
 * @param {string} manager manager id, used in the returned `id`
 * @param {string} root absolute `node_modules` directory
 * @param {string} packageId package name (may be `@scope/name`)
 * @returns {Promise<object>} contract `detail` payload for a node package
 */
export async function detailAtRoot(manager, root, packageId) {
  const packageDir = path.join(root, ...String(packageId).split('/'));

  let stat;
  try {
    stat = await fs.stat(packageDir);
  } catch {
    throw badRequest(`未找到已安装的包 ${packageId}`);
  }
  if (!stat.isDirectory()) throw badRequest(`未找到已安装的包 ${packageId}`);

  const pkg = (await readJson(path.join(packageDir, 'package.json'))) || {};
  const { sizeBytes, truncated } = await directorySize(packageDir);
  /* The exact walk just happened, so hand it to the list's size cache: the next snapshot then
   * shows this package's real size without paying for the bounded background walk. */
  if (sizeBytes > 0 && !truncated) rememberDirectorySize(packageDir, sizeBytes);

  const detail = {
    id: `${manager}:${packageId}`,
    manager,
    packageId,
    name: typeof pkg.name === 'string' && pkg.name ? pkg.name : packageId,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof pkg.description === 'string' && pkg.description ? pkg.description : null,
    sizeBytes,
    sizeTruncated: truncated || undefined,
    path: packageDir,
    license: licenseOf(pkg.license),
    homepage: urlOf(pkg.homepage),
    repository: urlOf(pkg.repository),
    dependencies: dependenciesOf(pkg),
    dependents: [],
    installedAt: null,
    otherVersions: null,
  };
  return detail;
}

/**
 * @returns {Promise<object>} contract `detail` payload for an npm / pnpm / bun package
 */
export async function nodeDetail(manager, packageId, opts = {}) {
  const root = await getRoot(manager, opts);
  return detailAtRoot(manager, root, packageId);
}
