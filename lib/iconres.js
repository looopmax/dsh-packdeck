// Low-level icon resource discovery for Packdeck (CONTRACT §8).
//
// Two machine sources, both scanned once and cached for 5 minutes (lib/cache.js):
//   1. ARP (Add/Remove Programs) uninstall keys: DisplayName / InstallLocation / DisplayIcon.
//      HKLM + WOW6432Node + HKCU, queried in parallel with `reg query`.
//   2. Editor extension roots: `<root>/<publisher>.<name>-<version>/package.json#icon`.
//
// All file access is read-only and defensive: `realpath` containment checks reject symlink
// escapes, non-files and unreadable targets. `.exe` DisplayIcon values are rasterised to a
// 32 px PNG with System.Drawing in a hidden, time-limited PowerShell child, cached in
// `<TEMP>\packdeck-icons\<sha1>.png` and in memory.
//
// Only node:* builtins are used.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from './cache.js';
import { run } from './run.js';
import { normalizeOutput } from './text.js';

/** ARP scan + extension-root scan TTL (CONTRACT §8.2: 5 minutes). */
export const ICON_SCAN_TTL = 5 * 60_000;

const ARP_CACHE_KEY = 'icons:arp';
const EXT_CACHE_KEY = 'icons:ext';

const HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const REG_TIMEOUT_MS = 15_000;
const REG_BLOCK_START = /^HKEY_/i;
const REG_VALUE_LINE = /^\s{2,}([^\s]+)\s+(REG_[A-Z_]+)\s?(.*)$/;

const EXTRACT_TIMEOUT_MS = 5_000;
const EXTRACT_MEMORY_MAX = 128;
const EXTRACT_DIR = 'packdeck-icons';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Icon file extensions served as-is (CONTRACT §8.2). */
const CONTENT_TYPES = new Map([
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

/* --------------------------------------------------------------------- helpers */

export function sha1Hex(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function stripQuotes(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).trim();
  return text;
}

/** Expand `%ProgramFiles%`-style environment references (reg query keeps them raw). */
function expandEnvVars(value) {
  const text = String(value == null ? '' : value);
  if (!text.includes('%')) return text;
  return text.replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name];
    return found === undefined ? match : found;
  });
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop a trailing platform/scope qualifier so "App (x64)" also matches "App". */
function looseName(value) {
  return normalizeName(value)
    .replace(/\s*\((?:x64|x86|32-bit|64-bit|user|machine|当前用户)\)\s*$/i, '')
    .replace(/\s+(?:x64|x86|arm64)$/i, '')
    .trim();
}

/** Lowercase alphanumerics only: "7-Zip 26.03 (x64 edition)" -> "7zip2603x64edition". */
function compactText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizePathKey(value) {
  const text = stripQuotes(value).replace(/\//g, '\\').replace(/\\+$/, '');
  return text.toLowerCase();
}

/* ------------------------------------------------------------ DisplayIcon parsing */

/**
 * Parse an ARP `DisplayIcon` value into a file path + optional resource index.
 * Real shapes on this machine: `C:\App\App.exe,0`, `"C:\App\setup.exe"`,
 * `C:\OneDriveSetup.exe,-101`, `C:\Git\git-for-windows.ico`.
 *
 * @param {unknown} raw registry value
 * @returns {{file: string, index: number|null}|null}
 */
export function parseDisplayIcon(raw) {
  let value = expandEnvVars(stripQuotes(raw));
  if (!value) return null;

  // Quoted path followed by `,<index>`: "C:\Program Files\App\app.exe",0
  if (value.startsWith('"')) {
    const close = value.indexOf('"', 1);
    if (close > 1) {
      const file = stripQuotes(value.slice(1, close));
      const rest = value.slice(close + 1).trim();
      return file ? { file, index: parseIconIndex(rest) } : null;
    }
    value = value.replace(/^"|"$/g, '').trim();
  }

  const indexed = /^(.+),\s*(-?\d+)\s*$/.exec(value);
  if (indexed) return { file: stripQuotes(indexed[1]), index: Number(indexed[2]) };
  return { file: stripQuotes(value), index: null };
}

function parseIconIndex(text) {
  const match = /^,?\s*(-?\d+)\s*$/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

/** MIME type for the file types CONTRACT §8.2 allows; null for anything else. */
export function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(String(filePath || '')).toLowerCase()) || null;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function realpathOrNull(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ ARP registry */

function collectArpEntries(output) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && (current.displayName || current.displayIcon)) entries.push(current);
    current = null;
  };
  for (const line of normalizeOutput(output).split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (REG_BLOCK_START.test(trimmed)) {
      flush();
      current = { key: trimmed };
      continue;
    }
    if (!current) continue;
    const match = REG_VALUE_LINE.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[3].trim();
    if (!value) continue;
    if (key === 'displayname') current.displayName = value;
    else if (key === 'displayicon') current.displayIcon = value;
    else if (key === 'installlocation') current.installLocation = stripQuotes(value);
    else if (key === 'estimatedsize') {
      /* REG_DWORD, already in KiB. Installers write it; a real directory walk is what the
       * `detail` action does and is far too expensive per row (see docs/CONTRACT.md §15). */
      const kib = Number(value);
      if (Number.isFinite(kib) && kib > 0) current.estimatedSizeKb = kib;
    }
  }
  flush();
  return entries;
}

/** One `reg query ... /s` pass over the three uninstall hives. `[]` when all fail. */
async function scanArpEntries() {
  if (process.platform !== 'win32') return [];
  const results = await Promise.all(HIVES.map((hive) => run('reg', ['query', hive, '/s'], { timeoutMs: REG_TIMEOUT_MS })));
  const entries = [];
  for (const result of results) {
    if (!result || result.timedOut || result.code !== 0) continue;
    entries.push(...collectArpEntries(result.stdout));
  }
  return entries;
}

function setPreferred(map, key, entry) {
  if (!key) return;
  const current = map.get(key);
  if (!current || (!current.displayIcon && entry.displayIcon)) map.set(key, entry);
}

function buildArpIndex(entries) {
  const byName = new Map();
  const byLoose = new Map();
  const byPath = new Map();
  const byCompact = new Map();
  const compact = [];
  for (const entry of entries) {
    if (!entry.displayName) continue;
    setPreferred(byName, normalizeName(entry.displayName), entry);
    setPreferred(byLoose, looseName(entry.displayName), entry);
    if (entry.installLocation) setPreferred(byPath, normalizePathKey(entry.installLocation), entry);
    const compactName = compactText(entry.displayName);
    if (compactName) {
      compact.push({ name: compactName, entry });
      /* O(1) exact-hit map: the linear `compact` scan below is only for prefix/substring
       * fallbacks, and running it once per item on every snapshot was measurable. */
      setPreferred(byCompact, compactName, entry);
    }
  }
  return { scannedAt: Date.now(), entries, byName, byLoose, byPath, byCompact, compact };
}

/**
 * Cached ARP index: `{ byName, byLoose, byPath, compact[], entries[] }`.
 * The scan itself runs once per 5 minutes; later snapshots and icon requests reuse it.
 *
 * @returns {Promise<object>}
 */
export async function getArpIndex() {
  const cached = cacheGet(ARP_CACHE_KEY);
  if (cached) return cached;
  return cacheSet(ARP_CACHE_KEY, buildArpIndex(await scanArpEntries()), ICON_SCAN_TTL);
}

/** Generic words that must never drive an ARP match (package ids often end in these). */
const WEAK_NAME_SEGMENTS = new Set([
  'x64',
  'x86',
  'arm64',
  'win32',
  'win64',
  'portable',
  'latest',
  'stable',
  'beta',
  'insiders',
  'app',
  'desktop',
  'cli',
  'gui',
  'tool',
  'tools',
  'runtime',
]);

/**
 * Candidate names derived from a winget package id, strongest first.
 * "Microsoft.VisualStudioCode" -> ["microsoftvisualstudiocode", "visualstudiocode"].
 * Ids that look like ARP/MSIX paths (they carry the display name already) and ids containing
 * path or control characters never drive a heuristic match.
 */
function packageIdNames(packageId) {
  const raw = String(packageId || '');
  if (!raw || raw.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(raw)) return [];
  const segments = raw
    .split('.')
    .map((segment) => compactText(segment))
    .filter((segment) => segment.length >= 3 && !WEAK_NAME_SEGMENTS.has(segment) && !/^\d+$/.test(segment));
  const names = [];
  if (segments.length >= 2) names.push(segments.slice(-2).join(''));
  if (segments.length >= 1) names.push(segments[segments.length - 1]);
  return [...new Set(names)].sort((left, right) => right.length - left.length);
}

function usableEntry(entry) {
  return entry && entry.displayIcon ? entry : null;
}

/**
 * Match a snapshot item (or a bare `{packageId}`) to an ARP record that has a DisplayIcon.
 * Heuristics, in order: install location -> exact DisplayName -> loose DisplayName ->
 * compact DisplayName -> package-id segments (exact, prefix, substring).
 *
 * @param {object} index result of getArpIndex()
 * @param {{packageId?: string, name?: string, path?: string|null}} item
 * @returns {object|null} ARP entry
 */
export function matchArpEntry(index, item) {
  if (!index || !item) return null;

  if (item.path) {
    const hit = usableEntry(index.byPath.get(normalizePathKey(item.path)));
    if (hit) return hit;
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name) {
    const exact = usableEntry(index.byName.get(normalizeName(name)));
    if (exact) return exact;
    const loose = usableEntry(index.byLoose.get(looseName(name)));
    if (loose) return loose;
    const compactName = compactText(name);
    for (const candidate of index.compact) {
      if (candidate.name === compactName) return usableEntry(candidate.entry);
    }
  }

  for (const wanted of packageIdNames(item.packageId)) {
    const direct = usableEntry(index.byName.get(wanted)) || usableEntry(index.byLoose.get(wanted));
    if (direct) return direct;
    // Prefix / substring matches need a long enough needle, otherwise ids like `winget:ini`
    // would hit an arbitrary "…ini…" program.
    if (wanted.length < 5) continue;
    let prefix = null;
    let contains = null;
    for (const candidate of index.compact) {
      const hit = usableEntry(candidate.entry);
      if (!hit) continue;
      if (candidate.name === wanted) return hit;
      if (!prefix && candidate.name.startsWith(wanted)) prefix = hit;
      if (!contains && candidate.name.includes(wanted)) contains = hit;
    }
    if (prefix) return prefix;
    if (contains) return contains;
  }
  return null;
}

/* --------------------------------------------------------------- installed size */

/**
 * Installed size in bytes from the ARP `EstimatedSize` value, or null.
 *
 * This is deliberately a *separate* matcher from `matchArpEntry`: that one only considers
 * records carrying a `DisplayIcon` (an icon needs one), while 159 of the 195 uninstall keys on
 * the reference machine carry `EstimatedSize` regardless of whether they have an icon. Reusing
 * the icon matcher here would silently drop most sizes.
 *
 * `EstimatedSize` is installer-reported (KiB), so it is an estimate — good enough for a sortable
 * column, never presented as an exact measurement. `detail` still does the real directory walk.
 *
 * @param {object} index result of getArpIndex()
 * @param {{packageId?: string, name?: string, path?: string|null}} item
 * @returns {number|null} bytes, or null when this item has no size on record
 */
export function matchArpSize(index, item) {
  if (!index || !item) return null;
  const sized = (entry) => (entry && entry.estimatedSizeKb > 0 ? entry.estimatedSizeKb * 1024 : null);

  if (item.path) {
    const hit = sized(index.byPath.get(normalizePathKey(item.path)));
    if (hit) return hit;
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name) {
    const exact = sized(index.byName.get(normalizeName(name)));
    if (exact) return exact;
    const loose = sized(index.byLoose.get(looseName(name)));
    if (loose) return loose;
    const byCompact = sized(index.byCompact && index.byCompact.get(compactText(name)));
    if (byCompact) return byCompact;
  }

  for (const wanted of packageIdNames(item.packageId)) {
    const direct =
      sized(index.byName.get(wanted)) ||
      sized(index.byLoose.get(wanted)) ||
      sized(index.byCompact && index.byCompact.get(wanted));
    if (direct) return direct;
  }
  return null;
}

/**
 * Install directory for an item, from the ARP `InstallLocation` value, or null.
 *
 * Used only as a size-walk target: an entry that carries a location but no `EstimatedSize` can
 * still be measured from disk. Same matching ladder as `matchArpSize`, but keyed on
 * `installLocation` instead of `estimatedSizeKb`.
 *
 * @param {object} index result of getArpIndex()
 * @param {{packageId?: string, name?: string, path?: string|null}} item
 * @returns {string|null}
 */
export function matchArpLocation(index, item) {
  if (!index || !item) return null;
  const located = (entry) => (entry && entry.installLocation ? entry.installLocation : null);

  if (item.path) {
    const hit = located(index.byPath.get(normalizePathKey(item.path)));
    if (hit) return hit;
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name) {
    const exact = located(index.byName.get(normalizeName(name)));
    if (exact) return exact;
    const loose = located(index.byLoose.get(looseName(name)));
    if (loose) return loose;
    const byCompact = located(index.byCompact && index.byCompact.get(compactText(name)));
    if (byCompact) return byCompact;
  }

  for (const wanted of packageIdNames(item.packageId)) {
    const direct =
      located(index.byName.get(wanted)) ||
      located(index.byLoose.get(wanted)) ||
      located(index.byCompact && index.byCompact.get(wanted));
    if (direct) return direct;
  }
  return null;
}

/* --------------------------------------------------------------- icon extraction */

const extractedMemory = new Map(); // key -> {bytes, contentType, path}
const extractedInflight = new Map(); // key -> Promise

function tempDir() {
  return path.join(os.tmpdir(), EXTRACT_DIR);
}

function rememberExtracted(key, icon) {
  extractedMemory.delete(key);
  extractedMemory.set(key, icon);
  if (extractedMemory.size > EXTRACT_MEMORY_MAX) {
    const oldest = extractedMemory.keys().next().value;
    if (oldest !== undefined) extractedMemory.delete(oldest);
  }
  return icon;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isPng(bytes) {
  return Boolean(bytes) && bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

async function readIconFile(filePath, contentType) {
  const real = await realpathOrNull(filePath);
  if (!real) return null;
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  const bytes = await fs.readFile(real);
  if (bytes.length === 0) return null;
  return { bytes, contentType, path: real, sizeBytes: bytes.length };
}

async function extractOnce(key, exePath) {
  const dir = tempDir();
  const outPath = path.join(dir, `${key}.png`);

  // Reuse the PNG written by a previous process lifetime.
  try {
    const existing = await fs.stat(outPath);
    if (existing.isFile() && existing.size > 0) {
      const bytes = await fs.readFile(outPath);
      if (isPng(bytes)) return rememberExtracted(key, { bytes, contentType: 'image/png', path: outPath, sizeBytes: bytes.length });
    }
  } catch {
    /* not extracted yet */
  }

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return null;
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$icon=[System.Drawing.Icon]::ExtractAssociatedIcon(${powershellQuote(exePath)})`,
    'if($null -eq $icon){exit 3}',
    'try{',
    '  $bmp=$icon.ToBitmap()',
    `  $bmp.Save(${powershellQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png)`,
    '  $bmp.Dispose()',
    '}finally{',
    '  $icon.Dispose()',
    '}',
  ].join('; ');

  let result;
  try {
    // lib/run.js resolves extensionless tool names (it appends PATHEXT), so 'powershell' is
    // the name that finds powershell.exe; passing 'powershell.exe' would look for
    // `powershell.exe.exe`.
    result = await run('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
  } catch {
    return null; // powershell.exe missing or the spawn was refused
  }
  if (!result || result.timedOut || result.code !== 0) return null;

  let stat;
  try {
    stat = await fs.stat(outPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  const bytes = await fs.readFile(outPath);
  if (!isPng(bytes)) return null;
  return rememberExtracted(key, { bytes, contentType: 'image/png', path: outPath, sizeBytes: bytes.length });
}

/**
 * Extract an `.exe`'s associated icon to a reusable PNG (CONTRACT §8.2).
 * Keyed by `<realpath>|<mtimeMs>|<size>` so an upgraded app gets a fresh icon.
 * Concurrent requests for the same source share one PowerShell child; a 5 s timeout kills
 * the whole tree (lib/run.js), so no orphan process is left behind.
 *
 * @param {string} exePath
 * @returns {Promise<{bytes: Buffer, contentType: 'image/png', path: string, sizeBytes: number}|null>}
 */
export async function extractExeIcon(exePath) {
  if (process.platform !== 'win32') return null;
  const real = await realpathOrNull(exePath);
  if (!real) return null;
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const key = sha1Hex(`${real.toLowerCase()}|${Math.trunc(stat.mtimeMs)}|${stat.size}`);
  const cached = extractedMemory.get(key);
  if (cached) return cached;
  const inflight = extractedInflight.get(key);
  if (inflight) return inflight;

  const task = extractOnce(key, real).finally(() => {
    extractedInflight.delete(key);
  });
  extractedInflight.set(key, task);
  return task;
}

/**
 * Resolve an ARP `DisplayIcon` into served bytes: `.ico` (and other contract types) are read
 * as-is, `.exe` is extracted to PNG, everything else is unsupported (null -> 404).
 */
export async function readDisplayIcon(displayIcon) {
  const parsed = typeof displayIcon === 'string' ? parseDisplayIcon(displayIcon) : displayIcon;
  if (!parsed || !parsed.file) return null;
  const file = parsed.file;
  if (file.length > 4000 || /[\u0000-\u001f\u007f]/.test(file) || !path.isAbsolute(file)) return null;
  const contentType = contentTypeFor(file);
  if (contentType) return readIconFile(file, contentType);
  if (path.extname(file).toLowerCase() === '.exe') return extractExeIcon(file);
  return null;
}

/**
 * Cheap pre-check used by the snapshot decorator: would `readDisplayIcon` stand a chance?
 * Keeps `logoUrl` off guaranteed-404 values such as `.dll` resource references.
 */
export function isServeableDisplayIcon(displayIcon) {
  const parsed = typeof displayIcon === 'string' ? parseDisplayIcon(displayIcon) : displayIcon;
  if (!parsed || !parsed.file) return false;
  if (parsed.file.length > 4000 || /[\u0000-\u001f\u007f]/.test(parsed.file)) return false;
  if (!path.isAbsolute(parsed.file)) return false;
  return contentTypeFor(parsed.file) !== null || path.extname(parsed.file).toLowerCase() === '.exe';
}

/* -------------------------------------------------------------- editor extension roots */

/**
 * Candidate extension roots per editor manager, most specific first. The first existing
 * directory wins and is recorded in the returned index (`root`) for the probe report.
 *
 * PinK uses its own user-data extensions dir (`.pink/extensions`, verified on this machine);
 * `.pink-dev` and the product user-data dir are tried next, with the VS Code root only as a
 * documented last resort.
 */
export function extensionRoots(managerId) {
  const home = os.homedir();
  const appData = process.env.APPDATA || '';
  switch (managerId) {
    case 'vscode':
      return [path.join(home, '.vscode', 'extensions')];
    case 'code-insiders':
      return [path.join(home, '.vscode-insiders', 'extensions')];
    case 'cursor':
      return [path.join(home, '.cursor', 'extensions')];
    case 'windsurf':
      return [path.join(home, '.windsurf', 'extensions')];
    case 'pink':
      return [
        path.join(home, '.pink', 'extensions'),
        path.join(home, '.pink-dev', 'extensions'),
        appData ? path.join(appData, 'PinK', 'extensions') : '',
        path.join(home, '.pink', 'data', 'extensions'),
        path.join(home, '.vscode', 'extensions'),
      ].filter(Boolean);
    default:
      return [];
  }
}

/** `<publisher>.<name>-<version>`; the id segment may itself contain hyphens. */
const EXTENSION_DIR = /^([A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*)-(.+)$/;

async function readPackageIcon(dir) {
  try {
    const packageJson = path.join(dir, 'package.json');
    const stat = await fs.stat(packageJson);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return {};
    const data = JSON.parse(await fs.readFile(packageJson, 'utf8'));
    const icon = typeof data.icon === 'string' ? data.icon.trim() : '';
    if (!icon || icon.length > 500 || /[\u0000-\u001f\u007f]/.test(icon)) return {};
    const dirResolved = path.resolve(dir);
    const iconPath = path.resolve(dirResolved, icon);
    if (!isInside(dirResolved, iconPath)) return {}; // package.json must not point outside its folder
    let iconStat = null;
    try {
      iconStat = await fs.stat(iconPath);
    } catch {
      iconStat = null;
    }
    return {
      iconPath,
      iconExists: Boolean(iconStat && iconStat.isFile() && iconStat.size > 0),
      iconMtimeMs: iconStat ? iconStat.mtimeMs : 0,
      iconBytes: iconStat ? iconStat.size : 0,
    };
  } catch {
    return {};
  }
}

function buildExtensionIndex(managerId, root, checkedRoots, scanned) {
  const byIdVersion = new Map();
  const byIdList = new Map();
  for (const entry of scanned) {
    const id = entry.id.toLowerCase();
    const versionKey = `${id}@${String(entry.version).toLowerCase()}`;
    if (!byIdVersion.has(versionKey)) byIdVersion.set(versionKey, entry);
    if (!byIdList.has(id)) byIdList.set(id, []);
    byIdList.get(id).push(entry);
  }
  const byId = new Map();
  for (const [id, list] of byIdList) {
    byId.set(id, list.find((entry) => entry.iconExists) || list[0]);
  }
  return {
    manager: managerId,
    root,
    rootReal: null,
    checkedRoots,
    extensions: scanned.length,
    withIcon: scanned.filter((entry) => entry.iconExists).length,
    byId,
    byIdVersion,
    byIdList,
    scannedAt: Date.now(),
  };
}

/**
 * Cached extension directory scan for one editor manager.
 *
 * @param {string} managerId catalog manager id
 * @returns {Promise<object|null>} index, or null when the editor has no extensions root
 */
export async function getExtensionIndex(managerId) {
  const cacheKey = `${EXT_CACHE_KEY}:${managerId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached || null;

  const checkedRoots = extensionRoots(managerId);
  let root = null;
  for (const candidate of checkedRoots) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        root = candidate;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (!root) {
    cacheSet(cacheKey, null, ICON_SCAN_TTL);
    return null;
  }

  let dirents = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    cacheSet(cacheKey, null, ICON_SCAN_TTL);
    return null;
  }

  const scanned = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const match = EXTENSION_DIR.exec(dirent.name);
    if (!match) continue;
    const dir = path.join(root, dirent.name);
    const icon = await readPackageIcon(dir);
    scanned.push({ id: match[1], version: match[2], dir, ...icon });
  }

  const index = buildExtensionIndex(managerId, root, checkedRoots, scanned);
  index.rootReal = (await realpathOrNull(root)) || path.resolve(root);
  return cacheSet(cacheKey, index, ICON_SCAN_TTL);
}

/**
 * Pick the installed folder for one extension. An exact version wins, then a platform
 * suffixed folder (`1.0.1-win32-x64`), then the best folder for that id.
 *
 * @param {object|null} index result of getExtensionIndex()
 * @param {string} extId `publisher.extension`
 * @param {string} [version] snapshot item version
 */
export function findExtensionEntry(index, extId, version = '') {
  if (!index || typeof extId !== 'string') return null;
  const id = extId.trim().toLowerCase();
  if (!id) return null;
  const list = index.byIdList.get(id);
  if (!list || list.length === 0) return null;

  const wanted = typeof version === 'string' ? version.trim().toLowerCase() : '';
  if (wanted) {
    const exact = index.byIdVersion.get(`${id}@${wanted}`);
    if (exact) return exact;
    for (const entry of list) {
      const dirVersion = String(entry.version).toLowerCase();
      if (dirVersion.startsWith(`${wanted}-`) || wanted.startsWith(`${dirVersion}-`)) return entry;
    }
  }
  return index.byId.get(id) || list[0];
}

/**
 * Read one extension icon, enforcing realpath containment inside the extension root.
 *
 * @param {object} index result of getExtensionIndex()
 * @param {object} entry folder entry from findExtensionEntry()
 */
export async function readExtensionIcon(index, entry) {
  if (!index || !index.rootReal || !entry || !entry.iconPath) return null;
  const real = await realpathOrNull(entry.iconPath);
  if (!real || !isInside(index.rootReal, real)) return null;
  const contentType = contentTypeFor(real);
  if (!contentType) return null;
  return readIconFile(real, contentType);
}
