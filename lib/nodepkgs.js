// Node.js global package managers: npm, pnpm, bun.
//
// npm  : `npm ls -g --depth=0 --json` is authoritative (names + versions, `file:`/`link:`
//        resolutions kept as a note).
// pnpm : `pnpm root -g` -> .../global/5/node_modules; the directory is scanned two levels
//        (`@scope/name`) and each package.json is read. `pnpm ls -g --json` is useless here.
// bun  : `bun pm ls -g` first line carries the global `node_modules` root and the tree lists
//        the actual globally installed packages. The directory itself is a flat install
//        store full of transitive dependencies, so scanning it would report ~330 packages
//        that were never installed globally; the tree (or `install/global/package.json`)
//        is used instead.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './run.js';
import { cacheGet, cacheSet, TTL } from './cache.js';
import { parseFailed, unavailable } from './errors.js';
import { oneLine, tail } from './text.js';

export const NODE_DEFS = {
  npm: { id: 'npm', label: 'npm', vendor: 'npm, Inc.', scopeLabel: '全局安装', kind: 'pkg' },
  pnpm: { id: 'pnpm', label: 'pnpm', vendor: 'pnpm', scopeLabel: '全局安装', kind: 'pkg' },
  bun: { id: 'bun', label: 'bun', vendor: 'Oven', scopeLabel: '全局安装', kind: 'pkg' },
};

const PROBE_TIMEOUT_MS = 10_000;
const ROOT_TIMEOUT_MS = 30_000;
// npm ls is part of snapshot; keep it inside the client's 20 s snapshot budget.
const LIST_TIMEOUT_MS = 25_000;
const MAX_PACKAGES = 800;

const BIN = { npm: 'npm', pnpm: 'pnpm', bun: 'bun' };

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

function describeFailure(result) {
  return oneLine(result.stderr || result.stdout || result.spawnError || '') || `退出码 ${result.code}`;
}

function firstLine(text) {
  return (
    String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

async function readPackageJson(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function toItem(manager, name, version, packageDir, description, managerVersion, note) {
  const item = {
    id: `${manager}:${name}`,
    manager,
    name,
    packageId: name,
    source: manager,
    kind: 'pkg',
    scope: NODE_DEFS[manager].scopeLabel,
    cwd: null,
    path: packageDir,
    version: version || '',
    latest: null,
    hasUpdate: false,
    description: description || null,
    sizeBytes: null,
    installedAt: null,
    managerVersion: managerVersion || null,
  };
  if (note) item.note = note;
  return item;
}

/** Resolve a manager's global root directory (cached briefly, dropped after mutations). */
export async function getRoot(manager, opts = {}) {
  const cacheKey = `root:${manager}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (manager === 'npm') {
    const result = await run('npm', ['root', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
    let root = result.code === 0 && !result.timedOut ? firstLine(result.stdout) : '';
    if (!root) {
      const prefix = await run('npm', ['prefix', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
      const base = prefix.code === 0 && !prefix.timedOut ? firstLine(prefix.stdout) : '';
      if (base) root = path.join(base, 'node_modules');
    }
    if (!root) throw unavailable(`无法确定 npm 全局目录：${describeFailure(result)}`, logOf(result));
    if (!opts.dryRun) cacheSet(cacheKey, root, TTL.root);
    return root;
  }

  if (manager === 'pnpm') {
    const result = await run('pnpm', ['root', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
    const root = result.code === 0 && !result.timedOut ? firstLine(result.stdout) : '';
    if (!root) throw unavailable(`无法确定 pnpm 全局目录：${describeFailure(result)}`, logOf(result));
    if (!opts.dryRun) cacheSet(cacheKey, root, TTL.root);
    return root;
  }

  if (manager === 'bun') {
    const root = await bunGlobalRoot(opts);
    if (!opts.dryRun) cacheSet(cacheKey, root, TTL.root);
    return root;
  }

  throw unavailable(`未知的包管理器 ${manager}`);
}

/** `bun pm ls -g` -> "C:\Users\x\.bun\install\global node_modules (331)" -> ...\global\node_modules */
async function bunGlobalRoot(opts = {}) {
  const listing = await run('bun', ['pm', 'ls', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
  if (!listing.timedOut && listing.code === 0) {
    const line = String(listing.stdout || '').split('\n').find((value) => /node_modules/.test(value));
    const match = line ? /^(.+?)\s+node_modules\b/.exec(line.trim()) : null;
    if (match) return path.join(match[1].trim(), 'node_modules');
  }
  const bin = await run('bun', ['pm', 'bin', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
  const binDir = bin.code === 0 && !bin.timedOut ? firstLine(bin.stdout) : '';
  if (!binDir) throw unavailable(`无法确定 bun 全局目录：${describeFailure(listing)}`, logOf(listing));
  return path.join(path.dirname(binDir), 'install', 'global', 'node_modules');
}

/** Availability + version for one node manager. */
export async function probe(manager, opts = {}) {
  const bin = BIN[manager];
  const result = await run(bin, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, dryRun: opts.dryRun });
  if (opts.dryRun) return { available: true, version: '?.?.?', root: null, error: null };
  if (result.timedOut) return { available: false, version: null, root: null, error: `${bin} --version 超时（10 s）` };
  const version = firstLine(result.stdout);
  if (result.code !== 0 || !version) {
    return { available: false, version: null, root: null, error: `${bin} 不可用：${describeFailure(result)}` };
  }
  return { available: true, version, root: null, error: null };
}

async function npmItems(managerVersion, opts) {
  const result = await run('npm', ['ls', '-g', '--depth=0', '--json'], { timeoutMs: LIST_TIMEOUT_MS, dryRun: opts.dryRun });
  if (result.timedOut) throw parseFailed('npm ls 超时（25 s）', logOf(result));

  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  let parsed = null;
  if (start >= 0) {
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw parseFailed(`无法解析 npm ls 输出：${describeFailure(result)}`, logOf(result));
  }

  const root = await getRoot('npm', opts);
  const dependencies = parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {};
  const items = [];
  for (const [name, meta] of Object.entries(dependencies)) {
    if (!meta || typeof meta !== 'object') continue;
    if (meta.missing === true) continue;
    if (typeof meta.version !== 'string' || !meta.version) continue;
    const resolved = typeof meta.resolved === 'string' ? meta.resolved : '';
    const note = resolved && /^(file|link):/.test(resolved) ? resolved : meta.link === true ? resolved : '';
    items.push(toItem('npm', name, meta.version, path.join(root, name), null, managerVersion, note));
  }
  return { items, root, raw: result };
}

async function pnpmItems(managerVersion, opts) {
  const root = await getRoot('pnpm', opts);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { items: [], root };
    throw unavailable(`无法读取 pnpm 全局目录：${error.message}`, String(root));
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (name === 'node_modules') continue;
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
        dirs.push(`${name}/${child.name}`);
      }
    } else {
      dirs.push(name);
    }
    if (dirs.length > MAX_PACKAGES) break;
  }

  const items = [];
  for (const name of dirs) {
    const packageDir = path.join(root, ...name.split('/'));
    const pkg = await readPackageJson(packageDir);
    if (!pkg) continue;
    items.push(toItem('pnpm', pkg.name || name, pkg.version || '', packageDir, pkg.description || null, managerVersion));
  }
  return { items, root };
}

function parseBunTree(output) {
  const entries = [];
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.replace(/\r/g, '').trimEnd();
    const match = /^[├└]──\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const entry = match[1];
    const at = entry.lastIndexOf('@');
    if (at > 0) entries.push({ name: entry.slice(0, at), version: entry.slice(at + 1) });
    else entries.push({ name: entry, version: '' });
  }
  return entries;
}

async function bunItems(managerVersion, opts) {
  const listing = await run('bun', ['pm', 'ls', '-g'], { timeoutMs: ROOT_TIMEOUT_MS, dryRun: opts.dryRun });
  if (listing.timedOut) throw parseFailed('bun pm ls -g 超时（30 s）', logOf(listing));
  const root = await getRoot('bun', opts);

  let entries = listing.code === 0 ? parseBunTree(listing.stdout) : [];
  if (entries.length === 0) {
    // Fallback: the global manifest next to node_modules lists the real top-level packages.
    const manifestPath = path.join(path.dirname(root), 'package.json');
    try {
      const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
      const dependencies = manifest && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
      entries = Object.keys(dependencies).map((name) => ({ name, version: '' }));
    } catch {
      entries = [];
    }
  }

  const items = [];
  for (const entry of entries.slice(0, MAX_PACKAGES)) {
    const packageDir = path.join(root, ...entry.name.split('/'));
    const pkg = await readPackageJson(packageDir);
    const version = entry.version || (pkg && pkg.version) || '';
    items.push(toItem('bun', entry.name, version, packageDir, (pkg && pkg.description) || null, managerVersion));
  }
  return { items, root };
}

function managerEntryFor(manager, { version, root, available = true, error = null }) {
  const def = NODE_DEFS[manager];
  return {
    id: def.id,
    label: def.label,
    vendor: def.vendor,
    scopeLabel: def.scopeLabel,
    available,
    version: version || null,
    root: root || null,
    error,
  };
}

/**
 * @returns {Promise<{manager: object, items: object[]}>}
 */
export async function snapshot(manager, managerVersion, opts = {}) {
  if (opts.dryRun) {
    return {
      manager: managerEntryFor(manager, { version: managerVersion || '?.?.?' }),
      items: [],
      dryRunCommands: [`${manager} root/list probe skipped in dry-run`],
    };
  }

  let result;
  if (manager === 'npm') result = await npmItems(managerVersion, opts);
  else if (manager === 'pnpm') result = await pnpmItems(managerVersion, opts);
  else if (manager === 'bun') result = await bunItems(managerVersion, opts);
  else throw unavailable(`未知的包管理器 ${manager}`);

  return {
    manager: managerEntryFor(manager, { version: managerVersion, root: result.root }),
    items: result.items,
  };
}
